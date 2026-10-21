// Copper pour filling: clearance cut-outs, thermal reliefs, keepouts, board-edge clearance,
// hatching and island removal, computed as exact polygons (see poly.ts). The result is plain
// copper (islands with holes) that every output draws with dark polarity only.
import { boardOutline, netRules } from "./doc";
import { ovalAxis, padCorners, padRect, polygonPolygonDistance, rotate, segmentPolygonDistance, type Rect, type WorldPad } from "./geometry";
import { area, circle, difference, grow, intersection, islandShape, islands as splitIslands, onIsland, polygon, stroke, union, type Area } from "./poly";
import type { CopperLayer, Design, Trace, Vec, Via, Zone } from "./types";

export type Cutout =
  | { kind: "rect"; rect: Rect }
  | { kind: "circle"; c: Vec; r: number }
  | { kind: "line"; points: Vec[]; width: number }
  | { kind: "polygon"; points: Vec[] };

export interface ZoneFill {
  zone: Zone;
  /** The pour's copper: each island is an outline followed by its holes (mm). */
  polygons: Vec[][][];
  /** For each island, the keys of same-net items it connects. */
  islands: string[][];
  /** Islands dropped because they connect to nothing. */
  removedIslands: number;
  /** Hatched fill parameters (the holes are already part of `polygons`). */
  hatch?: { width: number; gap: number; origin: Vec };
}

/** Minimal copper item view needed by the filler. */
export type FillItem =
  | { kind: "pad"; key: string; pad: WorldPad }
  | { kind: "trace"; key: string; trace: Trace }
  | { kind: "via"; key: string; via: Via; layers: CopperLayer[] };

const onLayer = (it: FillItem, l: CopperLayer) => (it.kind === "pad" ? it.pad.layers.includes(l) : it.kind === "trace" ? it.trace.layer === l : it.layers.includes(l));

/** An item's copper grown by `g`. */
function itemShape(it: FillItem, g: number): Area {
  if (it.kind === "via") return circle(it.via, it.via.diameter / 2 + g);
  if (it.kind === "trace") return stroke(it.trace.points, it.trace.width + 2 * g);
  return padShape(it.pad, g);
}

/** A pad's copper grown by `g` (round-cornered growth, like a clearance). */
export function padShape(pad: WorldPad, g: number): Area {
  if (pad.shape === "circle") return circle(pad.world, Math.min(pad.ww, pad.wh) / 2 + g);
  if (pad.shape === "oval") return stroke(ovalAxis(pad), Math.min(pad.ww, pad.wh) + 2 * g);
  return grow(polygon(padCorners(pad)), g);
}

/** Whether an item's copper touches an island: probe points first, then exact overlap. */
const boxOf = new WeakMap<Vec[][], [number, number, number, number]>();
function touches(island: Vec[][], it: FillItem, pts: Vec[]): boolean {
  let box = boxOf.get(island);
  if (!box) {
    let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const p of island[0]) [x0, x1, y0, y1] = [Math.min(x0, p.x), Math.max(x1, p.x), Math.min(y0, p.y), Math.max(y1, p.y)];
    box = [x0, x1, y0, y1];
    boxOf.set(island, box);
  }
  const [x0, x1, y0, y1] = box;
  if (pts.some((p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && onIsland(island, p))) return true;
  if (it.kind === "trace") return false;
  const c = it.kind === "pad" ? it.pad.world : it.via;
  const r = it.kind === "pad" ? Math.hypot(it.pad.ww, it.pad.wh) / 2 : it.via.diameter / 2;
  if (c.x + r < x0 || c.x - r > x1 || c.y + r < y0 || c.y - r > y1) return false;
  return area(intersection(islandShape(island), itemShape(it, 0))) > 1e-6;
}

/** Points of an item that must be on an island for the item to join it. */
function probes(it: FillItem): Vec[] {
  if (it.kind === "pad") return [it.pad.world];
  if (it.kind === "via") return [it.via];
  const out: Vec[] = [];
  it.trace.points.forEach((p, i) => {
    if (i === 0) return out.push(p);
    const a = it.trace.points[i - 1];
    const n = Math.max(1, Math.ceil(Math.hypot(p.x - a.x, p.y - a.y) / 0.25));
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((p.x - a.x) * k) / n, y: a.y + ((p.y - a.y) * k) / n });
  });
  return out;
}

// Fills are pure functions of their inputs; keep recent ones so an edit only refills the pours
// it actually reaches.
const fillCache = new Map<string, ZoneFill>();
const FILL_CACHE_SIZE = 400;

export function computeZoneFill(design: Design, zone: Zone, items: FillItem[], netOf: (it: FillItem) => string | undefined): ZoneFill {
  const zr = netRules(design, zone.net);
  const thermal = (zone.padConnection ?? "thermal") === "thermal";
  const gapT = zone.thermalGap ?? 0.5;
  const spokeW = zone.spokeWidth ?? Math.max(0.3, zr.traceWidth);
  const edgeClear = 0.5;
  const outline = boardOutline(design.board);
  const holes = design.board.cutouts ?? [];

  if (zone.raw) {
    // Literal copper: the drawn shape, joined to every same-net item it touches.
    const shape = intersection(polygon(zone.points), polygon(outline));
    const polygons = splitIslands(shape);
    const near = items.filter((it) => onLayer(it, zone.layer) && netOf(it) === zone.net).map((it) => ({ it, pts: probes(it) }));
    return { zone, polygons, islands: polygons.map((isl) => near.filter((m) => touches(isl, m.it, m.pts)).map((m) => m.it.key)), removedIslands: 0 };
  }
  // Only copper that reaches the pour matters to it.
  const reach = (it: FillItem, margin: number) => {
    if (it.kind === "via") return segmentPolygonDistance(it.via, it.via, zone.points) <= it.via.diameter / 2 + margin;
    if (it.kind === "trace") return it.trace.points.some((p, i) => i > 0 && segmentPolygonDistance(it.trace.points[i - 1], p, zone.points) <= it.trace.width / 2 + margin);
    return polygonPolygonDistance(padCorners(it.pad, margin), zone.points) === 0;
  };
  const reachMargin = Math.max(gapT + spokeW, ...design.netClasses.map((c) => c.clearance), design.board.clearance, zr.clearance) + 0.05;
  const reached = items.filter((it) => onLayer(it, zone.layer) && reach(it, reachMargin)).map((it) => ({ it, net: netOf(it) }));
  const keepouts = design.keepouts.filter((k) => k.noPours && k.layers.includes(zone.layer));
  // Higher-priority pours of other nets win where they overlap, with clearance around them.
  const above = design.zones.filter((z2) => z2.id !== zone.id && z2.layer === zone.layer && z2.net !== zone.net && (z2.priority ?? 0) > (zone.priority ?? 0) && polygonPolygonDistance(z2.points, zone.points) <= 5);

  const sig = JSON.stringify([
    zone,
    outline,
    holes,
    zr,
    keepouts.map((k) => k.points),
    above.map((z2) => [z2.points, z2.net]),
    design.netClasses,
    design.diffPairs,
    design.board.clearance,
    reached.map(({ it, net }) => [net, it.kind === "pad" ? [it.key, it.pad.world, it.pad.ww, it.pad.wh, it.pad.angle, it.pad.shape] : it.kind === "via" ? [it.key, it.via] : [it.key, it.trace]]),
  ]);
  const hit = fillCache.get(sig);
  if (hit) {
    fillCache.delete(sig);
    fillCache.set(sig, hit);
    return { ...hit, zone };
  }
  const result = fillGeometry();
  fillCache.set(sig, result);
  if (fillCache.size > FILL_CACHE_SIZE) fillCache.delete(fillCache.keys().next().value!);
  return result;

  function fillGeometry(): ZoneFill {
    // The area copper may occupy: the zone, inside the board by the edge clearance.
    let allowed = intersection(polygon(zone.points), grow(polygon(outline), -edgeClear));
    const blocked: Area[] = holes.map((h) => grow(polygon(h), edgeClear));
    for (const k of keepouts) blocked.push(polygon(k.points));
    for (const z2 of above) blocked.push(grow(polygon(z2.points), Math.max(zr.clearance, netRules(design, z2.net).clearance)));
    const same: FillItem[] = [];
    const gaps: Area[] = [];
    const spokes: Area[] = [];
    for (const { it, net } of reached) {
      if (net === zone.net) {
        same.push(it);
        if (it.kind === "pad" && thermal) {
          gaps.push(padShape(it.pad, gapT));
          const c = it.pad.world;
          const hx = it.pad.ww / 2 + gapT + spokeW;
          const hy = it.pad.wh / 2 + gapT + spokeW;
          // Spokes follow the pad's own axes and end square, one spoke width into the pour.
          const at = (dx: number, dy: number) => {
            const q = rotate({ x: dx, y: dy }, it.pad.angle);
            return { x: c.x + q.x, y: c.y + q.y };
          };
          spokes.push(stroke([at(-hx, 0), at(hx, 0)], spokeW, "flat"), stroke([at(0, -hy), at(0, hy)], spokeW, "flat"));
        }
        continue;
      }
      blocked.push(itemShape(it, Math.max(zr.clearance, netRules(design, net).clearance)));
    }
    allowed = difference(allowed, union(...blocked));
    // Thermal gaps come out, then the spokes go back in wherever copper is allowed.
    let fill = difference(allowed, union(...gaps));
    if (spokes.length) fill = union(fill, intersection(union(...spokes), allowed));

    let hatch: ZoneFill["hatch"];
    if (zone.fill === "hatch") {
      const width = zone.hatchWidth ?? Math.max(0.25, zr.traceWidth);
      const gap = zone.hatchGap ?? 1;
      const xs = zone.points.map((p) => p.x);
      const ys = zone.points.map((p) => p.y);
      hatch = { width, gap, origin: { x: Math.min(...xs), y: Math.min(...ys) } };
      // Square holes on a (width + gap) grid, kept one width inside the outline; solid copper stays
      // around same-net pads and vias so they always join the mesh.
      const pitch = width + gap;
      const squares: Vec[][] = [];
      for (let y = hatch.origin.y + width; y + gap <= Math.max(...ys) + 1e-9; y += pitch)
        for (let x = hatch.origin.x + width; x + gap <= Math.max(...xs) + 1e-9; x += pitch)
          squares.push([
            { x, y },
            { x: x + gap, y },
            { x: x + gap, y: y + gap },
            { x, y: y + gap },
          ]);
      const holeArea = intersection(union(...squares.map(polygon)), grow(polygon(zone.points), -width));
      const halos = union(...same.filter((it) => it.kind !== "trace").map((it) => itemShape(it, (thermal && it.kind === "pad" ? gapT : 0) + width)));
      fill = difference(fill, difference(holeArea, halos));
    }

    // Islands, and the same-net copper each one touches.
    const removeIslands = zone.removeIslands ?? true;
    const polygons: Vec[][][] = [];
    const islandKeys: string[][] = [];
    let removedIslands = 0;
    const pts = same.map((it) => ({ it, pts: probes(it) }));
    for (const island of splitIslands(fill)) {
      const members = pts.filter((m) => touches(island, m.it, m.pts)).map((m) => m.it.key);
      if (members.length || !removeIslands) {
        polygons.push(island);
        islandKeys.push(members);
      } else removedIslands++;
    }
    return { zone, polygons, islands: islandKeys, removedIslands, hatch };
  }
}

// ---------- teardrops ----------

/**
 * Teardrop polygons where a trace leaves a pad or via of the same copper island.
 * `connected(traceKey, itemKey)` tells whether the trace and pad/via are electrically joined.
 */
export function teardrops(
  design: Design,
  items: FillItem[],
  connected: (a: string, b: string) => boolean,
): { layer: CopperLayer; points: Vec[] }[] {
  const out: { layer: CopperLayer; points: Vec[] }[] = [];
  const anchors = items.filter((it) => it.kind !== "trace") as Exclude<FillItem, { kind: "trace" }>[];
  for (const t of items) {
    if (t.kind !== "trace" || t.trace.points.length < 2) continue;
    const pts = t.trace.points;
    for (const end of [0, pts.length - 1]) {
      const p = pts[end];
      const q = pts[end === 0 ? 1 : pts.length - 2];
      for (const a of anchors) {
        const isPad = a.kind === "pad";
        if (!(isPad ? a.pad.layers : a.layers).includes(t.trace.layer)) continue;
        const c = isPad ? a.pad.world : a.via;
        const size = isPad ? Math.min(a.pad.ww, a.pad.wh) : a.via.diameter;
        if (Math.hypot(p.x - c.x, p.y - c.y) > size / 2 + 1e-6) continue;
        if (!connected(t.key, a.key)) continue;
        if (size <= t.trace.width * 1.2) continue;
        const dx = q.x - c.x;
        const dy = q.y - c.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) continue;
        const ux = dx / len;
        const uy = dy / len;
        const reach = Math.min(len, size / 2 + Math.max(0.5, size * 0.8));
        const half = size * 0.45;
        const tip = { x: c.x + ux * reach, y: c.y + uy * reach };
        const w = t.trace.width / 2;
        out.push({
          layer: t.trace.layer,
          points: [
            { x: c.x - uy * half, y: c.y + ux * half },
            { x: tip.x - uy * w, y: tip.y + ux * w },
            { x: tip.x + uy * w, y: tip.y - ux * w },
            { x: c.x + uy * half, y: c.y - ux * half },
          ],
        });
      }
    }
  }
  return out;
}

/** A pad's copper grown by `grow` as a cutout (exact for circles and angled pads). */
export function padCutout(pad: WorldPad, grow: number): Cutout {
  if (pad.shape === "circle") return { kind: "circle", c: pad.world, r: Math.min(pad.ww, pad.wh) / 2 + grow };
  if (pad.angle && pad.shape === "oval") return { kind: "line", points: ovalAxis(pad), width: Math.min(pad.ww, pad.wh) + 2 * grow };
  if (pad.angle) return { kind: "polygon", points: padCorners(pad, grow) };
  const r = padRect(pad);
  return { kind: "rect", rect: { x0: r.x0 - grow, y0: r.y0 - grow, x1: r.x1 + grow, y1: r.y1 + grow } };
}

/** Pours of a layer in the order fabrication images draw them: lowest priority first, so a
 * higher-priority pour is drawn over (not under) the ones it cuts into. */
export const zonesInDrawOrder = (design: Pick<Design, "zones">, layer: string): Zone[] => design.zones.filter((z) => z.layer === layer).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
