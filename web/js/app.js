// Wiring: transport, board, shadow, tabs, polling.

import { SerialTransport } from './transport/serial.js';
import { Board } from './protocol/board.js';
import { Shadow } from './model/shadow.js';
import { Binder } from './ui/controls.js';
import { LogView } from './ui/log.js';
import { el } from './ui/dom.js';
import { header, deviceStatus, statusBar } from './ui/header.js';
import { clockingTab } from './ui/tabs/clocking.js';
import { playbackTab } from './ui/tabs/playback.js';
import { recordTab } from './ui/tabs/record.js';
import { filtersTab } from './ui/tabs/filters.js';
import { agcNgTab } from './ui/tabs/agcng.js';
import { registersTab, cs8427Tab } from './ui/tabs/registers.js';

const POLL_INTERVAL_MS = 250;

const shadow = new Shadow();
const log = new LogView();
const transport = new SerialTransport();
const board = new Board(transport, shadow, log.sink);

const onError = (err) => {
  log.append(`Error: ${err.message}`, 'meta error');
  bar.set(3, err.message);
};

const binder = new Binder(board, shadow, onError);
const bar = statusBar();

let pollTimer = null;
let busy = false;

const head = header(binder, {
  toggleConnect: () => (transport.connected ? disconnect() : connect()),
  readAll: () => guard(() => board.readAll()),
  reset: () => guard(async () => {
    await board.reset();
    await board.readAll();
  }),
  setPolling: (on) => setPolling(on),
});

// --- tabs -------------------------------------------------------------------

const TABS = [
  ['Digital Audio Interface and Clocking', () => clockingTab(binder, onError)],
  ['Playback / Sidetone', () => playbackTab(binder)],
  ['Record', () => recordTab(binder)],
  ['Digital Filters', () => filtersTab(binder)],
  ['AGC / NG', () => agcNgTab(binder)],
  ['Registers', () => registersTab(binder)],
  ['CS8427', () => cs8427Tab(binder)],
];

const tabStrip = el('div.tab-strip', { role: 'tablist' });
const tabBody = el('div.tab-body');
let current = 0;

TABS.forEach(([title, build], i) => {
  const panel = el('div.tab-panel', { hidden: i !== 0 }, build());
  const button = el('button.tab', { type: 'button', role: 'tab' }, title);
  button.addEventListener('click', () => select(i));
  tabStrip.append(button);
  tabBody.append(panel);
});

function select(i) {
  current = i;
  [...tabStrip.children].forEach((b, j) => b.classList.toggle('active', j === i));
  [...tabBody.children].forEach((p, j) => { p.hidden = j !== i; });
}
select(0);

document.body.append(
  head.node,
  deviceStatus(binder),
  el('main.app-main', tabStrip, tabBody),
  log.node,
  bar.node,
);

// --- connection -------------------------------------------------------------

async function connect() {
  if (!SerialTransport.supported) {
    onError(new Error('Web Serial is unavailable. Use Chrome or Edge, over http://localhost or https.'));
    return;
  }
  try {
    const banner = await transport.connect();
    log.append(banner ? `Connected — ${banner}` : 'Connected (no banner; port was already open)');
    head.setConnected(true);
    bar.set(1, 'Connected to the EVKIT');

    // Nothing is stored on the board, so read rather than reset: this attaches
    // to a running board without disturbing whatever it is currently doing.
    await guard(async () => {
      const present = await board.probeCodec();
      bar.set(2, present ? 'MAX9860: Connected' : 'MAX9860: not responding');
      await board.readAll();
    });
  } catch (err) {
    onError(err);
    await transport.disconnect().catch(() => {});
    head.setConnected(false);
  }
}

async function disconnect() {
  setPolling(false);
  try {
    await transport.disconnect();
  } catch (err) {
    onError(err);
  }
  head.setConnected(false);
  bar.set(1, 'Not connected');
  bar.set(2, '');
  shadow.clear();
  log.append('Disconnected');
}

/** Run a board operation, keeping only one in flight and reporting failures. */
async function guard(fn) {
  if (busy) return;
  busy = true;
  head.setBusy(true);
  try {
    await fn();
  } catch (err) {
    onError(err);
  } finally {
    busy = false;
    head.setBusy(!transport.connected);
    binder.syncAll();
  }
}

// --- polling ----------------------------------------------------------------

/**
 * Optional, and off by default. The vendor app polls the device-present probe
 * continuously — around 93% of all its traffic — which buries everything else
 * and keeps the link busy for no benefit while nothing is changing.
 *
 * When enabled this reads only what actually moves on its own: the interrupt
 * status register, the live NG/AGC readback, and the interrupt pin.
 */
function setPolling(on) {
  clearInterval(pollTimer);
  pollTimer = null;
  if (!on || !transport.connected) return;

  pollTimer = setInterval(async () => {
    if (busy || !transport.connected) return;
    busy = true;
    try {
      await board.quietly(async () => {
        await board.readCodecReg(0x00);
        await board.readCodecReg(0x01);
        shadow.setPin(1, await board.cmod.pinRead(1));
      });
    } catch (err) {
      setPolling(false);
      onError(err);
    } finally {
      busy = false;
    }
  }, POLL_INTERVAL_MS);
}

head.setConnected(false);
if (!SerialTransport.supported) {
  log.append('Web Serial is unavailable in this browser. Use Chrome or Edge over http://localhost or https.', 'meta error');
}
