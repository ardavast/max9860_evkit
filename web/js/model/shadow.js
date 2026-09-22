// Shadow copy of everything the board holds, plus change notification.
//
// The board has no non-volatile store (docs §8), but the parts are volatile, not
// amnesiac: they keep their registers while powered. So the shadow is seeded by
// reading the hardware, never by assuming reset values, and every write updates
// it from the value actually read back.

import { CODEC_ADDRS, CS8427_REGISTERS, fieldGet, fieldSet } from './registers.js';

export class Shadow extends EventTarget {
  /** @type {Map<number, number>} codec register address -> value */
  codec = new Map();
  /** @type {Map<number, number>} CS8427 MAP -> value */
  cs = new Map();
  /** @type {Array<0|1|null>} pin states K0..K15, null = not available */
  pins = new Array(16).fill(null);

  #suppress = 0;

  /** Batch several updates into one 'change' event. */
  batch(fn) {
    this.#suppress++;
    try {
      return fn();
    } finally {
      this.#suppress--;
      if (this.#suppress === 0) this.#emit();
    }
  }

  /**
   * The same, across awaits. A multi-step hardware sequence passes through
   * states that are not meaningful on their own — changing the clock source
   * moves four pins, and the intermediate combinations match no documented
   * source — so nothing should observe it until it has landed.
   */
  async batchAsync(fn) {
    this.#suppress++;
    try {
      return await fn();
    } finally {
      this.#suppress--;
      if (this.#suppress === 0) this.#emit();
    }
  }

  #emit() {
    if (this.#suppress === 0) this.dispatchEvent(new Event('change'));
  }

  setCodec(addr, value) {
    if (this.codec.get(addr) === value) return;
    this.codec.set(addr, value);
    this.#emit();
  }

  setCs(map, value) {
    if (this.cs.get(map) === value) return;
    this.cs.set(map, value);
    this.#emit();
  }

  setPin(k, value) {
    if (this.pins[k] === value) return;
    this.pins[k] = value;
    this.#emit();
  }

  setPins(values) {
    this.batch(() => values.forEach((v, k) => this.setPin(k, v)));
  }

  /** Codec register value, or 0 when it has not been read yet. */
  reg(addr) {
    return this.codec.get(addr) ?? 0;
  }

  csReg(map) {
    return this.cs.get(map) ?? 0;
  }

  /** Current value of a named codec bitfield. */
  get(field) {
    return fieldGet(this.reg(field.reg), field);
  }

  /** What `reg` would become if `field` were set to `value`. */
  withField(field, value) {
    return fieldSet(this.reg(field.reg), field, value);
  }

  getCs(field) {
    return fieldGet(this.csReg(field.reg), field);
  }

  withCsField(field, value) {
    return fieldSet(this.csReg(field.reg), field, value);
  }

  /** True once every codec and CS8427 register has been read at least once. */
  get complete() {
    return CODEC_ADDRS.every((a) => this.codec.has(a))
      && CS8427_REGISTERS.every((r) => this.cs.has(r.addr));
  }

  clear() {
    this.codec.clear();
    this.cs.clear();
    this.pins.fill(null);
    this.#emit();
  }
}
