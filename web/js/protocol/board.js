// Board-level operations: clock tree, whole-board read, reset, bring-up.
//
// Everything here keeps the Shadow in step with what was actually read back, so
// the UI never displays a value that was merely requested.

import { CommandModule, PIN } from './cmod.js';
import { Max9860, CODEC_ADDR } from './max9860.js';
import { Cs8427 } from './cs8427.js';
import { CODEC_ADDRS, CODEC_REGISTERS, CS8427_REGISTERS, fieldSet } from '../model/registers.js';

/**
 * Clock source -> pin states, measured by reading back all sixteen pins
 * (docs §5). The '157 mux datasheet would predict the opposite polarity for
 * both selects; this table is what the hardware actually does.
 *
 * "External" is not a mux position — it is the 13 MHz select state with both
 * oscillators tri-stated, so a source patched in at JU8 row 5 meets no active
 * driver. Selecting it in software does nothing on its own; the jumper is the
 * actual change.
 */
export const CLOCK_SOURCES = {
  recovered: { label: 'Recovered Master Clock', clkSel: 1, oxSel: 0, osc13: 0, osc12m288: 0 },
  osc12m288: { label: '12.288MHz', clkSel: 0, oxSel: 1, osc13: 0, osc12m288: 1 },
  osc13: { label: '13MHz', clkSel: 0, oxSel: 0, osc13: 1, osc12m288: 0 },
  external: { label: 'External', clkSel: 0, oxSel: 0, osc13: 0, osc12m288: 0 },
};

export class Board {
  /**
   * @param {import('../transport/serial.js').SerialTransport} transport
   * @param {import('../model/shadow.js').Shadow} shadow
   * @param {(event: object) => void} [log] API-level transaction log sink
   */
  constructor(transport, shadow, log = () => {}) {
    this.sink = log;
    this.cmod = new CommandModule(transport, (e) => this.log(e));
    this.codec = new Max9860(this.cmod);
    this.cs = new Cs8427(this.cmod);
    this.shadow = shadow;
    /** Suppresses log output — set while polling, which would otherwise flood it. */
    this.silent = false;
  }

  log(event) {
    if (!this.silent) this.sink(event);
  }

  /** Run `fn` without writing to the transaction log. */
  async quietly(fn) {
    this.silent = true;
    try {
      return await fn();
    } finally {
      this.silent = false;
    }
  }

  // --- clock tree -----------------------------------------------------------

  /** Which CLOCK_SOURCES key the pins currently describe, or null if none match. */
  detectClockSource() {
    const p = this.shadow.pins;
    for (const [key, s] of Object.entries(CLOCK_SOURCES)) {
      if (p[PIN.CLK_SEL] === s.clkSel && p[PIN.OX_SEL] === s.oxSel
        && p[PIN.OSC_13M] === s.osc13 && p[PIN.OSC_12M288] === s.osc12m288) {
        return key;
      }
    }
    return null;
  }

  /**
   * Select the master clock. Both oscillators go quiet before the selects move,
   * so the mux never sees two active drivers, and only one enable comes back up.
   */
  async setClockSource(key) {
    const s = CLOCK_SOURCES[key];
    if (!s) throw new Error(`unknown clock source: ${key}`);

    // Batched, so the UI never sees the half-moved states in the middle. Going
    // to or from 12.288MHz passes through pin combinations that match no source
    // at all, which showed up as the Clock Sources radio blanking mid-change.
    await this.shadow.batchAsync(async () => {
      await this.#writePin(PIN.OSC_13M, 0);
      await this.#writePin(PIN.OSC_12M288, 0);
      await this.#writePin(PIN.CLK_SEL, s.clkSel);
      await this.#writePin(PIN.OX_SEL, s.oxSel);
      if (s.osc13) await this.#writePin(PIN.OSC_13M, 1);
      if (s.osc12m288) await this.#writePin(PIN.OSC_12M288, 1);
    });
  }

  async #writePin(k, v) {
    await this.cmod.pinWrite(k, v);   // logs it
    this.shadow.setPin(k, v);
  }

  async setTransceiverReset(held) {
    await this.#writePin(PIN.CS8427_RST, held ? 0 : 1);
  }

  async readPins() {
    const pins = await this.cmod.pinReadAll();
    this.shadow.setPins(pins);
    return pins;
  }

  // --- register access, shadow-aware ---------------------------------------

  async readCodecReg(addr) {
    const v = await this.codec.read(addr);
    this.log({ kind: 'i2c-read', addr: CODEC_ADDR, reg: addr, value: v });
    this.shadow.setCodec(addr, v);
    return v;
  }

  async writeCodecReg(addr, value) {
    this.log({ kind: 'i2c-write', addr: CODEC_ADDR, reg: addr, value: value & 0xff });
    const got = await this.codec.write(addr, value);
    this.log({ kind: 'i2c-read', addr: CODEC_ADDR, reg: addr, value: got });
    this.shadow.setCodec(addr, got);
    return got;
  }

  /** Set a named codec bitfield, preserving every other bit in the register. */
  async writeField(field, value) {
    const next = fieldSet(this.shadow.reg(field.reg), field, value);
    return await this.writeCodecReg(field.reg, next);
  }

  /** Set several codec bitfields at once, coalescing writes per register. */
  async writeFields(pairs) {
    const byReg = new Map();
    for (const [field, value] of pairs) {
      const base = byReg.get(field.reg) ?? this.shadow.reg(field.reg);
      byReg.set(field.reg, fieldSet(base, field, value));
    }
    for (const [addr, value] of byReg) await this.writeCodecReg(addr, value);
  }

  async readCsReg(map) {
    const v = await this.cs.read(map);
    this.log({ kind: 'spi-read', reg: map, value: v });
    this.shadow.setCs(map, v);
    return v;
  }

  async writeCsReg(map, value) {
    this.log({ kind: 'spi-write', reg: map, value: value & 0xff });
    const got = await this.cs.writeVerified(map, value);
    this.log({ kind: 'spi-read', reg: map, value: got });
    this.shadow.setCs(map, got);
    return got;
  }

  async writeCsField(field, value) {
    const next = fieldSet(this.shadow.csReg(field.reg), field, value);
    return await this.writeCsReg(field.reg, next);
  }

  // --- whole-board operations ----------------------------------------------

  /**
   * Read everything: pins, codec registers, transceiver registers.
   *
   * This is what connecting does. Nothing is stored on the board, so all of its
   * state is recoverable by reading — which means attaching to a running board
   * without disturbing it. Reset stays an explicit, separate action.
   */
  async readAll() {
    await this.readPins();
    for (const addr of CODEC_ADDRS) await this.readCodecReg(addr);
    for (const r of CS8427_REGISTERS) await this.readCsReg(r.addr);
  }

  /**
   * Cold configuration to a known, working state.
   *
   * This deliberately does NOT copy the vendor's ordering. The vendor Reset
   * writes all six CS8427 registers while K4 is still low, raises K4 afterwards
   * and never rewrites them — so those writes went into a part held in reset.
   * Here the transceiver is released first, then configured.
   */
  async reset({ clockSource = 'osc13' } = {}) {
    try {
      await this.#resetSequence();
    } finally {
      // However that went, leave the clock tree somewhere nameable and re-read
      // the pins. A reset that failed part way used to strand them in a
      // combination matching no source, which left the UI with nothing selected.
      //
      // Guarded, because recovery must never replace the error that caused it —
      // a throw from a finally block silently discards the original.
      try {
        await this.setClockSource(clockSource);
        await this.readPins();
      } catch (err) {
        this.log({ kind: 'error', text: `could not restore the clock source: ${err.message}` });
      }
    }
  }

  async #resetSequence() {
    // Selects quiet and both oscillators off while we work.
    await this.setClockSource('external');

    // Release the transceiver, and park chip select so the first SPI transfer
    // has a clean edge.
    await this.setTransceiverReset(false);
    await this.cs.parkChipSelect();
    this.shadow.setPin(PIN.CS, 1);

    // Transceiver defaults — now that K4 is high and the part can accept them.
    for (const r of CS8427_REGISTERS) await this.writeCsReg(r.addr, r.reset);

    // Codec defaults, each verified by read-back. 0x10 comes last so the part
    // stays shut down until clocks and format are set.
    for (const r of CODEC_REGISTERS) {
      if (r.readOnly || r.addr === 0x10) continue;
      await this.writeCodecReg(r.addr, r.reset);
    }
    await this.writeCodecReg(0x10, 0x00);
  }

  /** Confirm the codec is on the bus. B0 back means the bus is good. */
  async probeCodec() {
    return await this.codec.present();
  }
}
