// Protocol encoder checks — no hardware, no browser.
//
//   node --test web/test/
//
// Every expected byte sequence here is quoted from docs/wire-protocol.md, and
// every Configure case is a transaction captured off the vendor application.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CommandModule, PIN } from '../js/protocol/cmod.js';
import { Max9860 } from '../js/protocol/max9860.js';
import { Cs8427 } from '../js/protocol/cs8427.js';
import { Board, CLOCK_SOURCES } from '../js/protocol/board.js';
import { Shadow } from '../js/model/shadow.js';
import { SerialTransport } from '../js/transport/serial.js';
import { FIELDS, fieldGet, fieldSet } from '../js/model/registers.js';
import { formatLogEvent, logClassesFor } from '../js/ui/log.js';
import {
  computeConfigure, scales, NG_THRESHOLD, AGC_THRESHOLD, NG_ATTEN_BAR, AGC_GAIN_BAR,
  mclkForSource, MIN_MCLK_HZ,
} from '../js/model/mappings.js';

/** Records what was written and replays canned replies. */
class FakeTransport {
  constructor(replies = []) {
    this.writes = [];
    this.replies = replies.map((r) => Uint8Array.from(r));
  }

  async transact(bytes, replyLen) {
    const tx = Uint8Array.from(bytes);
    this.writes.push(hexOf(tx));
    const reply = this.replies.shift() ?? new Uint8Array(replyLen);
    assert.equal(reply.length, replyLen, `reply length for ${hexOf(tx)}`);
    return reply;
  }
}

const hexOf = (b) => [...b].map((v) => v.toString(16).toUpperCase().padStart(2, '0')).join(' ');

// --- I2C --------------------------------------------------------------------

test('reading a codec register matches the documented bytes', async () => {
  // TX  A0 05 01 01 20 02     write 1 byte, read 1 byte, addr 0x20, register 0x02
  // RX  00 B0
  const t = new FakeTransport([[0x00, 0xb0]]);
  const codec = new Max9860(new CommandModule(t));

  assert.equal(await codec.read(0x02), 0x00);
  assert.deepEqual(t.writes, ['A0 05 01 01 20 02']);
});

test('writing a codec register uses read count zero, then reads back', async () => {
  // TX  A0 05 02 00 20 02 80
  // RX  B0
  const t = new FakeTransport([[0xb0], [0x80, 0xb0]]);
  const codec = new Max9860(new CommandModule(t));

  assert.equal(await codec.write(0x02, 0x80), 0x80);
  assert.deepEqual(t.writes, ['A0 05 02 00 20 02 80', 'A0 05 01 01 20 02']);
});

test('a write whose read-back disagrees is an error', async () => {
  const t = new FakeTransport([[0xb0], [0x00, 0xb0]]);
  const codec = new Max9860(new CommandModule(t));

  await assert.rejects(() => codec.write(0x02, 0x80), /wrote 0x80, read back 0x00/);
});

test('a device that does not acknowledge is reported, not returned as data', async () => {
  const t = new FakeTransport([[0xfa, 0xb0]]);
  const codec = new Max9860(new CommandModule(t));

  await assert.rejects(() => codec.read(0x02), /did not acknowledge/);
});

test('the device-present probe maps B0 and FA', async () => {
  const cmod = new CommandModule(new FakeTransport([[0xb0], [0xfa]]));
  assert.equal(await cmod.i2cPresent(0x20), true);
  assert.equal(await cmod.i2cPresent(0x20), false);
});

// --- pins -------------------------------------------------------------------

test('pin reads decode 00, 01 and FA', async () => {
  const cmod = new CommandModule(new FakeTransport([[0x00], [0x01], [0xfa]]));
  assert.equal(await cmod.pinRead(2), 0);
  assert.equal(await cmod.pinRead(2), 1);
  // K13 and K14 are simply absent; FA means "no such pin", not a fault.
  assert.equal(await cmod.pinRead(13), null);
});

test('pin writes are acknowledged with F0, not an echo', async () => {
  const t = new FakeTransport([[0xf0]]);
  await new CommandModule(t).pinWrite(PIN.CS, 1);
  assert.deepEqual(t.writes, ['F9 01']);
});

test('K1 cannot be driven — it is the codec interrupt output', async () => {
  const cmod = new CommandModule(new FakeTransport());
  await assert.rejects(() => cmod.pinWrite(PIN.IRQ, 1), /input/);
});

// --- SPI --------------------------------------------------------------------

test('a CS8427 register write is framed chip, MAP, data inside one /CS window', async () => {
  // TX  F9 00 · AF 20 AF 04 AF 48 · F9 01
  // RX  F0    · FF BF FF BF FF BF · F0
  const t = new FakeTransport([
    [0xf0],
    [0xff, 0xbf, 0xff, 0xbf, 0xff, 0xbf],
    [0xf0],
  ]);
  await new Cs8427(new CommandModule(t)).write(0x04, 0x48);

  assert.deepEqual(t.writes, ['F9 00', 'AF 20 AF 04 AF 48', 'F9 01']);
});

test('reading a CS8427 register takes two transactions, not one', async () => {
  // Putting the read chip byte, MAP and a dummy in one window returns zeros;
  // the pointer has to be set by its own write transaction first.
  const t = new FakeTransport([
    [0xf0], [0xff, 0xbf, 0xff, 0xbf], [0xf0],   // address: chip byte + MAP
    [0xf0], [0xff, 0xbf, 0x48, 0xbf], [0xf0],   // read: chip byte + one dummy
  ]);

  assert.equal(await new Cs8427(new CommandModule(t)).read(0x04), 0x48);
  assert.deepEqual(t.writes, [
    'F9 00', 'AF 20 AF 04', 'F9 01',
    'F9 00', 'AF 21 AF 00', 'F9 01',
  ]);
});

test('chip select is released even when the transfer throws', async () => {
  // The last byte's acknowledgement is 0x00 instead of 0xBF.
  const t = new FakeTransport([[0xf0], [0xff, 0xbf, 0xff, 0xbf, 0xff, 0x00], [0xf0]]);
  const cmod = new CommandModule(t);

  await assert.rejects(() => new Cs8427(cmod).write(0x04, 0x48), /expected 0xBF/);
  assert.equal(t.writes.at(-1), 'F9 01');
});

// --- transport rails --------------------------------------------------------

test('0xA9 is refused outright', async () => {
  // It puts the firmware into a continuous ASCII echo that only a port
  // close/reopen clears.
  await assert.rejects(
    () => new SerialTransport().transact([0xa9], 0),
    /0xA9/,
  );
});

// --- clock tree -------------------------------------------------------------

test('selecting a clock source silences both oscillators before moving the selects', async () => {
  const t = new FakeTransport(Array(5).fill([0xf0]));
  const board = new Board(t, new Shadow());

  await board.setClockSource('osc13');

  assert.deepEqual(t.writes, [
    'F5 00', // 13 MHz enable low
    'F6 00', // 12.288 MHz enable low
    'F2 00', // CLK_SEL
    'F3 00', // OX_SEL
    'F5 01', // only now, the one oscillator
  ]);
});

test('external leaves both oscillators off', async () => {
  const t = new FakeTransport(Array(4).fill([0xf0]));
  await new Board(t, new Shadow()).setClockSource('external');

  assert.deepEqual(t.writes, ['F5 00', 'F6 00', 'F2 00', 'F3 00']);
});

test('the pin table round-trips through clock source detection', () => {
  const board = new Board(new FakeTransport(), new Shadow());
  for (const [key, s] of Object.entries(CLOCK_SOURCES)) {
    board.shadow.pins[PIN.CLK_SEL] = s.clkSel;
    board.shadow.pins[PIN.OX_SEL] = s.oxSel;
    board.shadow.pins[PIN.OSC_13M] = s.osc13;
    board.shadow.pins[PIN.OSC_12M288] = s.osc12m288;
    assert.equal(board.detectClockSource(), key);
  }
});

// --- register model ---------------------------------------------------------

test('bitfields round-trip within their register', () => {
  // DVA sits at bits 7:1, so the register is twice the level.
  assert.equal(fieldSet(0x00, FIELDS.DVA, 3), 0x06);
  assert.equal(fieldGet(0x06, FIELDS.DVA), 3);

  // 0x0A holds both ADC levels: reset 0x33 is A1L 3 and AVL 3.
  assert.equal(fieldGet(0x33, FIELDS.A1L), 3);
  assert.equal(fieldGet(0x33, FIELDS.AVL), 3);
  assert.equal(fieldSet(0x33, FIELDS.AVL, 7), 0x37);

  // 0x10 running is 0x8B: /SHDN, DACEN, ADVEN, AD1EN.
  const running = [FIELDS.SHDN, FIELDS.DACEN, FIELDS.ADVEN, FIELDS.AD1EN]
    .reduce((v, f) => fieldSet(v, f, 1), 0x00);
  assert.equal(running, 0x8b);

  // 0x0C reset 0x14 is PGAM 20 with the preamp off.
  assert.equal(fieldGet(0x14, FIELDS.PGAM), 20);
  assert.equal(fieldGet(0x14, FIELDS.PAM), 0);
});

test('writeFields coalesces two fields in one register into a single write', async () => {
  const t = new FakeTransport([[0xb0], [0x37, 0xb0]]);
  const board = new Board(t, new Shadow());
  board.shadow.setCodec(0x0a, 0x33);

  await board.writeFields([[FIELDS.AVL, 7], [FIELDS.A1L, 3]]);

  assert.deepEqual(t.writes, ['A0 05 02 00 20 0A 37', 'A0 05 01 01 20 0A']);
});

// --- level scales, checked against the datasheet ----------------------------
//
// Spot values transcribed from the MAX9860 datasheet Tables 2, 8, 9 and 10. These
// were originally derived from captured traffic; the datasheet confirms them.

test('DAC level matches datasheet Table 8', () => {
  const { format } = scales.dacLevel;
  // Register 0x09 holds twice the level, so field value = register / 2.
  assert.equal(format(0x00 / 2), '3');    // 0x00 -> +3dB
  assert.equal(format(0x06 / 2), '0');    // 0x06 ->  0dB, the reset value
  assert.equal(format(0x14 / 2), '-7');   // 0x14 -> -7dB
  assert.equal(format(0x50 / 2), '-37');  // 0x50 -> -37dB
  assert.equal(format(0x7e / 2), '-60');  // 0x7E -> -60dB
  assert.equal(format(0xba / 2), '-90');  // 0xBA -> -90dB, the last real step
  assert.equal(format(0xbc / 2), 'Mute'); // >= 0xBC -> MUTE
});

test('sidetone matches datasheet Table 8', () => {
  // DVST 0 is Disabled; 0x01 is 0dB and every step after it is -2dB.
  const db = (dvst) => scales.sidetone.format(dvst - 1);
  assert.equal(db(0x01), '0');
  assert.equal(db(0x02), '-2');
  assert.equal(db(0x0f), '-28');
  assert.equal(db(0x10), '-30');
  assert.equal(db(0x1f), '-60');
});

test('MIC PGA matches datasheet Table 9', () => {
  const { format } = scales.micPga;
  assert.equal(format(0x00), '20');       // +20dB
  assert.equal(format(0x0b), '9');
  assert.equal(format(0x13), '1');
  assert.equal(format(0x14), '0');        // >= 0x14 -> 0dB
});

test('AGC and noise gate thresholds match datasheet Table 10', () => {
  // ANTH 0 is Disabled; 0x1 is -72dB, rising in 4dB steps to -16dB.
  assert.equal(NG_THRESHOLD.toDb(0x1 - 1), -72);
  assert.equal(NG_THRESHOLD.toDb(0xc - 1), -28);
  assert.equal(NG_THRESHOLD.toDb(0xf - 1), -16);

  // AGCTH runs the other way: code 0 is -3dB, falling 1dB per step.
  assert.equal(AGC_THRESHOLD.toDb(0x0), -3);
  assert.equal(AGC_THRESHOLD.toDb(0x5), -8);
  assert.equal(AGC_THRESHOLD.toDb(0xa), -13);
  assert.equal(AGC_THRESHOLD.toDb(0xf), -18);
});

test('the read-only bars match datasheet Table 2', () => {
  // Noise gate attenuation is not linear - the top four codes step by 2dB.
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(NG_ATTEN_BAR.toDb),
    [0, 1, 2, 3, 6, 8, 10, 12]);

  // AGC gain reads on the PGAM scale, not as decibels directly: code 0 is the
  // full +20dB of gain and 0x14 is 0dB.
  assert.equal(AGC_GAIN_BAR.toDb(0x00), 20);
  assert.equal(AGC_GAIN_BAR.toDb(0x01), 19);
  assert.equal(AGC_GAIN_BAR.toDb(0x14), 0);
  assert.equal(AGC_GAIN_BAR.toDb(0x1f), 0); // clamped past the end of the scale
});

// --- Configure --------------------------------------------------------------

test('Configure reproduces every captured vendor computation', () => {
  // Captured off the vendor app with the Clock Sources radio driving MCLK,
  // which is how the field is meant to be set.
  const cases = [
    // mclk MHz, lrclk Hz, master, reg03, N, PLL
    [13, 8000, false, 0x10, 0x0f20, true],
    [13, 16000, false, 0x10, 0x1e3f, true],
    [13, 48000, false, 0x11, 0x5abe, true],
    [13, 44100, false, 0x11, 0x535f, true],
    // 12.288MHz divides exactly, so the PLL stays off even as slave.
    [12.288, 48000, false, 0x11, 0x6000, false],
    [12.288, 8000, false, 0x10, 0x1000, false],
    [13, 8000, true, 0x14, 0x0f20, false],
  ];

  for (const [mhz, lrclkHz, master, reg03, n, pll] of cases) {
    const source = mhz === 13 ? 'osc13' : 'osc12m288';
    const p = computeConfigure({ mclkHz: mhz * 1e6, lrclkHz, master, dacAdc: 2, source });
    const label = `${mhz}MHz / ${lrclkHz}Hz ${master ? 'master' : 'slave'}`;

    assert.equal(p.reg03, reg03, `${label}: reg 0x03`);
    assert.equal(p.n, n, `${label}: N`);
    assert.equal(p.reg05, n & 0xff, `${label}: reg 0x05`);
    assert.equal(p.usePll, pll, `${label}: PLL`);
    assert.equal(p.reg04, ((n >> 8) & 0x7f) | (pll ? 0x80 : 0), `${label}: reg 0x04`);
    assert.equal(p.reg06, master ? 0x80 : 0x00, `${label}: reg 0x06`);
    assert.equal(p.reg07, 0x09, `${label}: reg 0x07`);
    assert.equal(p.reg10, 0x0b, `${label}: reg 0x10`);
  }
});

test('N matches the datasheet table of common values', () => {
  // MAX9860 datasheet Table 4, "LRCLK Divider" — an independent check on
  // N = (65536 x 96 x fLRCLK) / fPCLK.
  const table = {
    11.2896: { 8000: 0x116a, 16000: 0x22d4, 32000: 0x45a9, 44100: 0x6000, 48000: 0x687d },
    12: { 8000: 0x1062, 16000: 0x20c5, 32000: 0x4189, 44100: 0x5a51, 48000: 0x624e },
  };
  for (const [mhz, rates] of Object.entries(table)) {
    for (const [lrclkHz, want] of Object.entries(rates)) {
      const p = computeConfigure({
        mclkHz: Number(mhz) * 1e6, lrclkHz: Number(lrclkHz), master: false, dacAdc: 2,
      });
      assert.equal(p.n, want, `${mhz}MHz / ${lrclkHz}Hz`);
      assert.equal(p.psclk, 1, `${mhz}MHz prescaler`);
    }
  }
});

test('exact integer mode needs the right PCLK and an 8k or 16k rate', () => {
  // Measured off the vendor app by pressing Configure and reading the Manual
  // panel back: FREQ, the 16kHz/AGC-fast bit and PLL, per source and rate.
  const at = (mhz, lrclkHz, master) =>
    computeConfigure({ mclkHz: mhz * 1e6, lrclkHz, master, dacAdc: 2 });

  // 13MHz master reaches integer mode at 8k and 16k, but not at 48k.
  assert.equal(at(13, 8000, true).freq, 2);
  assert.equal(at(13, 16000, true).freq, 2);
  assert.equal(at(13, 48000, true).freq, 0);

  // The app only uses integer mode as master.
  assert.equal(at(13, 8000, false).freq, 0);

  // 12.288MHz is not one of the three integer-mode frequencies.
  assert.equal(at(12.288, 8000, true).freq, 0);
});

test('register 0x03 bit 0 carries whichever meaning FREQ selects', () => {
  const at = (mhz, lrclkHz, master) =>
    computeConfigure({ mclkHz: mhz * 1e6, lrclkHz, master, dacAdc: 2 });

  // In integer mode it picks the sample rate.
  assert.equal(at(13, 8000, true).sixteen, 0);
  assert.equal(at(13, 16000, true).sixteen, 1);

  // Otherwise it is the AGC clock rate flag, set above 24kHz.
  assert.equal(at(13, 16000, false).sixteen, 0);
  assert.equal(at(13, 48000, false).sixteen, 1);
  assert.equal(at(13, 48000, true).sixteen, 1);
});

test('the PLL is chosen by the clock source, not the frequency', () => {
  // Measured by sweeping the vendor app: the 12.288MHz radio gives PLL = 0 at
  // every rate, while External with 12.288 typed into the field gives PLL = 1
  // at those same rates. So it is the source, not the number, and not whether
  // N divides exactly.
  const at = (source, mhz, lrclkHz, master) =>
    computeConfigure({ mclkHz: mhz * 1e6, lrclkHz, master, dacAdc: 2, source });

  for (const hz of [48000, 44100, 8000]) {
    assert.equal(at('osc12m288', 12.288, hz, false).usePll, false, `osc12m288 ${hz}`);
    assert.equal(at('recovered', 12.288, hz, false).usePll, false, `recovered ${hz}`);
    assert.equal(at('external', 12.288, hz, false).usePll, true, `external 12.288 ${hz}`);
    assert.equal(at('osc13', 13, hz, false).usePll, true, `osc13 ${hz}`);
  }

  // 44.1kHz off 12.288MHz is not a whole N, and the PLL still stays off.
  assert.equal(at('osc12m288', 12.288, 44100, false).exact, false);
  assert.equal(at('osc12m288', 12.288, 44100, false).usePll, false);

  // Master never raises it, whatever the source.
  for (const src of ['osc13', 'external', 'osc12m288']) {
    assert.equal(at(src, 13, 48000, true).usePll, false, src);
  }
});

test('exact integer mode is matched against MCLK, as the app does it', () => {
  // The datasheet says PCLK, so 26MHz prescaled to a 13MHz PCLK ought to
  // qualify — the app does not take it, and this matches the app. Measured:
  // External 26MHz at 8kHz and 16kHz master both give FREQ = 00.
  const at = (mhz, lrclkHz) =>
    computeConfigure({ mclkHz: mhz * 1e6, lrclkHz, master: true, dacAdc: 2, source: 'external' });
  assert.equal(at(26, 8000).psclk, 2);   // 26MHz does prescale to 13MHz
  assert.equal(at(26, 8000).pclkHz, 13e6);
  assert.equal(at(26, 8000).freq, 0);    // ...and integer mode is still declined
  assert.equal(at(26, 16000).freq, 0);
  assert.equal(at(13, 8000).freq, 2);    // while a direct 13MHz takes it
});

test('a recovered clock is 256 x Fs, and unusable below 44.1kHz', () => {
  // RMCK out of the CS8427 is 256 x Fs, so the usable rates are the two where
  // that clears the codec's 10MHz minimum.
  assert.equal(mclkForSource('recovered', 48000), 12.288e6);
  assert.equal(mclkForSource('recovered', 44100), 11.2896e6);
  assert.ok(mclkForSource('recovered', 32000) < MIN_MCLK_HZ);
  assert.ok(mclkForSource('recovered', 8000) < MIN_MCLK_HZ);

  // The fixed oscillators do not move with the rate, and External is the
  // caller's problem.
  assert.equal(mclkForSource('osc12m288', 8000), 12.288e6);
  assert.equal(mclkForSource('osc13', 48000), 13e6);
  assert.equal(mclkForSource('external', 48000), null);
});

test('Configure picks the prescaler from MCLK', () => {
  const at = (mhz) => computeConfigure({ mclkHz: mhz * 1e6, lrclkHz: 8000, master: false, dacAdc: 2 });
  assert.equal(at(8).psclk, 0);   // Disabled
  assert.equal(at(13).psclk, 1);  // 10MHz to 20MHz
  assert.equal(at(26).psclk, 2);  // 20MHz to 40MHz
  assert.equal(at(48).psclk, 3);  // >40MHz
});

// --- transaction log --------------------------------------------------------

test('the log records I2C, SPI and GPIO, tagging reads separately', async () => {
  // The vendor app logged I2C only; the SPI transfers and the GPIO writes that
  // drive the clock tree went by unrecorded. Both appear here. Reads are
  // recorded too but carry a `read` class, so the toolbar can hide them without
  // losing them from the buffer.
  const lines = [];
  const shadow = new Shadow();
  const t = new FakeTransport([
    [0xf0],                                         // K5 low
    [0xf0], [0xf0], [0xf0], [0xf0],                 // rest of the clock select
    [0xb0], [0x14, 0xb0],                           // codec write + read-back
    [0x14, 0xb0],                                   // codec read
    [0xf0], [0xff, 0xbf, 0xff, 0xbf, 0xff, 0xbf], [0xf0],  // cs write window
    [0xf0], [0xff, 0xbf, 0xff, 0xbf], [0xf0],       // read: set pointer
    [0xf0], [0xff, 0xbf, 0x48, 0xbf], [0xf0],       // read: fetch
  ]);
  const board = new Board(t, shadow, (e) => lines.push(formatLogEvent(e)));

  await board.setClockSource('osc13');
  await board.writeCodecReg(0x03, 0x14);
  await board.readCodecReg(0x03);
  await board.writeCsReg(0x04, 0x48);

  const kinds = lines.map((l) => l.split(':')[0]);
  assert.ok(kinds.includes('PinWrite'), 'GPIO writes are logged');
  assert.ok(kinds.includes('I2CWrite') && kinds.includes('I2CRead'), 'I2C both ways');
  assert.ok(kinds.includes('SPIWrite') && kinds.includes('SPIRead'), 'SPI both ways');

  // Exact shapes, so the columns stay aligned and parseable.
  assert.equal(lines.find((l) => l.startsWith('PinWrite')),
    'PinWrite: Pin = K5 (13MHz enable), Value = 0');
  assert.equal(lines.find((l) => l.startsWith('I2CWrite')),
    'I2CWrite: Address = 0x20, Register = 0x03, Data = 0x14');
  assert.equal(lines.find((l) => l.startsWith('SPIWrite')),
    'SPIWrite: Chip = CS8427, Register = 0x04, Data = 0x48');
  assert.equal(lines.find((l) => l.startsWith('SPIRead')),
    'SPIRead:  Chip = CS8427, Register = 0x04, Data = 0x48');
});

test('every read is tagged so one filter can hide all three buses', () => {
  const cls = (kind) => logClassesFor({ kind }).split(' ');

  for (const kind of ['i2c-read', 'spi-read', 'pin-read']) {
    assert.ok(cls(kind).includes('read'), `${kind} is tagged read`);
  }
  for (const kind of ['i2c-write', 'spi-write', 'pin-write']) {
    assert.ok(!cls(kind).includes('read'), `${kind} is not`);
  }

  // The bus class survives alongside it, so the two axes compose.
  assert.deepEqual(cls('i2c-read'), ['i2c', 'read']);
  assert.deepEqual(cls('spi-read'), ['spi', 'read']);
  assert.deepEqual(cls('pin-read'), ['gpio', 'read']);
  assert.deepEqual(cls('pin-write'), ['gpio']);
  assert.deepEqual(logClassesFor({ kind: 'error' }).split(' '), ['meta', 'error']);
});

test('pin reads are formatted, including the absent pins', () => {
  assert.equal(formatLogEvent({ kind: 'pin-read', pin: 2, name: 'CLK_SEL', value: 0 }),
    'PinRead:  Pin = K2 (CLK_SEL), Value = 0');
  // K13 and K14 answer FA; the board layer turns that into null.
  assert.equal(formatLogEvent({ kind: 'pin-read', pin: 13, value: null }),
    'PinRead:  Pin = K13, Value = n/a');
});

test('reading the CS8427 logs a SPIRead for every register', async () => {
  // What Read All shows for the transceiver.
  const lines = [];
  const replies = [];
  for (let i = 0; i < 6; i++) {
    replies.push([0xf0], [0xff, 0xbf, 0xff, 0xbf], [0xf0],
                 [0xf0], [0xff, 0xbf, 0x10 * (i + 1), 0xbf], [0xf0]);
  }
  const board = new Board(new FakeTransport(replies), new Shadow(),
    (e) => lines.push(formatLogEvent(e)));

  for (const r of [0x01, 0x02, 0x03, 0x04, 0x05, 0x06]) await board.readCsReg(r);

  assert.equal(lines.filter((l) => l.startsWith('SPIRead')).length, 6);
  assert.equal(lines.find((l) => l.startsWith('SPIRead')),
    'SPIRead:  Chip = CS8427, Register = 0x01, Data = 0x10');

  // The /CS windows around each transfer are framing, like an I2C start/stop,
  // and stay out of the log — otherwise 24 of them would bury everything else.
  assert.equal(lines.length, 6, 'one line per register, no chip-select noise');
});

// --- clock source is never observed half-applied --------------------------

test('a clock source change publishes one state, never the ones in between', async () => {
  // Moving between sources walks four pins, and the combinations in the middle
  // match no documented source. Publishing those made the Clock Sources radio
  // blank mid-change, so the whole sequence is batched.
  const t = new FakeTransport(Array(6).fill([0xf0]));
  const shadow = new Shadow();
  const board = new Board(t, shadow);

  // Start on 12.288MHz, the source whose intermediate states are unnameable.
  shadow.setPins([null, null, 0, 1, null, 0, 1, ...new Array(9).fill(null)]);

  const observed = [];
  shadow.addEventListener('change', () => observed.push(board.detectClockSource()));
  await board.setClockSource('osc13');

  assert.ok(observed.length > 0, 'the change is published');
  assert.ok(!observed.includes(null), `never blank, saw ${JSON.stringify(observed)}`);
  assert.equal(observed.at(-1), 'osc13');
});

test('a failed reset reports why, not what its recovery hit', async () => {
  // The recovery in reset()'s finally block re-drives the clock source. If the
  // link is properly dead that fails too, and a throw from a finally silently
  // replaces the original error — so it is caught and logged instead.
  const t = new FakeTransport([]);
  let calls = 0;
  t.transact = async () => {
    if (++calls > 4) throw new Error('link died');
    return Uint8Array.from([0xf0]);
  };
  const logged = [];
  const board = new Board(t, new Shadow(), (e) => logged.push(e));

  await assert.rejects(() => board.reset(), /link died/, 'the real cause survives');
  assert.ok(logged.some((e) => e.kind === 'error' && /restore the clock source/.test(e.text)),
    'and the recovery failure is reported rather than thrown away');
});

test('reset ends on the requested clock source', async () => {
  const replies = [];
  for (let i = 0; i < 400; i++) replies.push([0xf0]);
  const t = {
    pins: new Array(16).fill(0), cs: new Map(), codec: new Map(), map: 0,
    async transact(bytes) {
      const b = [...bytes];
      if ((b[0] & 0xf0) === 0xe0) return Uint8Array.from([this.pins[b[0] & 0x0f]]);
      if ((b[0] & 0xf0) === 0xf0) { this.pins[b[0] & 0x0f] = b[1]; return Uint8Array.from([0xf0]); }
      if (b[0] === 0xa0 && b[1] === 0x05) {
        if (b[2] === 2) { this.codec.set(b[5], b[6]); return Uint8Array.from([0xb0]); }
        return Uint8Array.from([this.codec.get(b[5]) ?? 0, 0xb0]);
      }
      const m = []; for (let i = 0; i < b.length; i += 2) m.push(b[i + 1]);
      const o = [];
      if (m[0] === 0x20) { this.map = m[1]; if (m.length >= 3) this.cs.set(this.map, m[2]); m.forEach(() => o.push(0xff, 0xbf)); }
      else { o.push(0xff, 0xbf); for (let i = 1; i < m.length; i++) o.push(this.cs.get(this.map) ?? 0, 0xbf); }
      return Uint8Array.from(o);
    },
  };
  const shadow = new Shadow();
  const board = new Board(t, shadow);

  await board.reset();
  assert.equal(board.detectClockSource(), 'osc13');

  await board.reset({ clockSource: 'osc12m288' });
  assert.equal(board.detectClockSource(), 'osc12m288');
});
