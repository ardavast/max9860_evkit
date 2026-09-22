#!/usr/bin/env python3
"""
cmod_sniff - capture and decode the Maxim command-module serial protocol.

The command-module firmware (MINIQUSB / CMOD232 / CMAXQUSB and the on-board
equivalents found on many Maxim/ADI evaluation kits) speaks a compact binary
request/response protocol. This tool hooks a running vendor application and
renders that traffic as readable transactions.

    live capture:   uv run --with frida python cmod_sniff.py --process MAX9860.exe
    re-decode:      python cmod_sniff.py --decode capture.jsonl

Capture always writes a raw .jsonl alongside the decoded transcript, so the
decoder can be improved and re-run against traffic you already collected.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass, field
from typing import Iterable, Iterator

# --------------------------------------------------------------------------
# injected agent - deliberately minimal: capture bytes, timestamp, forward.
# All decoding happens host-side so it can be iterated without re-injecting.
# --------------------------------------------------------------------------

AGENT_JS = r"""
function resolve(mod, name) {
    // frida >= 17 dropped Module.findExportByName
    try { if (Module.findGlobalExportByName) {
        var a = Module.findGlobalExportByName(name); if (a) return a; } } catch (e) {}
    try { if (Module.findExportByName) {
        var b = Module.findExportByName(mod, name); if (b) return b; } } catch (e) {}
    try { return Process.getModuleByName(mod).findExportByName(name); } catch (e) {}
    return null;
}

function hex(buf) {
    var u = new Uint8Array(buf), out = [];
    for (var i = 0; i < u.length; i++)
        out.push(('0' + u[i].toString(16).toUpperCase()).slice(-2));
    return out.join(' ');
}

var MAX = 4096;
var hooked = [];

// FTDI D2XX transport
[['FT_Write', 'TX'], ['FT_Read', 'RX']].forEach(function (pair) {
    var addr = resolve('FTD2XX.dll', pair[0]);
    if (!addr) return;
    Interceptor.attach(addr, {
        onEnter: function (a) { this.buf = a[1]; this.len = a[2].toInt32(); },
        onLeave: function () {
            if (this.len <= 0 || this.len > MAX) return;
            send({ dir: pair[1], via: 'd2xx', hex: hex(this.buf.readByteArray(this.len)) });
        }
    });
    hooked.push(pair[0]);
});

// Win32 serial transport (the app can be configured either way).
// Track which handles are COM ports so we don't mistake the application's own
// log-file writes for protocol traffic.
var comHandles = {};
[['CreateFileA', false], ['CreateFileW', true]].forEach(function (pair) {
    var addr = resolve('kernel32.dll', pair[0]);
    if (!addr) return;
    Interceptor.attach(addr, {
        onEnter: function (a) {
            try { this.name = pair[1] ? a[0].readUtf16String() : a[0].readAnsiString(); }
            catch (e) { this.name = null; }
        },
        onLeave: function (ret) {
            if (this.name && this.name.toUpperCase().indexOf('COM') !== -1)
                comHandles[ret.toString()] = true;
        }
    });
    hooked.push(pair[0]);
});

var wf = resolve('kernel32.dll', 'WriteFile');
if (wf) {
    Interceptor.attach(wf, {
        onEnter: function (a) {
            this.h = a[0].toString(); this.buf = a[1]; this.len = a[2].toInt32();
        },
        onLeave: function () {
            if (this.len <= 0 || this.len > 64) return;   // serial writes are tiny
            send({ dir: 'TX', via: 'comm', known: (this.h in comHandles),
                   hex: hex(this.buf.readByteArray(this.len)) });
        }
    });
    hooked.push('WriteFile');
}

var rf = resolve('kernel32.dll', 'ReadFile');
if (rf) {
    Interceptor.attach(rf, {
        onEnter: function (a) { this.h = a[0].toString(); this.buf = a[1]; this.pn = a[3]; },
        onLeave: function () {
            var n = 0;
            try { n = this.pn.readU32(); } catch (e) { return; }
            if (n <= 0 || n > 64) return;
            send({ dir: 'RX', via: 'comm', known: (this.h in comHandles),
                   hex: hex(this.buf.readByteArray(n)) });
        }
    });
    hooked.push('ReadFile');
}

send({ dir: 'READY', hooked: hooked.join(', ') });
"""

# --------------------------------------------------------------------------
# board profiles - what each K-pin is wired to. Purely cosmetic annotation;
# the protocol decode below is board-independent.
# --------------------------------------------------------------------------

BOARDS: dict[str, dict[int, str]] = {
    "max9860": {
        1: "IRQ (input)",
        2: "CLK_SEL",
        3: "OX_SEL",
        4: "CS8427_RST",
        5: "13MHz OE",
        6: "12.288MHz OE",
        9: "CS8427 /CS",
        10: "SCL",
        11: "SDA",
        12: "CDIN",
    },
    "none": {},
}

STATUS = {0xF0: "ok", 0xB0: "ok", 0xBF: "ok", 0xFA: "ERR/NA"}

# Register names as the vendor application itself labels them. The two parts
# share several addresses but sit on different buses, so the bus picks the map.
MAX9860_REGS = {
    0x00: "Interrupt Status", 0x02: "Interrupt Enable", 0x03: "System Clock",
    0x04: "Clock Control High", 0x05: "Clock Control Low", 0x06: "Interface",
    0x07: "Interface", 0x08: "Voice Filters", 0x09: "DAC Attenuation",
    0x0A: "ADC Output", 0x0B: "Gain / Sidetone", 0x0C: "MIC Left",
    0x0E: "AGC", 0x0F: "NG/AGC", 0x10: "System",
    0xF8: "Test Points", 0xF9: "VIO Tests", 0xFA: "I2S Tests",
    0xFB: "Analog Test 1", 0xFC: "Analog Test 2",
    0xFD: "Analog Test 3", 0xFE: "Analog Test 4",
}

CS8427_REGS = {
    0x01: "Control 1", 0x02: "Control 2", 0x03: "Data Flow",
    0x04: "Clock Source", 0x05: "Serial Input", 0x06: "Serial Output",
}

# CS8427 control port: chip address byte, then MAP (bit 7 = auto-increment),
# then data. 0x20 = write, 0x21 = read.
CS8427_CHIP_W, CS8427_CHIP_R = 0x20, 0x21

# I2C sub-commands under the 0xA0 prefix
A0_SUB = {
    0x00: ("i2c start", 0),
    0x01: ("i2c repeated start", 0),
    0x02: ("get capabilities", 3),
    0x04: ("scl timeout", 5),
    0x06: ("smbus write block", 0),
    0x07: ("smbus read block", 0),
}


@dataclass
class Event:
    dir: str
    via: str
    data: bytes
    t: float
    known: bool = False


def select_transport(events: list[Event], mode: str) -> list[Event]:
    """
    The same bytes can be seen at two layers: FT_Write calls down into
    WriteFile, so an app on D2XX produces a duplicate of every command. The
    Win32 layer also carries unrelated file I/O (the app's own log). Pick one
    layer and keep only that.
    """
    if mode == "d2xx":
        return [e for e in events if e.via == "d2xx"]
    if mode == "comm":
        chosen = [e for e in events if e.via == "comm"]
    elif any(e.via == "d2xx" for e in events):
        return [e for e in events if e.via == "d2xx"]
    else:
        chosen = [e for e in events if e.via == "comm"]
    # if we learned the real COM handle, drop everything that isn't it
    if any(e.known for e in chosen):
        chosen = [e for e in chosen if e.known]
    return chosen


@dataclass
class Txn:
    t: float
    tx: bytes
    rx: bytes = b""
    op: str = ""
    detail: str = ""
    status: str = ""
    unknown: bool = False
    poll: bool = False


def _pins(board: dict[int, str], k: int) -> str:
    name = board.get(k)
    return f"K{k} ({name})" if name else f"K{k}"


def decode(txn: Txn, board: dict[int, str]) -> None:
    """Fill in op/detail/status on a transaction from its raw bytes."""
    tx, rx = txn.tx, txn.rx
    if not tx:
        txn.op, txn.unknown = "(reply with no request)", True
        return

    c = tx[0]

    # ---- pin read: 0xE0 | K -------------------------------------------
    if 0xE0 <= c <= 0xEF:
        k = c & 0x0F
        txn.op = f"pin read  {_pins(board, k)}"
        if rx:
            v = rx[0]
            if v == 0xFA:
                txn.detail, txn.status = "pin not available", "ERR/NA"
            else:
                txn.detail = "HIGH" if v else "LOW"
                txn.status = "ok"
        return

    # ---- pin write: 0xF0 | K ------------------------------------------
    if 0xF0 <= c <= 0xFF:
        k = c & 0x0F
        val = tx[1] if len(tx) > 1 else None
        txn.op = f"pin write {_pins(board, k)}"
        txn.detail = "" if val is None else ("HIGH" if val else "LOW")
        if rx:
            txn.status = STATUS.get(rx[0], f"?{rx[0]:02X}")
        return

    # ---- SPI byte: 0xAF <mosi> ----------------------------------------
    if c == 0xAF:
        mosi = tx[1] if len(tx) > 1 else 0
        txn.op = "spi byte"
        miso = f"{rx[0]:02X}" if rx else "--"
        txn.detail = f"mosi=0x{mosi:02X} miso=0x{miso}"
        if len(rx) > 1:
            txn.status = STATUS.get(rx[1], f"?{rx[1]:02X}")
        return

    # ---- I2C combined write/read: A0 05 wn rn addr [wdata...] ---------
    if c == 0xA0 and len(tx) > 1 and tx[1] == 0x05:
        wn = tx[2] if len(tx) > 2 else 0
        rn = tx[3] if len(tx) > 3 else 0
        addr = tx[4] if len(tx) > 4 else 0
        wdata = tx[5:5 + wn]
        if wdata:
            rname = MAX9860_REGS.get(wdata[0]) if addr in (0x20, 0x21) else None
            reg = f"reg 0x{wdata[0]:02X}" + (f" {rname}" if rname else "")
        else:
            reg = "no reg"
        txn.op = f"i2c 0x{addr:02X}"
        rdata = rx[:rn]
        parts = [reg]
        if wn > 1:
            parts.append("write " + " ".join(f"{b:02X}" for b in wdata[1:]))
        if rn:
            got = " ".join(f"{b:02X}" for b in rdata) if rdata else "--"
            parts.append(f"read {rn} -> {got}")
        txn.detail = ", ".join(parts)
        if len(rx) > rn:
            txn.status = STATUS.get(rx[rn], f"?{rx[rn]:02X}")
        return

    # ---- device-present probe: A0 03 <addr> ---------------------------
    # The vendor app runs this continuously while "Auto Connect" is on, so it
    # dominates any capture. --no-poll hides it from the transcript.
    if c == 0xA0 and len(tx) > 1 and tx[1] == 0x03:
        txn.op = "i2c quick"
        txn.poll = True
        if len(tx) > 2:
            present = bool(rx) and rx[0] == 0xB0
            txn.detail = f"0x{tx[2]:02X} " + ("present" if present else "absent")
        if rx:
            txn.status = STATUS.get(rx[0], f"?{rx[0]:02X}")
        return

    # ---- other A0 sub-commands ----------------------------------------
    if c == 0xA0 and len(tx) > 1 and tx[1] in A0_SUB:
        txn.op = A0_SUB[tx[1]][0]
        if rx:
            txn.detail = " ".join(f"{b:02X}" for b in rx)
        return

    # ---- I2C low-level primitives -------------------------------------
    if c == 0xA1:
        txn.op = "i2c write byte"
        txn.detail = f"0x{tx[1]:02X}" if len(tx) > 1 else ""
        return
    if c == 0xA2:
        ack = "ACK" if len(tx) > 1 and tx[1] else "NACK"
        txn.op = f"i2c read byte +{ack}"
        txn.detail = f"0x{rx[0]:02X}" if rx else ""
        return
    if c == 0xA3:
        txn.op = "i2c stop"
        return
    if c == 0xA4:
        txn.op = "i2c pulse 9 clocks"
        return
    if c == 0xA9:
        txn.op = "!! 0xA9 ECHO MODE"
        txn.detail = "floods the link until the port is reopened"
        txn.status = "DANGER"
        return

    txn.op = f"unknown 0x{c:02X}"
    txn.unknown = True


def pair(events: Iterable[Event]) -> Iterator[Txn]:
    """Group the stream into request/response transactions."""
    cur: Txn | None = None
    for ev in events:
        if ev.dir == "TX":
            if cur is not None:
                yield cur
            cur = Txn(t=ev.t, tx=ev.data)
        elif ev.dir == "RX":
            if cur is None:
                cur = Txn(t=ev.t, tx=b"")
            cur.rx += ev.data
    if cur is not None:
        yield cur


def cmd_len(b: bytes) -> int:
    """Length of the command beginning at b[0], or 0 if not recognised."""
    c = b[0]
    if 0xE0 <= c <= 0xFF or c in (0xAF, 0xA1, 0xA2):
        return 2
    if c in (0xA3, 0xA4):
        return 1
    if c == 0xA0:
        if len(b) < 2:
            return 0
        if b[1] == 0x05:
            return 5 + b[2] if len(b) > 2 else 0
        if b[1] == 0x03:
            return 3
        return 2
    return 0


def reply_len(cmd: bytes) -> int:
    """Expected reply size, so batched replies can be split alongside."""
    c = cmd[0]
    if 0xE0 <= c <= 0xFF:
        return 1
    if c == 0xAF:
        return 2
    if c == 0xA0 and len(cmd) > 1:
        if cmd[1] == 0x05:
            return (cmd[3] if len(cmd) > 3 else 0) + 1
        if cmd[1] == 0x03:
            return 1
        if cmd[1] == 0x02:
            return 3
        if cmd[1] == 0x04:
            return 5
    return 0


def explode(txns: Iterable[Txn]) -> list[Txn]:
    """
    The application batches several commands into one write - e.g. a CS8427
    register write goes out as `AF 20 AF 04 AF 08` with `FF BF FF BF FF BF`
    coming back. Split those into individual transactions.
    """
    out: list[Txn] = []
    for x in txns:
        cmds, b, i = [], x.tx, 0
        while i < len(b):
            n = cmd_len(b[i:])
            if n <= 0 or i + n > len(b):
                cmds = []
                break
            cmds.append(b[i:i + n])
            i += n
        if len(cmds) <= 1:
            out.append(x)
            continue
        off = 0
        for cmd in cmds:
            rl = reply_len(cmd)
            out.append(Txn(t=x.t, tx=cmd, rx=x.rx[off:off + rl] if rl else b""))
            off += rl
    return out


def _cs8427_txn(t: float, xfer: list[tuple[int, int | None]],
                unterminated: bool = False) -> Txn:
    """Build one transaction from the bytes clocked while /CS was asserted."""
    mosi = bytes(m for m, _ in xfer)
    miso = bytes((s if s is not None else 0) for _, s in xfer)
    txn = Txn(t=t, tx=mosi, rx=miso, op="cs8427")

    if len(mosi) < 2:
        txn.op = "cs8427 (short)"
        txn.detail = " ".join(f"{b:02X}" for b in mosi)
        txn.unknown = True
        return txn

    chip, mapb = mosi[0], mosi[1]
    incr = bool(mapb & 0x80)
    reg = mapb & 0x7F
    name = CS8427_REGS.get(reg)
    label = f"0x{reg:02X}" + (f" {name}" if name else "")

    if chip == CS8427_CHIP_W:
        data = mosi[2:]
        txn.op = "cs8427 write"
        txn.detail = f"{label}{'+' if incr else ''} <- " + (
            " ".join(f"{b:02X}" for b in data) if data else "(map only)")
    elif chip == CS8427_CHIP_R:
        data = miso[2:]
        txn.op = "cs8427 read"
        txn.detail = f"{label}{'+' if incr else ''} -> " + (
            " ".join(f"{b:02X}" for b in data) if data else "(no data)")
    else:
        # not the control-port framing we expect - show it rather than mislabel
        txn.op = "spi burst"
        txn.detail = "mosi " + " ".join(f"{b:02X}" for b in mosi)
        txn.unknown = True
        return txn

    txn.status = "unterminated" if unterminated else "ok"
    return txn


def fold_cs8427(txns: Iterable[Txn], cs_pin: int = 9) -> list[Txn]:
    """
    Collapse `/CS low - AF bytes - /CS high` into a single register operation.
    Anything outside a CS window passes through untouched.
    """
    out: list[Txn] = []
    buf: list[tuple[int, int | None]] | None = None
    start = 0.0
    for x in txns:
        head = x.tx[0] if x.tx else None
        if head == (0xF0 | cs_pin) and len(x.tx) > 1:
            if x.tx[1] == 0:                       # /CS asserted
                buf, start = [], x.t
                continue
            if buf is not None:                    # /CS released
                out.append(_cs8427_txn(start, buf))
                buf = None
                continue
        if buf is not None and head == 0xAF:
            buf.append((x.tx[1] if len(x.tx) > 1 else 0,
                        x.rx[0] if x.rx else None))
            continue
        out.append(x)
    if buf:
        out.append(_cs8427_txn(start, buf, unterminated=True))
    return out


def render(txns: list[Txn], show_raw: bool) -> str:
    lines = []
    head = f"{'t (s)':>9}  {'operation':<28} {'detail':<44} {'status':<7}"
    if show_raw:
        head += "  raw"
    lines.append(head)
    lines.append("-" * len(head))
    t0 = txns[0].t if txns else 0.0
    for x in txns:
        row = (f"{x.t - t0:9.3f}  {x.op:<28} {x.detail:<44} {x.status:<7}")
        if show_raw:
            tx = " ".join(f"{b:02X}" for b in x.tx)
            rx = " ".join(f"{b:02X}" for b in x.rx)
            row += f"  {tx} -> {rx}"
        lines.append(row)
    return "\n".join(lines)


def summarise(txns: list[Txn]) -> str:
    counts: dict[str, int] = {}
    unknown: dict[str, int] = {}
    for x in txns:
        key = x.op.split("(")[0].strip()
        counts[key] = counts.get(key, 0) + 1
        if x.unknown:
            raw = " ".join(f"{b:02X}" for b in x.tx[:4])
            unknown[raw] = unknown.get(raw, 0) + 1
    out = [f"\n{len(txns)} transactions"]
    for k, v in sorted(counts.items(), key=lambda kv: -kv[1]):
        out.append(f"  {v:5d}  {k}")
    if unknown:
        out.append("\nUNDECODED - likely new protocol, worth a look:")
        for k, v in sorted(unknown.items(), key=lambda kv: -kv[1]):
            out.append(f"  {v:5d}  {k}")
    return "\n".join(out)


def capture(process: str, seconds: int, raw_path: str,
            spawn: str | None = None) -> list[Event]:
    import frida

    events: list[Event] = []
    start = time.time()
    if spawn:
        # Spawn suspended so the hooks are in place before the app's first
        # instruction. Attaching to an already-running process cannot see what
        # it did at startup - and this app does a full blind reset there.
        device = frida.get_local_device()
        pid = device.spawn([spawn])
        session = device.attach(pid)
    else:
        device = pid = None
        session = frida.attach(process)
    script = session.create_script(AGENT_JS)
    raw = open(raw_path, "w", encoding="utf-8")

    def on_message(msg, _data):
        if msg.get("type") != "send":
            print(f"[agent] {msg}", file=sys.stderr)
            return
        p = msg["payload"]
        if p.get("dir") == "READY":
            print(f"[hooked: {p['hooked']}]", file=sys.stderr)
            return
        rec = {"t": time.time() - start, "dir": p["dir"],
               "via": p.get("via", "?"), "known": bool(p.get("known")),
               "hex": p["hex"]}
        raw.write(json.dumps(rec) + "\n")
        events.append(Event(rec["dir"], rec["via"],
                            bytes.fromhex(rec["hex"].replace(" ", "")),
                            rec["t"], rec["known"]))

    script.on("message", on_message)
    script.load()
    if spawn:
        device.resume(pid)
        start = time.time()   # t=0 is the app's first instruction
        print(f"[spawned pid {pid}, capturing {seconds}s from launch]",
              file=sys.stderr)
    else:
        print(f"[capturing {seconds}s from {process} - exercise the app now]",
              file=sys.stderr)
    try:
        time.sleep(seconds)
    except KeyboardInterrupt:
        pass
    session.detach()
    raw.close()
    print(f"[raw capture: {raw_path}]", file=sys.stderr)
    return events


def load(path: str) -> list[Event]:
    events = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            events.append(Event(r["dir"], r.get("via", "?"),
                                bytes.fromhex(r["hex"].replace(" ", "")),
                                r["t"], bool(r.get("known"))))
    return events


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--process", default="MAX9860.exe",
                    help="process to attach to (default: MAX9860.exe)")
    ap.add_argument("--spawn", metavar="EXE",
                    help="launch EXE suspended and capture from its first "
                         "instruction, instead of attaching to a running "
                         "process - the only way to see startup traffic")
    ap.add_argument("--seconds", type=int, default=30,
                    help="capture duration (default: 30)")
    ap.add_argument("--decode", metavar="FILE",
                    help="re-decode a saved .jsonl capture instead of attaching")
    ap.add_argument("--raw", metavar="FILE", default="capture.jsonl",
                    help="where to write the raw capture (default: capture.jsonl)")
    ap.add_argument("--board", choices=sorted(BOARDS), default="max9860",
                    help="pin-name annotations (default: max9860)")
    ap.add_argument("--show-raw", action="store_true",
                    help="append raw bytes to every row")
    ap.add_argument("--no-poll", action="store_true",
                    help="hide the app's continuous device-present probe "
                         "(A0 03), which otherwise dominates the transcript")
    ap.add_argument("--raw-spi", action="store_true",
                    help="show every SPI byte separately instead of folding "
                         "each /CS window into one CS8427 register operation")
    ap.add_argument("--transport", choices=("auto", "d2xx", "comm"), default="auto",
                    help="which capture layer to decode (default: auto - prefers "
                         "D2XX, since FT_Write also shows up as WriteFile)")
    args = ap.parse_args()

    events = load(args.decode) if args.decode else capture(
        args.process, args.seconds, args.raw, args.spawn)

    if not events:
        print("no traffic captured - is the app connected and are you "
              "exercising it during the capture window?", file=sys.stderr)
        return 1

    total = len(events)
    events = select_transport(events, args.transport)
    if not events:
        print(f"no {args.transport} traffic in {total} captured events",
              file=sys.stderr)
        return 1
    if len(events) != total:
        print(f"[{total - len(events)} events dropped as duplicate layer or "
              f"non-serial I/O; decoding {len(events)}]", file=sys.stderr)

    board = BOARDS[args.board]
    txns = explode(pair(events))
    for t in txns:
        decode(t, board)
    if not args.raw_spi:
        txns = fold_cs8427(txns)

    shown = [t for t in txns if not (args.no_poll and t.poll)]
    hidden = len(txns) - len(shown)
    if hidden:
        print(f"[{hidden} device-present polls hidden; still counted below]",
              file=sys.stderr)
    print(render(shown, args.show_raw))
    print(summarise(txns))
    return 0


if __name__ == "__main__":
    sys.exit(main())
