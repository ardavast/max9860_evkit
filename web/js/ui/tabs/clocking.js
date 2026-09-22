// Digital Audio Interface and Clocking tab.
//
// This is the one tab that genuinely needs the command module: the two mux
// selects and both oscillator enables land on MAXQ2000 port pins and on no
// jumper, so Clock Sources here is the only way to choose or gate MCLK.
//
// Layout and behaviour follow the vendor app, which were established by driving
// its controls over Win32 and reading the results back — see docs/control-map.md
// §5. In short:
//
//   * Automatic and Manual are both always on screen; the radio above them
//     decides which side accepts input, and the other greys out.
//   * Automatic does not mirror into Manual as you type. Manual shows the
//     registers as they are, and only Configure moves them.
//   * The Clock Sources radio sets the MCLK frequency and locks the field;
//     only External lets you type one. It does not itself Configure.

import { el, group } from '../dom.js';
import { FIELDS, CS_FIELDS } from '../../model/registers.js';
import { CLOCK_SOURCES } from '../../protocol/board.js';
import {
  BCLK_OPTIONS, DAC_ADC_OPTIONS, FREQ_OPTIONS, LRCLK_OPTIONS, MASTER_SLAVE_OPTIONS,
  PSCLK_OPTIONS, SPDIF_PLL_INPUT_OPTIONS, DAI_CLOCK_SOURCE, MIN_MCLK_HZ,
  mclkForSource, computeConfigure,
} from '../../model/mappings.js';

/**
 * @param {import('../controls.js').Binder} binder
 * @param {(err: Error) => void} onError
 */
export function clockingTab(binder, onError) {
  const board = binder.board;
  const auto = automaticPanel(binder, onError);
  const manual = manualPanel(binder);

  const clockSources = binder.customRadio(
    'Clock Sources',
    Object.entries(CLOCK_SOURCES).map(([key, s]) => ({ key, label: s.label })),
    () => board.detectClockSource(),
    (key) => board.setClockSource(key),
    // Pinning MCLK is pure UI, so it happens even with no board attached.
    (key) => auto.setSource(key),
  );

  // The interface radio drives CS8427 register 0x04 wholesale: 0x48 selects
  // S/PDIF (RUN set), 0x08 selects I2S and stops the receiver.
  const dai = binder.customRadio(
    'Digital Audio Interface',
    [{ key: 'i2s', label: 'I2S - JU8' }, { key: 'spdif', label: 'S/PDIF' }],
    () => (binder.shadow.getCs(CS_FIELDS.RUN) === 1 ? 'spdif' : 'i2s'),
    (key) => board.writeCsReg(0x04, DAI_CLOCK_SOURCE[key]),
  );

  const setMode = (automatic) => {
    // `inert` greys a whole panel and blocks interaction without fighting the
    // per-control disabled state that the gated fields manage themselves.
    auto.node.inert = !automatic;
    manual.node.inert = automatic;
    auto.node.classList.toggle('is-off', !automatic);
    manual.node.classList.toggle('is-off', automatic);
  };

  const mode = el('div.iface-mode',
    modeRadio('Automatic', true, () => setMode(true)),
    modeRadio('Manual', false, () => setMode(false)));
  setMode(true);

  // Reflect whatever the pins already say once a board is read.
  binder.onSync(() => auto.syncSource(board.detectClockSource()));

  return el('div',
    el('div.tab-cols', clockSources, dai),
    el('section.group.iface',
      el('h3.group-title', 'Interface Configuration'),
      el('div.group-body',
        mode,
        el('div.iface-panels', auto.node, manual.node))));
}

function modeRadio(label, checked, onchange) {
  const input = el('input', { type: 'radio', name: 'iface-mode', checked, onchange });
  return el('label.check', input, el('span', label));
}

/**
 * Automatic: pick MCLK and LRCLK, press Configure, and the prescaler, the
 * integer-mode selector and the PLL divider are computed and written.
 */
function automaticPanel(binder, onError) {
  const mclk = el('input.num', { type: 'text', value: '13', spellcheck: false });
  const lrclk = el('select', LRCLK_OPTIONS.map((o) => el('option', o.label)));
  lrclk.selectedIndex = LRCLK_OPTIONS.findIndex((o) => o.hz === 8000);
  const masterSlave = el('select', MASTER_SLAVE_OPTIONS.map((o) => el('option', o)));
  const dacAdc = el('select', DAC_ADC_OPTIONS.map((o) => el('option', o)));
  dacAdc.selectedIndex = 2;

  let source = 'osc13';

  /**
   * Clock source pins the MCLK frequency; only External lets you type one.
   * Recovered is rate-dependent — RMCK is 256 x Fs — so it is re-derived
   * whenever the sample rate changes too.
   */
  const setSource = (key) => {
    source = key;
    refreshMclk();
  };
  function refreshMclk() {
    const hz = mclkForSource(source, lrclkHz());
    mclk.disabled = hz !== null;
    if (hz !== null) mclk.value = String(Number((hz / 1e6).toFixed(6)));
    update();
  }
  const lrclkHz = () => LRCLK_OPTIONS[lrclk.selectedIndex].hz;
  // Only follow the board when it actually reports a recognisable source.
  const syncSource = (key) => { if (key) setSource(key); };

  const summary = el('p.hint');
  const plan = () => {
    const mhz = Number(mclk.value);
    if (!Number.isFinite(mhz) || mhz <= 0) return null;
    return computeConfigure({
      mclkHz: mhz * 1e6,
      lrclkHz: lrclkHz(),
      master: masterSlave.selectedIndex === 1,
      dacAdc: dacAdc.selectedIndex,
      source,
    });
  };
  /** Below 10MHz the codec cannot make a legal PCLK, so Configure is refused. */
  const tooSlow = () => Number(mclk.value) * 1e6 < MIN_MCLK_HZ;

  function update() {
    const p = plan();
    if (!p) { summary.textContent = 'Enter an MCLK frequency in MHz.'; return; }
    if (tooSlow()) {
      summary.textContent = `MCLK ${mclk.value} MHz is below the codec's 10 MHz minimum`
        + `${source === 'recovered' ? ` — a recovered clock is 256 x ${lrclkHz() / 1000}kHz` : ''}.`;
      summary.classList.add('warn');
      return;
    }
    summary.classList.remove('warn');
    const mode = p.freq ? `exact integer (${FREQ_OPTIONS[p.freq]})` : p.usePll ? 'PLL' : 'divider';
    summary.textContent = `PCLK ${(p.pclkHz / 1e6).toFixed(3)} MHz · N ${p.n}`
      + `${p.exact ? ' exactly' : ''} · ${mode}`;
  }
  [masterSlave, dacAdc].forEach((c) => c.addEventListener('change', update));
  lrclk.addEventListener('change', refreshMclk);
  mclk.addEventListener('input', update);
  refreshMclk();

  const button = el('button.primary', { type: 'button' }, 'Configure');
  button.addEventListener('click', async () => {
    const p = plan();
    if (!p) { onError(new Error('MCLK must be a frequency in MHz')); return; }
    if (tooSlow()) {
      onError(new Error(`MCLK ${mclk.value} MHz is below the codec's 10 MHz minimum`));
      return;
    }
    button.disabled = true;
    try {
      await applyConfigure(binder.board, p);
    } catch (err) {
      onError(err);
    } finally {
      button.disabled = false;
      binder.syncAll();
    }
  });

  const node = el('div.panel.panel-auto',
    labelled('MCLK Frequency', el('div.row.tight', mclk, el('span.unit', 'MHz'))),
    labelled('LRCLK Frequency', lrclk),
    labelled('Master / Slave Mode', masterSlave),
    labelled('DAC / ADC', dacAdc),
    button,
    summary);

  return { node, setSource, syncSource };
}

/**
 * Replay the vendor's Configure write order exactly: interface and format
 * first, then the clock registers, then N in two passes so the PLL bit is only
 * raised once N is fully written.
 */
async function applyConfigure(board, plan) {
  await board.writeCodecReg(0x07, plan.reg07);
  await board.writeCodecReg(0x06, plan.reg06);
  await board.writeCodecReg(0x03, plan.reg03);
  await board.writeCodecReg(0x04, (plan.n >> 8) & 0x7f);
  await board.writeCodecReg(0x05, plan.reg05);
  await board.writeCodecReg(0x04, plan.reg04);
  await board.writeCodecReg(0x10, plan.reg10);
}

/** Manual: the registers Automatic would compute, exposed directly. */
function manualPanel(binder) {
  const shadow = binder.shadow;
  const integerMode = () => shadow.get(FIELDS.FREQ) !== 0;
  const slave = () => shadow.get(FIELDS.MAS) === 0;

  const node = el('div.panel.panel-manual',
    el('div.manual-col',
      el('h4', 'MCLK Setup'),
      binder.select('PSCLK - MCLK Range', FIELDS.PSCLK, PSCLK_OPTIONS),
      binder.select('FREQ - Integer Sampling Modes', FIELDS.FREQ, FREQ_OPTIONS),
      // Captured: this combo drives CS8427 0x04 bit 0, moving the register
      // between 0x48 (LRCLK) and 0x49 (S/PDIF Input).
      binder.csSelect('S/PDIF PLL Clock Input', CS_FIELDS.RXD, SPDIF_PLL_INPUT_OPTIONS),

      el('h4', 'LRCLK Setup'),
      el('div.row.tight.n-row',
        labelled('N MSB', binder.fieldHexInput(FIELDS.N_HIGH)),
        labelled('N LSB', binder.fieldHexInput(FIELDS.N_LOW))),
      // Register 0x03 bit 0 under its two meanings. Exactly one is live at a
      // time, decided by FREQ, and the vendor app greys the other out.
      binder.checkbox('16kHz Mode', FIELDS.SIXTEEN_KHZ, { activeWhen: integerMode }),
      binder.checkbox('AGC Fast Mode (LRCLK > 24kHz)', FIELDS.SIXTEEN_KHZ,
        { activeWhen: () => !integerMode() }),
      binder.checkbox('PCM Mode', FIELDS.PCM)),

    el('div.manual-col',
      el('h4', 'Master / Slave Mode'),
      binder.select('', FIELDS.MAS, MASTER_SLAVE_OPTIONS),
      // The PLL is valid in slave mode only.
      binder.checkbox('PLL Mode', FIELDS.PLL, { activeWhen: slave }),

      el('h4', 'BCLK Setup'),
      binder.select('', FIELDS.BS, BCLK_OPTIONS),

      el('h4', 'Timing'),
      binder.checkbox('LRCLK Invert', FIELDS.WCI),
      binder.checkbox('DAC BCLK Invert', FIELDS.DBCI),
      binder.checkbox('ADC BCLK Invert', FIELDS.ABCI),
      binder.checkbox('DAC Delay', FIELDS.DDLY),
      binder.checkbox('ADC Delay', FIELDS.ADLY),
      binder.checkbox('SDOUT High Z', FIELDS.HIZ),
      binder.checkbox('Stereo Data', FIELDS.ST)));

  return { node };
}

function labelled(text, control) {
  return el('label.field', text ? el('span.field-label', text) : null, control);
}
