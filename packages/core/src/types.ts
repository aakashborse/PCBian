// Core data model for a PCBian project.
// Schematic coordinates are in abstract grid units (1 grid = 10 units).
// PCB coordinates are in millimetres, y axis pointing down (screen convention).

export interface Vec {
  x: number;
  y: number;
}

export type Rotation = 0 | 90 | 180 | 270;
export type Side = "top" | "bottom";
/** Copper layers from front to back: top, in1 … in30, bottom. A board uses the first layers-2 inner layers. */
export type CopperLayer = "top" | "bottom" | `in${number}`;
export const MAX_LAYERS = 32;
/** Every possible copper layer (through-hole pads and through vias are on all of a board's layers). */
export const ALL_COPPER: CopperLayer[] = ["top", ...Array.from({ length: MAX_LAYERS - 2 }, (_, i) => `in${i + 1}` as CopperLayer), "bottom"];

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
  /** SPICE model name (from the design's imported models) used by the simulator. */
  model?: string;
}

export type SpiceModelType = "D" | "NPN" | "PNP" | "NMOS" | "PMOS";

/** A primitive SPICE .model card (parameter names upper-case, values in SI units). */
export interface SpiceModel {
  name: string;
  type: SpiceModelType;
  params: Record<string, number>;
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
  /** Higher priority zones win where zones of different nets overlap (default 0). */
  priority?: number;
  /** Solid fill (default) or a hatched mesh (flex boards, impedance reference planes). */
  fill?: "solid" | "hatch";
  /** Hatch line width and gap between lines (mm). */
  hatchWidth?: number;
  hatchGap?: number;
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
  /** Target single-ended impedance (ohms); the width is then solved from the stackup per layer. */
  impedance?: number;
}

/** Two nets routed as a coupled pair (USB, LVDS, Ethernet…). */
export interface DiffPair {
  name: string;
  positive: string;
  negative: string;
  /** Trace width and edge-to-edge gap in mm. */
  width: number;
  gap: number;
  /** Target differential impedance (ohms), for reporting and width/gap solving. */
  impedance?: number;
  /** Allowed length difference between the two nets (mm). */
  maxSkew: number;
}

/** Nets whose routed lengths must match (a DDR byte lane, a parallel bus…). */
export interface LengthGroup {
  name: string;
  nets: string[];
  /** Target length (mm); when omitted the longest net in the group sets it. */
  target?: number;
  /** Allowed deviation from the target (mm). */
  tolerance: number;
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
  /** Layer span for blind/buried/micro vias; omitted = through (top to bottom). */
  from?: CopperLayer;
  to?: CopperLayer;
}

/** Dielectric between two adjacent copper layers. */
export interface Dielectric {
  /** mm */
  thickness: number;
  /** Relative permittivity (FR-4 ≈ 4.3). */
  er: number;
  kind: "core" | "prepreg";
}

export interface Stackup {
  /** Copper weight per layer, top to bottom (oz; 1 oz ≈ 0.035 mm). */
  copperOz: number[];
  /** layers - 1 dielectrics, top to bottom. */
  dielectrics: Dielectric[];
  /** Soldermask thickness (mm) and permittivity, used for outer-layer impedance. */
  maskThickness?: number;
  maskEr?: number;
}

export interface BoardSettings {
  width: number;
  height: number;
  /** Copper layer count: an even number from 2 to 32. */
  layers: number;
  /** Layer stackup; derived from thickness when absent. */
  stackup?: Stackup;
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

export interface CommentReply {
  id: string;
  author: string;
  color?: string;
  text: string;
  at: number;
}

/** A review comment pinned to a spot on the schematic or the board. */
export interface DesignComment {
  id: string;
  view: "schematic" | "pcb";
  /** Schematic sheet (schematic comments). */
  sheet?: string;
  pos: Vec;
  /** Component the comment is about, if it was dropped on one. */
  ref?: string;
  author: string;
  color?: string;
  text: string;
  createdAt: number;
  resolved?: boolean;
  replies: CommentReply[];
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
  diffPairs: DiffPair[];
  lengthGroups: LengthGroup[];
  comments: DesignComment[];
  spiceModels: SpiceModel[];
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
