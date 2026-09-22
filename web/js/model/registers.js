// Register and bitfield definitions — the single source of truth.
//
// The Registers and CS8427 tabs render straight from these tables, and every
// semantic control on the other tabs names a field from FIELDS. Changing a
// control and editing a raw hex value are then the same operation on the same
// model, which is why the two stay in sync.
//
// Bit names are transcribed verbatim from the vendor app's own Registers and
// CS8427 tabs (see docs/vendor-ui/). Bit arrays run B7..B0, so index 0 is B7.
// Cross-checked against the reset values the app displays: 0x09=0x06 highlights
// DVA1|DVA0, 0x0A=0x33 highlights A1L1|A1L0|AVL1|AVL0, 0x0C=0x14 highlights
// PGAM4|PGAM2, and 0x10=0x8B decodes as /SHDN|DACEN|ADVEN|AD1EN.

export const CODEC_ADDR = 0x20;

/** Registers grouped as the vendor app's Registers tab groups them. */
export const CODEC_GROUPS = [
  {
    title: 'Status/Interrupt',
    registers: [
      { addr: 0x00, name: 'Interrupt Status', reset: 0x00, readOnly: true,
        bits: ['CLD', 'SLD', 'ULK', 'SPOC', null, null, null, null] },
      { addr: 0x01, name: 'NG/AGC', reset: 0x00, readOnly: true,
        bits: ['NG2', 'NG1', 'NG0', 'AGC4', 'AGC3', 'AGC2', 'AGC1', 'AGC0'] },
      { addr: 0x02, name: 'Interrupt Enable', reset: 0x00,
        bits: ['ICLD', 'ISLD', 'IULK', 'ISPOC', null, null, null, null] },
    ],
  },
  {
    title: 'Clock Control',
    registers: [
      { addr: 0x03, name: 'System Clock', reset: 0x00,
        bits: [null, null, 'PSCLK1', 'PSCLK0', null, 'FREQ1', 'FREQ0', '16kHz'] },
      { addr: 0x04, name: 'Clock Control High', reset: 0x00,
        bits: ['PLL', 'N14', 'N13', 'N12', 'N11', 'N10', 'N9', 'N8'] },
      { addr: 0x05, name: 'Clock Control Low', reset: 0x00,
        bits: ['N7', 'N6', 'N5', 'N4', 'N3', 'N2', 'N1', 'N0'] },
    ],
  },
  {
    title: 'Digital Audio Interface',
    registers: [
      { addr: 0x06, name: 'Interface', reset: 0x00,
        bits: ['MAS', 'WCI', 'DBCI', 'DDLY', 'HIZ', 'PCM', null, null] },
      { addr: 0x07, name: 'Interface', reset: 0x00,
        bits: [null, null, 'ABCI', 'ADLY', 'ST', 'BS2', 'BS1', 'BS0'] },
    ],
  },
  {
    title: 'Digital Filtering',
    registers: [
      { addr: 0x08, name: 'Voice Filters', reset: 0x00,
        bits: ['AVFLT3', 'AVFLT2', 'AVFLT1', 'AVFLT0', 'DVFLT3', 'DVFLT2', 'DVFLT1', 'DVFLT0'] },
    ],
  },
  {
    title: 'Digital Level Control',
    registers: [
      // DVA occupies bits 7:1 — the register value is the level shifted left by
      // one. Reset 0x06 is level 3, which is exactly where the app's slider sits.
      { addr: 0x09, name: 'DAC Attenuation', reset: 0x06,
        bits: ['DVA6', 'DVA5', 'DVA4', 'DVA3', 'DVA2', 'DVA1', 'DVA0', null] },
      { addr: 0x0a, name: 'ADC Output', reset: 0x33,
        bits: ['A1L3', 'A1L2', 'A1L1', 'A1L0', 'AVL3', 'AVL2', 'AVL1', 'AVL0'] },
      { addr: 0x0b, name: 'Gain / Sidetone', reset: 0x00,
        bits: [null, 'DVG1', 'DVG0', 'DVST4', 'DVST3', 'DVST2', 'DVST1', 'DVST0'] },
    ],
  },
  {
    title: 'Analog Level Control',
    registers: [
      // PAM1 at B6 and PAM2 at B5 is the app's own labelling, kept verbatim.
      { addr: 0x0c, name: 'MIC Left', reset: 0x14,
        bits: [null, 'PAM1', 'PAM2', 'PGAM4', 'PGAM3', 'PGAM2', 'PGAM1', 'PGAM0'] },
    ],
  },
  {
    title: 'Automatic Gain Control',
    registers: [
      { addr: 0x0e, name: 'AGC', reset: 0x00,
        bits: ['SRC', 'RLS2', 'RLS1', 'RLS0', 'ATK1', 'ATK0', 'HLD1', 'HLD0'] },
      { addr: 0x0f, name: 'NG/AGC', reset: 0x00,
        bits: ['ANTH3', 'ANTH2', 'ANTH1', 'ANTH0', 'AGCTH3', 'AGCTH2', 'AGCTH1', 'AGCTH0'] },
    ],
  },
  {
    title: 'Power Management',
    registers: [
      { addr: 0x10, name: 'System', reset: 0x00,
        bits: ['/SHDN', null, null, null, 'DACEN', null, 'ADVEN', 'AD1EN'] },
    ],
  },
];

export const CODEC_REGISTERS = CODEC_GROUPS.flatMap((g) => g.registers);

/** Addresses in ascending order — what Read All walks. 0x0D does not exist. */
export const CODEC_ADDRS = CODEC_REGISTERS.map((r) => r.addr);

/** Registers safe to write during a cold reset, in order. */
export const CODEC_WRITABLE_ADDRS = CODEC_REGISTERS
  .filter((r) => !r.readOnly)
  .map((r) => r.addr);

export const CS8427_REGISTERS = [
  { addr: 0x01, name: 'Control 1', reset: 0x01,
    bits: ['SWCLK', 'VSET', 'MUTESAO', 'MUTEAES', null, 'INT1', 'INT0', 'TCBLD'] },
  { addr: 0x02, name: 'Control 2', reset: 0x00,
    bits: [null, 'HOLD1', 'HOLD0', 'RMCKF', 'MMR', 'MMT', 'MMTCS', 'MMTLR'] },
  { addr: 0x03, name: 'Data Flow', reset: 0x0c,
    bits: [null, 'TXOFF', 'AESBP', 'TXD1', 'TXD0', 'SPD1', 'SPD0', null] },
  { addr: 0x04, name: 'Clock Source', reset: 0x09,
    bits: [null, 'RUN', 'CLK1', 'CLK0', 'OUTC', 'INC', 'RXD1', 'RXD0'] },
  { addr: 0x05, name: 'Serial Input', reset: 0x21,
    bits: ['SIMS', 'SISF', 'SIRES1', 'SIRES0', 'SIJUST', 'SIDEL', 'SISPOL', 'SILRPOL'] },
  { addr: 0x06, name: 'Serial Output', reset: 0xa1,
    bits: ['SOMS', 'SOSF', 'SORES1', 'SORES0', 'SOJUST', 'SODEL', 'SOSPOL', 'SOLRPOL'] },
];

/**
 * Named codec bitfields, {reg, shift, width}.
 * Derived from the bit tables above; the grid and these must agree.
 */
export const FIELDS = {
  // 0x00 interrupt status (read-only)
  CLD: { reg: 0x00, shift: 7, width: 1 },
  SLD: { reg: 0x00, shift: 6, width: 1 },
  ULK: { reg: 0x00, shift: 5, width: 1 },
  SPOC: { reg: 0x00, shift: 4, width: 1 },

  // 0x01 live NG/AGC readback (read-only)
  NG: { reg: 0x01, shift: 5, width: 3 },
  AGC: { reg: 0x01, shift: 0, width: 5 },

  // 0x02 interrupt enable
  ICLD: { reg: 0x02, shift: 7, width: 1 },
  ISLD: { reg: 0x02, shift: 6, width: 1 },
  IULK: { reg: 0x02, shift: 5, width: 1 },
  ISPOC: { reg: 0x02, shift: 4, width: 1 },

  // 0x03 system clock
  PSCLK: { reg: 0x03, shift: 4, width: 2 },
  FREQ: { reg: 0x03, shift: 1, width: 2 },
  SIXTEEN_KHZ: { reg: 0x03, shift: 0, width: 1 },

  // 0x04/0x05 clock control
  PLL: { reg: 0x04, shift: 7, width: 1 },
  N_HIGH: { reg: 0x04, shift: 0, width: 7 },
  N_LOW: { reg: 0x05, shift: 0, width: 8 },

  // 0x06 interface
  MAS: { reg: 0x06, shift: 7, width: 1 },
  WCI: { reg: 0x06, shift: 6, width: 1 },
  DBCI: { reg: 0x06, shift: 5, width: 1 },
  DDLY: { reg: 0x06, shift: 4, width: 1 },
  HIZ: { reg: 0x06, shift: 3, width: 1 },
  PCM: { reg: 0x06, shift: 2, width: 1 },

  // 0x07 interface
  ABCI: { reg: 0x07, shift: 5, width: 1 },
  ADLY: { reg: 0x07, shift: 4, width: 1 },
  ST: { reg: 0x07, shift: 3, width: 1 },
  BS: { reg: 0x07, shift: 0, width: 3 },

  // 0x08 voice filters
  AVFLT: { reg: 0x08, shift: 4, width: 4 },
  DVFLT: { reg: 0x08, shift: 0, width: 4 },

  // 0x09/0x0A/0x0B digital level control
  DVA: { reg: 0x09, shift: 1, width: 7 },
  A1L: { reg: 0x0a, shift: 4, width: 4 },
  AVL: { reg: 0x0a, shift: 0, width: 4 },
  DVG: { reg: 0x0b, shift: 5, width: 2 },
  DVST: { reg: 0x0b, shift: 0, width: 5 },

  // 0x0C analog level control
  PAM: { reg: 0x0c, shift: 5, width: 2 },
  PGAM: { reg: 0x0c, shift: 0, width: 5 },

  // 0x0E/0x0F automatic gain control
  SRC: { reg: 0x0e, shift: 7, width: 1 },
  RLS: { reg: 0x0e, shift: 4, width: 3 },
  ATK: { reg: 0x0e, shift: 2, width: 2 },
  HLD: { reg: 0x0e, shift: 0, width: 2 },
  ANTH: { reg: 0x0f, shift: 4, width: 4 },
  AGCTH: { reg: 0x0f, shift: 0, width: 4 },

  // 0x10 power management
  SHDN: { reg: 0x10, shift: 7, width: 1 },
  DACEN: { reg: 0x10, shift: 3, width: 1 },
  ADVEN: { reg: 0x10, shift: 1, width: 1 },
  AD1EN: { reg: 0x10, shift: 0, width: 1 },
};

/** Named CS8427 bitfields. */
export const CS_FIELDS = {
  RUN: { reg: 0x04, shift: 6, width: 1 },
  CLK: { reg: 0x04, shift: 4, width: 2 },
  OUTC: { reg: 0x04, shift: 3, width: 1 },
  INC: { reg: 0x04, shift: 2, width: 1 },
  RXD: { reg: 0x04, shift: 0, width: 2 },
};

export function fieldMask(field) {
  return ((1 << field.width) - 1) << field.shift;
}

export function fieldGet(regValue, field) {
  return (regValue >> field.shift) & ((1 << field.width) - 1);
}

export function fieldSet(regValue, field, value) {
  const mask = fieldMask(field);
  return (regValue & ~mask & 0xff) | ((value << field.shift) & mask);
}
