// Header strip and the Device Status group.

import { el } from './dom.js';
import { FIELDS } from '../model/registers.js';

/**
 * @param {import('./controls.js').Binder} binder
 * @param {object} actions
 */
export function header(binder, actions) {
  const connect = el('button.primary', { type: 'button' }, 'Connect');
  const readAll = el('button', { type: 'button', disabled: true }, 'Read All');
  const reset = el('button', { type: 'button', disabled: true }, 'Reset');
  const polling = el('select', { disabled: true },
    el('option', 'Disabled'), el('option', 'Enabled'));

  connect.addEventListener('click', () => actions.toggleConnect());
  readAll.addEventListener('click', () => actions.readAll());
  reset.addEventListener('click', () => actions.reset());
  polling.addEventListener('change', () => actions.setPolling(polling.selectedIndex === 1));

  const bar = el('header.app-header',
    // Plain text, no imitation of the Maxim wordmark — naming the part this
    // drives is all that is needed, and all that is ours to use.
    el('div.brand', el('span.brand-part', 'MAX9860'), el('span.brand-sub', 'EV kit')),
    el('div.header-actions', readAll, reset, connect, polling));

  return {
    node: bar,
    setConnected(on) {
      connect.textContent = on ? 'Disconnect' : 'Connect';
      connect.classList.toggle('primary', !on);
      readAll.disabled = !on;
      reset.disabled = !on;
      polling.disabled = !on;
      if (!on) polling.selectedIndex = 0;
    },
    setBusy(busy) {
      readAll.disabled = busy;
      reset.disabled = busy;
    },
  };
}

/**
 * Device Status. The check boxes are the interrupt enables in register 0x02;
 * the lamps show the corresponding bits of the read-only register 0x00.
 */
export function deviceStatus(binder) {
  const irq = el('span.lamp');
  binder.onSync(() => {
    // K1 is the codec's interrupt output and reads low while it is asserting.
    irq.classList.toggle('on', binder.shadow.pins[1] === 0);
  });

  return el('section.group.status',
    el('h3.group-title', 'Device Status (check a box to enable that interrupt)'),
    el('div.group-body.status-row',
      binder.statusLamp('DAC or ADC Clipping', FIELDS.CLD, FIELDS.ICLD),
      binder.statusLamp('Slewing Complete', FIELDS.SLD, FIELDS.ISLD),
      binder.statusLamp('PLL Unlock', FIELDS.ULK, FIELDS.IULK),
      binder.statusLamp('Speaker Over Current', FIELDS.SPOC, FIELDS.ISPOC),
      el('div.hw-irq', irq, el('span', 'Hardware Interrupt'))));
}

/** The four-panel status bar along the bottom. */
export function statusBar() {
  const panels = [
    el('span', 'MAX9860 Slave Address: 0x20'),
    el('span', 'Not connected'),
    el('span', ''),
    el('span', ''),
  ];
  return {
    node: el('footer.status-bar', panels),
    set(index, text) { panels[index].textContent = text; },
  };
}
