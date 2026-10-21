// Built-in parts library: schematic symbols paired with footprints.
import * as fp from "./footprints";
import type { Footprint, PartDef, PartSymbol, PinType, Shape, SymbolPin } from "./types";

// ---------- symbol helpers (schematic units, 10 = one grid step) ----------

const pin = (id: string, name: string, x: number, y: number, side: SymbolPin["side"], length = 10, showName = false, showNumber = false): SymbolPin => ({
  id,
  name,
  x,
  y,
  side,
  length,
  showName,
  showNumber,
});

/** Horizontal two-pin symbol spanning x = -30..30, with the given body glyph. */
function twoPin(body: Shape[], names: [string, string] = ["1", "2"]): PartSymbol {
  return {
    shapes: body,
    pins: [pin("1", names[0], -30, 0, "left", 10), pin("2", names[1], 30, 0, "right", 10)],
    refPos: { x: 0, y: -14 },
    valuePos: { x: 0, y: 20 },
  };
}

const resistorBody: Shape[] = [{ kind: "rect", x: -20, y: -6, w: 40, h: 12 }];
const capacitorBody: Shape[] = [
  { kind: "line", points: [{ x: -20, y: 0 }, { x: -4, y: 0 }] },
  { kind: "line", points: [{ x: 4, y: 0 }, { x: 20, y: 0 }] },
  { kind: "line", points: [{ x: -4, y: -12 }, { x: -4, y: 12 }] },
  { kind: "line", points: [{ x: 4, y: -12 }, { x: 4, y: 12 }] },
];
const polarCapBody: Shape[] = [
  ...capacitorBody,
  { kind: "text", x: -11, y: -9, text: "+", size: 9 },
];
const inductorBody: Shape[] = [
  {
    kind: "line",
    points: [-15, -5, 5, 15].flatMap((cx) =>
      Array.from({ length: 9 }, (_, i) => ({ x: cx - 5 * Math.cos((Math.PI * i) / 8), y: -5 * Math.sin((Math.PI * i) / 8) })),
    ),
  },
];
const diodeBody = (extra: Shape[] = []): Shape[] => [
  { kind: "line", points: [{ x: -20, y: 0 }, { x: 20, y: 0 }] },
  { kind: "polygon", points: [{ x: 8, y: 0 }, { x: -8, y: -9 }, { x: -8, y: 9 }], fill: false },
  { kind: "line", points: [{ x: 8, y: -9 }, { x: 8, y: 9 }] },
  ...extra,
];
// Diode symbols in this library are drawn anode-left; pin 1 = K is on the right.
const diodeSymbol = (extra: Shape[] = []): PartSymbol => {
  const s = twoPin(diodeBody(extra));
  s.pins = [pin("2", "A", -30, 0, "left"), pin("1", "K", 30, 0, "right")];
  return s;
};
const ledArrows: Shape[] = [
  { kind: "line", points: [{ x: 0, y: -12 }, { x: 8, y: -20 }] },
  { kind: "polygon", points: [{ x: 8, y: -20 }, { x: 3, y: -19 }, { x: 7, y: -15 }], fill: true },
  { kind: "line", points: [{ x: 6, y: -10 }, { x: 14, y: -18 }] },
  { kind: "polygon", points: [{ x: 14, y: -18 }, { x: 9, y: -17 }, { x: 13, y: -13 }], fill: true },
];
const switchBody: Shape[] = [
  { kind: "circle", x: -16, y: 0, r: 2 },
  { kind: "circle", x: 16, y: 0, r: 2 },
  { kind: "line", points: [{ x: -16, y: -6 }, { x: 16, y: -6 }] },
  { kind: "line", points: [{ x: 0, y: -6 }, { x: 0, y: -14 }] },
  { kind: "line", points: [{ x: -20, y: 0 }, { x: -18, y: 0 }] },
  { kind: "line", points: [{ x: 18, y: 0 }, { x: 20, y: 0 }] },
];
const crystalBody: Shape[] = [
  { kind: "rect", x: -5, y: -10, w: 10, h: 20 },
  { kind: "line", points: [{ x: -10, y: -12 }, { x: -10, y: 12 }] },
  { kind: "line", points: [{ x: 10, y: -12 }, { x: 10, y: 12 }] },
  { kind: "line", points: [{ x: -20, y: 0 }, { x: -10, y: 0 }] },
  { kind: "line", points: [{ x: 10, y: 0 }, { x: 20, y: 0 }] },
];
const fuseBody: Shape[] = [
  { kind: "rect", x: -16, y: -6, w: 32, h: 12 },
  { kind: "line", points: [{ x: -20, y: 0 }, { x: 20, y: 0 }] },
];

/** Rectangular IC symbol. Pins are listed top to bottom on each side as [number, name]. */
export function icSymbol(left: [string, string][], right: [string, string][], label = ""): PartSymbol {
  const rows = Math.max(left.length, right.length);
  const h = (rows + 1) * 10;
  const longest = Math.max(...[...left, ...right].map(([, n]) => n.length), 3);
  const halfW = Math.max(30, Math.ceil((longest * 5.5 * 2 + 20) / 20) * 10);
  const top = -Math.floor(rows / 2) * 10 - 10;
  const pins: SymbolPin[] = [];
  left.forEach(([id, name], i) => pins.push(pin(id, name, -halfW - 20, top + (i + 1) * 10, "left", 20, true, true)));
  right.forEach(([id, name], i) => pins.push(pin(id, name, halfW + 20, top + (i + 1) * 10, "right", 20, true, true)));
  const shapes: Shape[] = [{ kind: "rect", x: -halfW, y: top, w: halfW * 2, h }];
  if (label) shapes.push({ kind: "text", x: 0, y: top + h / 2 + 3, text: label, size: 8, anchor: "middle" });
  return { shapes, pins, refPos: { x: -halfW, y: top - 6 }, valuePos: { x: -halfW, y: top + h + 12 } };
}

function transistorSymbol(kind: "npn" | "pnp" | "nmos" | "pmos"): PartSymbol {
  const bjt = kind === "npn" || kind === "pnp";
  const shapes: Shape[] =
    bjt
      ? [
          { kind: "circle", x: 5, y: 0, r: 16 },
          { kind: "line", points: [{ x: -20, y: 0 }, { x: -2, y: 0 }] },
          { kind: "line", points: [{ x: -2, y: -10 }, { x: -2, y: 10 }] },
          { kind: "line", points: [{ x: -2, y: -4 }, { x: 10, y: -14 }, { x: 10, y: -20 }] },
          { kind: "line", points: [{ x: -2, y: 4 }, { x: 10, y: 14 }, { x: 10, y: 20 }] },
          // Emitter arrow: out of the base for NPN, into it for PNP.
          kind === "npn"
            ? { kind: "polygon", points: [{ x: 10, y: 14 }, { x: 3, y: 13 }, { x: 7, y: 8 }], fill: true }
            : { kind: "polygon", points: [{ x: -1, y: 5 }, { x: 6, y: 6 }, { x: 3, y: 11 }], fill: true },
        ]
      : [
          { kind: "circle", x: 5, y: 0, r: 16 },
          { kind: "line", points: [{ x: -20, y: 0 }, { x: -6, y: 0 }, { x: -6, y: -10 }] },
          { kind: "line", points: [{ x: -1, y: -11 }, { x: -1, y: 11 }] },
          { kind: "line", points: [{ x: -1, y: -8 }, { x: 10, y: -8 }, { x: 10, y: -20 }] },
          { kind: "line", points: [{ x: -1, y: 8 }, { x: 10, y: 8 }, { x: 10, y: 20 }] },
          { kind: "line", points: [{ x: -1, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }] },
          // Body-diode arrow on the channel: into it for N-channel, out of it for P-channel.
          kind === "nmos"
            ? { kind: "polygon", points: [{ x: 0, y: 0 }, { x: 6, y: -3 }, { x: 6, y: 3 }], fill: true }
            : { kind: "polygon", points: [{ x: 7, y: 0 }, { x: 1, y: -3 }, { x: 1, y: 3 }], fill: true },
        ];
  const names = bjt ? { b: "B", c: "C", e: "E" } : { b: "G", c: "D", e: "S" };
  // SOT-23 pinout: 1 = B/G, 2 = E/S, 3 = C/D
  return {
    shapes,
    pins: [pin("1", names.b, -30, 0, "left"), pin("3", names.c, 10, -30, "top"), pin("2", names.e, 10, 30, "bottom")],
    refPos: { x: 24, y: -4 },
    valuePos: { x: 24, y: 10 },
  };
}

function powerSymbol(kind: "gnd" | "rail"): PartSymbol {
  const shapes: Shape[] =
    kind === "gnd"
      ? [
          { kind: "line", points: [{ x: 0, y: 0 }, { x: 0, y: 10 }] },
          { kind: "line", points: [{ x: -10, y: 10 }, { x: 10, y: 10 }] },
          { kind: "line", points: [{ x: -6, y: 14 }, { x: 6, y: 14 }] },
          { kind: "line", points: [{ x: -2, y: 18 }, { x: 2, y: 18 }] },
        ]
      : [
          { kind: "line", points: [{ x: 0, y: 0 }, { x: 0, y: -10 }] },
          { kind: "line", points: [{ x: -8, y: -10 }, { x: 8, y: -10 }] },
        ];
  return {
    shapes,
    pins: [pin("1", "1", 0, 0, kind === "gnd" ? "top" : "bottom", 0)],
    refPos: { x: 0, y: 0 },
    valuePos: kind === "gnd" ? { x: 0, y: 30 } : { x: 0, y: -15 },
  };
}

const localLabelSymbol: PartSymbol = {
  shapes: [{ kind: "line", points: [{ x: 0, y: 0 }, { x: 40, y: 0 }] }],
  pins: [pin("1", "1", 0, 0, "left", 0)],
  refPos: { x: 0, y: 0 },
  valuePos: { x: 2, y: -3 },
};

const hierLabelSymbol: PartSymbol = {
  shapes: [{ kind: "polygon", points: [{ x: 0, y: 0 }, { x: 6, y: -5 }, { x: 12, y: -5 }, { x: 12, y: 5 }, { x: 6, y: 5 }], fill: false }],
  pins: [pin("1", "1", 0, 0, "left", 0)],
  refPos: { x: 0, y: 0 },
  valuePos: { x: 15, y: 3 },
};

/** Single-pin mechanical symbol (mounting holes, fiducials). */
function twoPinless(label: string): PartSymbol {
  return {
    shapes: [
      { kind: "circle", x: 0, y: 0, r: 10 },
      { kind: "circle", x: 0, y: 0, r: 4 },
      { kind: "text", x: 0, y: -14, text: label, size: 7, anchor: "middle" },
    ],
    pins: [pin("1", "1", 0, 20, "bottom", 10)],
    refPos: { x: 14, y: -4 },
    valuePos: { x: 14, y: 8 },
  };
}

function sourceSymbol(kind: "V" | "I"): PartSymbol {
  const shapes: Shape[] = [{ kind: "circle", x: 0, y: 0, r: 12 }];
  if (kind === "V") shapes.push({ kind: "text", x: 0, y: -3, text: "+", size: 9, anchor: "middle" }, { kind: "text", x: 0, y: 9, text: "−", size: 9, anchor: "middle" });
  else shapes.push({ kind: "line", points: [{ x: 0, y: 7 }, { x: 0, y: -7 }] }, { kind: "polygon", points: [{ x: 0, y: -8 }, { x: -3, y: -3 }, { x: 3, y: -3 }], fill: true });
  return { shapes, pins: [pin("1", "+", 0, -20, "top", 8), pin("2", "-", 0, 20, "bottom", 8)], refPos: { x: 16, y: -4 }, valuePos: { x: 16, y: 8 } };
}

const netLabelSymbol: PartSymbol = {
  shapes: [{ kind: "line", points: [{ x: 0, y: 0 }, { x: 6, y: -6 }, { x: 40, y: -6 }, { x: 40, y: 6 }, { x: 6, y: 6 }, { x: 0, y: 0 }] }],
  pins: [pin("1", "1", 0, 0, "left", 0)],
  refPos: { x: 0, y: 0 },
  valuePos: { x: 9, y: 3 },
};

// ---------- library ----------

interface PartInput extends Omit<PartDef, "kind" | "keywords"> {
  kind?: PartDef["kind"];
  keywords?: string[];
}
const part = (p: PartInput): PartDef => ({ kind: "part", keywords: [], ...p });

const passive = (id: string, name: string, prefix: string, value: string, body: Shape[], footprint: Footprint, description: string, keywords: string[]) =>
  part({ id, name, category: "Passives", refPrefix: prefix, defaultValue: value, symbol: twoPin(body), footprint, description, keywords });

export const PARTS: PartDef[] = [
  passive("resistor_0603", "Resistor (0603)", "R", "10k", resistorBody, fp.chip("0603"), "Thick-film chip resistor, 0603 (1608 metric), 1/10 W.", ["resistor", "res", "pullup", "pulldown"]),
  passive("resistor_0805", "Resistor (0805)", "R", "1k", resistorBody, fp.chip("0805"), "Thick-film chip resistor, 0805 (2012 metric), 1/8 W.", ["resistor", "res"]),
  passive("capacitor_0603", "Capacitor (0603)", "C", "100nF", capacitorBody, fp.chip("0603"), "MLCC ceramic capacitor, 0603, X7R. Typical decoupling cap.", ["capacitor", "cap", "decoupling", "bypass", "mlcc"]),
  passive("capacitor_0805", "Capacitor (0805)", "C", "10uF", capacitorBody, fp.chip("0805"), "MLCC ceramic capacitor, 0805, X5R. Bulk decoupling.", ["capacitor", "cap", "bulk", "mlcc"]),
  passive("capacitor_electrolytic", "Electrolytic Capacitor (radial 5mm)", "C", "100uF", polarCapBody, fp.radialCap(5, 2), "Aluminium electrolytic capacitor, radial, D5mm P2mm. Pin 1 = +.", ["capacitor", "electrolytic", "polarized", "bulk"]),
  passive("inductor_0805", "Inductor (0805)", "L", "10uH", inductorBody, fp.chip("0805"), "Chip inductor, 0805.", ["inductor", "coil", "choke"]),
  passive("ferrite_0603", "Ferrite Bead (0603)", "FB", "600R@100MHz", resistorBody, fp.chip("0603"), "Ferrite bead for power filtering, 0603.", ["ferrite", "bead", "emi", "filter"]),
  passive("fuse_1206", "Fuse (1206)", "F", "500mA", fuseBody, fp.chip("1206"), "Resettable PTC fuse, 1206.", ["fuse", "ptc", "polyfuse", "protection"]),
  part({ id: "led_0603", name: "LED (0603)", category: "Discrete", refPrefix: "D", defaultValue: "Red", symbol: { ...diodeSymbol(ledArrows), refPos: { x: -10, y: -16 } }, footprint: fp.chip("0603"), description: "Indicator LED, 0603. Pin 1 = cathode (K), pin 2 = anode (A). Vf ~2V for red, ~3V for blue/white.", keywords: ["led", "light", "indicator", "diode"] }),
  part({ id: "diode_sod123", name: "Diode (SOD-123)", category: "Discrete", refPrefix: "D", defaultValue: "1N4148W", mpn: "1N4148W", symbol: diodeSymbol(), footprint: fp.sod123(), description: "Small-signal switching diode. Pin 1 = K, pin 2 = A.", keywords: ["diode", "rectifier", "signal"] }),
  part({ id: "schottky_sod123", name: "Schottky Diode (SOD-123)", category: "Discrete", refPrefix: "D", defaultValue: "SS14", mpn: "B5819W", symbol: diodeSymbol([{ kind: "line", points: [{ x: 8, y: -9 }, { x: 12, y: -9 }] }, { kind: "line", points: [{ x: 8, y: 9 }, { x: 4, y: 9 }] }]), footprint: fp.sod123(), description: "1A 40V Schottky diode, reverse-polarity protection. Pin 1 = K.", keywords: ["schottky", "diode", "protection"] }),
  part({ id: "npn_sot23", name: "NPN Transistor (SOT-23)", category: "Discrete", refPrefix: "Q", defaultValue: "MMBT3904", mpn: "MMBT3904", symbol: transistorSymbol("npn"), footprint: fp.sot23(), description: "General purpose NPN BJT, 40V 200mA. Pins: 1=B, 2=E, 3=C.", keywords: ["transistor", "bjt", "npn", "switch"] }),
  part({ id: "pnp_sot23", name: "PNP Transistor (SOT-23)", category: "Discrete", refPrefix: "Q", defaultValue: "MMBT3906", mpn: "MMBT3906", symbol: transistorSymbol("pnp"), footprint: fp.sot23(), description: "General purpose PNP BJT, -40V -200mA. Pins: 1=B, 2=E, 3=C.", keywords: ["transistor", "bjt", "pnp", "high-side", "switch"] }),
  part({ id: "pmos_sot23", name: "P-MOSFET (SOT-23)", category: "Discrete", refPrefix: "Q", defaultValue: "AO3401A", mpn: "AO3401A", symbol: transistorSymbol("pmos"), footprint: fp.sot23(), description: "Logic-level P-channel MOSFET, -30V -4A, for high-side switching and reverse-polarity protection. Pins: 1=G, 2=S, 3=D.", keywords: ["mosfet", "fet", "pmos", "high-side", "load switch", "transistor"] }),
  part({ id: "nmos_sot23", name: "N-MOSFET (SOT-23)", category: "Discrete", refPrefix: "Q", defaultValue: "AO3400A", mpn: "AO3400A", symbol: transistorSymbol("nmos"), footprint: fp.sot23(), description: "Logic-level N-channel MOSFET, 30V 5.7A. Pins: 1=G, 2=S, 3=D.", keywords: ["mosfet", "fet", "nmos", "switch", "transistor"] }),
  part({ id: "button_6mm", name: "Push Button (6mm THT)", category: "Electromechanical", refPrefix: "SW", defaultValue: "SW_Push", symbol: twoPin(switchBody), footprint: fp.tactSwitch6mm(), description: "6x6mm tactile push button, normally open.", keywords: ["button", "switch", "tactile", "reset"] }),
  part({ id: "crystal_hc49", name: "Crystal (HC-49)", category: "Frequency", refPrefix: "Y", defaultValue: "16MHz", symbol: twoPin(crystalBody), footprint: fp.hc49(), description: "Quartz crystal, HC-49/U through-hole. Needs two load capacitors (typ. 22pF) to GND.", keywords: ["crystal", "oscillator", "xtal", "clock"] }),
  ...[2, 3, 4, 6].map((n) =>
    part({
      id: `header_1x${n}`,
      name: `Pin Header 1x${n} (2.54mm)`,
      category: "Connectors",
      refPrefix: "J",
      defaultValue: `Conn_01x${n}`,
      symbol: icSymbol(Array.from({ length: n }, (_, i) => [String(i + 1), `Pin_${i + 1}`] as [string, string]), [], ""),
      footprint: fp.header(n),
      description: `Single row ${n}-pin male header, 2.54mm pitch.`,
      keywords: ["header", "connector", "pin", "jumper"],
    }),
  ),
  part({
    id: "usb_c_power",
    name: "USB-C Receptacle (USB 2.0)",
    category: "Connectors",
    refPrefix: "J",
    defaultValue: "USB_C",
    symbol: icSymbol([["A4", "VBUS"], ["A5", "CC1"], ["B5", "CC2"], ["A6", "D+"], ["A7", "D-"], ["A1", "GND"], ["S1", "SHIELD"]], [], "USB-C"),
    footprint: fp.usbC(),
    description: "USB Type-C receptacle, USB 2.0 subset. CC1/CC2 need 5.1k pulldowns to GND for a sink to get 5V.",
    keywords: ["usb", "usb-c", "type-c", "connector", "power"],
  }),
  part({
    id: "ams1117_33",
    name: "AMS1117-3.3 LDO",
    category: "Power",
    refPrefix: "U",
    defaultValue: "AMS1117-3.3",
    mpn: "AMS1117-3.3",
    symbol: icSymbol([["3", "VIN"], ["1", "GND"]], [["2", "VOUT"], ["4", "TAB"]], "LDO"),
    footprint: fp.sot223(),
    description: "1A low dropout 3.3V linear regulator. Pins: 1=GND, 2=VOUT, 3=VIN, 4=TAB (VOUT). Needs 10uF on input and output.",
    keywords: ["regulator", "ldo", "3.3v", "power", "linear"],
  }),
  part({
    id: "ne555_dip8",
    name: "NE555 Timer (DIP-8)",
    category: "ICs",
    refPrefix: "U",
    defaultValue: "NE555",
    mpn: "NE555P",
    symbol: icSymbol([["8", "VCC"], ["4", "RESET"], ["2", "TRIG"], ["6", "THR"], ["5", "CV"]], [["3", "OUT"], ["7", "DISCH"], ["1", "GND"]], "555"),
    footprint: fp.dip(8),
    description: "Precision timer, astable/monostable. Supply 4.5-16V.",
    keywords: ["555", "timer", "oscillator", "astable", "blinker"],
  }),
  part({
    id: "lm358_soic8",
    name: "LM358 Dual Op-Amp (SOIC-8)",
    category: "ICs",
    refPrefix: "U",
    defaultValue: "LM358",
    mpn: "LM358DR",
    symbol: icSymbol([["3", "+INA"], ["2", "-INA"], ["5", "+INB"], ["6", "-INB"]], [["1", "OUTA"], ["7", "OUTB"], ["8", "V+"], ["4", "V-"]], "LM358"),
    footprint: fp.soic(8),
    description: "Dual low-power operational amplifier, single supply 3-32V.",
    keywords: ["opamp", "op-amp", "amplifier", "comparator"],
  }),
  part({
    id: "atmega328p_tqfp32",
    name: "ATmega328P (TQFP-32)",
    category: "Microcontrollers",
    refPrefix: "U",
    defaultValue: "ATmega328P-AU",
    mpn: "ATMEGA328P-AU",
    symbol: icSymbol(
      [["4", "VCC"], ["6", "VCC"], ["18", "AVCC"], ["20", "AREF"], ["29", "PC6/RESET"], ["7", "PB6/XTAL1"], ["8", "PB7/XTAL2"], ["3", "GND"], ["5", "GND"], ["21", "GND"], ["19", "ADC6"], ["22", "ADC7"]],
      [["12", "PB0"], ["13", "PB1"], ["14", "PB2/SS"], ["15", "PB3/MOSI"], ["16", "PB4/MISO"], ["17", "PB5/SCK"], ["23", "PC0/A0"], ["24", "PC1/A1"], ["25", "PC2/A2"], ["26", "PC3/A3"], ["27", "PC4/SDA"], ["28", "PC5/SCL"], ["30", "PD0/RXD"], ["31", "PD1/TXD"], ["32", "PD2"], ["1", "PD3"], ["2", "PD4"], ["9", "PD5"], ["10", "PD6"], ["11", "PD7"]],
      "ATmega328P",
    ),
    footprint: fp.qfp(32, 0.8, 8.4),
    description: "8-bit AVR MCU, 32KB flash, 2KB SRAM, 20MHz. Arduino Uno core. Needs 100nF decoupling per VCC pin, 10k RESET pullup, crystal on XTAL1/XTAL2.",
    keywords: ["mcu", "microcontroller", "avr", "arduino", "atmega"],
  }),
  // ----- power symbols and net labels -----
  part({ id: "power_gnd", name: "GND", category: "Power Symbols", kind: "power", refPrefix: "#PWR", defaultValue: "GND", symbol: powerSymbol("gnd"), footprint: null, description: "Ground power symbol. All GND symbols share one net.", keywords: ["gnd", "ground"] }),
  part({ id: "power_rail", name: "Power Rail", category: "Power Symbols", kind: "power", refPrefix: "#PWR", defaultValue: "+3V3", symbol: powerSymbol("rail"), footprint: null, description: "Power rail symbol (e.g. +3V3, +5V, VBUS). The value is the net name; all rails with the same value are connected.", keywords: ["vcc", "vdd", "3v3", "5v", "power", "rail"] }),
  part({ id: "net_label", name: "Global Label", category: "Labels", kind: "netlabel", refPrefix: "#LBL", defaultValue: "NET", symbol: netLabelSymbol, footprint: null, description: "Global net label. Pins attached to global labels with the same name are connected on every sheet.", keywords: ["label", "net", "name", "global"] }),
  part({ id: "local_label", name: "Local Label", category: "Labels", kind: "locallabel", refPrefix: "#LBL", defaultValue: "SIG", symbol: localLabelSymbol, footprint: null, description: "Local net label. Connects only to labels with the same name on the same sheet.", keywords: ["label", "local", "net"] }),
  part({ id: "hier_label", name: "Hierarchical Label", category: "Labels", kind: "hierlabel", refPrefix: "#LBL", defaultValue: "PORT", symbol: hierLabelSymbol, footprint: null, description: "Hierarchical port of a sheet. Appears as a pin on this sheet's sheet symbol in the parent sheet.", keywords: ["label", "hierarchical", "port", "sheet"] }),
  part({ id: "mounting_hole_m3", name: "Mounting Hole M3 (plated)", category: "Mechanical", refPrefix: "H", defaultValue: "M3", symbol: twoPinless("H"), footprint: fp.mountingHole(3.2, 6), description: "Plated M3 mounting hole (3.2mm drill, 6mm pad). Connect to GND for chassis ground or leave unconnected (no-connect).", keywords: ["mounting", "hole", "m3", "screw", "mechanical"] }),
  part({ id: "mounting_hole_m2", name: "Mounting Hole M2 (plated)", category: "Mechanical", refPrefix: "H", defaultValue: "M2", symbol: twoPinless("H"), footprint: fp.mountingHole(2.2, 4), description: "Plated M2 mounting hole (2.2mm drill, 4mm pad).", keywords: ["mounting", "hole", "m2", "screw", "mechanical"] }),
  part({ id: "fiducial", name: "Fiducial (1mm)", category: "Mechanical", refPrefix: "FID", defaultValue: "Fiducial", symbol: twoPinless("FID"), footprint: fp.fiducial(), description: "1mm copper fiducial for pick-and-place alignment. Leave unconnected (mark no-connect).", keywords: ["fiducial", "assembly", "mechanical"] }),
  // ----- simulation sources (no footprint) -----
  part({ id: "sim_vsource", name: "Voltage Source (simulation)", category: "Simulation", refPrefix: "V", defaultValue: "DC 5", symbol: sourceSymbol("V"), footprint: null, description: "Independent voltage source for simulation. Value: 'DC 5', 'PULSE(0 5 0 1u 1u 0.5m 1m)', 'SIN(0 1 1k)', optionally followed by 'AC 1' for AC analysis. Pin 1 = +, pin 2 = -.", keywords: ["source", "voltage", "simulation", "pulse", "sine", "signal"] }),
  part({ id: "sim_isource", name: "Current Source (simulation)", category: "Simulation", refPrefix: "I", defaultValue: "DC 1m", symbol: sourceSymbol("I"), footprint: null, description: "Independent current source for simulation; current flows out of pin 1 through the external circuit into pin 2. Value as for the voltage source.", keywords: ["source", "current", "simulation"] }),
];

// ---------- pin electrical types (for ERC) ----------

const PIN_TYPES: Record<string, Record<string, PinType>> = {
  ne555_dip8: { "8": "power_in", "1": "power_in", "4": "input", "2": "input", "6": "input", "5": "input", "3": "output", "7": "open_collector" },
  lm358_soic8: { "3": "input", "2": "input", "5": "input", "6": "input", "1": "output", "7": "output", "8": "power_in", "4": "power_in" },
  ams1117_33: { "3": "power_in", "1": "power_in", "2": "power_out", "4": "power_out" },
  usb_c_power: { A4: "power_out", A6: "bidirectional", A7: "bidirectional" },
  sim_vsource: { "1": "power_out", "2": "passive" },
};
for (const p of PARTS) {
  const map = PIN_TYPES[p.id];
  for (const pin of p.symbol.pins) {
    if (map?.[pin.id]) pin.type = map[pin.id];
    else if (p.id.startsWith("atmega")) pin.type = /VCC|GND/.test(pin.name) ? "power_in" : pin.name === "AREF" ? "passive" : /RESET|XTAL1|ADC/.test(pin.name) ? "input" : /XTAL2/.test(pin.name) ? "output" : "bidirectional";
    else pin.type ??= "passive";
  }
}

const BY_ID = new Map(PARTS.map((p) => [p.id, p]));
/** Project-specific parts (created by users/the copilot or imported from KiCad), keyed by globally unique id. */
const CUSTOM = new Map<string, PartDef>();

export function registerParts(parts: Iterable<PartDef>) {
  for (const p of parts) CUSTOM.set(p.id, p);
}

export function getPart(id: string): PartDef | undefined {
  return BY_ID.get(id) ?? CUSTOM.get(id);
}

export function searchParts(query: string, limit = 10, extra: PartDef[] = []): PartDef[] {
  const pool = [...PARTS, ...extra];
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return pool.slice(0, limit);
  const scored = pool.map((p) => {
    const hay = [p.id, p.name, p.category, p.description, p.defaultValue, p.mpn ?? "", ...(p.keywords ?? [])].join(" ").toLowerCase();
    const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 + ((p.keywords ?? []).includes(t) ? 1 : 0) : 0), 0);
    return { p, score };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.p);
}

// ---------- part builder ----------

export type PackageSpec =
  | { type: "dip" | "soic"; pins: number }
  | { type: "qfp"; pins: number; pitch?: number; span?: number }
  | { type: "header"; pins: number }
  | { type: "chip"; size: "0402" | "0603" | "0805" | "1206" }
  | { type: "sot23" | "sot223" | "sod123" }
  | { type: "tht2"; pitch?: number };

export interface PartSpec {
  name: string;
  refPrefix: string;
  value?: string;
  description?: string;
  category?: string;
  mpn?: string;
  keywords?: string[];
  /** Pins as [number, name]; `side` defaults to left for the first half, right for the rest. */
  pins: { number: string; name: string; side?: "left" | "right"; type?: PinType }[];
  package: PackageSpec;
}

export function packageFootprint(pkg: PackageSpec): Footprint {
  switch (pkg.type) {
    case "dip":
      return fp.dip(pkg.pins);
    case "soic":
      return fp.soic(pkg.pins);
    case "qfp":
      return fp.qfp(pkg.pins, pkg.pitch ?? 0.5, pkg.span ?? Math.max(5, (pkg.pins / 4) * (pkg.pitch ?? 0.5) + 2.5));
    case "header":
      return fp.header(pkg.pins);
    case "chip":
      return fp.chip(pkg.size);
    case "sot23":
      return fp.sot23();
    case "sot223":
      return fp.sot223();
    case "sod123":
      return fp.sod123();
    case "tht2":
      return fp.tht2("THT_2pin", pkg.pitch ?? 5.08, (pkg.pitch ?? 5.08) + 1, 2.5);
  }
}

/** Build a complete part (IC-style symbol + footprint) from a compact spec. */
export function buildPart(spec: PartSpec, id = `custom_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`): PartDef {
  const footprint = packageFootprint(spec.package);
  const padIds = new Set(footprint.pads.map((p) => p.id));
  for (const pin of spec.pins) if (!padIds.has(pin.number)) throw new Error(`Pin ${pin.number} has no pad in a ${spec.package.type} package (pads: ${[...padIds].join(", ")})`);
  for (const pad of padIds) if (!spec.pins.some((p) => p.number === pad)) throw new Error(`Pad ${pad} of the ${spec.package.type} package has no pin; list every pad (use NC for unused)`);
  const half = Math.ceil(spec.pins.length / 2);
  const left: [string, string][] = [];
  const right: [string, string][] = [];
  spec.pins.forEach((p, i) => ((p.side ?? (i < half ? "left" : "right")) === "left" ? left : right).push([p.number, p.name]));
  return {
    id,
    name: spec.name,
    category: spec.category ?? "Custom",
    description: spec.description ?? spec.name,
    kind: "part",
    refPrefix: spec.refPrefix,
    defaultValue: spec.value ?? spec.name,
    mpn: spec.mpn,
    keywords: spec.keywords ?? [],
    symbol: withTypes(icSymbol(left, right, spec.pins.length > 3 ? spec.name.slice(0, 14) : ""), spec.pins),
    footprint,
  };
}

function withTypes(sym: PartSymbol, pins: { number: string; type?: PinType }[]): PartSymbol {
  for (const p of sym.pins) p.type = pins.find((x) => x.number === p.id)?.type ?? "passive";
  return sym;
}
