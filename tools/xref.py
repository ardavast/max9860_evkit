#!/usr/bin/env python3
"""
xref - locate a routine in a 32-bit PE by a string it references, then walk
the call graph backwards to every site that reaches it.

Used to answer "what in this application can possibly touch the SPI bus?"
without clicking every control in the UI.

    uv run --with pefile --with capstone python xref.py <exe> "<string>"
"""

from __future__ import annotations

import sys
from collections import defaultdict

import capstone
import pefile


def load(path):
    pe = pefile.PE(path, fast_load=True)
    base = pe.OPTIONAL_HEADER.ImageBase
    text = None
    for s in pe.sections:
        name = s.Name.rstrip(b"\x00").decode(errors="replace")
        if name.lower().startswith(".text") or (
            s.Characteristics & 0x20000000 and text is None
        ):
            text = s
            break
    if text is None:
        raise SystemExit("no executable section found")
    data = text.get_data()
    va = base + text.VirtualAddress
    return pe, base, text, data, va


def find_string_vas(pe, base, needle: bytes) -> list[int]:
    """Every virtual address at which `needle` appears in any section."""
    out = []
    for s in pe.sections:
        d = s.get_data()
        start = 0
        while True:
            i = d.find(needle, start)
            if i < 0:
                break
            out.append(base + s.VirtualAddress + i)
            start = i + 1
    return out


def disasm_all(data: bytes, va: int):
    """
    Resilient linear sweep. C++Builder interleaves data with code, so a plain
    disasm() stops at the first non-instruction; skip that byte and resume.
    """
    md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
    md.detail = True
    out = []
    off = 0
    n = len(data)
    while off < n:
        got = 0
        for i in md.disasm(data[off:], va + off):
            out.append(i)
            got += i.size
        off += got + 1 if got else 1
    return out


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    exe, needle = sys.argv[1], sys.argv[2].encode()

    pe, base, sec, data, text_va = load(exe)
    print(f"image base 0x{base:08X}  .text 0x{text_va:08X}  {len(data)} bytes")

    targets = find_string_vas(pe, base, needle)
    if not targets:
        print(f"string not found: {needle!r}")
        return 1
    print(f"string {needle!r} at: " + ", ".join(f"0x{v:08X}" for v in targets))

    print("disassembling .text ...")
    insns = disasm_all(data, text_va)
    print(f"  {len(insns)} instructions")

    by_addr = {i.address: n for n, i in enumerate(insns)}

    # 1. instructions that reference the string's address as an immediate
    refs = []
    tset = set(targets)
    for i in insns:
        for op in i.operands:
            if op.type == capstone.x86.X86_OP_IMM and op.imm in tset:
                refs.append(i)
                break
    print(f"\n{len(refs)} instruction(s) reference the string:")
    for i in refs:
        print(f"  0x{i.address:08X}  {i.mnemonic} {i.op_str}")

    # 2. build the global call map first. A called function's entry point must
    #    itself be a call target, which is far more reliable than matching
    #    prologues on a sweep that can misalign around embedded data.
    callers = defaultdict(list)
    for i in insns:
        if i.mnemonic == "call" and i.operands and \
           i.operands[0].type == capstone.x86.X86_OP_IMM:
            callers[i.operands[0].imm].append(i.address)
    entries = sorted(callers)
    print(f"\n{len(entries)} distinct call targets in .text")

    import bisect

    def func_start(addr: int) -> int | None:
        """Nearest call target at or below addr - i.e. the enclosing routine."""
        k = bisect.bisect_right(entries, addr) - 1
        return entries[k] if k >= 0 else None

    funcs = sorted({f for f in (func_start(i.address) for i in refs) if f})
    print("enclosing function(s): " + ", ".join(f"0x{f:08X}" for f in funcs))

    for f in funcs:
        sites = callers.get(f, [])
        print(f"\n0x{f:08X}  <- {len(sites)} direct call site(s)")
        for s in sites:
            fs = func_start(s)
            fs_txt = f"0x{fs:08X}" if fs else "?"
            print(f"    call at 0x{s:08X}   inside {fs_txt}")

        # one level further out
        parents = sorted({func_start(s) for s in sites} - {None})
        for p in parents:
            up = callers.get(p, [])
            print(f"    ^ 0x{p:08X} <- {len(up)} call site(s)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
