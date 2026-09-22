// MAX9860 codec register access over the command module's I2C bridge.
//
// The codec answers at 0x20 — the eight-bit form, already shifted, exactly as it
// goes into the command. One command carries the whole transaction.
//
// See docs/wire-protocol.md §6.

import { hex } from './cmod.js';

export const CODEC_ADDR = 0x20;

export class Max9860 {
  /** @param {import('./cmod.js').CommandModule} cmod */
  constructor(cmod) {
    this.cmod = cmod;
  }

  async present() {
    return await this.cmod.i2cPresent(CODEC_ADDR);
  }

  /** Read one register. */
  async read(reg) {
    const [v] = await this.cmod.i2cWriteRead(CODEC_ADDR, [reg], 1);
    return v;
  }

  /** Read `count` consecutive registers starting at `reg`. */
  async readBurst(reg, count) {
    return await this.cmod.i2cWriteRead(CODEC_ADDR, [reg], count);
  }

  /**
   * Write one register and read it straight back.
   *
   * B0 only tells you the bus cycle completed, so the read-back is the only
   * confirmation the write actually landed. The vendor software does this for
   * every write and it is worth copying.
   *
   * Returns the value read back. Throws if it disagrees with what was written,
   * except for registers listed as not reading back what you wrote.
   */
  async write(reg, value, { verify = true } = {}) {
    await this.cmod.i2cWriteRead(CODEC_ADDR, [reg, value & 0xff], 0);
    if (!verify) return value & 0xff;

    const got = await this.read(reg);
    if (got !== (value & 0xff)) {
      throw new Error(
        `codec reg 0x${hex(reg)}: wrote 0x${hex(value & 0xff)}, read back 0x${hex(got)}`,
      );
    }
    return got;
  }

  /** Read-modify-write a masked field, preserving the other bits. */
  async updateBits(reg, mask, value) {
    const current = await this.read(reg);
    const next = (current & ~mask) | (value & mask);
    if (next === current) return current;
    return await this.write(reg, next);
  }
}
