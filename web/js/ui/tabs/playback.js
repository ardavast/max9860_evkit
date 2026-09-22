// Playback / Sidetone tab.

import { el, group } from '../dom.js';
import { FIELDS } from '../../model/registers.js';
import { scales, PLAYBACK_GAIN_SCALE } from '../../model/mappings.js';

/** @param {import('../controls.js').Binder} binder */
export function playbackTab(binder) {
  const sidetone = binder.gate(FIELDS.DVST);
  const dac = scales.dacLevel;
  const st = scales.sidetone;

  return el('div.tab-cols',
    group('Voice DAC',
      binder.checkbox('Enable DAC', FIELDS.DACEN),
      binder.slider({
        label: 'Voice DAC Level',
        field: FIELDS.DVA,
        max: dac.max,
        format: dac.format,
        parse: dac.parse,
        topLabel: dac.top,
        bottomLabel: dac.bottom,
      }),
      binder.scaleSlider('Gain', FIELDS.DVG, PLAYBACK_GAIN_SCALE)),

    group('Sidetone',
      binder.gateCheckbox('Enable Sidetone', sidetone),
      binder.gateSlider({
        label: 'Sidetone Level',
        gate: sidetone,
        max: st.max,
        format: st.format,
        parse: st.parse,
        topLabel: st.top,
        bottomLabel: st.bottom,
      })));
}
