import { getPart, unitCount } from "./library";
import { ALL_COPPER, type ComponentData, type CopperLayer, type Pad, type PcbPlacement, type Rotation, type SymbolPin, type Vec } from "./types";

/** Rotate by any angle in degrees (90 maps +x to +y, i.e. clockwise on a y-down screen). */
export function rotate(p: Vec, rot: number): Vec {
  switch (((rot % 360) + 360) % 360) {
    case 0:
      return { x: p.x, y: p.y };
    case 90:
      return { x: -p.y, y: p.x };
    case 180:
      return { x: -p.x, y: -p.y };
    case 270:
      return { x: p.y, y: -p.x };
    default: {
      const a = (rot * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
    }
  }
}

/** Angle normalised to [0, 360). */
export const normAngle = (deg: number) => ((Math.round(deg * 1e6) / 1e6) % 360 + 360) % 360;

export const nextRotation = (r: Rotation): Rotation => (((r + 90) % 360) as Rotation);

export function toWorld(local: Vec, at: { x: number; y: number; rot: number; mirror?: boolean }, mirrorX = false): Vec {
  const m = mirrorX ? { x: -local.x, y: local.y } : local;
  const r = rotate(m, at.rot);
  return { x: at.x + r.x, y: at.y + r.y };
}

export const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);

export function snap(v: number, step: number) {
  return Math.round(v / step) * step;
}

export function pointSegmentDistance(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
}

function segmentsIntersect(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const cross = (o: Vec, p: Vec, q: Vec) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

export function segmentSegmentDistance(a: Vec, b: Vec, c: Vec, d: Vec): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function segmentRectDistance(a: Vec, b: Vec, r: Rect): number {
  const inside = (p: Vec) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
  if (inside(a) || inside(b)) return 0;
  const c = [
    { x: r.x0, y: r.y0 },
    { x: r.x1, y: r.y0 },
    { x: r.x1, y: r.y1 },
    { x: r.x0, y: r.y1 },
  ];
  let best = Infinity;
  for (let i = 0; i < 4; i++) best = Math.min(best, segmentSegmentDistance(a, b, c[i], c[(i + 1) % 4]));
  return best;
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

// ---------- schematic ----------

export interface WorldPin extends SymbolPin {
  world: Vec;
  /** Unit of a multi-unit part the pin belongs to (1 for ordinary parts). */
  unit: number;
  /** Sheet the pin's unit is drawn on (undefined: the first sheet). */
  sheet?: string;
}

/**
 * A component as drawn on the schematic: one view per unit, each a component whose `sch` and
 * `sheet` are that unit's placement and whose part is the unit's symbol. Ordinary parts have one
 * view, the component itself (with unit 1).
 */
export function schematicViews(c: ComponentData): ComponentData[] {
  if (c.unit) return [c];
  const n = unitCount(getPart(c.partId));
  if (n === 1) return [{ ...c, unit: 1 }];
  return Array.from({ length: n }, (_, i) => {
    const u = i === 0 ? { ...c.sch, sheet: c.sheet } : (c.units?.[i - 1] ?? { x: c.sch.x + 60 * i, y: c.sch.y, rot: c.sch.rot, sheet: c.sheet });
    const { sheet, ...sch } = u;
    return { ...c, partId: `${c.partId}#u${i + 1}`, sch, sheet, unit: i + 1 };
  });
}

/** Reference as shown on a unit's symbol: "U1A", "U1B"… for multi-unit parts, else "U1". */
export function unitRef(c: ComponentData): string {
  if (!c.unit || unitCount(getPart(c.partId.replace(/#u\d+$/, ""))) === 1) return c.ref;
  return c.ref + String.fromCharCode(64 + c.unit);
}

export function schematicPins(c: ComponentData): WorldPin[] {
  if (!c.unit && unitCount(getPart(c.partId)) > 1) return schematicViews(c).flatMap(schematicPins);
  const part = getPart(c.partId);
  if (!part) return [];
  const mirror = Boolean(c.sch.mirror);
  // A mirrored pin on the left side ends up on the right (and vice versa).
  const flip = (side: SymbolPin["side"]): SymbolPin["side"] => (mirror && side === "left" ? "right" : mirror && side === "right" ? "left" : side);
  return part.symbol.pins.map((p) => ({ ...p, side: flip(p.side), world: toWorld(p, c.sch, mirror), unit: c.unit ?? 1, sheet: c.sheet }));
}

export function schematicPin(c: ComponentData, pinId: string): Vec | undefined {
  return schematicPins(c).find((p) => p.id === pinId)?.world;
}

// ---------- PCB ----------

export interface WorldPad extends Pad {
  comp: string;
  ref: string;
  world: Vec;
  /** Width/height in the board frame; for angled pads, the unrotated size (see `angle`). */
  ww: number;
  wh: number;
  /** Remaining rotation (degrees, 0 < angle < 180) for pads that are not axis-aligned; 0 otherwise. */
  angle: number;
  layers: CopperLayer[];
}

export function padsOf(c: ComponentData): WorldPad[] {
  const part = getPart(c.partId);
  if (!part?.footprint) return [];
  const mirror = c.pcb.side === "bottom";
  return part.footprint.pads.map((p) => {
    // Mirroring for the bottom side flips the pad's own rotation.
    const total = normAngle(c.pcb.rot + (mirror ? -(p.rot ?? 0) : p.rot ?? 0));
    const quarter = Math.round(total / 90);
    const axis = Math.abs(total - quarter * 90) < 1e-6;
    const swap = axis && quarter % 2 !== 0;
    return {
      ...p,
      comp: c.id,
      ref: c.ref,
      world: toWorld(p, c.pcb, mirror),
      ww: swap ? p.h : p.w,
      wh: swap ? p.w : p.h,
      angle: axis || p.shape === "circle" ? 0 : total % 180,
      layers: p.drill ? ALL_COPPER : [c.pcb.side],
    };
  });
}

/** Corners of a pad's rectangle in the board frame (exact for angled pads). */
export function padCorners(p: Pick<WorldPad, "world" | "ww" | "wh" | "angle">, grow = 0): Vec[] {
  const hw = p.ww / 2 + grow;
  const hh = p.wh / 2 + grow;
  return [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ].map((q) => {
    const r = rotate(q, p.angle);
    return { x: p.world.x + r.x, y: p.world.y + r.y };
  });
}

/** Distance from a segment to a polygon's area (0 when they touch or the segment lies inside). */
export function segmentPolygonDistance(a: Vec, b: Vec, poly: Vec[]): number {
  if (pointInPolygon(a, poly) || pointInPolygon(b, poly)) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) best = Math.min(best, segmentSegmentDistance(a, b, poly[i], poly[(i + 1) % poly.length]));
  return best;
}

/** Distance between two polygons' areas (0 when they overlap). */
export function polygonPolygonDistance(p: Vec[], q: Vec[]): number {
  if (pointInPolygon(p[0], q) || pointInPolygon(q[0], p)) return 0;
  let best = Infinity;
  for (let i = 0; i < p.length; i++) best = Math.min(best, segmentPolygonDistance(p[i], p[(i + 1) % p.length], q));
  return best;
}

/** Centre-line of an oval pad (its stadium is this segment grown by half the short side). */
export function ovalAxis(p: Pick<WorldPad, "world" | "ww" | "wh" | "angle">): [Vec, Vec] {
  const r = Math.min(p.ww, p.wh) / 2;
  const d = rotate({ x: p.ww / 2 - r, y: p.wh / 2 - r }, p.angle);
  return [
    { x: p.world.x - d.x, y: p.world.y - d.y },
    { x: p.world.x + d.x, y: p.world.y + d.y },
  ];
}

/** Distance from a point to a pad's copper (0 inside); exact for circles, ovals and angled pads. */
export function padDistance(p: WorldPad, q: Vec): number {
  if (p.shape === "circle") return Math.max(0, Math.hypot(q.x - p.world.x, q.y - p.world.y) - Math.min(p.ww, p.wh) / 2);
  if (p.shape === "oval") {
    const [a, b] = ovalAxis(p);
    return Math.max(0, pointSegmentDistance(q, a, b) - Math.min(p.ww, p.wh) / 2);
  }
  if (p.angle) return segmentPolygonDistance(q, q, padCorners(p));
  return segmentRectDistance(q, q, padRect(p));
}

/** Axis-aligned bounds of a pad (its exact rectangle when the pad is not angled). */
export function padRect(p: WorldPad): Rect {
  if (!p.angle) return { x0: p.world.x - p.ww / 2, y0: p.world.y - p.wh / 2, x1: p.world.x + p.ww / 2, y1: p.world.y + p.wh / 2 };
  const cs = padCorners(p);
  return { x0: Math.min(...cs.map((q) => q.x)), y0: Math.min(...cs.map((q) => q.y)), x1: Math.max(...cs.map((q) => q.x)), y1: Math.max(...cs.map((q) => q.y)) };
}

export function courtyardRect(c: ComponentData): Rect | null {
  const part = getPart(c.partId);
  if (!part?.footprint) return null;
  const { w, h } = part.footprint.courtyard;
  // Bounding box of the rotated courtyard (exact for multiples of 90 degrees).
  const a = (normAngle(c.pcb.rot) * Math.PI) / 180;
  const cs = Math.abs(Math.cos(a));
  const sn = Math.abs(Math.sin(a));
  const hw = (w * cs + h * sn) / 2;
  const hh = (w * sn + h * cs) / 2;
  return { x0: c.pcb.x - hw, y0: c.pcb.y - hh, x1: c.pcb.x + hw, y1: c.pcb.y + hh };
}

/** Corners of a part's courtyard (shrunk by `inset`) in the board frame, at any rotation. */
export function courtyardCorners(c: ComponentData, inset = 0): Vec[] | null {
  const part = getPart(c.partId);
  if (!part?.footprint) return null;
  const hw = part.footprint.courtyard.w / 2 - inset;
  const hh = part.footprint.courtyard.h / 2 - inset;
  return padCorners({ world: c.pcb, ww: 2 * hw, wh: 2 * hh, angle: normAngle(c.pcb.rot) });
}

export function defaultPcbPlacement(index: number): PcbPlacement {
  // Stage new parts in a column to the left of the board until the user places them.
  return { x: -12, y: 4 + (index % 12) * 6, rot: 0, side: "top" };
}

export function pointInPolygon(p: Vec, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** True when a polyline (or point) touches the inside of a polygon. */
export function polylineTouchesPolygon(pts: Vec[], poly: Vec[]): boolean {
  if (pts.some((p) => pointInPolygon(p, poly))) return true;
  for (let i = 1; i < pts.length; i++) {
    for (let j = 0; j < poly.length; j++) {
      if (segmentSegmentDistance(pts[i - 1], pts[i], poly[j], poly[(j + 1) % poly.length]) === 0) return true;
    }
  }
  return false;
}

export function polygonArea(poly: Vec[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  return Math.abs(a / 2);
}

/** Horizontal scanline: inside intervals [x0, x1] of a polygon at height y (even-odd rule). */
export function polygonSpans(poly: Vec[], y: number): [number, number][] {
  const xs: number[] = [];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y) xs.push(((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x);
  }
  xs.sort((p, q) => p - q);
  const out: [number, number][] = [];
  for (let k = 0; k + 1 < xs.length; k += 2) out.push([xs[k], xs[k + 1]]);
  return out;
}
