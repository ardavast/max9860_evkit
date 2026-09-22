# MAX9860 EVKIT — browser implementation

The vendor application's main window and its seven tabs, in the browser, over
**Web Serial**. No dependencies, no build step.

```bash
cd web && python serve.py
```

Then open <http://127.0.0.1:8765/> in Chrome or Edge and press **Connect**.
`serve.py` is `http.server` with caching switched off, so an edit shows up on a
plain reload instead of needing a hard one.
Web Serial needs a secure context, which `localhost` is; it will not work from a
`file://` URL.

**Close `MAX9860.exe` first.** The vendor app holds the FTDI device — over D2XX,
which it keeps across a *Disconnect* and only releases on exit — and the two
lock each other out.

## Why Web Serial and not WebUSB

The FT232 on this board is bound to the FTDI driver (`FTDIBUS` / `FTSER2K`).
Chrome's WebUSB on Windows can only claim interfaces bound to WinUSB, so
`claimInterface()` fails. Rebinding with Zadig would make WebUSB work but breaks
COM4, D2XX and the vendor application at the same time. Web Serial talks to the
existing COM port with no driver change.

The transport is the only part that knows this. `transport/serial.js` exposes a
single `transact(bytes, replyLen)`, so a WebUSB backend — FT232 vendor control
requests, bulk endpoints, and stripping the two modem-status bytes off each IN
packet — could be dropped in beside it without touching anything above.

## Layout

```
js/transport/serial.js   port open/close, banner drain, one serialized queue
js/protocol/cmod.js      command module: pins, I2C, SPI, chip select
js/protocol/max9860.js   codec registers over I2C, with read-back
js/protocol/cs8427.js    transceiver registers over SPI, two-transaction read
js/protocol/board.js     clock tree, whole-board read, reset
js/model/registers.js    register and bitfield definitions
js/model/mappings.js     control semantics and the Configure computation
js/model/shadow.js       shadow state and change notification
js/ui/                   controls and one module per tab
test/                    protocol encoder checks — node --test test/
```

**One register model drives everything.** `model/registers.js` declares each
register and its bitfields once. The Registers and CS8427 tabs render from it
directly, and every control on the other tabs names a field. A control change is
a read-modify-write on that field; a change from anywhere — Read All, polling,
someone editing the raw hex — pushes back into the controls. That is why the
semantic tabs and the register grid never disagree.

Where each control maps to is documented in
[`../docs/control-map.md`](../docs/control-map.md), with the captured evidence.

## The clocking tab

Automatic and Manual sit side by side and the radio above them greys out the
inactive one, as in the vendor app. Automatic does not mirror into Manual as you
type — Manual shows the registers as they are, and only **Configure** moves them.
The Clock Sources radio sets and locks the MCLK frequency; only *External* lets
you type one.

Configure was checked against the app across 72 input combinations — every clock
source, all seven sample rates, master and slave, plus External at five typed
MCLK frequencies. `FREQ`, `16KHZ`, `PLL`, `PSCLK` and `N` agree on all of them.

Three rules are counter-intuitive enough to repeat, all measured:

- **Exact integer mode needs the sample rate as well as the clock.** It covers
  8kHz and 16kHz only, so 13MHz master at 48kHz stays in normal mode.
- **The PLL is chosen by the clock source**, not by any frequency and not by
  whether N divides exactly — the 12.288MHz radio gives PLL off at every rate,
  while External with 12.288 *typed in* gives PLL on at the same rates.
- **A recovered clock is 256 × Fs**, so it is only usable at 48kHz and 44.1kHz;
  below that it falls under the codec's 10MHz minimum.

The one deliberate difference: at those unusable recovered rates the vendor
silently leaves the previous configuration in place, while this refuses the
Configure and says why. [`../docs/control-map.md`](../docs/control-map.md) §5 has
the full matrix.

## Deliberate differences from the vendor app

**Connecting reads; it does not reset.** Nothing is stored on the board, so all
of its state is recoverable — codec registers over I²C, transceiver registers
over SPI, and the clock configuration from the pins. Connecting therefore
attaches to a running board without disturbing it. Reset stays an explicit
button.

This one is easy to doubt, because the vendor app gives no sign of resetting at
startup. It does: launching it under a capture with distinct values in every
register wipes all of them and writes the defaults, including the `0xF8`–`0xFE`
test registers. See [§7 of the control map](../docs/control-map.md) for the
measurement and the captured sequence.

**The log records SPI and GPIO, not just I²C.** The vendor app logs I²C only,
so its SPI transfers to the CS8427 and every GPIO write go past unrecorded —
including the clock-tree pins that are the entire reason this board needs a
command module. Both are logged here, in the same shape as the I²C lines, with
per-category filters and colour coding.

The toolbar filters by bus (I²C / SPI / GPIO) and, on a separate axis, by
**Reads** — which covers all three buses and starts **off**, since a Read All is
38 read lines that would bury the writes. Hidden lines stay in the buffer, so
ticking Reads reveals everything already recorded, not just what happens next.
A consequence worth knowing: with Reads off, pressing Read All adds nothing
visible to the log — the values land in the Registers grid instead.

The one thing genuinely never logged is the **/CS toggles** that bracket every
SPI transfer. Chip select is the SPI equivalent of an I²C start/stop condition,
and the I²C lines do not log their framing either — a whole-board read emitted 24
chip-select lines against 5 clock-tree ones before this was fixed.

**Reset releases the transceiver first.** The vendor's Reset writes all six
CS8427 registers while K4 is still low, raises K4 afterwards, and never rewrites
them — so those writes went into a part held in reset. This one raises K4, then
configures.

**Reset is not guarded by a confirmation.** It is a dev kit; the button does
what it says. It always ends on a known clock source, and reports the original
failure if the sequence breaks part way rather than whatever its recovery hit.

**Polling is off by default.** The vendor app polls the device-present probe
continuously; it is around 93% of all its traffic and keeps the link busy while
nothing is changing. The Enabled/Disabled control turns on polling of only what
actually moves on its own: `0x00`, `0x01`, and the K1 interrupt pin.

## Rails

Taken from §10 of the protocol reference and enforced in the protocol layer, not
left to callers:

- `0xA9` is refused outright — it starts a continuous ASCII echo that saturates
  the link and only stops on a port close/reopen.
- K1 is read-only. It is the codec's interrupt output, and the firmware will
  happily accept a write to it.
- Selecting a clock source silences both oscillators before moving the mux
  selects, and brings only one back up.
- `FA` from a pin read is reported as "no such pin" (K13, K14), not an error.
- Replies are consumed by expected length, never by write boundary — commands
  batch inside one write.

## Tests

```bash
node --test test/
```

37 checks, no hardware and no browser: the encoders are asserted against the
exact byte sequences in [`../docs/wire-protocol.md`](../docs/wire-protocol.md),
and the Configure rules, level scales and N divider against both the captured
traffic and the datasheet tables.
