# MAX9860 EVKIT — wire protocol reference

Everything needed to drive the MAX9860 evaluation board — clock tree, codec and
S/PDIF transceiver — without the Maxim Windows application.

Every byte sequence here was captured off the live link. Anything inferred but
not measured is marked as such.

Published copy (same content, nicer to read): <https://claude.ai/code/artifact/ff553337-9dab-4b19-ae06-747e3e9c2508>
HTML source for that page: [`wire-protocol.html`](wire-protocol.html)

| | |
|---|---|
| Link | 460800 baud, 8N1 |
| Bridge | FTDI FT232, VID `0403` PID `6001` |
| Firmware | `Maxim MINIQUSB V01.05.39` |
| Codec address | `0x20` (eight-bit form, already shifted) |

---

## 1. Why any of this is necessary

The board does nothing on its own. Out of the box it produces no sound; the
vendor application does nothing but set registers, in a way that had to be
reverse-engineered to reproduce.

Most of that is sidesteppable. Open **JU8** and the MAX9860's I²S and I²C lines
are yours — the codec's control interface is ordinary I²C at `0x20` and needs no
command module at all. The CS8427 can be ignored entirely if you don't want
S/PDIF.

**The clock tree is the exception, and it is the reason this document exists.**
The two mux selects and both oscillator enables land on MAXQ2000 port pins —
P0.1, P0.2, P0.4, P0.5 — and nowhere else. The board's eleven jumpers cover
microphone wiring, the supply rails and the JU8 interface takeover; *none of them
touches clock selection*.

| Capability | Needs the command module? |
|---|---|
| **Selecting and gating the master clock** | **Yes — no other route exists** |
| **Reading back the board's actual state** | **Yes — pins are only readable this way** |
| Configuring the codec | No — plain I²C at `0x20`, reachable at JU8 |
| Audio in and out | No — I²S at JU8 |
| CS8427 / S/PDIF | Only if you want S/PDIF at all |

Injecting an external clock at JU8 row 5 bypasses the mux but does not escape
the problem: the on-board oscillators are gated by those same GPIOs, so you
cannot guarantee they are silent without driving them.

---

## 2. Transport

The board carries an FT232 bridged to an on-board MAXQ2000 running the
command-module firmware. You talk to *the MAXQ2000*, never to the codec
directly — it performs the I²C and SPI cycles for you.

Two routes to the same silicon, **mutually exclusive**:

* FTDI D2XX (`FT_Open` device 0) — what the vendor app uses
* The virtual COM port (`COM4` on this machine) — simpler for a portable driver

Whichever opens first wins; the other gets access-denied until it is released.
Closing the vendor application is not always enough — it holds the D2XX handle
across a *Disconnect*, and only releases on exit.

Every exchange is strict request/response: write a command, read its reply. No
framing, no length prefix, no checksum, no line terminators. Reply length is
fixed per command.

**One exception.** On open the module emits an ASCII banner,
`"Maxim MINIQUSB V01.05.39 >"` — 26 bytes, no terminator, unprompted. It will
otherwise turn up glued to the front of your first command's reply. Drain the
port before the first command.

---

## 3. Command set

Pin commands encode the pin index in the **low nibble**, which is why the
hardware exposes exactly sixteen pins, K0–K15.

`K` = pin index 0–15, `vv` = `00` or `01`.

| Operation | Send | Receive | Notes |
|---|---|---|---|
| Read pin | `E0+K 00` | `00` \| `01` \| `FA` | `00` low, `01` high, `FA` pin unavailable |
| Write pin | `F0+K vv` | `F0` | `F0` is the acknowledgement, not an echo |
| SPI transfer byte | `AF mosi` | `miso BF` | one byte per command; several may be pipelined |
| I²C write-then-read | `A0 05 wn rn addr data…` | `read… B0` | whole transaction in one command — the usual way in |
| I²C device present | `A0 03 addr` | `B0` present, `FA` absent | the vendor app polls this continuously |
| I²C start | `A0 00` | — | low-level primitives; rarely needed |
| I²C repeated start | `A0 01` | — | |
| I²C write byte | `A1 bb` | — | |
| I²C read byte + ACK | `A2 01` | — | |
| I²C read byte + NACK | `A2 00` | — | |
| I²C stop | `A3` | — | |
| Pulse 9 clocks | `A4` | — | bus recovery for a stuck slave |
| Capabilities | `A0 02` | `BF 01 B0` | fixed 3-byte reply on this firmware |
| SCL timeout | `A0 04` | `02 FA 04 21 3E` | 5-byte reply |
| SMBus write/read block | `A0 06` / `A0 07` | — | unused by this board |
| *unidentified* | `AD bb` | `bb BD` | same shape as `AF`; issued once during the vendor reset, just before releasing the transceiver. **Purpose unknown — don't rely on it** |

### Status bytes follow a rule

For the `Ax` family the acknowledgement is **the command's first byte with its
high nibble changed from A to B**: `A0…→B0`, `AD→BD`, `AF→BF`. Pin writes answer
`F0`. `FA` is the error / not-available reply throughout.

### Do not send `0xA9`

It puts the firmware into a continuous ASCII echo mode that saturates the link
at full line rate and does not stop on its own. Recovery is closing and
reopening the port. Nothing else in the `A0`–`AF` range behaves this way.

### Commands batch inside one write

**A write is not a command boundary.** A CS8427 register write goes out as
`AF 20 AF 04 AF 48` with `FF BF FF BF FF BF` coming back. Parse the stream by
command length, not by write boundary, or you will decode the first command of
each burst and silently lose the rest.

---

## 4. Pin map

| Pin | Read | Write | MAXQ2000 | Net | Purpose |
|---|---|---|---|---|---|
| K0 | `E0` | `F0` | — | — | unused |
| **K1** | `E1` | `F1` | P0.0 | `IRQ` | codec interrupt, active low — **input, never drive it** |
| **K2** | `E2` | `F2` | P0.1 | `CLK_SEL` | master clock source select |
| **K3** | `E3` | `F3` | P0.2 | `OX_SEL` | oscillator select |
| **K4** | `E4` | `F4` | P0.3 | `CS8427_RST` | transceiver reset — hold high to run |
| **K5** | `E5` | `F5` | P0.4 | — | 13 MHz oscillator enable |
| **K6** | `E6` | `F6` | P0.5 | — | 12.288 MHz oscillator enable |
| K7 | `E7` | `F7` | P0.6 | — | not connected |
| K8 | `E8` | `F8` | P1.7 | — | not connected |
| **K9** | `E9` | `F9` | P5.4 | `CS` | CS8427 chip select, active low — **you drive this** |
| K10 | `EA` | `FA` | P6.0 | `SCL` | driven by the I²C commands |
| K11 | `EB` | `FB` | P6.1 | `SDA` | driven by the I²C commands |
| K12 | `EC` | `FC` | P5.5 | `CDIN` | driven by the SPI command |
| K13 | `ED` | `FD` | — | — | returns `FA`, not available |
| K14 | `EE` | `FE` | — | — | returns `FA`, not available |
| K15 | `EF` | `FF` | — | — | unused |

Writing K10 is the byte `FA`, which is also the error reply value. They never
collide — one is a command you send, the other a status you receive — but a
naive log parser will confuse them.

---

## 5. Clock tree

```
12.288 MHz (Y1) --enable K6--> [U5.I0]
                                       U5 (S = OX_SEL) --Z--> [U6.I1]
13 MHz     (Y2) --enable K5--> [U5.I1]                                U6 (S = CLK_SEL) --Z--> MCLK
RMCK from CS8427 -----------------------------------------> [U6.I0]
```

Measured — each row read back off all sixteen pins:

| Master clock | K2 `CLK_SEL` | K3 `OX_SEL` | K5 13 MHz | K6 12.288 MHz |
|---|---|---|---|---|
| Recovered from S/PDIF | 1 | 0 | 0 | 0 |
| 12.288 MHz | 0 | 1 | 0 | 1 |
| 13 MHz | 0 | 0 | 1 | 0 |
| External | 0 | 0 | 0 | 0 |

Only ever one oscillator is enabled, so the idle one cannot couple into MCLK.

**External is not a mux position.** It is the same select state as 13 MHz with
both oscillators tri-stated, so a source patched in at **JU8 row 5** meets no
active driver. Selecting it in software does nothing on its own — the jumper is
the actual change.

> The `'157` mux datasheet truth table would predict the opposite polarity for
> both selects. The table above is what the hardware actually does; trust it
> over the datasheet reasoning.

---

## 6. Codec over I²C

The MAX9860 answers at **`0x20`** — the eight-bit form, already shifted, exactly
as you place it in the command. One command carries the whole transaction.

```
read register 0x02
TX  A0 05 01 01 20 02     write 1 byte, read 1 byte, addr 0x20, register 0x02
RX  00 B0                 register value 0x00, then the B0 acknowledgement

write 0x80 to register 0x02 — read count zero
TX  A0 05 02 00 20 02 80
RX  B0
```

Read counts above one return that many bytes ahead of the `B0`. A device that
does not acknowledge yields `FA` in place of the data.

### MAX9860 registers

Names as the EV kit software labels them; defaults observed on reset.

| Reg | Name | Reset | Notes |
|---|---|---|---|
| `0x00` | Interrupt Status | — | read-only; the app polls it continuously alongside K1 |
| `0x01` | NG/AGC readback | — | read-only; live noise-gate attenuation and AGC gain. **Neither field is decibels**: `NG2:0` is 0/1/2/3/6/8/10/12 dB of attenuation, and `AGC4:0` is on the `PGAM` scale, `20 - code` dB. See `control-map.md` §8 |
| `0x02` | Interrupt Enable | `00` | |
| `0x03` | System Clock | `00` | **bit 0 does two jobs.** With `FREQ` = 00 it is the AGC clock rate (set above 24kHz); with `FREQ` ≠ 00 it picks 8kHz or 16kHz for exact integer mode. Integer mode covers those two rates only |
| `0x04` | Clock Control High | `00` | audio clock divider; bit 7 is the PLL. Raise it only as slave, and only when `N` is not a whole number — an MCLK that divides exactly (12.288MHz here) needs no PLL |
| `0x05` | Clock Control Low | `00` | |
| `0x06` | Interface | `00` | writing these also drives CS8427 `0x05`/`0x06` |
| `0x07` | Interface | `00` | |
| `0x08` | Voice Filters | `00` | |
| `0x09` | DAC Attenuation | `06` | |
| `0x0A` | ADC Output | `33` | |
| `0x0B` | Gain / Sidetone | `00` | |
| `0x0C` | MIC Left | `14` | |
| `0x0E` | AGC | `00` | |
| `0x0F` | NG/AGC | `00` | |
| **`0x10`** | **System** | `00` | **bit 7 = shutdown/enable.** `0x8B` running, `0x0B` shut down — low bits preserved, so read-modify-write |
| `0xF8`–`0xFE` | Test Points, VIO / I2S / Analog Tests | — | factory test; leave alone — and see the `0xF9` note below |

The vendor software **reads every register straight back after writing it**.
Worth copying: it is the only confirmation you get that a write landed, since
`B0` only tells you the bus cycle completed.

**`0xF9` is the one register that does not read back what you wrote.** In the
vendor application's startup sequence it writes `0x00` to `0xF9` and reads back
`0x80`; every other register in that sequence, `0xF8` and `0xFA`–`0xFE`
included, reads back exactly what went in. So a write-then-verify helper needs
an exemption for `0xF9`, or should leave the test registers alone entirely.

Why bit 7 comes back set was not investigated — characterising it means writing
arbitrary values into an analog test register, which is not worth the risk for a
block you should not be touching anyway. Treat this as "observed once, in the
vendor's own sequence", not as a described behaviour.

---

## 7. Transceiver over SPI

The CS8427's control port is on the MAXQ2000's hardware SPI, but **chip select
is not automatic** — it is plain GPIO on K9, and you bracket the transfer with
it yourself.

### Writing

Framing is **chip byte, MAP, then data**, all inside one `/CS` window. Chip is
`0x20` to write. Bit 7 of MAP auto-increments the pointer across a burst.

```
captured: write CS8427 register 0x04 (Clock Source) = 0x48
TX  F9 00                  K9 low — assert chip select
RX  F0
TX  AF 20  AF 04  AF 48    chip 0x20 = write, MAP 0x04, data 0x48
RX  FF BF  FF BF  FF BF    one <miso> BF pair per byte
TX  F9 01                  K9 high — release chip select
RX  F0
```

### Reading takes two transactions, not one

This is the part that will waste your afternoon. Putting `0x21`, MAP and a dummy
byte in a single `/CS` window returns **zeros**. The register pointer has to be
set by its own write transaction first, then read in a second one.

```
--- does NOT work: one transaction ---
TX  F9 00 · AF 21 AF 04 AF 00 · F9 01
RX  MISO FF 00 00                       always zero

--- works: address, then read ---
TX  F9 00 · AF 20 AF 04 · F9 01         write chip byte + MAP, no data
TX  F9 00 · AF 21 AF 00 · F9 01         read chip byte + one dummy
RX  MISO FF 48                          second MISO byte is the register
```

MISO during the chip-address byte is always `0xFF` (the bus idles high); the
register value arrives on the following byte.

**All six registers are readable** — verified by writing the distinct values
`0x11`…`0x66` and reading each back, all six matching. A register that reads
`0x00` genuinely holds zero; it is not a failed readback.

### CS8427 registers

| MAP | Register | Reset | Observed in use |
|---|---|---|---|
| `0x01` | Control 1 | `01` | — |
| `0x02` | Control 2 | `00` | — |
| `0x03` | Data Flow | `0C` | — |
| **`0x04`** | **Clock Source** | `09` | `0x48` S/PDIF · `0x08` I²S · `0x49` after Configure |
| `0x05` | Serial Input | `21` | `0x21` |
| `0x06` | Serial Output | `A1` | `0xA1` |

Bit names are readable off the EV kit software's own CS8427 tab. For Clock
Source they are `RUN CLK1 CLK0 OUTC INC RXD1 RXD0`, which decodes the values
above: S/PDIF sets **RUN**, selecting I²S clears it and stops the receiver.

Hold **K4 high** before expecting the transceiver to answer; it is the reset
line and a low leaves the part held down.

---

## 8. The board remembers nothing

There is no non-volatile settings store anywhere in this design.

The only EEPROM on the board is **U9, a 93C46 on the FT232's `EECS`/`EESK`/
`EEDATA` pins** — that holds the USB descriptor (VID, PID, serial) and is not
reachable from the command module. The firmware's `A0 06`/`A0 07` EEPROM support
targets an I²C part on a daughter board; there isn't one here.

The vendor Reset confirms it behaviourally: it writes *every* register blind and
never reads anything first to recover prior state.

```
the vendor Reset sequence, captured — a complete cold configuration
K2=0  K3=0  K4=0  K5=0  K6=0        selects quiet, both oscillators off, /RST low
i2c 0x20  regs 0x02..0x10 <- defaults, each verified by read-back
spi       CS8427 0x01..0x06 <- defaults
i2c 0x20  regs 0xF8..0xFE <- 00     the factory test registers, also blind
AD 20                               unidentified, once
K4=1                                transceiver released
K2=0  K3=0  K5=1  K6=0              13 MHz selected and enabled
```

**The application runs this at launch, not only on the Reset button.** Nothing
in the UI says so, and the values it then displays look like a freshly powered
board because it has just made it one. Measured by writing distinctive values
into every writable register and then spawning the app suspended, so the hooks
were in place before its first instruction — every marker was gone afterwards:

```
before launch   03=12 06=44 07=25 08=5A 09=2C 0A=71 0B=13 0E=66 0F=39
after launch    03=00 06=00 07=00 08=00 09=06 0A=33 0B=00 0E=00 0F=00
```

Attaching to the running process cannot see this; use
`tools/cmod_sniff.py --spawn`. The practical consequence is that **you cannot
inspect a board's live state by opening the vendor application** — opening it
destroys the state you wanted to look at.

That tail is an independent check on the clock table: `CLK_SEL=0`, `OX_SEL=0`,
13 MHz enable high is exactly the documented 13 MHz selection.

**But the parts are volatile, not amnesiac.** The codec and transceiver hold
their registers for as long as the board stays powered, so closing and reopening
a host program does not blank them. "Starts blank" is true only after a power
cycle.

Because nothing is stored on the board, a host program does not have to reset at
startup — every part of the state is recoverable by reading: codec registers
over I²C, transceiver registers over SPI, and the clock configuration from the
pins themselves (`E0|K` on K2, K3, K5, K6). Reading rather than resetting means
attaching to a running board without disturbing it.

---

## 9. Bring-up order

A sequence that lands the board in a known, working state from cold.

| Step | Bytes | Why |
|---|---|---|
| Release the transceiver | `F4 01` | K4 high — CS8427 out of reset |
| Park chip select | `F9 01` | K9 idles high so the first transfer has a clean edge |
| Silence both oscillators | `F5 00` · `F6 00` | avoid two drivers on the mux while you choose |
| Choose the source | `F2 vv` · `F3 vv` | per the clock table |
| Enable the one oscillator | `F5 01` *or* `F6 01` | never both |
| Confirm the codec is alive | `A0 05 01 01 20 02` | a `B0` reply means the bus is good |
| Configure the transceiver | `F9 00 · AF 20 AF mm AF dd · F9 01` | CS8427 `0x01`–`0x06` — **after** K4 is high, not before |
| Configure the codec | `A0 05 02 00 20 rr dd` | MAX9860 `0x02`–`0x0F`, reading each back |
| Bring the codec out of shutdown | `A0 05 02 00 20 10 8B` | register `0x10` bit 7 — **last**, once clocks and format are set |
| Poll the interrupt line | `E1 00` | K1 reads 0 when the codec is asserting IRQ |

---

## 10. Things that will cost you an afternoon

**K1 is an input.** It is the codec's interrupt output. The pin-write command
will happily accept `F1 01` and you will be driving against a live output.

**K13 and K14 answer `FA`.** Not a bus fault — those indices are simply absent.
Treat `FA` from a read as "no such pin", not as an error worth retrying.

**D2XX and the COM port lock each other out.** Whichever opens first wins.
Closing the vendor app is not always enough; it holds the D2XX handle across a
*Disconnect*.

**Both oscillators off is a valid state.** It means "external clock". If MCLK is
dead and both enables read 0, the board is waiting on a jumper.

**Don't copy the vendor's reset ordering.** Its Reset writes all six CS8427
registers *while* K4 is low, raises K4 afterwards, and never rewrites them. If
K4-high is the operational state — which normal running suggests — those writes
went into a part held in reset. Release K4 first, then configure.

**Opening the vendor application destroys the board's state.** It runs the full
blind reset at launch, unprompted. If you want to see what a board is currently
doing, read it yourself — do not open the app to look. See §8.

**`0xF9` does not read back what you wrote.** Alone among the registers the
vendor writes, it answers `0x80` to a written `0x00`. Write-then-read-back is
the right discipline everywhere else; this is the exception. See §6.

**Commands batch inside one write.** See §3.

**Reading the CS8427 needs two transactions.** See §7.
