#!/usr/bin/env python3
"""
Are CS8427 registers 0x01/0x02/0x05/0x06 write-only, or is something else
going on? Write six distinct values, read all six back.

  all six return what was written -> everything is readable
  only 0x03/0x04 return           -> the others really are write-only
  values come back shifted        -> an addressing problem, not write-only

Restores the vendor reset defaults afterwards. App must be closed.
"""
import time
import serial

PORT, BAUD = "COM4", 460800
CS, RST = 9, 4

REGS = [(0x01, "Control 1"), (0x02, "Control 2"), (0x03, "Data Flow"),
        (0x04, "Clock Source"), (0x05, "Serial Input"), (0x06, "Serial Output")]
PROBE = {0x01: 0x11, 0x02: 0x22, 0x03: 0x33, 0x04: 0x44, 0x05: 0x55, 0x06: 0x66}
DEFAULTS = {0x01: 0x01, 0x02: 0x00, 0x03: 0x0C, 0x04: 0x09, 0x05: 0x21, 0x06: 0xA1}


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
            buf += sp.read(w); last = now
        else:
            time.sleep(0.004)
    return bytes(buf)


def raw(sp, data, expect):
    sp.write(data); sp.flush()
    return rd(sp, expect)


def spi(sp, payload: bytes) -> list[int]:
    raw(sp, bytes([0xF0 | CS, 0]), 1)
    r = raw(sp, b"".join(bytes([0xAF, b]) for b in payload), 2 * len(payload))
    raw(sp, bytes([0xF0 | CS, 1]), 1)
    return [r[i] for i in range(0, len(r), 2)] if len(r) >= 2 * len(payload) else []


def write_reg(sp, reg, val):
    spi(sp, bytes([0x20, reg, val]))


def read_reg(sp, reg):
    spi(sp, bytes([0x20, reg]))            # address it
    m = spi(sp, bytes([0x21, 0x00]))       # read one byte
    return m[1] if len(m) == 2 else None


sp = serial.Serial(PORT, BAUD, timeout=0.2)
sp.dtr = False; sp.rts = False
time.sleep(0.3)
banner = sp.read(sp.in_waiting or 1)
if banner:
    p(f"[banner] {''.join(chr(b) if 32 <= b < 127 else '.' for b in banner)}\n")

raw(sp, bytes([0xF0 | RST, 1]), 1)
raw(sp, bytes([0xF0 | CS, 1]), 1)
time.sleep(0.05)
sp.reset_input_buffer()

p("state as found:")
for reg, name in REGS:
    p(f"  0x{reg:02X} {name:<14} = 0x{read_reg(sp, reg):02X}")

p("\nwriting distinct probe values 0x11..0x66 ...")
for reg, _ in REGS:
    write_reg(sp, reg, PROBE[reg])
time.sleep(0.05)

p("\nreading back:")
verdict = {}
for reg, name in REGS:
    got = read_reg(sp, reg)
    want = PROBE[reg]
    ok = "MATCH" if got == want else ("zero" if got == 0 else "OTHER")
    verdict[reg] = ok
    p(f"  0x{reg:02X} {name:<14} wrote 0x{want:02X}  read 0x{got:02X}   {ok}")

p("\nrestoring vendor defaults ...")
for reg, _ in REGS:
    write_reg(sp, reg, DEFAULTS[reg])
time.sleep(0.05)
for reg, name in REGS:
    p(f"  0x{reg:02X} {name:<14} = 0x{read_reg(sp, reg):02X}  (wrote 0x{DEFAULTS[reg]:02X})")

p("\nverdict: " + ", ".join(f"0x{r:02X}={v}" for r, v in verdict.items()))
sp.close()
