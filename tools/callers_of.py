#!/usr/bin/env python3
"""
callers_of - direct call-site xrefs for one function, with published-method
names resolved. Deliberately only ONE level: direct `call imm` instructions are
recovered reliably, whereas multi-level reachability in a C++Builder binary
needs real function-boundary analysis and produces false edges without it.

    uv run --with pefile --with capstone python callers_of.py <exe> 0x0040419A ...
"""

from __future__ import annotations

import bisect
import re
import struct
import sys
from collections import defaultdict

import capstone
import pefile

NAME_RE = re.compile(rb"[A-Za-z_][A-Za-z0-9_]{4,60}")


def published_methods(pe, base) -> dict[int, str]:
    out: dict[int, str] = {}
    execs = [(base + s.VirtualAddress,
              base + s.VirtualAddress + max(s.Misc_VirtualSize, s.SizeOfRawData))
             for s in pe.sections if s.Characteristics & 0x20000000]
    for sec in pe.sections:
        d = sec.get_data()
        for m in NAME_RE.finditer(d):
            name, i = m.group(), m.start()
            if i < 7 or d[i - 1] != len(name):
                continue
            size, addr = struct.unpack_from("<HI", d, i - 7)
            if size != len(name) + 7:
                continue
            if any(lo <= addr < hi for lo, hi in execs):
                out.setdefault(addr, name.decode())
    return out


def main() -> int:
    exe = sys.argv[1]
    wanted = [int(a, 0) for a in sys.argv[2:]]
    pe = pefile.PE(exe, fast_load=True)
    base = pe.OPTIONAL_HEADER.ImageBase
    names = published_methods(pe, base)
    print(f"{len(names)} published methods recovered\n", file=sys.stderr)

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

    callers = defaultdict(list)
    for i in insns:
        if i.mnemonic == "call" and i.operands and \
           i.operands[0].type == capstone.x86.X86_OP_IMM:
            callers[i.operands[0].imm].append(i.address)
    entries = sorted(set(callers) | set(names))

    def enclosing(a: int):
        k = bisect.bisect_right(entries, a) - 1
        return entries[k] if k >= 0 else None

    for target in wanted:
        sites = callers.get(target, [])
        nm = names.get(target, "")
        print("=" * 70)
        print(f"0x{target:08X} {nm}  <- {len(sites)} direct call site(s)")
        seen = {}
        for s in sites:
            f = enclosing(s)
            seen.setdefault(f, []).append(s)
        for f, ss in sorted(seen.items(), key=lambda kv: kv[0] or 0):
            label = names.get(f, "(not a published method)")
            at = ", ".join(f"0x{x:08X}" for x in ss)
            print(f"   from 0x{f:08X}  {label:<38} at {at}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
