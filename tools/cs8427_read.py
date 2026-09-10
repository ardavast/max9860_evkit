#!/usr/bin/env python3
"""
Can the CS8427 be read back over the command module's SPI?

Tries both plausible framings:
  A. one transaction   - /CS low, 0x21, MAP, dummy, /CS high
  B. two transactions  - write MAP first (0x20, MAP), then read (0x21, dummy)

Cirrus control ports generally want form B. Requires the vendor app closed.
"""
import time
import serial

PORT, BAUD = "COM4", 460800
CS, RST = 9, 4
REGS = [(0x01, "Control 1"), (0x02, "Control 2"), (0x03, "Data Flow"),
        (0x04, "Clock Source"), (0x05, "Serial Input"), (0x06, "Serial Output")]


def p(*a):
    print(*a, flush=True)


def rd(sp, n, quiet=0.2, cap=1.0):
    start = last = time.time()
    buf = bytearray()
    while len(buf) < n:
        now = time.time()
        if now - start > cap or (buf and now - last > quiet):
            break
        w = sp.in_waiting
        if w:
            buf += sp.read(w)
            last = now
        else:
            time.sleep(0.005)
    return bytes(buf)


def cmd(sp, data, expect):
    sp.write(data)
    sp.flush()
    return rd(sp, expect)


def spi(sp, payload: bytes) -> list[int]:
    """Clock out payload inside one /CS window; return the MISO bytes."""
    cmd(sp, bytes([0xF0 | CS, 0]), 1)
    batch = b"".join(bytes([0xAF, b]) for b in payload)
    r = cmd(sp, batch, 2 * len(payload))
    cmd(sp, bytes([0xF0 | CS, 1]), 1)
    return [r[i] for i in range(0, len(r), 2)] if len(r) >= 2 * len(payload) else []


sp = serial.Serial(PORT, BAUD, timeout=0.2)
sp.dtr = False
sp.rts = False
time.sleep(0.3)
drained = sp.read(sp.in_waiting or 1)
if drained:
    txt = "".join(chr(b) if 32 <= b < 127 else "." for b in drained)
    p(f"[drained {len(drained)} bytes at open] |{txt}|\n")

cmd(sp, bytes([0xF0 | RST, 1]), 1)      # K4 high, transceiver running
cmd(sp, bytes([0xF0 | CS, 1]), 1)       # /CS idle high
time.sleep(0.05)
sp.reset_input_buffer()

p("FORM A - single transaction: 0x21, MAP, dummy")
for reg, name in REGS:
    m = spi(sp, bytes([0x21, reg, 0x00]))
    p(f"  0x{reg:02X} {name:<14} MISO {' '.join(f'{b:02X}' for b in m)}"
      f"    value=0x{m[2]:02X}" if len(m) == 3 else f"  0x{reg:02X} {name}: short")

p("\nFORM B - set MAP with a write, then a separate read transaction")
for reg, name in REGS:
    spi(sp, bytes([0x20, reg]))              # address the register, no data
    m = spi(sp, bytes([0x21, 0x00]))         # read one byte back
    p(f"  0x{reg:02X} {name:<14} MISO {' '.join(f'{b:02X}' for b in m)}"
      f"    value=0x{m[1]:02X}" if len(m) == 2 else f"  0x{reg:02X} {name}: short")

p("\nCONTROL - write a known value, then read it back with whichever form worked")
spi(sp, bytes([0x20, 0x04, 0x48]))           # Clock Source = 0x48 (S/PDIF)
time.sleep(0.02)
a = spi(sp, bytes([0x21, 0x04, 0x00]))
spi(sp, bytes([0x20, 0x04]))
b = spi(sp, bytes([0x21, 0x00]))
p(f"  wrote 0x48 to Clock Source")
p(f"  form A readback: {' '.join(f'{x:02X}' for x in a)}")
p(f"  form B readback: {' '.join(f'{x:02X}' for x in b)}")

sp.close()
p("\nclosed")
