// MINIQUSB command module primitives.
//
// You talk to the MAXQ2000, never to the codec or transceiver directly — it
// performs the I2C and SPI cycles on your behalf.
//
// For the Ax family the acknowledgement is the command's first byte with its
// high nibble changed from A to B (A0->B0, AF->BF). Pin writes answer F0. FA is
// the error / not-available reply throughout.
//
// See docs/wire-protocol.md §3 and §4.

/** Pin indices, K0..K15. The index lives in the command byte's low nibble. */
export const PIN = {
  IRQ: 1,         // P0.0  codec interrupt, active low — input only
  CLK_SEL: 2,     // P0.1  master clock source select
  OX_SEL: 3,      // P0.2  oscillator select
  CS8427_RST: 4,  // P0.3  transceiver reset — hold high to run
  OSC_13M: 5,     // P0.4  13 MHz oscillator enable
  OSC_12M288: 6,  // P0.5  12.288 MHz oscillator enable
  CS: 9,          // P5.4  CS8427 chip select, active low — we drive this
  SCL: 10,        // P6.0  driven by the I2C commands
  SDA: 11,        // P6.1  driven by the I2C commands
  CDIN: 12,       // P5.5  driven by the SPI command
};

/** Human-readable names for the pin-state readback, indexed by K. */
export const PIN_NAMES = {
  1: 'IRQ', 2: 'CLK_SEL', 3: 'OX_SEL', 4: 'CS8427_RST',
  5: '13MHz enable', 6: '12.288MHz enable', 9: 'CS', 10: 'SCL', 11: 'SDA', 12: 'CDIN',
};

const NOT_AVAILABLE = 0xfa;
const PIN_WRITE_ACK = 0xf0;

/** K13 and K14 are simply absent on this firmware and always answer FA. */
export const ABSENT_PINS = new Set([13, 14]);

export class CommandModule {
  /**
   * @param {import('../transport/serial.js').SerialTransport} transport
   * @param {(event: object) => void} [log] pin-level log sink
   */
  constructor(transport, log = () => {}) {
    this.transport = transport;
    // Pins are logged here rather than in Board so every one shows up. The
    // exception is the chip-select framing in withChipSelect().
    this.log = log;
  }

  // --- pins -----------------------------------------------------------------

  /**
   * Read a pin. Returns 0, 1, or null when the pin is not available.
   * FA from a read means "no such pin", not a fault worth retrying.
   */
  async pinRead(k) {
    assertPin(k);
    const [v] = await this.transport.transact([0xe0 | k, 0x00], 1);
    if (v !== 0 && v !== 1 && v !== NOT_AVAILABLE) {
      throw new Error(`pin K${k} read: unexpected reply 0x${hex(v)}`);
    }
    const value = v === NOT_AVAILABLE ? null : v;
    // Recorded, but the log hides reads unless the Reads filter is ticked —
    // sixteen pin reads per Read All would otherwise bury the writes.
    this.log({ kind: 'pin-read', pin: k, name: PIN_NAMES[k], value });
    return value;
  }

  /** Read every pin at once. Returns an array of 16 values (0, 1 or null). */
  async pinReadAll() {
    const out = [];
    for (let k = 0; k < 16; k++) out.push(await this.pinRead(k));
    return out;
  }

  async pinWrite(k, value) {
    const v = await this.#pinWriteRaw(k, value);
    this.log({ kind: 'pin-write', pin: k, name: PIN_NAMES[k], value: v });
  }

  async #pinWriteRaw(k, value) {
    assertPin(k);
    // K1 is the codec's interrupt *output*. The firmware will happily accept a
    // write and you would be driving against a live output.
    if (k === PIN.IRQ) throw new Error('K1 (IRQ) is an input — refusing to drive it');
    const v = value ? 1 : 0;
    const [ack] = await this.transport.transact([0xf0 | k, v], 1);
    if (ack !== PIN_WRITE_ACK) throw new Error(`pin K${k} write: got 0x${hex(ack)}, expected 0xF0`);
    return v;
  }

  // --- I2C ------------------------------------------------------------------

  /**
   * One whole write-then-read transaction, the usual way in.
   *
   *   A0 05 <wn> <rn> <addr> <data...>  ->  <read...> B0
   *
   * `addr` is the eight-bit form, already shifted (0x20 for the codec).
   * A device that does not acknowledge yields FA in place of the data.
   */
  async i2cWriteRead(addr, writeBytes = [], readCount = 0) {
    const w = Uint8Array.from(writeBytes);
    const cmd = [0xa0, 0x05, w.length, readCount, addr, ...w];
    const reply = await this.transport.transact(cmd, readCount + 1);

    const status = reply[readCount];
    if (status !== 0xb0) {
      throw new Error(`i2c 0x${hex(addr)}: got 0x${hex(status)}, expected 0xB0`);
    }
    const data = reply.slice(0, readCount);
    if (data.includes(NOT_AVAILABLE)) {
      throw new Error(`i2c 0x${hex(addr)}: device did not acknowledge`);
    }
    return data;
  }

  /** Probe for a device. This is what the vendor app polls continuously. */
  async i2cPresent(addr) {
    const [v] = await this.transport.transact([0xa0, 0x03, addr], 1);
    if (v === 0xb0) return true;
    if (v === NOT_AVAILABLE) return false;
    throw new Error(`i2c probe 0x${hex(addr)}: unexpected reply 0x${hex(v)}`);
  }

  /** Fixed 3-byte reply on this firmware: BF 01 B0. */
  async capabilities() {
    return await this.transport.transact([0xa0, 0x02], 3);
  }

  // --- SPI ------------------------------------------------------------------

  /**
   * Transfer bytes on the hardware SPI, one `AF <mosi>` command per byte.
   *
   * Several are pipelined into a single write — a write is not a command
   * boundary — so the reply is one `<miso> BF` pair per byte sent.
   * Chip select is NOT automatic; bracket these with withChipSelect().
   */
  async spiTransfer(mosiBytes) {
    const bytes = Uint8Array.from(mosiBytes);
    const cmd = [];
    for (const b of bytes) cmd.push(0xaf, b);

    const reply = await this.transport.transact(cmd, bytes.length * 2);
    const miso = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      miso[i] = reply[i * 2];
      const ack = reply[i * 2 + 1];
      if (ack !== 0xbf) throw new Error(`spi byte ${i}: got 0x${hex(ack)}, expected 0xBF`);
    }
    return miso;
  }

  /**
   * Run `fn` with /CS asserted, releasing it even if `fn` throws.
   *
   * These two writes are deliberately not logged. /CS is the SPI equivalent of
   * an I2C start/stop condition — pure framing — and the I2C lines do not log
   * their framing either. Logging it buries the GPIO writes that carry meaning:
   * a whole-board read produced 24 chip-select lines against 5 clock-tree ones.
   */
  async withChipSelect(fn) {
    await this.#pinWriteRaw(PIN.CS, 0);
    try {
      return await fn();
    } finally {
      await this.#pinWriteRaw(PIN.CS, 1);
    }
  }
}

function assertPin(k) {
  if (!Number.isInteger(k) || k < 0 || k > 15) {
    throw new Error(`pin index must be K0..K15, got ${k}`);
  }
}

export function hex(v, width = 2) {
  return v.toString(16).toUpperCase().padStart(width, '0');
}
