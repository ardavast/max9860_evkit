# MAX9860 EVKIT — control map

Which register bits each control of the vendor application's main window drives.
[`wire-protocol.md`](wire-protocol.md) covers the wire; this covers what the host
software puts on it.

Every row was established by driving the vendor application under
[`../tools/cmod_sniff.py`](../tools/cmod_sniff.py) and reading the captured
writes. Anything not confirmed that way is called out as such.

Bit names are transcribed from the vendor app's own Registers and CS8427 tabs
(screenshots in [`vendor-ui/`](vendor-ui/)).

---

## 1. Register bit map

Cross-checked against the reset values the app displays: `0x09` = `0x06`
highlights `DVA1|DVA0`, `0x0A` = `0x33` highlights `A1L1|A1L0|AVL1|AVL0`,
`0x0C` = `0x14` highlights `PGAM4|PGAM2`, and `0x10` = `0x8B` decodes as
`/SHDN|DACEN|ADVEN|AD1EN`.

| Reg | Name | B7 | B6 | B5 | B4 | B3 | B2 | B1 | B0 |
|---|---|---|---|---|---|---|---|---|---|
| `0x00` | Interrupt Status | CLD | SLD | ULK | SPOC | | | | |
| `0x01` | NG/AGC | NG2 | NG1 | NG0 | AGC4 | AGC3 | AGC2 | AGC1 | AGC0 |
| `0x02` | Interrupt Enable | ICLD | ISLD | IULK | ISPOC | | | | |
| `0x03` | System Clock | | | PSCLK1 | PSCLK0 | | FREQ1 | FREQ0 | 16kHz |
| `0x04` | Clock Control High | PLL | N14 | N13 | N12 | N11 | N10 | N9 | N8 |
| `0x05` | Clock Control Low | N7 | N6 | N5 | N4 | N3 | N2 | N1 | N0 |
| `0x06` | Interface | MAS | WCI | DBCI | DDLY | HIZ | PCM | | |
| `0x07` | Interface | | | ABCI | ADLY | ST | BS2 | BS1 | BS0 |
| `0x08` | Voice Filters | AVFLT3 | AVFLT2 | AVFLT1 | AVFLT0 | DVFLT3 | DVFLT2 | DVFLT1 | DVFLT0 |
| `0x09` | DAC Attenuation | DVA6 | DVA5 | DVA4 | DVA3 | DVA2 | DVA1 | DVA0 | |
| `0x0A` | ADC Output | A1L3 | A1L2 | A1L1 | A1L0 | AVL3 | AVL2 | AVL1 | AVL0 |
| `0x0B` | Gain / Sidetone | | DVG1 | DVG0 | DVST4 | DVST3 | DVST2 | DVST1 | DVST0 |
| `0x0C` | MIC Left | | PAM1 | PAM2 | PGAM4 | PGAM3 | PGAM2 | PGAM1 | PGAM0 |
| `0x0E` | AGC | SRC | RLS2 | RLS1 | RLS0 | ATK1 | ATK0 | HLD1 | HLD0 |
| `0x0F` | NG/AGC | ANTH3 | ANTH2 | ANTH1 | ANTH0 | AGCTH3 | AGCTH2 | AGCTH1 | AGCTH0 |
| `0x10` | System | /SHDN | | | | DACEN | | ADVEN | AD1EN |

**`DVA` sits at bits 7:1, not 7:0.** The register holds twice the level. Slider
10 wrote `0x14`, slider 40 wrote `0x50`, slider 3 wrote `0x06`. Reset `0x06` is
level 3, which is where the app's slider sits.

`PAM1` at B6 and `PAM2` at B5 is the app's own labelling, kept verbatim; treat
them as a two-bit `PAM` field at bits 6:5.

CS8427 bits, from the CS8427 tab:

| MAP | Name | B7 | B6 | B5 | B4 | B3 | B2 | B1 | B0 |
|---|---|---|---|---|---|---|---|---|---|
| `0x01` | Control 1 | SWCLK | VSET | MUTESAO | MUTEAES | | INT1 | INT0 | TCBLD |
| `0x02` | Control 2 | | HOLD1 | HOLD0 | RMCKF | MMR | MMT | MMTCS | MMTLR |
| `0x03` | Data Flow | | TXOFF | AESBP | TXD1 | TXD0 | SPD1 | SPD0 | |
| `0x04` | Clock Source | | RUN | CLK1 | CLK0 | OUTC | INC | RXD1 | RXD0 |
| `0x05` | Serial Input | SIMS | SISF | SIRES1 | SIRES0 | SIJUST | SIDEL | SISPOL | SILRPOL |
| `0x06` | Serial Output | SOMS | SOSF | SORES1 | SORES0 | SOJUST | SODEL | SOSPOL | SOLRPOL |

---

## 2. Four "Enable" boxes are not bits

This is the thing most likely to catch you out. Several enable checkboxes have
no dedicated bit — the field itself encodes off as zero, and the usable
settings start at one. The app writes **nothing at all** while the control is
disabled; it holds the level in the UI until the box is ticked.

| Control | Field | Captured |
|---|---|---|
| Enable Sidetone | `DVST` | enabling with the level slider at 0 wrote `0x0B` = `0x01` |
| Microphone Enable | `PAM` | enabling wrote `0x0C` = `0x34`, up from `0x14` |
| Enable Noise Gate | `ANTH` | enabling with the threshold at the bottom wrote `0x0F` = `0x10` |
| Enable AGC | `HLD` | enabling with Hold at "50ms" wrote `0x0E` = `0x01` |

So the paired level control writes `field = index + 1`, and moving that control
while the box is unticked produces no traffic at all. Confirmed: with the mic
and gate disabled, moving MIC Preamp Gain, Sidetone Level and Noise Gate
Threshold wrote nothing.

The remaining enables *are* ordinary bits: **Enable DAC** = `DACEN`, **Enable
Voice ADC** = `ADVEN`, **Enable Background ADC** = `AD1EN` — captured as `0x10`
= `0x08`, `0x02` and `0x01` respectively.

---

## 3. Level scales

| Control | Field | Range | dB |
|---|---|---|---|
| Voice DAC Level | `DVA` | 0–94 | `3 - DVA`; 94 is Mute |
| Gain (playback) | `DVG` | 0–3 | 0 / +6 / +12 / +18 |
| Sidetone Level | `DVST` | 1–31 | `-2 × (DVST - 1)`, so 0dB…-60dB |
| Voice Output Level | `AVL` | 0–15 | `3 - AVL`, so +3dB…-12dB |
| Background Output Level | `A1L` | 0–15 | `3 - A1L` |
| MIC PGA | `PGAM` | 0–20 | `20 - PGAM`, so +20dB…0dB |
| MIC Preamp Gain | `PAM` | 1–3 | +0 / +20 / +30 |
| Noise Gate Threshold | `ANTH` | 1–15 | `-72 + 4 × (ANTH - 1)`, so -72dB…-16dB |
| AGC Threshold | `AGCTH` | 0–15 | `-3 - AGCTH`, so -3dB…-18dB |

**`AGCTH` runs backwards relative to its slider.** The slider's right-hand end
(-3dB) is `AGCTH` 0: setting the slider to position 5 wrote `AGCTH` = 10, and to
15 wrote 0.

Every row above was derived from captured traffic and then **checked against
the MAX9860 datasheet Tables 8, 9 and 10 — all agree**, including the
three "0 means off" fields, `DVA` living at bits 7:1, `PGAM` and `AGCTH` both
counting downwards, and `DVA` ≥ `0xBC` being MUTE. `web/test/protocol.test.mjs`
pins the spot values so they cannot drift.

**One datasheet erratum.** Table 8's ADC Output Level column lists `0xB` and
`0xC` both as -8dB and skips -9dB entirely, then resumes at `0xD` = -10dB. Every
other entry is a clean 1dB step, so `0xC` = -9dB is almost certainly what was
meant; the linear `3 - code` used here follows that. Worth knowing before
trusting a readout at that one code.

Index-valued controls, all confirmed as the plain option index:

| Control | Field | Note |
|---|---|---|
| DAC / ADC Voice Filters | `DVFLT` / `AVFLT` | 0–5 |
| BCLK Setup | `BS` | 0–7; "64 x LRCLK" wrote `0x07` = `0x01`, "PCLK / 2" wrote `0x04` |
| PSCLK - MCLK Range | `PSCLK` | 0–3 |
| FREQ - Integer Sampling Modes | `FREQ` | 0–3 |
| Master / Slave Mode | `MAS` | Master wrote `0x06` = `0x80` |
| AGC Attack Time | `ATK` | "50ms" (index 2) wrote `0x0E` = `0x08` |
| AGC Release Time | `RLS` | "625ms" (index 3) wrote `0x30` |
| AGC / NG Signal Source | `SRC` | "Voice + Background" wrote bit 7 |
| **AGC Hold Time** | `HLD` | **index + 1** — "50ms" wrote 1, "100ms" wrote 2 |

The seven Timing checkboxes map one-to-one: LRCLK Invert = `WCI`, DAC BCLK
Invert = `DBCI`, ADC BCLK Invert = `ABCI`, DAC Delay = `DDLY`, ADC Delay =
`ADLY`, SDOUT High Z = `HIZ`, Stereo Data = `ST`.

**"16kHz Mode" and "AGC Fast Mode (LRCLK > 24kHz)" are two views of one bit**
— `0x03` bit 0, which the Registers tab labels `16kHz`. The datasheet gives it
two jobs depending on `FREQ`:

* `FREQ` = 00 — AGC clock rate: 0 for LRCLK ≤ 24kHz, 1 for above.
* `FREQ` ≠ 00 — sample rate in exact integer mode: 0 is 8kHz, 1 is 16kHz.

The app shows both checkboxes and greys out whichever is not currently
meaningful, so exactly one is live at a time. Measured by sweeping `FREQ` in
Manual mode and reading both boxes back:

| `FREQ` | 16kHz Mode | AGC Fast Mode |
|---|---|---|
| 00 Normal | disabled | **enabled** |
| 01/10/11 integer | **enabled** | disabled |

The disabled one always reads unchecked rather than mirroring the bit.

An earlier revision of this file called "16kHz Mode" vestigial because clicking
it produced no traffic. That was a measurement taken with `FREQ` = 00, where the
box is disabled — it is not vestigial, it is gated.

---

## 4. Digital Audio Interface and the CS8427

The **Digital Audio Interface** radio writes CS8427 `0x04` wholesale: `0x48`
selects S/PDIF (sets `RUN`), `0x08` selects I²S and stops the receiver.

The **S/PDIF PLL Clock Input** combo drives the same register's bit 0, moving it
between `0x48` (LRCLK) and `0x49` (S/PDIF Input). This is why the doc's Reset
capture shows `0x49` after Configure.

Changing **BCLK Setup** or **Master / Slave** also rewrites CS8427 `0x05` =
`0x21` and `0x06` = `0xA1`, keeping the transceiver's serial format in step with
the codec's.

---

## 5. The Automatic and Manual panels

Both panels are **always on screen**; the Automatic/Manual radio above them only
decides which side accepts input, and greys the other out. Established by
driving the app over Win32 and reading its controls back.

**Automatic does not mirror into Manual as you type.** Sweeping the LRCLK combo
through all seven rates left every Manual field untouched. Manual shows the
registers as they actually are; only **Configure** moves them. Clicking a Clock
Sources radio does not Configure either.

**The Clock Sources radio sets and locks the MCLK frequency:**

| Source | MCLK Frequency field |
|---|---|
| Recovered Master Clock | **256 × Fs**, read-only — `12.288` at 48kHz, `11.2896` at 44.1kHz |
| 12.288MHz | `12.288`, read-only |
| 13MHz | `13`, read-only |
| External | editable — type your own |

**Recovered is rate-dependent**, because RMCK out of the CS8427 is 256 × Fs.
That only clears the codec's 10MHz minimum for 48kHz and 44.1kHz; at 32kHz it
would be 8.192MHz and at 8kHz just 2.048MHz.

The vendor app handles the rest of the range badly: below 44.1kHz the MCLK field
stops updating and **Configure silently does nothing**, leaving whatever the
previous rate wrote. Sweeping all seven rates with Recovered selected left
`N` = `0x6000` and `16KHZ` = 1 throughout, which is the 48kHz answer stranded on
a configuration that cannot work.

Two Manual controls are gated by state rather than by the panel:

* **PLL Mode** is enabled only in slave mode — the datasheet marks the bit
  "valid for slave mode only".
* **16kHz Mode** / **AGC Fast Mode** — see §3.

### What Configure computes

Captured writes, in order:

```
0x07 <- 0x09                    ST set, BS = 1 (64 x LRCLK)
0x06 <- MAS ? 0x80 : 0x00
0x03 <- PSCLK<<4 | FREQ<<1 | 16KHZ
0x04 <- N high 7 bits           PLL bit clear
0x05 <- N low 8 bits
0x04 <- N high | (PLL ? 0x80 : 0)
0x10 <- DAC/ADC enables         /SHDN still low
```

with

```
PSCLK = 0 below 10MHz, 1 for 10-20MHz, 2 for 20-40MHz, 3 above 40MHz
PCLK  = MCLK / 2^(PSCLK-1)
N     = round(65536 * 96 * LRCLK / PCLK)
FREQ  = master and MCLK is 12 / 13 / 19.2MHz and LRCLK is 8k or 16k
        ? 1 / 2 / 3 : 0 (Normal)
16KHZ = FREQ ? (LRCLK == 16kHz) : (LRCLK > 24kHz)
PLL   = slave and the clock source is neither 12.288MHz nor Recovered
```

N is written in two passes so the PLL bit is only raised once N is complete.

**Three rules here are easy to get wrong:**

*Exact integer mode needs the sample rate as well as the clock.* It covers
**8kHz and 16kHz only**, so 13MHz master at 48kHz stays in normal mode with
`FREQ` = 00.

*`FREQ` is matched against MCLK, not PCLK.* The datasheet says PCLK ("Select
when PCLK is 12MHz"), so a 26MHz MCLK prescaled to a 13MHz PCLK ought to
qualify — measured, the app declines it and leaves `FREQ` = 00. The app is not
following its own datasheet here.

*The PLL is chosen by the clock **source**, not by any frequency and not by
whether N divides exactly.* The discriminating measurement, all slave:

| Source | MCLK | 48kHz | 44.1kHz | 8kHz |
|---|---|---|---|---|
| **radio** 12.288MHz | 12.288 | PLL 0 | PLL 0 | PLL 0 |
| **External**, typed 12.288 | 12.288 | PLL 1 | PLL 1 | PLL 1 |
| 13MHz, either way | 13 | PLL 1 | — | PLL 1 |

Same frequency, opposite answer — so it is the radio that decides. And 12.288MHz
at 44.1kHz gives PLL 0 even though N (`0x5833`) is *not* whole, which rules out
an exactness rule outright. It makes physical sense: the on-board 12.288MHz
oscillator and the recovered RMCK are synchronous with the audio clock so the
divider can track them, while 13MHz and anything patched in externally cannot be
assumed to be.

This is what the `WM_SETTEXT` anomaly below was pointing at all along — N came
from the field, the PLL from the radio.

The measured matrix, Configure pressed for each row and the Manual panel read
back:

| MCLK | LRCLK | Mode | `FREQ` | 16KHZ | PLL | N |
|---|---|---|---|---|---|---|
| 13MHz | 8kHz | slave | 0 | 0 | **1** | `0x0F20` |
| 13MHz | 16kHz | slave | 0 | 0 | **1** | `0x1E3F` |
| 13MHz | 48kHz | slave | 0 | 1 | **1** | `0x5ABE` |
| 13MHz | 44.1kHz | slave | 0 | 1 | **1** | `0x535F` |
| 13MHz | 8kHz | master | **2** | 0 | 0 | `0x0F20` |
| 13MHz | 16kHz | master | **2** | **1** | 0 | `0x1E3F` |
| 13MHz | 48kHz | master | 0 | 1 | 0 | `0x5ABE` |
| 12.288MHz | 8kHz | either | 0 | 0 | **0** | `0x1000` |
| 12.288MHz | 16kHz | either | 0 | 0 | **0** | `0x2000` |
| 12.288MHz | 48kHz | either | 0 | 1 | **0** | `0x6000` |

The N formula is independently confirmed by the datasheet's own Table 4 of
common values, which `web/test/protocol.test.mjs` checks against.

> **One earlier capture disagrees with the PLL rule, and is an artefact of how
> it was taken.** That run set the MCLK frequency with `WM_SETTEXT`, which
> writes an edit control's text even while the control is disabled — and this
> field is disabled unless the source is External, so the state it produced is
> not reachable from the UI at all.
>
> Reproduced deliberately to pin it down:
>
> | How MCLK was set | Field text | Editable | N | PLL |
> |---|---|---|---|---|
> | 12.288MHz radio | `12.288` | no | `0x6000` | 0 |
> | 13MHz radio, then `WM_SETTEXT "12.288"` | `12.288` | no | `0x6000` | **1** |
>
> So Configure takes **N from the field but the PLL decision from the clock
> source radio**. Drive the radio, not the field, and the two agree. Worth
> knowing if you automate the app over Win32: `WM_SETTEXT` will happily
> desynchronise a control from the state the app believes it is in.

### Where this implementation deliberately differs

The browser implementation matches every row of the measured matrix (62 of 72
inputs identical, including all of the `FREQ`, `16KHZ`, `PLL`, `PSCLK` and `N`
columns) with one exception:

**Recovered below 44.1kHz.** The vendor leaves the previous configuration in
place without saying so. This one computes 256 × Fs, sees it is under the
codec's 10MHz minimum, and refuses the Configure with the reason on screen. Both
decline to produce a working setup — because none exists at those rates on a
recovered clock — but one of them tells you why.

The `FREQ`-from-MCLK quirk above is **not** treated as a divergence: it is
matched deliberately, with the datasheet disagreement noted in the code.

The **DAC / ADC** combo is register `0x10`: DAC Only `0x08`, ADC Only `0x03`,
DAC and ADC `0x0B`. Note `/SHDN` stays low — Configure leaves the codec shut
down, and bringing it up is a separate step.

---

## 6. Status, and what the app polls

The four **Device Status** checkboxes are the interrupt enables in `0x02`
(`ICLD`, `ISLD`, `IULK`, `ISPOC`); the lamps beside them are the matching bits
of the read-only `0x00`.

The vendor app polls `0x00` and pin K1 continuously, alongside the `A0 03`
device-present probe. While the **AGC / NG** tab is visible it additionally
polls `0x01` at roughly 6 Hz to drive the two indicator bars — AGC Gain from
`AGC4:0` and Noise Gate Attenuation from `NG2:0`.

## 7. The app resets the board at launch

Worth knowing, because it is not obvious from the UI — there is no prompt, no
progress, and the register values it then displays look exactly like a
freshly-powered board, because it has just made it one.

Measured by writing distinctive values to every writable register, then spawning
`MAX9860.exe` suspended under frida so the hooks were in place before its first
instruction. Every marker was gone afterwards:

```
before launch   03=12 06=44 07=25 08=5A 09=2C 0A=71 0B=13 0E=66 0F=39
after launch    03=00 06=00 07=00 08=00 09=06 0A=33 0B=00 0E=00 0F=00
```

The captured sequence, about 1.5 s after the port opens:

```
K2=0 K3=0 K4=0 K5=0 K6=0        selects quiet, both oscillators off, /RST low
i2c 0x20  regs 0x02..0x10 <- defaults, each verified by read-back
spi       CS8427 0x01..0x06 <- defaults        (while K4 is still LOW)
i2c 0x20  regs 0xF8..0xFE <- 00                the factory test registers
K4=1                                           transceiver released
K2=0 K3=0 K5=1 K6=0                            13 MHz selected and enabled
spi       CS8427 0x04 <- 0x49, then 0x48
```

This is the same sequence the Reset button issues, so §8 of
[`wire-protocol.md`](wire-protocol.md) describes it accurately — it just also
runs unprompted at startup. Note the CS8427 registers are written while K4 is
low, which is the ordering that reference warns against copying.

The `0xF9` read-back anomaly this sequence exposes is recorded in §6 and §10 of
[`wire-protocol.md`](wire-protocol.md), where register behaviour belongs.

---

## 8. The two indicator bars

These could not be established from captured traffic — register `0x01` only
moves when the codec is running with live audio — so they come from the
datasheet, Table 2. **Neither is the register code
read as decibels**, which is the obvious guess and is wrong in both cases.

**Noise Gate Attenuation (`NG2:0`) is not linear.** The top four codes step by
2dB, not 1dB:

| Code | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|---|
| Attenuation | 0dB | 1dB | 2dB | 3dB | 6dB | 8dB | 10dB | 12dB |

Code 0 is no attenuation, so a full bar means the gate is doing nothing — which
is why the app draws the bar full with `0dB` at its right-hand end.

**AGC Gain (`AGC4:0`) is on the PGAM scale**, not decibels: "the levels
indicated by these bits correspond to the levels defined for the PGAM bits
described in register `0x0C`". So code `0x00` is the full +20dB of gain and
`0x14` is 0dB — `dB = 20 - code`, running the opposite way to the code.

Both readings mean the vendor app's bars, sitting full with `0x01` reading
`0x00`, were showing genuine values rather than design-time defaults.

---

## 9. Still unconfirmed

Nothing material. The `AD 20` command issued once during the vendor's reset
remains unidentified — see §3 of [`wire-protocol.md`](wire-protocol.md) — but it
is not tied to any control.
