// Digital Filters tab. Both selectors are plain 4-bit fields in register 0x08,
// with the option index as the value.

import { el } from '../dom.js';
import { FIELDS } from '../../model/registers.js';
import { VOICE_FILTER_OPTIONS } from '../../model/mappings.js';

/** @param {import('../controls.js').Binder} binder */
export function filtersTab(binder) {
  return el('div.tab-cols',
    binder.radioGroup('DAC Voice Filters', FIELDS.DVFLT, VOICE_FILTER_OPTIONS),
    binder.radioGroup('ADC Voice Filters', FIELDS.AVFLT, VOICE_FILTER_OPTIONS));
}
