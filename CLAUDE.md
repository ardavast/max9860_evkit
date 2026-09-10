# MAX9860 EVKIT

Host software for the Maxim MAX9860 evaluation board, replacing the vendor
Windows application.

**Start here:** [`docs/wire-protocol.md`](docs/wire-protocol.md) is the complete
protocol reference — command set, pin map, clock tree, register maps, bring-up
order. It is the output of the reverse-engineering effort; this file is about
*how that was done*, so it can be redone when something doesn't match.

## Why this project exists

The board produces no sound on its own, and its clock tree is not reachable from
the outside. `CLK_SEL`, `OX_SEL` and both oscillator enables land on MAXQ2000
port pins (P0.1, P0.2, P0.4, P0.5) and on no jumper. So even if you wire your own
I²S/I²C to JU8 and ignore the vendor software entirely — which works fine for the
codec — you still cannot choose or gate the master clock.

**The two things that genuinely require this protocol are clock control and
reading back board state.** Everything else in the reference is incidental.

## Layout

```
docs/          protocol reference (md + the html published as an artifact)
tools/         reverse-engineering and debugging tools — see below
<impl>/        each implementation gets its own subdirectory
```

## Hardware and environment

| | |
|---|---|
| Vendor app | `C:\Program Files (x86)\MAX9860\MAX9860.exe` (32-bit, C++Builder 2007) |
| Link | 460800 8N1, FTDI FT232 (`0403:6001`) |
| Transports | FTDI D2XX (`USB:0`) **or** `\\.\COM4` — mutually exclusive |
| Firmware | `Maxim MINIQUSB V01.05.39` |
| Toolchain | `uv` for Python; no compiler needed for any of this |

---

# Debugging and reverse-engineering

## Sniffing the wire — the primary tool

`tools/cmod_sniff.py` hooks the running vendor app with frida and decodes its
traffic into readable transactions. This is how essentially everything in the
reference was established.

```bash
# live capture — exercise the app while it runs
uv run --with frida python tools/cmod_sniff.py --process MAX9860.exe --seconds 30 --no-poll

# re-decode a saved capture (no hardware needed — iterate the decoder freely)
python tools/cmod_sniff.py --decode capture.jsonl --show-raw
```

Capture always writes raw JSONL alongside the transcript. **Improve the decoder
and re-run it against old captures** rather than re-running experiments.

Options that matter:

* `--no-poll` — hides the device-present probe (`A0 03`), which is ~93% of all
  traffic and buries everything else
* `--show-raw` — appends raw bytes to each row
* `--raw-spi` — don't fold `/CS` windows into CS8427 register operations
* `--transport d2xx|comm` — override the auto-selected capture layer
* `--board none` — drop the MAX9860 pin-name annotations for a different kit

### Why it hooks where it does

The agent hooks `FT_Write`/`FT_Read` **and** `WriteFile`/`ReadFile`, because the
app can be configured onto either transport. Two consequences, both handled:

* An app on D2XX produces **every command twice** — `FT_Write` calls down into
  `WriteFile`. The decoder auto-selects one layer (D2XX wins).
* The Win32 layer also carries the app's own log-file writes. The agent tracks
  COM handles via `CreateFileA/W`; handles opened *before* you attach can't be
  learned, so on the COM transport use the app's *Close / Reopen port* once
  after starting a capture.

### frida gotchas

* frida ≥ 17 removed `Module.findExportByName`. Use `Module.findGlobalExportByName`
  with fallbacks — `tools/cmod_sniff.py` has a version-tolerant `resolve()`.
* Python block-buffers stdout when redirected; run with `python -u`.
* Don't write read loops that extend their deadline on every byte — the module
  can stream continuously (see `0xA9` below) and the loop never exits.

## Talking to the board directly

With the vendor app **closed**, the port is free and you can drive the module
yourself. This is the fastest way to test a hypothesis about the protocol.

```bash
uv run --with pyserial python tools/cs8427_rw.py     # read/write probe of the CS8427
```

Both `tools/cs8427_read.py` and `tools/cs8427_rw.py` are small, readable
templates for this — copy one and change the command bytes.

Watch out for:

* **Drain the banner first.** The module emits `"Maxim MINIQUSB V01.05.39 >"`
  (26 bytes, no terminator) on port open, and it will otherwise arrive stuck to
  the front of your first reply.
* **Never send `0xA9`.** It starts a continuous ASCII echo that saturates the
  link and only stops on port close/reopen.
* Set `dtr=False, rts=False` explicitly — pyserial asserts them by default and
  the app exposes a `DTR High=Reset` option, so the polarity matters.

## Static analysis of the vendor binary

Useful for "what *can* reach this code path", which clicking can never answer
exhaustively.

```bash
# find a routine by a log string it references, list its direct callers
uv run --with pefile --with capstone python tools/xref.py \
  "C:\Program Files (x86)\MAX9860\MAX9860.exe" "CmodSpiByte(mosi=0x%2.2x)"

# direct call-site xrefs with Delphi published-method names resolved
uv run --with pefile --with capstone python tools/callers_of.py \
  "C:\Program Files (x86)\MAX9860\MAX9860.exe" 0x0040419A
```

How it works: each `Cmod*` routine references a unique log string, so you can
locate the function from the string. Delphi stores published method names next
to their code addresses in the VMT method table (`word size, dword addr, byte
namelen, char name[]`), which recovers ~512 handler names like
`HardwareReset1Click`.

**Known-good addresses** (this build): `CmodSpiByte` `0x0040419A`,
`CmodSpiTransfer` `0x004047AC`, `HardwareReset1Click` `0x00435750`,
`ReadStatus1Click` `0x00436234`, the six CS8427 register writers
`0x0043C234/C46C/C6A4/C8C8/CB98/CDD0` (published as `Edit29..34KeyPress`).

### What does *not* work — don't repeat it

`tools/spi_paths.py` and `tools/handler_reach.py` attempt **multi-level**
reachability. **Their output is not trustworthy** and they are kept only as a
record of the dead end. Function boundaries are recovered by "nearest call target
at or below the address", which is fine for one hop but merges small functions a
few levels up; in a VCL app one false edge into a shared dispatcher makes
everything appear to reach everything. `handler_reach.py` cheerfully reports that
`TrackBar9Change` can reach the SPI bus.

**One level of direct `call imm` xrefs is reliable. Anything deeper needs real
function-boundary analysis (Ghidra/IDA class).** A negative conclusion drawn from
these tools is worthless — verify negatives empirically.

---

# Driving the vendor application

Sometimes you need the app itself — to generate traffic, or to compare against.

## Getting to the useful UI

The command module window is created at startup but hidden.

1. **Tools → Debug Mode** on the main window opens *Maxim Command Module
   Interface* (menu ID `16` on `TForm1`).
2. **Options → Detail → Logging → Tab Sheet Visible** exposes the Logging tab
   (menu ID `57` on `TM2EAMForm`).
3. On the Logging tab, **More Filter Choices >>** reveals additional filters
   including **Raw comm port operations**.

Default filters log *failures only*, which is why the log looks empty. Enable
*Attempting operation*, *Successful completion* and *Pin Read/Write* to see
anything useful.

Window classes: `TForm1` (main), `TM2EAMForm` (command module),
`TApplication` (hidden owner window — this is what `MainWindowHandle` returns).

## Vendor-app quirks that will waste your time

* **Controls on an inactive tab sheet ignore `BM_CLICK`.** Switch to the tab
  first (a real click via the Terminator MCP works).
* **VCL creates tab-sheet children lazily** — a control on a never-shown tab has
  no window handle yet and won't enumerate.
* **Radio buttons inside a `TRadioGroup` are class `TGroupButton`**, not
  `TRadioButton`. Filtering on the latter finds nothing.
* **`SendMessage` to a button that opens a modal dialog blocks forever.** Use
  `PostMessage` for anything that might open a dialog.
* **The log memo silently stops appending when full**, and **never**
  `SetWindowText` it to clear — that desyncs VCL's `Lines` cache and kills
  logging until restart. Use the *Clear Window* button, or *Begin Saving…* to a
  file.
* The app's own log is **API-level**, not wire-level (`CmodPinWrite(Pin = K2,
  value = 1)`). For actual bytes you need the frida sniffer.
* `Disconnect` does **not** release the D2XX handle; only exiting does.

## GUI automation

The **Terminator MCP** (`terminator-mcp-agent`, configured in the personfilter
repo's `.mcp.json`) drives Windows UI via the accessibility tree. Genuinely
useful for clicking tabs and buttons, and it reads windowed controls exactly —
including the app's I²C log `ListItem`s.

Its limits, learned the hard way:

* **It sees one window per process — whichever is topmost.** To reach the
  command module window, `SetForegroundWindow` it first via Win32; the main
  window then disappears from its listing. `title` and `tree_from_selector` do
  not reach a second window.
* When it can't find the target it may **silently act on the wrong window** —
  a failed `get_window_tree` returned a `tree_error` field *alongside* a
  successful-looking OCR of a different window.
* **`TLabel` is invisible to it.** VCL `TLabel` is a `TGraphicControl` — no
  HWND, no UIA provider. The pin labels, the Status column, and most static text
  in this app cannot be read from the accessibility tree at all.

### Reading non-windowed text

`tools/Ocr-Window.ps1` captures a window with `PrintWindow`, upscales, and OCRs
it with the built-in `Windows.Media.Ocr` (nothing to install), returning words
with bounding boxes rescaled to original window coordinates.

```powershell
.\tools\Ocr-Window.ps1 -Hwnd 132380 -Scale 4 -Filter '^(K\d+|P[34]\.\d+)'
```

**Manage expectations:** it recovered roughly 8 of 26 labels on this app's 9-px
MS Sans Serif. Bicubic ×4 was the best of the sweep; nearest-neighbour scored
zero. If you need reliable text from small UI, either set a per-app DPI override
so the app renders larger natively, or use a better OCR engine (RapidOCR is
`uv`-installable with no system dependencies). For anything read visually,
capturing the window and looking at the image is more dependable than OCR.

### Win32 recipes that work

Raw P/Invoke from PowerShell was more reliable than the MCP for most things:

* `EnumWindows` / `EnumChildWindows` with class + text — finds everything
  windowed. **Collect into an `ArrayList` from the delegate**; output from a
  PowerShell delegate does not flow to the pipeline.
* `GetMenu` / `GetSubMenu` / `GetMenuString` / `GetMenuState` — dumps menu trees
  *with checked state*, which is how the hidden Logging tab was found.
* `GetMenuItemID` + `PostMessage(hwnd, WM_COMMAND, id, 0)` — fire a menu item
  without opening the menu.
* `CB_GETCOUNT` / `CB_GETLBTEXT` / `CB_SETCURSEL` + `WM_COMMAND`/`CBN_SELCHANGE`
  to the parent — read and drive combo boxes (a bare `CB_SETCURSEL` fires no
  `OnChange`).
* `PrintWindow(hwnd, hdc, 2)` — captures a window even when hidden or occluded.
* **64-bit PowerShell cannot enumerate a 32-bit process's modules.** Both
  `tasklist /M` and `Get-Process().Modules` show only WOW64 stubs. Use
  `C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe`.

---

# Lessons worth keeping

* **The app's log cannot answer wire-level questions.** It is API-level by
  construction. Several hours went into filter combinations before this was
  clear. Go to the frida sniffer early.
* **Verify negatives empirically.** The static analysis produced a confident,
  wrong negative ("no radio handler reaches the CS8427"). One capture disproved
  it in seconds.
* **A register reading `0x00` means it contains zero.** It is not evidence of a
  write-only register. Write a distinct value and read it back before concluding
  anything about readability.
* **Write-then-read-back everything.** `B0` only says the bus cycle completed.
* **Capture raw, decode separately.** Every decoder bug found here was fixed and
  re-verified against saved captures without touching hardware.
