// Control semantics: how each visible setting maps onto register bits.
//
// Every mapping here was confirmed by driving the vendor application under
// tools/cmod_sniff.py and reading the captured writes, not inferred. The
// captured evidence is quoted next to anything surprising.

// --- combo box contents, read out of the vendor app's own controls -----------

export const PSCLK_OPTIONS = ['Disabled', '10MHz to 20MHz', '20MHz to 40MHz', '>40MHz'];
export const FREQ_OPTIONS = ['Normal', '12MHz', '13MHz', '19.2MHz'];
export const MASTER_SLAVE_OPTIONS = ['Slave', 'Master'];
export const SPDIF_PLL_INPUT_OPTIONS = ['LRCLK', 'S/PDIF Input'];
export const BCLK_OPTIONS = [
  'Off', '64 x LRCLK', '48 x LRCLK', 'Reserved', 'PCLK / 2', 'PCLK / 4', 'PCLK / 8', 'PCLK / 16',
];
export const LRCLK_OPTIONS = [
  { label: '48kHz', hz: 48000 },
  { label: '44.1kHz', hz: 44100 },
  { label: '32kHz', hz: 32000 },
  { label: '24kHz', hz: 24000 },
  { label: '16kHz', hz: 16000 },
  { label: '12kHz', hz: 12000 },
  { label: '8kHz', hz: 8000 },
];
export const DAC_ADC_OPTIONS = ['DAC Only', 'ADC Only', 'DAC and ADC'];

export const VOICE_FILTER_OPTIONS = [
  'Disabled',
  'Elliptical for 16kHz GSM with 217Hz notch',
  '500Hz butterworth for 16kHz',
  'Elliptical for 8kHz GSM with 217Hz notch',
  '500Hz butterworth for 8kHz',
  '200Hz butterworth for 48kHz',
];

// ATK and RLS are plain indices: setting Attack to "50ms" (index 2) wrote
// 0x0E = 0x08, which is ATK = 2; Release "625ms" (index 3) wrote 0x30 = RLS 3.
export const AGC_ATTACK_OPTIONS = ['3ms', '12ms', '50ms', '200ms'];
export const AGC_RELEASE_OPTIONS = ['78ms', '156ms', '312ms', '625ms', '1.25s', '2.5s', '5s', '10s'];
// HLD is offset by one: Hold "50ms" (index 0) wrote HLD = 1, "100ms" wrote 2.
// HLD = 0 is what "Enable AGC" clears, so it is the AGC off state.
export const AGC_HOLD_OPTIONS = ['50ms', '100ms', '400ms'];
export const AGC_SOURCE_OPTIONS = ['Voice ADC', 'Voice + Background ADC'];

// PAM is gated the same way: enabling the microphone wrote 0x0C = 0x34 (PAM 1)
// from 0x14 (PAM 0), so PAM 0 is "microphone off" and the gains start at 1.
export const MIC_PREAMP_SCALE = ['+0dB', '+20dB', '+30dB'];
export const PLAYBACK_GAIN_SCALE = ['0dB', '+6dB', '+12dB', '+18dB'];

// --- level scales -----------------------------------------------------------
//
// DVA sits at bits 7:1, so the register is twice the level: slider 10 wrote
// 0x09 = 0x14, slider 40 wrote 0x50, slider 3 wrote 0x06. The field definition
// already accounts for the shift, so these work in level units.

export const scales = {
  /** Voice DAC level, 0..94. 0 is +3dB; the bottom of the range is mute. */
  dacLevel: {
    max: 94,
    format: (v) => (v >= 94 ? 'Mute' : String(3 - v)),
    parse: (text) => (/^mute$/i.test(text.trim()) ? 94 : intOrNull(text, (db) => 3 - db)),
    top: '+3dB',
    bottom: 'Mute',
  },

  /** Sidetone, gated: DVST 0 = off, 1..31 = 0dB..-60dB in 2dB steps. */
  sidetone: {
    max: 30,
    format: (v) => String(-2 * v),
    parse: (text) => intOrNull(text, (db) => Math.round(-db / 2)),
    top: '0dB',
    bottom: '-60dB',
  },

  /** ADC output levels (AVL and A1L), 0..15 = +3dB..-12dB. */
  adcLevel: {
    max: 15,
    format: (v) => String(3 - v),
    parse: (text) => intOrNull(text, (db) => 3 - db),
    top: '+3dB',
    bottom: '-12dB',
  },

  /** MIC PGA, 0..20 = +20dB..0dB. Reset 0x14 is PGAM 20, i.e. 0dB. */
  micPga: {
    max: 20,
    format: (v) => String(20 - v),
    parse: (text) => intOrNull(text, (db) => 20 - db),
    top: '+20dB',
    bottom: '0dB',
  },
};

/**
 * Noise gate threshold, gated: ANTH 0 = gate off, 1..15 = -72dB..-16dB in 4dB
 * steps. Enabling the gate with the slider at the bottom wrote ANTH = 1.
 */
export const NG_THRESHOLD = {
  max: 14,
  toDb: (level) => -72 + 4 * level,
  fromDb: (db) => Math.round((db + 72) / 4),
  minLabel: '-72dB',
  maxLabel: '-16dB',
};

/**
 * AGC threshold, 0..15 running the other way: the slider's right-hand end
 * (-3dB) is AGCTH 0. Setting the slider to 5 wrote AGCTH = 10, and to 15 wrote
 * 0 — so AGCTH = 15 - position and dB = -3 - AGCTH.
 */
export const AGC_THRESHOLD = {
  max: 15,
  toDb: (agcth) => -3 - agcth,
  fromDb: (db) => Math.min(15, Math.max(0, Math.round(-3 - db))),
  minLabel: '-18dB',
  maxLabel: '-3dB',
};

/**
 * The two read-only indicator bars on the AGC / NG tab, driven by register 0x01.
 * The vendor app polls 0x01 at roughly 6 Hz while that tab is visible.
 *
 * Both scales are from the MAX9860 datasheet (Table 2, p16). Neither is
 * the code itself, and neither could be established from captured traffic —
 * these registers only move with live audio.
 */

/**
 * Noise Gate Attenuation, NG2:0. Non-linear: the top four codes step by 2dB.
 * Code 0 is no attenuation, which is why a full bar means 0dB.
 */
const NG_ATTEN_DB = [0, 1, 2, 3, 6, 8, 10, 12];
export const NG_ATTEN_BAR = {
  max: 7,
  full: 12,
  toDb: (code) => NG_ATTEN_DB[code] ?? 0,
  minLabel: '-12dB',
  maxLabel: '0dB',
};

/**
 * AGC Gain, AGC4:0. "The levels indicated by these bits correspond to the levels
 * defined for the PGAM bits described in register 0x0C" — so this is the PGAM
 * scale, +20dB at code 0 falling to 0dB at code 0x14, not the code as decibels.
 */
export const AGC_GAIN_BAR = {
  max: 20,
  full: 20,
  toDb: (code) => Math.max(0, 20 - code),
  minLabel: '0dB',
  maxLabel: '20dB',
};

// --- CS8427 -----------------------------------------------------------------

/**
 * Digital Audio Interface radio. S/PDIF sets RUN (bit 6), selecting I2S clears
 * it and stops the receiver.
 */
export const DAI_CLOCK_SOURCE = { i2s: 0x08, spdif: 0x48 };

// --- Configure --------------------------------------------------------------

/**
 * What the Automatic tab's Configure button computes.
 *
 * Captured across seven presses. Writes, in order:
 *
 *   0x07 <- 0x09                 ST set, BS = 1 (64 x LRCLK)
 *   0x06 <- MAS ? 0x80 : 0x00
 *   0x03 <- PSCLK<<4 | FREQ<<1 | fast
 *   0x04 <- N high 7 bits        PLL bit clear
 *   0x05 <- N low 8 bits
 *   0x04 <- N high | (slave ? 0x80 : 0x00)      PLL enabled only as slave
 *   0x10 <- DAC/ADC enables      /SHDN still low
 *
 * Worked examples that pinned the formula down:
 *   13MHz    /  8kHz slave -> 0x03=0x10, N=0x0F20 (3872)
 *   13MHz    / 16kHz slave -> 0x03=0x10, N=0x1E3F (7743)
 *   13MHz    / 48kHz slave -> 0x03=0x11, N=0x5ABE (23230)
 *   13MHz    / 44.1k slave -> 0x03=0x11, N=0x535F (21343)
 *   12.288M  / 48kHz slave -> 0x03=0x11, N=0x6000 (24576)
 *   12.288M  /  8kHz slave -> 0x03=0x10, N=0x1000 (4096)
 *   13MHz    /  8kHz master-> 0x03=0x14, N=0x0F20, PLL left clear
 *
 * The 0x03 bit 0 the register grid labels "16kHz" is the LRCLK > 24kHz flag —
 * the same bit the Manual tab exposes as "AGC Fast Mode (LRCLK > 24kHz)". It is
 * set for 48kHz and 44.1kHz and clear for 8kHz and 16kHz.
 */
export function computeConfigure({ mclkHz, lrclkHz, master, dacAdc, source = 'external' }) {
  const psclk = prescalerCode(mclkHz);
  const pclkHz = mclkHz / (psclk === 0 ? 1 : 2 ** (psclk - 1));

  // Exact integer mode needs one of three frequencies *and* an 8k or 16k sample
  // rate, and the app only uses it as master. 13MHz/48kHz master stays in
  // normal mode, which is what the app does.
  //
  // The app matches against MCLK, not PCLK. The datasheet says PCLK ("Select
  // when PCLK is 12MHz"), so a 26MHz MCLK prescaled to a 13MHz PCLK is eligible
  // by the datasheet and the app misses it. Measured: External 26MHz at 8kHz
  // master gives FREQ = 00. Matched here deliberately, to stay equivalent.
  const freq = master ? integerModeCode(mclkHz, lrclkHz) : 0;

  const exactN = (65536 * 96 * lrclkHz) / pclkHz;
  const n = Math.min(0x7fff, Math.round(exactN));

  // The PLL is chosen by the clock *source*, not by the frequency and not by
  // whether N comes out whole. Measured: the 12.288MHz radio gives PLL = 0 at
  // every rate including 44.1kHz where N is inexact, while External with 12.288
  // typed into the field gives PLL = 1 at the same rates. The on-board 12.288MHz
  // oscillator and the recovered RMCK are synchronous with the audio clock, so
  // the divider can track them; 13MHz and anything external cannot be assumed to
  // be, so the PLL has to lock to the incoming LRCLK. Slave mode only either way.
  const usePll = !master && !SYNCHRONOUS_SOURCES.has(source);

  // Register 0x03 bit 0 carries two different meanings. With exact integer mode
  // engaged it selects 8kHz or 16kHz; otherwise it is the AGC clock rate flag.
  const sixteen = freq !== 0
    ? (lrclkHz === 16000 ? 1 : 0)
    : (lrclkHz > 24000 ? 1 : 0);

  return {
    psclk,
    freq,
    sixteen,
    n,
    pclkHz,
    exact: isWhole(exactN),
    usePll,
    reg03: (psclk << 4) | (freq << 1) | sixteen,
    reg04: ((n >> 8) & 0x7f) | (usePll ? 0x80 : 0x00),
    reg05: n & 0xff,
    reg06: master ? 0x80 : 0x00,
    reg07: 0x09,
    reg10: DAC_ADC_ENABLES[dacAdc],
  };
}

/** Clock sources that run synchronously with the audio, so need no PLL. */
const SYNCHRONOUS_SOURCES = new Set(['recovered', 'osc12m288']);

/** The codec needs PCLK in 10-20MHz, so MCLK below 10MHz cannot be used. */
export const MIN_MCLK_HZ = 10e6;

/**
 * MCLK a source presents at a given sample rate, or null when the user supplies
 * it. Recovered is rate-dependent: RMCK out of the CS8427 is 256 x Fs, so the
 * app shows 12.288MHz at 48kHz and 11.2896MHz at 44.1kHz — both measured.
 */
export function mclkForSource(key, lrclkHz) {
  switch (key) {
    case 'recovered': return 256 * lrclkHz;
    case 'osc12m288': return 12.288e6;
    case 'osc13': return 13e6;
    default: return null; // external — whatever is patched in at JU8 row 5
  }
}

const isWhole = (x) => Math.abs(x - Math.round(x)) < 1e-6;

/** reg 0x10 for the DAC/ADC combo: DACEN 0x08, ADVEN 0x02, AD1EN 0x01. */
export const DAC_ADC_ENABLES = [0x08, 0x03, 0x0b];

function prescalerCode(mclkHz) {
  if (mclkHz > 40e6) return 3;
  if (mclkHz > 20e6) return 2;
  if (mclkHz >= 10e6) return 1;
  return 0; // Disabled
}

/** FREQ code per PCLK frequency; index 0 is Normal. */
const INTEGER_MODE_PCLK = [null, 12e6, 13e6, 19.2e6];

function integerModeCode(pclkHz, lrclkHz) {
  // "Exact integer mode ... for both 8kHz and 16kHz sample rates" — nothing else.
  if (lrclkHz !== 8000 && lrclkHz !== 16000) return 0;
  for (let code = 1; code <= 3; code++) {
    if (Math.abs(pclkHz - INTEGER_MODE_PCLK[code]) < 1000) return code;
  }
  return 0; // Normal
}

function intOrNull(text, toLevel) {
  const db = Number(text.trim().replace(/dB$/i, ''));
  if (!Number.isFinite(db)) return null;
  const level = toLevel(db);
  return Number.isFinite(level) ? Math.round(level) : null;
}
