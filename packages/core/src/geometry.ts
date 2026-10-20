import { getPart } from "./library";
import type { ComponentData, Pad, PcbPlacement, Placement, Rotation, Side, SymbolPin, Vec } from "./types";

export function rotate(p: Vec, rot: Rotation): Vec {
  switch (rot) {
    case 90:
      return { x: -p.y, y: p.x };
    case 180:
      return { x: -p.x, y: -p.y };
    case 270:
      return { x: p.y, y: -p.x };
    default:
      return { x: p.x, y: p.y };
  }
}

export const nextRotation = (r: Rotation): Rotation => (((r + 90) % 360) as Rotation);

export function toWorld(local: Vec, at: Placement, mirrorX = false): Vec {
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
}

export function schematicPins(c: ComponentData): WorldPin[] {
  const part = getPart(c.partId);
  if (!part) return [];
  return part.symbol.pins.map((p) => ({ ...p, world: toWorld(p, c.sch) }));
}

export function schematicPin(c: ComponentData, pinId: string): Vec | undefined {
  return schematicPins(c).find((p) => p.id === pinId)?.world;
}

// ---------- PCB ----------

export interface WorldPad extends Pad {
  comp: string;
  ref: string;
  world: Vec;
  /** Width/height after rotation (rotations are multiples of 90 degrees). */
  ww: number;
  wh: number;
  layers: Side[];
}

export function padsOf(c: ComponentData): WorldPad[] {
  const part = getPart(c.partId);
  if (!part?.footprint) return [];
  const mirror = c.pcb.side === "bottom";
  const swap = c.pcb.rot === 90 || c.pcb.rot === 270;
  return part.footprint.pads.map((p) => ({
    ...p,
    comp: c.id,
    ref: c.ref,
    world: toWorld(p, c.pcb, mirror),
    ww: swap ? p.h : p.w,
    wh: swap ? p.w : p.h,
    layers: p.drill ? ["top", "bottom"] : [c.pcb.side],
  }));
}

export function padRect(p: WorldPad): Rect {
  return { x0: p.world.x - p.ww / 2, y0: p.world.y - p.wh / 2, x1: p.world.x + p.ww / 2, y1: p.world.y + p.wh / 2 };
}

export function courtyardRect(c: ComponentData): Rect | null {
  const part = getPart(c.partId);
  if (!part?.footprint) return null;
  const { w, h } = part.footprint.courtyard;
  const swap = c.pcb.rot === 90 || c.pcb.rot === 270;
  const hw = (swap ? h : w) / 2;
  const hh = (swap ? w : h) / 2;
  return { x0: c.pcb.x - hw, y0: c.pcb.y - hh, x1: c.pcb.x + hw, y1: c.pcb.y + hh };
}

export function defaultPcbPlacement(index: number): PcbPlacement {
  // Stage new parts in a column to the left of the board until the user places them.
  return { x: -12, y: 4 + (index % 12) * 6, rot: 0, side: "top" };
}
