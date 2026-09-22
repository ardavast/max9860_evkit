// Web Serial transport for the MINIQUSB command module.
//
// The link is strict request/response: write a command, read a fixed number of
// reply bytes. There is no framing, no length prefix and no terminator, so the
// only way to stay in sync is to consume exactly as many bytes as the command
// promises. Every exchange therefore goes through one serialized queue.
//
// See docs/wire-protocol.md §2.

const BAUD = 460800;

// The module emits this unprompted on port open: 26 bytes, no terminator. If it
// is not drained it turns up glued to the front of the first command's reply.
const BANNER = 'Maxim MINIQUSB V01.05.39 >';

// Sending 0xA9 puts the firmware into a continuous ASCII echo that saturates the
// link and only stops on port close/reopen. Nothing above this layer has any
// reason to send it, so refuse it here rather than trusting callers.
const FORBIDDEN_COMMAND = 0xa9;

export class SerialTransport {
  #port = null;
  #reader = null;
  #writer = null;
  #pending = Promise.resolve(); // serializes transact() calls
  #rx = new Uint8Array(0); // bytes read but not yet consumed
  #onTraffic = null;

  /** @param {(dir: 'tx'|'rx', bytes: Uint8Array) => void} [onTraffic] raw byte tap */
  constructor(onTraffic) {
    this.#onTraffic = onTraffic ?? null;
  }

  static get supported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  get connected() {
    return this.#port !== null;
  }

  /**
   * Prompt for a port and open it. Must be called from a user gesture.
   * Returns the banner text if one was seen, else null.
   */
  async connect() {
    if (this.#port) throw new Error('already connected');
    if (!SerialTransport.supported) {
      throw new Error('Web Serial is unavailable — use Chrome or Edge over https or http://localhost');
    }

    // Filter to the FT232 on the EV kit, but allow anything through the "show
    // all" escape hatch the browser offers, in case of a re-flashed descriptor.
    const port = await navigator.serial.requestPort({
      filters: [{ usbVendorId: 0x0403, usbProductId: 0x6001 }],
    });

    // DTR/RTS polarity matters here: the vendor app exposes a "DTR High = Reset"
    // option, so asserting them (which is the common default) can hold the
    // MAXQ2000 in reset.
    await port.open({
      baudRate: BAUD,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
    });
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });

    this.#port = port;
    this.#reader = port.readable.getReader();
    this.#writer = port.writable.getWriter();
    this.#rx = new Uint8Array(0);

    return await this.#drainBanner();
  }

  async disconnect() {
    if (!this.#port) return;
    const port = this.#port;
    this.#port = null;

    try {
      await this.#reader?.cancel();
    } catch { /* the port may already be gone */ }
    try {
      this.#reader?.releaseLock();
    } catch { /* ignore */ }
    try {
      this.#writer?.releaseLock();
    } catch { /* ignore */ }
    this.#reader = null;
    this.#writer = null;
    this.#rx = new Uint8Array(0);

    await port.close();
  }

  /**
   * Write `bytes`, then read exactly `replyLen` bytes back.
   *
   * Commands may be batched inside a single write — a CS8427 register write goes
   * out as `AF 20 AF 04 AF 48` and comes back as `FF BF FF BF FF BF`. Callers
   * pass the total reply length for the whole batch; a write is not a command
   * boundary.
   *
   * @param {ArrayLike<number>} bytes
   * @param {number} replyLen
   * @param {number} [timeoutMs]
   * @returns {Promise<Uint8Array>}
   */
  transact(bytes, replyLen, timeoutMs = 1000) {
    const run = async () => {
      const tx = Uint8Array.from(bytes);
      // Checked before the connection state: sending this is a programming
      // error either way, and refusing early keeps it testable without a port.
      if (tx.includes(FORBIDDEN_COMMAND)) {
        throw new Error('refusing to send 0xA9 — it starts an unstoppable echo mode');
      }
      if (!this.#port) throw new Error('not connected');

      this.#onTraffic?.('tx', tx);
      await this.#writer.write(tx);

      if (replyLen === 0) return new Uint8Array(0);
      const rx = await this.#read(replyLen, timeoutMs);
      this.#onTraffic?.('rx', rx);
      return rx;
    };

    // Chain onto the queue, and keep the queue alive across failures so one bad
    // command does not wedge every later one.
    const result = this.#pending.then(run, run);
    this.#pending = result.then(() => {}, () => {});
    return result;
  }

  /**
   * Read exactly `n` bytes, with a deadline fixed at entry.
   *
   * The deadline is deliberately not extended on each arriving byte: the module
   * can stream continuously (see 0xA9), and a self-extending loop never exits.
   */
  async #read(n, timeoutMs) {
    const deadline = performance.now() + timeoutMs;

    while (this.#rx.length < n) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        const got = this.#rx.length;
        this.#rx = new Uint8Array(0); // resync: a partial reply is unusable
        throw new Error(`timed out reading ${n} bytes (got ${got})`);
      }

      const chunk = await this.#readChunk(remaining);
      if (chunk === null) throw new Error('port closed while reading');
      this.#append(chunk);
    }

    const out = this.#rx.slice(0, n);
    this.#rx = this.#rx.slice(n);
    return out;
  }

  /** One reader.read() bounded by `ms`. Resolves null on stream close. */
  async #readChunk(ms) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms);
    });
    try {
      const winner = await Promise.race([this.#reader.read(), timeout]);
      if (winner === 'timeout') return new Uint8Array(0);
      return winner.done ? null : winner.value;
    } finally {
      clearTimeout(timer);
    }
  }

  #append(chunk) {
    if (chunk.length === 0) return;
    const merged = new Uint8Array(this.#rx.length + chunk.length);
    merged.set(this.#rx, 0);
    merged.set(chunk, this.#rx.length);
    this.#rx = merged;
  }

  /**
   * Swallow the open banner. It has no terminator, so read until the line goes
   * quiet rather than waiting for a fixed count — a board that was already open
   * emits nothing at all, and that is not an error.
   */
  async #drainBanner() {
    const deadline = performance.now() + 300;
    while (performance.now() < deadline) {
      const chunk = await this.#readChunk(Math.max(0, deadline - performance.now()));
      if (chunk === null) break;
      this.#append(chunk);
      if (this.#rx.length >= BANNER.length) break;
    }

    const text = new TextDecoder().decode(this.#rx);
    this.#rx = new Uint8Array(0);
    return text.length ? text.trim() : null;
  }
}
