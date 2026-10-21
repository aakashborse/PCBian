// Exact polygon geometry for copper pours, on Clipper (Angus Johnson's Clipper 6, integer
// coordinates on a 0.1 µm grid). Shapes are lists of closed paths (outer contours and holes,
// non-zero fill); round features (pads, vias, clearances, trace ends) are approximated within 2 µm.
import ClipperLib from "clipper-lib";
import { pointInPolygon, pointSegmentDistance } from "./geometry";
import type { Vec } from "./types";

const S = 1e4; // integer units per mm
const ARC_TOL = 0.002 * S;
const { Clipper, ClipperOffset, ClipType, PolyType, PolyFillType, JoinType, EndType, PolyTree } = ClipperLib;
const NZ = PolyFillType.pftNonZero;

export type Area = ClipperLib.Paths;

const toPath = (pts: Vec[]): ClipperLib.Path => pts.map((q) => ({ X: Math.round(q.x * S), Y: Math.round(q.y * S) }));
const fromPath = (p: ClipperLib.Path): Vec[] => p.map((q) => ({ x: q.X / S, y: q.Y / S }));

export const polygon = (pts: Vec[]): Area => [toPath(pts)];

/** A polygon grown (or shrunk, for negative d) by d with round corners. */
export function grow(shape: Area, d: number): Area {
  if (!d) return shape;
  const o = new ClipperOffset(2, ARC_TOL);
  o.AddPaths(shape, JoinType.jtRound, EndType.etClosedPolygon);
  const out: Area = [];
  o.Execute(out, d * S);
  return out;
}

/** A stroked polyline: round joins, and round or flat ends. */
export function stroke(pts: Vec[], width: number, ends: "round" | "flat" = "round"): Area {
  if (pts.length === 1 || pts.every((p) => p.x === pts[0].x && p.y === pts[0].y)) return ends === "round" ? circle(pts[0], width / 2) : [];
  const o = new ClipperOffset(2, ARC_TOL);
  o.AddPath(toPath(pts), JoinType.jtRound, ends === "round" ? EndType.etOpenRound : EndType.etOpenButt);
  const out: Area = [];
  o.Execute(out, (width / 2) * S);
  return out;
}

/** A circle as a polygon, with enough sides to stay within the arc tolerance. */
export function circle(c: Vec, r: number): Area {
  const n = Math.max(12, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - ARC_TOL / Math.max(r * S, ARC_TOL)))));
  return polygon(Array.from({ length: n }, (_, i) => ({ x: c.x + r * Math.cos((2 * Math.PI * i) / n), y: c.y + r * Math.sin((2 * Math.PI * i) / n) })));
}

function op(type: ClipperLib.ClipType, a: Area, b: Area): Area {
  const c = new Clipper();
  c.AddPaths(a, PolyType.ptSubject, true);
  c.AddPaths(b, PolyType.ptClip, true);
  const out: Area = [];
  c.Execute(type, out, NZ, NZ);
  return out;
}
export const union = (...shapes: Area[]): Area => op(ClipType.ctUnion, shapes.flat(), []);
export const difference = (a: Area, b: Area): Area => (b.length ? op(ClipType.ctDifference, a, b) : a);
export const intersection = (a: Area, b: Area): Area => op(ClipType.ctIntersection, a, b);
export const area = (s: Area) => Math.abs(s.reduce((sum, p) => sum + Clipper.Area(p), 0)) / (S * S);

/** A shape split into islands: each an outer contour followed by its holes. */
export function islands(shape: Area): Vec[][][] {
  const c = new Clipper();
  c.AddPaths(shape, PolyType.ptSubject, true);
  const tree = new PolyTree();
  c.Execute(ClipType.ctUnion, tree, NZ, NZ);
  const out: Vec[][][] = [];
  const walk = (node: ClipperLib.PolyNode) => {
    for (const outer of node.Childs()) {
      out.push([fromPath(outer.Contour()), ...outer.Childs().map((h) => fromPath(h.Contour()))]);
      // Copper inside a hole is an island of its own.
      for (const h of outer.Childs()) walk(h);
    }
  };
  walk(tree);
  return out;
}

/** Whether a point lies on an island (inside its outline, not inside a hole); edges count. */
export function onIsland(island: Vec[][], p: Vec): boolean {
  const near = (ring: Vec[]) => ring.some((a, i) => pointSegmentDistance(p, a, ring[(i + 1) % ring.length]) < 1e-6);
  if (!pointInPolygon(p, island[0]) && !near(island[0])) return false;
  for (const h of island.slice(1)) if (pointInPolygon(p, h) && !near(h)) return false;
  return true;
}

export const islandShape = (island: Vec[][]): Area => island.map(toPath);

/**
 * One simple contour for an island with holes, joining each hole to the outline with a
 * zero-width cut (Gerber "cut-in" regions). Holes are bridged left-most first, along a
 * horizontal ray to the nearest edge on their left.
 */
export function fracture(island: Vec[][]): Vec[] {
  let outer = orient(island[0], true);
  const holes = island.slice(1).map((h) => orient(h, false)).sort((a, b) => minX(a) - minX(b));
  for (const hole of holes) {
    const hi = hole.reduce((best, p, i) => (p.x < hole[best].x ? i : best), 0);
    const h = hole[hi];
    let best = -1;
    let bx = -Infinity;
    for (let i = 0; i < outer.length; i++) {
      const a = outer[i];
      const b = outer[(i + 1) % outer.length];
      if (a.y > h.y === b.y > h.y) continue;
      const x = a.x + ((h.y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (x <= h.x && x > bx) {
        bx = x;
        best = i;
      }
    }
    if (best < 0) continue;
    const at = { x: bx, y: h.y };
    const ring = [...hole.slice(hi), ...hole.slice(0, hi), h];
    outer = [...outer.slice(0, best + 1), at, ...ring, at, ...outer.slice(best + 1)];
  }
  return outer;
}

const minX = (pts: Vec[]) => Math.min(...pts.map((p) => p.x));
const signedArea = (pts: Vec[]) => pts.reduce((s, p, i) => s + p.x * pts[(i + 1) % pts.length].y - pts[(i + 1) % pts.length].x * p.y, 0) / 2;
/** Outer contours one way, holes the other (so cut-in regions fill correctly). */
const orient = (pts: Vec[], outer: boolean) => (signedArea(pts) > 0 === outer ? pts : [...pts].reverse());
