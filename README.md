# max9860_evkit

Host software for the **Maxim MAX9860 evaluation board**, replacing the vendor
Windows application.

## Why

The board makes no sound out of the box, and the vendor software only sets
registers — in a way that had to be reverse-engineered to reproduce.

Most of it you can bypass: open **JU8** and the codec's I²S and I²C lines are
yours, and the MAX9860's control interface is ordinary I²C at `0x20`.

**But the clock tree isn't reachable that way.** The two mux selects and both
oscillator enables land on MAXQ2000 port pins — P0.1, P0.2, P0.4, P0.5 — and on
no jumper. Choosing between the 12.288 MHz oscillator, the 13 MHz oscillator and
the recovered S/PDIF clock, or gating either oscillator, is only possible through
the on-board command module.

So this project exists for two things:

1. **Control the clock tree**
2. **Read back the board's actual state**

Everything else is incidental.

## Layout

| Path | Contents |
|---|---|
| [`docs/wire-protocol.md`](docs/wire-protocol.md) | The protocol reference — command set, pin map, clock tree, register maps, bring-up order |
| `docs/wire-protocol.html` | Source of the published reference page |
| `tools/` | Sniffer, decoders and binary-analysis tools used to derive the above |
| `<impl>/` | Each implementation in its own subdirectory |

[`CLAUDE.md`](CLAUDE.md) documents the tooling and the vendor-app quirks — read
it before debugging or reverse-engineering anything further.

## Quick facts

| | |
|---|---|
| Link | 460800 8N1 over FTDI FT232 (`0403:6001`) |
| Transports | FTDI D2XX (`USB:0`) or `\\.\COM4` — mutually exclusive |
| Codec | MAX9860 at I²C address `0x20` |
| Transceiver | CS8427 on SPI, chip select bit-banged on pin K9 |
| Clock control | pins K2 `CLK_SEL`, K3 `OX_SEL`, K5 13 MHz enable, K6 12.288 MHz enable |
| Persistence | none — the board stores nothing, but keeps register state while powered |

## Protocol in one screen

```
E0|K  00        read pin K   -> 00 low / 01 high / FA unavailable
F0|K  vv        write pin K  -> F0
AF    mosi      SPI byte     -> miso BF
A0 05 wn rn addr data...     I2C write-then-read -> read... B0
```

Pin index is the low nibble of the opcode, which is why there are exactly
sixteen pins. Status is the command's first byte with the high nibble changed
A→B. `FA` is the error reply.
