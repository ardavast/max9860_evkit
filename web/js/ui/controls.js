// Bound control factories.
//
// Every control names a bitfield from model/registers.js. Changing the control
// does a read-modify-write on that field; a change to the shadow (from Read All,
// polling, or someone editing the raw hex on the Registers tab) pushes back into
// the control. That is why the semantic tabs and the register grid stay in sync.

import { el, hex, parseByte } from './dom.js';

export class Binder {
  #syncs = [];
  #applying = false;

  /**
   * @param {import('../protocol/board.js').Board} board
   * @param {import('../model/shadow.js').Shadow} shadow
   * @param {(err: Error) => void} onError
   */
  constructor(board, shadow, onError) {
    this.board = board;
    this.shadow = shadow;
    this.onError = onError;
    shadow.addEventListener('change', () => this.syncAll());
  }

  syncAll() {
    // Guard against a write's own read-back bouncing straight back into the
    // control the user is still interacting with.
    if (this.#applying) return;
    for (const fn of this.#syncs) fn();
  }

  #register(fn) {
    this.#syncs.push(fn);
    fn();
  }

  /** Run a board write, surfacing failures without breaking the UI. */
  async #apply(fn) {
    // Nothing to write to yet: snap the control back rather than logging a
    // "not connected" error for every stray click.
    if (!this.board.cmod.transport.connected) {
      this.syncAll();
      return;
    }
    this.#applying = true;
    try {
      await fn();
    } catch (err) {
      this.onError(err);
    } finally {
      this.#applying = false;
      this.syncAll();
    }
  }

  // --- codec-field controls -------------------------------------------------

  /** Single-bit checkbox. `note` marks a mapping that is not yet verified. */
  checkbox(label, field, { note = null, activeWhen = null } = {}) {
    const input = el('input', {
      type: 'checkbox',
      onchange: () => this.#apply(() => this.board.writeField(field, input.checked ? 1 : 0)),
    });
    this.#register(() => {
      const active = activeWhen ? activeWhen() : true;
      input.disabled = !active;
      // The vendor app shows the inactive view of a shared bit as unchecked
      // rather than mirroring the bit into both boxes.
      input.checked = active && this.shadow.get(field) === 1;
    });
    return el('label.check', input, el('span', label), note ? unverified(note) : null);
  }

  /** Drop-down where the option index is the field value. */
  select(label, field, options, { note = null, activeWhen = null } = {}) {
    const sel = el('select', {
      onchange: () => this.#apply(() => this.board.writeField(field, sel.selectedIndex)),
    }, options.map((o) => el('option', o)));
    this.#register(() => {
      sel.disabled = activeWhen ? !activeWhen() : false;
      sel.selectedIndex = this.shadow.get(field);
    });
    return el('label.field',
      el('span.field-label', label, note ? unverified(note) : null),
      sel);
  }

  /** Drop-down over a CS8427 field rather than a codec field. */
  csSelect(label, field, options) {
    const sel = el('select', {
      onchange: () => this.#apply(() => this.board.writeCsField(field, sel.selectedIndex)),
    }, options.map((o) => el('option', o)));
    this.#register(() => { sel.selectedIndex = Math.min(options.length - 1, this.shadow.getCs(field)); });
    return el('label.field', el('span.field-label', label), sel);
  }

  /** Radio group where the option index is the field value. */
  radioGroup(title, field, options, { note = null } = {}) {
    const name = `r${Math.random().toString(36).slice(2)}`;
    const inputs = options.map((text, i) => {
      const input = el('input', {
        type: 'radio', name,
        onchange: () => { if (input.checked) this.#apply(() => this.board.writeField(field, i)); },
      });
      return { input, node: el('label.check', input, el('span', text)) };
    });
    this.#register(() => {
      const v = this.shadow.get(field);
      inputs.forEach((r, i) => { r.input.checked = i === v; });
    });
    return el('section.group',
      el('h3.group-title', title, note ? unverified(note) : null),
      el('div.group-body.radio-list', inputs.map((r) => r.node)));
  }

  /** Radio group backed by something other than a register field. */
  customRadio(title, options, get, set, onPick = null) {
    const name = `r${Math.random().toString(36).slice(2)}`;
    const inputs = options.map(({ key, label }) => {
      const input = el('input', {
        type: 'radio', name,
        onchange: () => {
          if (!input.checked) return;
          // Runs whether or not a board is attached; the write may not.
          onPick?.(key);
          this.#apply(() => set(key));
        },
      });
      return { key, input, node: el('label.check', input, el('span', label)) };
    });
    this.#register(() => {
      const v = get();
      inputs.forEach((r) => { r.input.checked = r.key === v; });
    });
    return el('section.group',
      el('h3.group-title', title),
      el('div.group-body.radio-list', inputs.map((r) => r.node)));
  }

  /**
   * Slider over a field, with a live dB readout.
   *
   * Vertical sliders put field value 0 at the top, matching the vendor app —
   * all four of its vertical sliders label the top as the maximum level, which
   * is field value 0.
   *
   * @param {object} o
   * @param {string} o.label
   * @param {object} o.field
   * @param {number} o.max         highest usable field value
   * @param {(v:number)=>string} o.format   field value -> readout text
   * @param {(db:number)=>number} [o.parse] readout text -> field value
   * @param {boolean} [o.vertical]
   * @param {string} [o.topLabel] @param {string} [o.bottomLabel]
   * @param {string[]} [o.scale]   tick labels for a horizontal slider
   */
  slider(o) {
    const vertical = o.vertical ?? true;
    const range = el('input', {
      type: 'range', min: 0, max: o.max, step: 1,
      class: vertical ? 'range-v' : 'range-h',
      oninput: () => { readout.value = o.format(fromRange(+range.value)); },
      onchange: () => this.#apply(() => this.board.writeField(o.field, fromRange(+range.value))),
    });
    const fromRange = (v) => (vertical ? o.max - v : v);
    const toRange = (v) => (vertical ? o.max - v : v);

    const readout = el('input.readout', {
      type: 'text',
      onchange: () => {
        const v = o.parse ? o.parse(readout.value) : null;
        if (v === null || !Number.isInteger(v)) { this.syncAll(); return; }
        const clamped = Math.min(o.max, Math.max(0, v));
        this.#apply(() => this.board.writeField(o.field, clamped));
      },
    });

    this.#register(() => {
      const v = Math.min(o.max, this.shadow.get(o.field));
      range.value = toRange(v);
      readout.value = o.format(v);
    });

    if (!vertical) {
      return el('div.slider-h',
        el('span.slider-h-label', o.label),
        el('div.slider-h-body',
          range,
          o.scale ? el('div.scale', o.scale.map((s) => el('span', s))) : null));
    }

    return el('div.slider-v',
      el('div.slider-v-title', o.label),
      el('div.slider-v-body',
        withTicks(range, o.max, true),
        el('div.slider-v-marks',
          el('span.mark-top', o.topLabel ?? ''),
          el('span.mark-bottom', o.bottomLabel ?? ''))),
      el('div.readout-row', readout, el('span.unit', 'dB')));
  }

  /** Read-only indicator bar, e.g. AGC Gain and Noise Gate Attenuation. */
  bar(o) {
    const fill = el('div.bar-fill');
    const value = el('span.bar-value');
    this.#register(() => {
      const v = Math.min(o.max, this.shadow.get(o.field));
      fill.style.width = `${(o.fraction ? o.fraction(v) : v / o.max) * 100}%`;
      value.textContent = o.format(v);
    });
    return el('div.bar-block',
      el('div.bar-title', o.label, o.note ? unverified(o.note) : null),
      el('div.bar-row', el('div.bar', fill), value),
      el('div.scale.scale-ends', el('span', o.minLabel), el('span', o.maxLabel)));
  }

  /** Read-only lamp for a status bit, with an optional interrupt-enable box. */
  statusLamp(label, statusField, enableField) {
    const lamp = el('span.lamp');
    const input = el('input', {
      type: 'checkbox',
      onchange: () => this.#apply(() => this.board.writeField(enableField, input.checked ? 1 : 0)),
    });
    this.#register(() => {
      input.checked = this.shadow.get(enableField) === 1;
      lamp.classList.toggle('on', this.shadow.get(statusField) === 1);
    });
    return el('label.check.status-item', input, lamp, el('span', label));
  }

  // --- gated fields ---------------------------------------------------------

  /**
   * Several "Enable X" boxes in the vendor app are not dedicated bits — the
   * field itself encodes off. Captured: enabling Sidetone with the level slider
   * at 0 writes DVST=1; enabling the Microphone writes PAM=1; enabling the Noise
   * Gate writes ANTH=1; enabling AGC writes HLD=1. In each case 0 means off and
   * the usable settings start at 1, and the app writes nothing at all while the
   * control is disabled.
   *
   * A Gate holds the level the user last chose so it survives a disable/enable
   * round trip, exactly as the vendor app's controls do.
   */
  gate(field) {
    return new Gate(this, field);
  }

  gateCheckbox(label, gate) {
    const input = el('input', {
      type: 'checkbox',
      onchange: () => this.#apply(() => gate.setEnabled(input.checked)),
    });
    this.#register(() => { input.checked = gate.enabled; });
    return el('label.check', input, el('span', label));
  }

  /**
   * Vertical slider over a gated field. Level 0 sits at the top, matching the
   * vendor app. Writes only reach the board while the gate is enabled; while it
   * is off the level is remembered and applied on the next enable.
   */
  gateSlider(o) {
    const range = el('input.range-v', {
      type: 'range', min: 0, max: o.max, step: 1,
      oninput: () => { readout.value = o.format(o.max - +range.value); },
      onchange: () => this.#apply(() => o.gate.setLevel(o.max - +range.value)),
    });
    const readout = el('input.readout', {
      type: 'text',
      onchange: () => {
        const level = o.parse ? o.parse(readout.value) : null;
        if (level === null) { this.syncAll(); return; }
        this.#apply(() => o.gate.setLevel(Math.min(o.max, Math.max(0, level))));
      },
    });

    this.#register(() => {
      const level = Math.min(o.max, o.gate.level);
      range.value = o.max - level;
      readout.value = o.format(level);
    });

    return el('div.slider-v',
      el('div.slider-v-title', o.label),
      el('div.slider-v-body',
        withTicks(range, o.max, true),
        el('div.slider-v-marks',
          el('span.mark-top', o.topLabel ?? ''),
          el('span.mark-bottom', o.bottomLabel ?? ''))),
      el('div.readout-row', readout, el('span.unit', 'dB')));
  }

  /** Drop-down over a gated field, e.g. AGC Hold Time and MIC Preamp Gain. */
  gateSelect(label, gate, options) {
    const sel = el('select', {
      onchange: () => this.#apply(() => gate.setLevel(sel.selectedIndex)),
    }, options.map((o) => el('option', o)));
    this.#register(() => {
      sel.selectedIndex = Math.min(options.length - 1, gate.level);
      sel.disabled = !gate.enabled;
    });
    return el('label.field', el('span.field-label', label), sel);
  }

  /** Horizontal stepped slider over a gated field, e.g. MIC Preamp Gain. */
  gateScale(label, gate, scale) {
    const range = el('input.range-h', {
      type: 'range', min: 0, max: scale.length - 1, step: 1,
      onchange: () => this.#apply(() => gate.setLevel(+range.value)),
    });
    this.#register(() => {
      range.value = Math.min(scale.length - 1, gate.level);
      range.disabled = !gate.enabled;
    });
    return el('div.slider-h',
      el('span.slider-h-label', label),
      el('div.slider-h-body',
        withTicks(range, scale.length - 1, false),
        el('div.scale', scale.map((s) => el('span', s)))));
  }

  /** Plain horizontal stepped slider over an ordinary field. */
  scaleSlider(label, field, scale) {
    const range = el('input.range-h', {
      type: 'range', min: 0, max: scale.length - 1, step: 1,
      onchange: () => this.#apply(() => this.board.writeField(field, +range.value)),
    });
    this.#register(() => { range.value = Math.min(scale.length - 1, this.shadow.get(field)); });
    return el('div.slider-h',
      el('span.slider-h-label', label),
      el('div.slider-h-body',
        withTicks(range, scale.length - 1, false),
        el('div.scale', scale.map((s) => el('span', s)))));
  }

  // --- raw register controls ------------------------------------------------

  /** Editable hex byte for one codec register. */
  hexInput(addr, { readOnly = false } = {}) {
    const input = el('input.hex', {
      type: 'text', readOnly, spellcheck: false,
      onchange: () => {
        const v = parseByte(input.value);
        if (v === null) { this.syncAll(); return; }
        this.#apply(() => this.board.writeCodecReg(addr, v));
      },
    });
    this.#register(() => {
      input.value = this.shadow.codec.has(addr) ? hex(this.shadow.reg(addr)) : '--';
    });
    return input;
  }

  /** Editable hex byte for one CS8427 register. */
  csHexInput(map) {
    const input = el('input.hex', {
      type: 'text', spellcheck: false,
      onchange: () => {
        const v = parseByte(input.value);
        if (v === null) { this.syncAll(); return; }
        this.#apply(() => this.board.writeCsReg(map, v));
      },
    });
    this.#register(() => {
      input.value = this.shadow.cs.has(map) ? hex(this.shadow.csReg(map)) : '--';
    });
    return input;
  }

  /** Hex byte bound to a multi-bit field rather than a whole register. */
  fieldHexInput(field) {
    const input = el('input.hex', {
      type: 'text', spellcheck: false,
      onchange: () => {
        const v = parseByte(input.value);
        const limit = (1 << field.width) - 1;
        if (v === null || v > limit) { this.syncAll(); return; }
        this.#apply(() => this.board.writeField(field, v));
      },
    });
    this.#register(() => { input.value = hex(this.shadow.get(field)); });
    return input;
  }

  // --- escape hatches -------------------------------------------------------

  /**
   * A horizontal range whose position is not simply the field value — used by
   * the AGC threshold, which runs the opposite way to AGCTH.
   */
  rawRange({ max, read, write, oninput }) {
    const range = el('input.range-h', {
      type: 'range', min: 0, max, step: 1,
      oninput: () => oninput?.(+range.value),
      onchange: () => this.#apply(() => write(+range.value)),
    });
    this.#register(() => { range.value = read(); });
    return withTicks(range, max, false);
  }

  /** A text box; `parse` returns null to reject the input and snap back. */
  rawText({ read, parse, write }) {
    const input = el('input.readout', {
      type: 'text',
      onchange: () => {
        const value = parse(input.value);
        if (value === null) { this.syncAll(); return; }
        this.#apply(() => write(value));
      },
    });
    this.#register(() => { input.value = read(); });
    return input;
  }

  /** Register a plain sync callback for anything the factories do not cover. */
  onSync(fn) {
    this.#register(fn);
  }
}

/**
 * A field where 0 means "off" and the usable settings run from 1 upwards.
 *
 * `level` is the user-facing 0-based setting; the register holds level + 1 while
 * enabled and 0 while not. The chosen level is remembered across a disable so
 * re-enabling restores it rather than snapping back to the minimum.
 */
class Gate {
  #stored = 0;

  constructor(binder, field) {
    this.binder = binder;
    this.field = field;
  }

  get raw() {
    return this.binder.shadow.get(this.field);
  }

  get enabled() {
    return this.raw !== 0;
  }

  get level() {
    return this.enabled ? this.raw - 1 : this.#stored;
  }

  async setEnabled(on) {
    if (on) {
      await this.binder.board.writeField(this.field, this.#stored + 1);
    } else {
      this.#stored = this.level;
      await this.binder.board.writeField(this.field, 0);
    }
  }

  async setLevel(level) {
    this.#stored = level;
    // The vendor app writes nothing while the control is disabled; the level is
    // held in the UI until the box is ticked.
    if (this.enabled) await this.binder.board.writeField(this.field, level + 1);
  }
}

/** Marks a binding that has not been confirmed against captured traffic. */
function unverified(note) {
  return el('abbr.unverified', { title: `Unverified mapping: ${note}` }, '?');
}

/**
 * Wrap a range in a tick scale down both sides, the way the vendor app's
 * trackbars are drawn.
 *
 * Tick counts measured off the vendor screenshots: 20 for the 0..94 Voice DAC
 * slider, 31 for 0..30 Sidetone, 16 for 0..15 AGC Threshold, 4 for 0..3 Gain.
 * So it draws one tick per step until the range gets long, then thins out.
 */
function withTicks(range, steps, vertical) {
  const count = tickCount(steps);
  const scale = () => el('div.ticks', Array.from({ length: count }, () => el('i')));
  return el(`div.range-wrap.range-wrap-${vertical ? 'v' : 'h'}`, scale(), range, scale());
}

function tickCount(steps) {
  if (steps < 1) return 2;
  const every = steps <= 32 ? 1 : Math.ceil(steps / 20);
  return Math.round(steps / every) + 1;
}
