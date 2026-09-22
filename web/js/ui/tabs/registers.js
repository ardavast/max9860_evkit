// The Registers and CS8427 tabs: a bit grid with an editable hex byte per row.
//
// A bit cell lights up when the bit reads 1, the way the vendor app bolds it.

import { el, hex } from '../dom.js';
import { CODEC_GROUPS, CS8427_REGISTERS } from '../../model/registers.js';

const BIT_HEADERS = ['B7', 'B6', 'B5', 'B4', 'B3', 'B2', 'B1', 'B0'];

/** @param {import('../controls.js').Binder} binder */
export function registersTab(binder) {
  const rows = [headerRow()];
  for (const grp of CODEC_GROUPS) {
    rows.push(el('div.reg-group-title', grp.title));
    for (const reg of grp.registers) {
      rows.push(registerRow(binder, reg,
        binder.hexInput(reg.addr, { readOnly: reg.readOnly }),
        () => binder.shadow.reg(reg.addr)));
    }
  }
  return el('div.reg-grid', rows);
}

/** @param {import('../controls.js').Binder} binder */
export function cs8427Tab(binder) {
  const rows = [headerRow()];
  for (const reg of CS8427_REGISTERS) {
    rows.push(registerRow(binder, reg,
      binder.csHexInput(reg.addr),
      () => binder.shadow.csReg(reg.addr)));
  }
  return el('div.reg-grid', rows);
}

function headerRow() {
  return el('div.reg-row.reg-head',
    el('div.reg-name'),
    BIT_HEADERS.map((b) => el('div.reg-bit', b)),
    el('div.reg-value'));
}

function registerRow(binder, reg, input, read) {
  const cells = reg.bits.map((name) => el(`div.reg-bit${name ? '' : '.empty'}`, name ?? ''));

  binder.onSync(() => {
    const v = read();
    cells.forEach((cell, i) => {
      const bit = 7 - i;
      cell.classList.toggle('set', reg.bits[i] !== null && ((v >> bit) & 1) === 1);
    });
  });

  return el(`div.reg-row${reg.readOnly ? '.read-only' : ''}`,
    el('div.reg-name', el('span.reg-addr', hex(reg.addr)), el('span', reg.name)),
    cells,
    el('div.reg-value', input));
}
