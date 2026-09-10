#!/usr/bin/env python3
"""
spi_paths - enumerate every code path in the vendor application that can reach
the SPI bus, and identify each function by the string constants it references.

Answers "what in this app can talk to the CS8427?" statically, rather than by
clicking every control and hoping the sample was exhaustive.

    uv run --with pefile --with capstone python spi_paths.py <exe>
"""

from __future__ import annotations

import bisect
import re
import sys
from collections import defaultdict, deque

import capstone
import pefile

# Each Cmod primitive is identified by a log string only it references.
SEEDS = {
    "CmodSpiByte":      b"CmodSpiByte(mosi=0x%2.2x)",
    "CmodSpiTransfer":  b"CmodSpiTransfer(transmit buffer)",
    "CmodSpiCsAssert":  b"CmodSpiCsAssert()",
    "CmodSpiCsNegate":  b"CmodSpiCsNegate()",
    "CmodPinWrite":     b"CmodPinWrite(Pin = K%d, value = %d)",
}

LEVELS = 4          # how far up the call graph to walk
STR_RE = re.compile(rb"[\x20-\x7e]{4,}")


def main() -> int:
    exe = sys.argv[1] if len(sys.argv) > 1 else r"C:\Program Files (x86)\MAX9860\MAX9860.exe"
    pe = pefile.PE(exe, fast_load=True)
    base = pe.OPTIONAL_HEADER.ImageBase

    # ---- string table: VA -> text ------------------------------------
    strings: dict[int, str] = {}
    for s in pe.sections:
        d = s.get_data()
        sva = base + s.VirtualAddress
        for m in STR_RE.finditer(d):
            strings[sva + m.start()] = m.group().decode("ascii", "replace")

    # ---- disassemble the executable section --------------------------
    text = next(s for s in pe.sections
                if s.Name.rstrip(b"\x00").lower().startswith(b".text"))
    data, tva = text.get_data(), base + text.VirtualAddress
    md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
    md.detail = True
    insns, off, n = [], 0, len(data)
    while off < n:
        got = 0
        for i in md.disasm(data[off:], tva + off):
            insns.append(i)
            got += i.size
        off += got + 1 if got else 1
    print(f"{len(insns)} instructions, {len(strings)} strings", file=sys.stderr)

    # ---- call graph ---------------------------------------------------
    callers: dict[int, list[int]] = defaultdict(list)
    for i in insns:
        if i.mnemonic == "call" and i.operands and \
           i.operands[0].type == capstone.x86.X86_OP_IMM:
            callers[i.operands[0].imm].append(i.address)
    entries = sorted(callers)

    def enclosing(addr: int) -> int | None:
        k = bisect.bisect_right(entries, addr) - 1
        return entries[k] if k >= 0 else None

    # immediates per function, for identification
    imm_by_func: dict[int, list[int]] = defaultdict(list)
    for i in insns:
        for op in i.operands:
            if op.type == capstone.x86.X86_OP_IMM:
                f = enclosing(i.address)
                if f is not None:
                    imm_by_func[f].append(op.imm)

    def label(func: int, limit: int = 4) -> str:
        """Identify a function by the string constants it references."""
        seen, out = set(), []
        for v in imm_by_func.get(func, []):
            t = strings.get(v)
            if t and t not in seen and len(t) > 5:
                seen.add(t)
                out.append(t)
            if len(out) >= limit:
                break
        return " | ".join(out) if out else "(no strings)"

    # ---- locate each primitive ----------------------------------------
    def find_func(needle: bytes) -> int | None:
        vas = [va for va, t in strings.items()
               if t.encode("ascii", "replace").startswith(needle[:24])]
        if not vas:
            return None
        vset = set(vas)
        for i in insns:
            for op in i.operands:
                if op.type == capstone.x86.X86_OP_IMM and op.imm in vset:
                    return enclosing(i.address)
        return None

    for name, needle in SEEDS.items():
        fn = find_func(needle)
        print("\n" + "=" * 78)
        if fn is None:
            print(f"{name}: not located")
            continue
        print(f"{name}  @ 0x{fn:08X}")

        # breadth-first walk up the call graph
        seen = {fn}
        frontier = deque([(fn, 0)])
        while frontier:
            func, depth = frontier.popleft()
            sites = callers.get(func, [])
            parents = sorted({enclosing(s) for s in sites} - {None})
            for p in parents:
                pad = "   " * (depth + 1)
                mark = "" if p in seen else ""
                print(f"{pad}<- 0x{p:08X}  {label(p)}{mark}")
                if p not in seen and depth + 1 < LEVELS:
                    seen.add(p)
                    frontier.append((p, depth + 1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
