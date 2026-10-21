// A two-part enclosure (base and lid) generated around the board: walls at a clearance from the
// board's outline box, standoffs under the mounting holes, headroom over the tallest part, and wall
// openings for connectors at the board edge. All solids are axis-aligned boxes or round standoffs,
// in the STEP export's frame (mm, y up, board bottom at z = 0), so they line up with the board model.
import { boardOutline } from "./doc";
import { courtyardCorners, padsOf } from "./geometry";
import { getPart } from "./library";
import { bodyHeight, stepFile, type StepSolid } from "./step";
import type { Design, Vec } from "./types";

export interface EnclosureOptions {
  /** Wall, floor and lid thickness (mm). */
  wall?: number;
  /** Gap between the board edge and the inside of the walls (mm). */
  clearance?: number;
  /** Board standoff height above the floor (mm). */
  standoff?: number;
  /** Space above the tallest part (mm). */
  headroom?: number;
  /** Parts whose body comes within this distance of the board edge get a wall opening (mm). */
  edgeReach?: number;
  /** Margin around a wall opening (mm). */
  openingMargin?: number;
}

export interface EnclosureCutout {
  ref: string;
  side: "left" | "right" | "front" | "back";
  /** Opening in the wall: along-wall range and height range (mm, STEP frame). */
  a0: number;
  a1: number;
  z0: number;
  z1: number;
}

export interface Enclosure {
  base: StepSolid[];
  lid: StepSolid[];
  /** Outside box of the closed enclosure (STEP frame). */
  outer: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number };
  cutouts: EnclosureCutout[];
  standoffs: Vec[];
  /** Tallest part above the board top (mm). */
  tallest: number;
  warnings: string[];
}

const box = (name: string, x0: number, y0: number, x1: number, y1: number, z0: number, z1: number, rgb: StepSolid["rgb"]): StepSolid => ({
  name,
  outer: [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ],
  z0,
  z1,
  rgb,
});

const ring = (c: Vec, r: number, n = 24) => Array.from({ length: n }, (_, i) => ({ x: c.x + r * Math.cos((2 * Math.PI * i) / n), y: c.y + r * Math.sin((2 * Math.PI * i) / n) }));

const BASE: StepSolid["rgb"] = [0.75, 0.77, 0.8];
const LID: StepSolid["rgb"] = [0.6, 0.63, 0.68];

export function enclosure(design: Design, o: EnclosureOptions = {}): Enclosure {
  const t = o.wall ?? 2;
  const cl = o.clearance ?? 0.5;
  const so = o.standoff ?? 4;
  const head = o.headroom ?? 2;
  const reach = o.edgeReach ?? 1.5;
  const margin = o.openingMargin ?? 0.5;
  const T = design.board.thickness;
  const H = design.board.height;
  const warnings: string[] = [];
  // Board box in the STEP frame (y up).
  const outline = boardOutline(design.board).map((p) => ({ x: p.x, y: H - p.y }));
  const bx0 = Math.min(...outline.map((p) => p.x));
  const bx1 = Math.max(...outline.map((p) => p.x));
  const by0 = Math.min(...outline.map((p) => p.y));
  const by1 = Math.max(...outline.map((p) => p.y));
  const ix0 = bx0 - cl;
  const ix1 = bx1 + cl;
  const iy0 = by0 - cl;
  const iy1 = by1 + cl;
  const floorTop = -so;
  const floorBottom = floorTop - t;
  // Tallest part on top, and anything on the bottom that needs room under the board.
  let tallest = 0;
  let under = 0;
  const parts = design.components.filter((c) => getPart(c.partId)?.footprint && !c.dnp);
  for (const c of parts) {
    const hgt = bodyHeight(c);
    if (c.pcb.side === "top") tallest = Math.max(tallest, hgt);
    else under = Math.max(under, hgt);
  }
  if (under > so - 0.5) warnings.push(`Bottom-side parts are ${under.toFixed(1)}mm tall: raise the standoffs above ${so}mm`);
  const innerTop = T + tallest + head;
  const lidBottom = innerTop;
  const lidTop = lidBottom + t;

  // Openings for parts that reach the board edge (connectors, switches...).
  const cutouts: EnclosureCutout[] = [];
  for (const c of parts) {
    const corners = courtyardCorners(c, 0)?.map((p) => ({ x: p.x, y: H - p.y }));
    if (!corners) continue;
    const cx0 = Math.min(...corners.map((p) => p.x));
    const cx1 = Math.max(...corners.map((p) => p.x));
    const cy0 = Math.min(...corners.map((p) => p.y));
    const cy1 = Math.max(...corners.map((p) => p.y));
    const hgt = bodyHeight(c);
    const zA = c.pcb.side === "top" ? T : -hgt;
    const zB = c.pcb.side === "top" ? T + hgt : 0;
    const z0 = Math.max(floorTop, zA - margin);
    const z1 = Math.min(innerTop, zB + margin);
    const sides: [EnclosureCutout["side"], boolean, number, number][] = [
      ["left", cx0 - bx0 < reach, cy0, cy1],
      ["right", bx1 - cx1 < reach, cy0, cy1],
      ["front", cy0 - by0 < reach, cx0, cx1],
      ["back", by1 - cy1 < reach, cx0, cx1],
    ];
    for (const [side, near, a0, a1] of sides) if (near && hgt > 0) cutouts.push({ ref: c.ref, side, a0: a0 - margin, a1: a1 + margin, z0, z1 });
  }

  // Walls: each side a set of boxes around its openings.
  const base: StepSolid[] = [box("Floor", ix0 - t, iy0 - t, ix1 + t, iy1 + t, floorBottom, floorTop, BASE)];
  const wallSpan: Record<EnclosureCutout["side"], { a0: number; a1: number; box: (a0: number, a1: number, z0: number, z1: number) => StepSolid }> = {
    left: { a0: iy0 - t, a1: iy1 + t, box: (a0, a1, z0, z1) => box("Wall left", ix0 - t, a0, ix0, a1, z0, z1, BASE) },
    right: { a0: iy0 - t, a1: iy1 + t, box: (a0, a1, z0, z1) => box("Wall right", ix1, a0, ix1 + t, a1, z0, z1, BASE) },
    front: { a0: ix0, a1: ix1, box: (a0, a1, z0, z1) => box("Wall front", a0, iy0 - t, a1, iy0, z0, z1, BASE) },
    back: { a0: ix0, a1: ix1, box: (a0, a1, z0, z1) => box("Wall back", a0, iy1, a1, iy1 + t, z0, z1, BASE) },
  };
  for (const side of ["left", "right", "front", "back"] as const) {
    const w = wallSpan[side];
    const holes = cutouts
      .filter((c) => c.side === side)
      .map((c) => ({ ...c, a0: Math.max(w.a0 + t, c.a0), a1: Math.min(w.a1 - t, c.a1) }))
      .filter((c) => c.a1 > c.a0)
      .sort((a, b) => a.a0 - b.a0);
    // Merge overlapping openings into one.
    const merged: typeof holes = [];
    for (const h of holes) {
      const last = merged[merged.length - 1];
      if (last && h.a0 <= last.a1) {
        last.a1 = Math.max(last.a1, h.a1);
        last.z0 = Math.min(last.z0, h.z0);
        last.z1 = Math.max(last.z1, h.z1);
      } else merged.push({ ...h });
    }
    let a = w.a0;
    for (const h of merged) {
      if (h.a0 > a) base.push(w.box(a, h.a0, floorTop, innerTop));
      if (h.z0 > floorTop) base.push(w.box(h.a0, h.a1, floorTop, h.z0));
      if (h.z1 < innerTop) base.push(w.box(h.a0, h.a1, h.z1, innerTop));
      a = h.a1;
    }
    if (a < w.a1) base.push(w.box(a, w.a1, floorTop, innerTop));
  }

  // Standoffs under plated mounting holes (or none, with a note).
  const standoffs: Vec[] = [];
  for (const c of parts)
    for (const p of padsOf(c)) {
      if (!p.drill || !/^mounting/i.test(c.partId)) continue;
      const at = { x: p.world.x, y: H - p.world.y };
      standoffs.push(at);
      const r = Math.max(p.ww, p.wh) / 2;
      base.push({ name: `Standoff ${c.ref}`, outer: ring(at, r), holes: [ring(at, Math.max(0.5, p.drill / 2 - 0.35))], z0: floorTop, z1: 0, rgb: BASE });
    }
  if (!standoffs.length) warnings.push("No mounting holes: the board has nothing to sit on (add mounting holes for standoffs)");

  const lid: StepSolid[] = [box("Lid", ix0 - t, iy0 - t, ix1 + t, iy1 + t, lidBottom, lidTop, LID)];
  return { base, lid, outer: { x0: ix0 - t, y0: iy0 - t, z0: floorBottom, x1: ix1 + t, y1: iy1 + t, z1: lidTop }, cutouts, standoffs, tallest, warnings };
}

/** STEP of the enclosure (base and lid), optionally with the board inside. */
export function enclosureStep(design: Design, o: EnclosureOptions = {}, withBoard = true, models: Record<string, string> = {}): string {
  const e = enclosure(design, o);
  return stepFile({ ...design, name: `${design.name}-enclosure` }, withBoard ? models : {}, { extra: [...e.base, ...e.lid], boardless: !withBoard });
}
