// CS8427 S/PDIF transceiver register access over SPI.
//
// The control port sits on the MAXQ2000's hardware SPI, but chip select is not
// automatic — it is plain GPIO on K9 and we bracket the transfer ourselves.
//
// See docs/wire-protocol.md §7.

import { PIN, hex } from './cmod.js';

const CHIP_WRITE = 0x20;
const CHIP_READ = 0x21;

/** Bit 7 of MAP auto-increments the register pointer across a burst. */
const MAP_INCREMENT = 0x80;

export class Cs8427 {
  /** @param {import('./cmod.js').CommandModule} cmod */
  constructor(cmod) {
    this.cmod = cmod;
  }

  /** Hold the transceiver out of reset. A low here leaves the part held down. */
  async setReset(held) {
    await this.cmod.pinWrite(PIN.CS8427_RST, held ? 0 : 1);
  }

  /** Park chip select high so the first transfer has a clean edge. */
  async parkChipSelect() {
    await this.cmod.pinWrite(PIN.CS, 1);
  }

  /** Framing is chip byte, MAP, then data, all inside one /CS window. */
  async write(map, value) {
    await this.cmod.withChipSelect(() =>
      this.cmod.spiTransfer([CHIP_WRITE, map & 0xff, value & 0xff]),
    );
  }

  /**
   * Read one register. This takes two transactions, not one.
   *
   * Putting the read chip byte, MAP and a dummy in a single /CS window returns
   * zeros. The register pointer has to be set by its own write transaction
   * first, then read in a second one.
   */
  async read(map) {
    // 1. address: chip byte + MAP, no data.
    await this.cmod.withChipSelect(() => this.cmod.spiTransfer([CHIP_WRITE, map & 0xff]));

    // 2. read: chip byte + one dummy. MISO during the chip-address byte is
    //    always 0xFF (the bus idles high); the value arrives on the next byte.
    const miso = await this.cmod.withChipSelect(() =>
      this.cmod.spiTransfer([CHIP_READ, 0x00]),
    );
    return miso[1];
  }

  /** Read `count` consecutive registers using the MAP auto-increment bit. */
  async readBurst(map, count) {
    await this.cmod.withChipSelect(() =>
      this.cmod.spiTransfer([CHIP_WRITE, (map & 0xff) | MAP_INCREMENT]),
    );
    const miso = await this.cmod.withChipSelect(() =>
      this.cmod.spiTransfer([CHIP_READ, ...new Array(count).fill(0x00)]),
    );
    return miso.slice(1);
  }

  /** Write then read straight back, same discipline as the codec. */
  async writeVerified(map, value) {
    await this.write(map, value);
    const got = await this.read(map);
    if (got !== (value & 0xff)) {
      throw new Error(
        `cs8427 reg 0x${hex(map)}: wrote 0x${hex(value & 0xff)}, read back 0x${hex(got)}`,
      );
    }
    return got;
  }

  async updateBits(map, mask, value) {
    const current = await this.read(map);
    const next = (current & ~mask) | (value & mask);
    if (next === current) return current;
    return await this.writeVerified(map, next);
  }
}
