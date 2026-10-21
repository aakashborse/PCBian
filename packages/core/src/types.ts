// Core data model for a PCBian project.
// Schematic coordinates are in abstract grid units (1 grid = 10 units).
// PCB coordinates are in millimetres, y axis pointing down (screen convention).

export interface Vec {
  x: number;
  y: number;
}

export type Rotation = 0 | 90 | 180 | 270;
export type Side = "top" | "bottom";
/** Copper layers from front to back. Inner layers exist only on 4-layer boards. */
export type CopperLayer = "top" | "in1" | "in2" | "bottom";
export const ALL_COPPER: CopperLayer[] = ["top", "in1", "in2", "bottom"];

/** Drawing primitives used by schematic symbols and footprint silkscreen. */
export type Shape =
  | { kind: "rect"; x: number; y: number; w: number; h: number; fill?: boolean }
  | { kind: "line"; points: Vec[] }
  | { kind: "circle"; x: number; y: number; r: number; fill?: boolean }
  | { kind: "polygon"; points: Vec[]; fill?: boolean }
  | { kind: "text"; x: number; y: number; text: string; size?: number; anchor?: "start" | "middle" | "end" };

export type PinSide = "left" | "right" | "top" | "bottom";

/** Electrical pin type, used by the ERC pin-conflict matrix (KiCad/Altium style). */
export type PinType = "input" | "output" | "bidirectional" | "tristate" | "passive" | "power_in" | "power_out" | "open_collector" | "unspecified" | "nc";

export interface SymbolPin {
  /** Pin number, matches the footprint pad id. */
  id: string;
  name: string;
  /** Connection point (the outer end of the pin), relative to the symbol origin. */
  x: number;
  y: number;
  /** Side of the body the pin sticks out of. */
  side: PinSide;
  length: number;
  showName: boolean;
  showNumber: boolean;
  /** Electrical type; missing means passive. */
  type?: PinType;
}

export interface PartSymbol {
  shapes: Shape[];
  pins: SymbolPin[];
  refPos: Vec;
  valuePos: Vec;
}

export type PadShape = "rect" | "circle" | "oval";

export interface Pad {
  /** Pad number, matches the symbol pin id. */
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  shape: PadShape;
  /** Present for through-hole pads (diameter in mm). */
  drill?: number;
}

export interface Footprint {
  name: string;
  pads: Pad[];
  /** Courtyard rectangle, centred on the footprint origin. */
  courtyard: { w: number; h: number };
  silk: Shape[];
}

/**
 * part: physical component · power: global power symbol · netlabel: global label ·
 * locallabel: label scoped to its sheet · hierlabel: hierarchical port of its sheet ·
 * sheet: sheet symbol that instantiates a child sheet (pins = the child's hierarchical labels).
 */
export type PartKind = "part" | "power" | "netlabel" | "locallabel" | "hierlabel" | "sheet";

export interface PartDef {
  id: string;
  name: string;
  category: string;
  description: string;
  kind: PartKind;
  refPrefix: string;
  defaultValue: string;
  mpn?: string;
  keywords?: string[];
  symbol: PartSymbol;
  /** Power symbols and net labels have no physical footprint. */
  footprint: Footprint | null;
}

export interface Placement {
  x: number;
  y: number;
  rot: Rotation;
  /** Schematic only: mirror the symbol left-right before rotating. */
  mirror?: boolean;
}

export interface PcbPlacement extends Placement {
  side: Side;
}

export interface ComponentData {
  id: string;
  partId: string;
  ref: string;
  value: string;
  sch: Placement;
  pcb: PcbPlacement;
  /** Schematic sheet id; missing means the first sheet. */
  sheet?: string;
  /** Pin ids deliberately left unconnected (no-connect flags). */
  noConnect?: string[];
  /** Excluded from BOM / placement (e.g. fiducials, do-not-populate). */
  dnp?: boolean;
}

export interface Sheet {
  id: string;
  name: string;
}

/** Schematic graphics: free text, lines, rectangles and buses (a bus is a named, thick polyline). */
export interface SchGraphic {
  id: string;
  sheet: string;
  kind: "text" | "line" | "rect" | "bus";
  points: Vec[];
  text?: string;
  size?: number;
}

/** PCB graphics: dimensions and free text on the fab/assembly drawing. */
export interface PcbGraphic {
  id: string;
  kind: "dimension" | "text";
  points: Vec[];
  text?: string;
}

export interface TitleBlock {
  title: string;
  revision: string;
  date: string;
  company: string;
  author: string;
}

export interface Keepout {
  id: string;
  /** Layers the keepout applies to. */
  layers: CopperLayer[];
  points: Vec[];
  noTracks: boolean;
  noVias: boolean;
  noPours: boolean;
}

export interface Variant {
  name: string;
  /** References not fitted in this variant. */
  dnp: string[];
  /** Value overrides by reference. */
  values: Record<string, string>;
}

export interface Zone {
  id: string;
  net: string;
  layer: CopperLayer;
  /** Closed outline polygon in PCB mm. */
  points: Vec[];
  /** Higher priority zones win where zones overlap (reserved for future use). */
  priority?: number;
  /** How same-net pads join the pour (default thermal). */
  padConnection?: "thermal" | "solid";
  thermalGap?: number;
  spokeWidth?: number;
  /** Remove fill islands not connected to the zone's net (default true). */
  removeIslands?: boolean;
}

export interface NetClass {
  name: string;
  traceWidth: number;
  clearance: number;
  viaDiameter: number;
  viaDrill: number;
  /** Net names assigned to this class. */
  nets: string[];
}

export interface Terminal {
  comp: string;
  pin: string;
}

export interface Wire {
  id: string;
  a: Terminal;
  b: Terminal;
  /** Intermediate waypoints between terminal a and terminal b. */
  points: Vec[];
}

export interface Trace {
  id: string;
  layer: CopperLayer;
  width: number;
  points: Vec[];
}

export interface Via {
  id: string;
  x: number;
  y: number;
  diameter: number;
  drill: number;
}

export interface BoardSettings {
  width: number;
  height: number;
  /** Copper layer count: 2 (top/bottom) or 4 (top/in1/in2/bottom). */
  layers: 2 | 4;
  /** Board thickness in mm (for 3D and fab notes). */
  thickness: number;
  /** Minimum copper-to-copper clearance used by DRC (mm). */
  clearance: number;
  defaultTraceWidth: number;
  /** Optional custom outline polygon (mm); when absent the board is a width x height rectangle. */
  outline?: Vec[];
  /** Corner radius for the rectangular outline (mm). */
  cornerRadius?: number;
  /** Internal cutouts / slots (polygons, mm). */
  cutouts?: Vec[][];
  /** Add teardrops where traces meet pads and vias. */
  teardrops?: boolean;
}

/** Plain-object snapshot of a project's design document. */
export interface Design {
  name: string;
  board: BoardSettings;
  components: ComponentData[];
  wires: Wire[];
  traces: Trace[];
  vias: Via[];
  zones: Zone[];
  sheets: Sheet[];
  netClasses: NetClass[];
  keepouts: Keepout[];
  schGraphics: SchGraphic[];
  pcbGraphics: PcbGraphic[];
  titleBlock: TitleBlock;
  variants: Variant[];
  /** Active variant name; "" means the base design. */
  activeVariant: string;
}

export interface Net {
  name: string;
  terminals: Terminal[];
  /** True when the name comes from a power symbol or net label. */
  named: boolean;
}

export type Severity = "error" | "warning";

export interface Issue {
  severity: Severity;
  code: string;
  message: string;
  /** Location in PCB mm (DRC) or schematic units (ERC), when meaningful. */
  at?: Vec;
  refs?: string[];
}
