// AGC / NG tab.
//
// Two of the "Enable" boxes here are gated fields rather than dedicated bits:
// enabling the Noise Gate writes ANTH = 1, and enabling AGC writes HLD = 1.
// The two bars are read-only and driven by register 0x01, which the vendor app
// polls at roughly 6 Hz while this tab is visible.

import { el, group } from '../dom.js';
import { FIELDS } from '../../model/registers.js';
import {
  AGC_ATTACK_OPTIONS, AGC_HOLD_OPTIONS, AGC_RELEASE_OPTIONS, AGC_SOURCE_OPTIONS,
  AGC_THRESHOLD, NG_THRESHOLD, AGC_GAIN_BAR, NG_ATTEN_BAR,
} from '../../model/mappings.js';

/** @param {import('../controls.js').Binder} binder */
export function agcNgTab(binder) {
  const gate = binder.gate(FIELDS.ANTH);
  const agc = binder.gate(FIELDS.HLD);

  return el('div',
    el('div.tab-cols',
      group('Noise Gate',
        binder.gateCheckbox('Enable Noise Gate', gate),
        binder.bar({
          label: 'Noise Gate Attenuation',
          field: FIELDS.NG,
          max: NG_ATTEN_BAR.max,
          // NG counts attenuation, so a full bar is no attenuation at all.
          fraction: (v) => 1 - NG_ATTEN_BAR.toDb(v) / NG_ATTEN_BAR.full,
          format: (v) => (NG_ATTEN_BAR.toDb(v) ? `-${NG_ATTEN_BAR.toDb(v)}dB` : '0dB'),
          minLabel: NG_ATTEN_BAR.minLabel,
          maxLabel: NG_ATTEN_BAR.maxLabel,
        }),
        thresholdSlider(binder, {
          label: 'Noise Gate Threshold',
          gate,
          scale: NG_THRESHOLD,
          invert: false,
        })),

      group('Automatic Gain Control (AGC)',
        binder.gateCheckbox('Enable AGC', agc),
        binder.bar({
          label: 'AGC Gain',
          field: FIELDS.AGC,
          max: AGC_GAIN_BAR.max,
          fraction: (v) => AGC_GAIN_BAR.toDb(v) / AGC_GAIN_BAR.full,
          format: (v) => `${AGC_GAIN_BAR.toDb(v)}dB`,
          minLabel: AGC_GAIN_BAR.minLabel,
          maxLabel: AGC_GAIN_BAR.maxLabel,
        }),
        thresholdSlider(binder, {
          label: 'AGC Threshold',
          field: FIELDS.AGCTH,
          scale: AGC_THRESHOLD,
          invert: true,
        }),
        el('div.agc-times',
          binder.select('AGC Attack Time', FIELDS.ATK, AGC_ATTACK_OPTIONS),
          binder.gateSelect('AGC Hold Time', agc, AGC_HOLD_OPTIONS),
          binder.select('AGC Release Time', FIELDS.RLS, AGC_RELEASE_OPTIONS)))),

    group('AGC / NG Signal Source',
      binder.select('', FIELDS.SRC, AGC_SOURCE_OPTIONS)));
}

/**
 * Horizontal threshold slider with the dB readout underneath.
 *
 * The AGC threshold runs the opposite way to its field: the right-hand end of
 * the slider (-3dB) is AGCTH 0, so the slider position is 15 - AGCTH.
 */
function thresholdSlider(binder, { label, field, gate, scale, invert }) {
  const toPosition = (v) => (invert ? scale.max - v : v);
  const fromPosition = (p) => (invert ? scale.max - p : p);

  const range = binder.rawRange({
    max: scale.max,
    read: () => toPosition(gate ? gate.level : binder.shadow.get(field)),
    write: (pos) => (gate
      ? gate.setLevel(fromPosition(pos))
      : binder.board.writeField(field, fromPosition(pos))),
    oninput: (pos) => { readout.value = String(scale.toDb(fromPosition(pos))); },
  });

  const readout = binder.rawText({
    read: () => String(scale.toDb(gate ? gate.level : binder.shadow.get(field))),
    parse: (text) => {
      const db = Number(text.trim().replace(/dB$/i, ''));
      if (!Number.isFinite(db)) return null;
      return Math.min(scale.max, Math.max(0, scale.fromDb(db)));
    },
    write: (v) => (gate ? gate.setLevel(v) : binder.board.writeField(field, v)),
  });

  return el('div.threshold',
    el('div.threshold-title', label),
    range,
    el('div.threshold-foot',
      el('span', scale.minLabel),
      el('span.readout-row', readout, el('span.unit', 'dB')),
      el('span', scale.maxLabel)));
}
