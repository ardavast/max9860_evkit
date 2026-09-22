// Record tab.

import { el, group } from '../dom.js';
import { FIELDS } from '../../model/registers.js';
import { scales, MIC_PREAMP_SCALE } from '../../model/mappings.js';

/** @param {import('../controls.js').Binder} binder */
export function recordTab(binder) {
  // PAM 0 means the microphone is off; the three preamp gains are PAM 1..3.
  const mic = binder.gate(FIELDS.PAM);
  const adc = scales.adcLevel;
  const pga = scales.micPga;

  return el('div.tab-cols',
    group('ADC',
      el('div.row',
        binder.checkbox('Enable Voice ADC', FIELDS.ADVEN),
        binder.checkbox('Enable Background ADC', FIELDS.AD1EN)),
      el('div.row.sliders',
        binder.slider({
          label: 'Voice Output Level',
          field: FIELDS.AVL,
          max: adc.max,
          format: adc.format,
          parse: adc.parse,
          topLabel: adc.top,
          bottomLabel: adc.bottom,
        }),
        binder.slider({
          label: 'Background Output Level',
          field: FIELDS.A1L,
          max: adc.max,
          format: adc.format,
          parse: adc.parse,
          topLabel: adc.top,
          bottomLabel: adc.bottom,
        }))),

    group('Microphone Input',
      binder.gateCheckbox('Microphone Enable', mic),
      binder.slider({
        label: 'MIC PGA',
        field: FIELDS.PGAM,
        max: pga.max,
        format: pga.format,
        parse: pga.parse,
        topLabel: pga.top,
        bottomLabel: pga.bottom,
      }),
      binder.gateScale('MIC Preamp Gain', mic, MIC_PREAMP_SCALE)));
}
