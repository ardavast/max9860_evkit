// The transaction log at the bottom of the window.
//
// API-level, in the style of the vendor app's own lines
// ("I2CWrite: Address = 0x20, Register = 0xFC, Data = 0x00") — but the vendor
// only ever logged I2C. The SPI transfers to the CS8427 and every GPIO write,
// including the clock-tree pins that are the whole reason this board needs a
// command module, went past unrecorded. Both are here.
//
// Raw wire bytes are a separate concern; for those use tools/cmod_sniff.py.

import { el, hex } from './dom.js';

const MAX_LINES = 2000;

/**
 * Filters, in toolbar order. The first three are buses; `read` is a separate
 * axis crossing all of them, and starts off — a Read All is 38 read lines, which
 * would bury the writes. Hidden lines stay in the buffer, so ticking it reveals
 * everything already recorded rather than only what happens next.
 */
const FILTERS = [
  { key: 'i2c', label: 'I²C', on: true },
  { key: 'spi', label: 'SPI', on: true },
  { key: 'gpio', label: 'GPIO', on: true },
  { key: 'read', label: 'Reads', on: false, separate: true },
];

export class LogView {
  constructor() {
    this.list = el('div.log', { role: 'log' });
    this.follow = true;
    this.list.addEventListener('scroll', () => {
      const atEnd = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 24;
      this.follow = atEnd;
    });

    const toggles = FILTERS.map(({ key, label, on, separate }) => {
      const input = el('input', {
        type: 'checkbox',
        checked: on,
        onchange: () => this.list.classList.toggle(`hide-${key}`, !input.checked),
      });
      this.list.classList.toggle(`hide-${key}`, !on);
      return el(`label.check.log-filter${separate ? '.log-filter-split' : ''}`,
        input, el('span', label));
    });

    const clear = el('button.log-clear', { type: 'button', onclick: () => this.clear() }, 'Clear');

    this.node = el('section.log-pane',
      el('div.log-bar', el('span.log-bar-title', 'Transactions'), toggles, clear),
      this.list);
  }

  append(text, cls = 'meta') {
    const line = el(`div.log-line.${cls}`, text);
    this.list.append(line);

    // The vendor app's memo silently stops appending once it fills up. Drop the
    // oldest lines instead.
    while (this.list.childElementCount > MAX_LINES) this.list.firstElementChild.remove();
    if (this.follow) this.list.scrollTop = this.list.scrollHeight;
  }

  clear() {
    this.list.replaceChildren();
  }

  /** The logger handed to Board. */
  get sink() {
    return (event) => this.append(format(event), classesOf(event));
  }
}

/** Bus class, plus `read` for anything that only fetched a value. */
function classesOf(e) {
  if (e.kind === 'error') return 'meta error';
  const bus = e.kind.startsWith('i2c') ? 'i2c'
    : e.kind.startsWith('spi') ? 'spi'
      : e.kind.startsWith('pin') ? 'gpio' : 'meta';
  return e.kind.endsWith('-read') ? `${bus} read` : bus;
}

/** Exported for the tests, which pin the exact line shapes and classes. */
export { format as formatLogEvent, classesOf as logClassesFor };

/** Labels are padded so the columns line up down the log. */
const label = (s) => `${s}:`.padEnd(10);

function format(e) {
  switch (e.kind) {
    case 'i2c-write':
      return label('I2CWrite') + `Address = ${hex(e.addr)}, Register = ${hex(e.reg)}, Data = ${hex(e.value)}`;
    case 'i2c-read':
      return label('I2CRead') + `Address = ${hex(e.addr)}, Register = ${hex(e.reg)}, Data = ${hex(e.value)}`;
    case 'spi-write':
      return label('SPIWrite') + `Chip = CS8427, Register = ${hex(e.reg)}, Data = ${hex(e.value)}`;
    case 'spi-read':
      return label('SPIRead') + `Chip = CS8427, Register = ${hex(e.reg)}, Data = ${hex(e.value)}`;
    case 'pin-write':
      return label('PinWrite') + `Pin = K${e.pin}${e.name ? ` (${e.name})` : ''}, Value = ${e.value}`;
    case 'pin-read':
      return label('PinRead') + `Pin = K${e.pin}${e.name ? ` (${e.name})` : ''}, `
        + `Value = ${e.value ?? 'n/a'}`;
    case 'info':
      return e.text;
    case 'error':
      return `Error: ${e.text}`;
    default:
      return String(e.text ?? '');
  }
}
