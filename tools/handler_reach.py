#!/usr/bin/env python3
"""
handler_reach - which of the application's UI event handlers can reach the SPI
bus (and therefore the CS8427), determined statically.

Delphi / C++Builder store published method names next to their code addresses
in the VMT method table:

    word  entry size
    dword code address
    byte  name length
    char  name[]

We recover that map, build the call graph, and walk forward from every handler.

    uv run --with pefile --with capstone python handler_reach.py <exe>
"""

from __future__ import annotations

import bisect
import re
import struct
import sys
from collections import defaultdict

import capstone
import pefile

TARGETS = {
    "CmodSpiByte":     b"CmodSpiByte(mosi=0x%2.2x)",
    "CmodSpiTransfer": b"CmodSpiTransfer(transmit buffer)",
}
NAME_RE = re.compile(rb"[A-Za-z_][A-Za-z0-9_]{4,60}")
MAX_DEPTH = 12


def published_methods(pe, base) -> dict[str, int]:
    """Recover name -> code address from the VMT published method tables."""
    out: dict[str, int] = {}
    for sec in pe.sections:
        d = sec.get_data()
        sva = base + sec.VirtualAddress
        for m in NAME_RE.finditer(d):
            name = m.group()
            i = m.start()
            if i < 7:
                continue
            namelen = d[i - 1]
            if namelen != len(name):
                continue
            size, addr = struct.unpack_from("<HI", d, i - 7)
            if size != len(name) + 7:
                continue
            # address must land inside some executable section
            for s2 in pe.sections:
                lo = base + s2.VirtualAddress
                if lo <= addr < lo + max(s2.Misc_VirtualSize, s2.SizeOfRawData) \
                   and (s2.Characteristics & 0x20000000):
                    out[name.decode()] = addr
                    break
        del d
    return out


def main() -> int:
    exe = sys.argv[1] if len(sys.argv) > 1 else \
        r"C:\Program Files (x86)\MAX9860\MAX9860.exe"
    pe = pefile.PE(exe, fast_load=True)
    base = pe.OPTIONAL_HEADER.ImageBase

    methods = published_methods(pe, base)
    print(f"recovered {len(methods)} published methods", file=sys.stderr)

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
    print(f"{len(insns)} instructions", file=sys.stderr)

    call_targets = sorted({i.operands[0].imm for i in insns
                           if i.mnemonic == "call" and i.operands
                           and i.operands[0].type == capstone.x86.X86_OP_IMM})
    # handler entry points are function starts too
    entries = sorted(set(call_targets) | set(methods.values()))

    def enclosing(addr: int) -> int | None:
        k = bisect.bisect_right(entries, addr) - 1
        return entries[k] if k >= 0 else None

    callees: dict[int, set[int]] = defaultdict(set)
    for i in insns:
        if i.mnemonic == "call" and i.operands and \
           i.operands[0].type == capstone.x86.X86_OP_IMM:
            f = enclosing(i.address)
            if f is not None:
                callees[f].add(i.operands[0].imm)

    # locate the SPI primitives by the strings they reference
    strings = {}
    for s in pe.sections:
        d = s.get_data()
        sva = base + s.VirtualAddress
        for m in re.finditer(rb"[\x20-\x7e]{6,}", d):
            strings[sva + m.start()] = m.group()

    def find_func(needle: bytes) -> int | None:
        vset = {va for va, t in strings.items() if t.startswith(needle[:24])}
        for i in insns:
            for op in i.operands:
                if op.type == capstone.x86.X86_OP_IMM and op.imm in vset:
                    return enclosing(i.address)
        return None

    spi = {}
    for nm, needle in TARGETS.items():
        f = find_func(needle)
        if f:
            spi[f] = nm
            print(f"{nm} @ 0x{f:08X}", file=sys.stderr)

    # forward reachability with memoisation
    memo: dict[int, frozenset] = {}

    def reaches(func: int, depth: int, stack: frozenset) -> frozenset:
        if func in spi:
            return frozenset({spi[func]})
        if depth <= 0 or func in stack:
            return frozenset()
        if func in memo:
            return memo[func]
        acc: set[str] = set()
        for c in callees.get(func, ()):
            acc |= reaches(c, depth - 1, stack | {func})
        r = frozenset(acc)
        if depth > 6:
            memo[func] = r
        return r

    hits, misses = [], []
    for name, addr in sorted(methods.items()):
        if not name.endswith(("Click", "Change", "Exit", "KeyPress", "MouseUp")):
            continue
        r = reaches(addr, MAX_DEPTH, frozenset())
        (hits if r else misses).append((name, addr, r))

    print("\n" + "=" * 74)
    print(f"HANDLERS THAT CAN REACH SPI  ({len(hits)})")
    print("=" * 74)
    for name, addr, r in hits:
        print(f"  0x{addr:08X}  {name:<44} {','.join(sorted(r))}")

    print(f"\nhandlers examined that cannot reach SPI: {len(misses)}")
    print("sample:", ", ".join(n for n, _, _ in misses[:12]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
