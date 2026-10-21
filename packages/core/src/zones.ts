// Copper pour filling: clearance cut-outs, thermal reliefs, keepouts, board-edge clearance
// and island removal. The fill outline stays vector-exact (polygon minus cut-outs); a raster
// pass only decides which islands survive and which same-net copper each island touches.
import { boardOutline, netRules } from "./doc";
import { ovalAxis, padCorners, padRect, pointInPolygon, pointSegmentDistance, rotate, type Rect, type WorldPad } from "./geometry";
import type { CopperLayer, Design, Trace, Vec, Via, Zone } from "./types";

export type Cutout =
  | { kind: "rect"; rect: Rect }
  | { kind: "circle"; c: Vec; r: number }
  | { kind: "line"; points: Vec[]; width: number }
  | { kind: "polygon"; points: Vec[] };

export interface ZoneFill {
  zone: Zone;
  /** Removed from the outline first (clearances, thermal gaps, keepouts, board edge, holes). */
  cutouts: Cutout[];
  /** Thermal spokes added back after the cut-outs. */
  spokes: { points: Vec[]; width: number }[];
  /** Cut-outs re-applied after spokes so spokes never reach foreign copper. */
  clip: Cutout[];
  /** Isolated islands removed from the fill (rectangles of the raster). */
  removed: Rect[];
  /** For each surviving island, the keys of same-net items it connects. */
  islands: string[][];
  /** Hatched fill: square holes of side `gap` on a (width + gap) pitch, axis-aligned from the zone's bbox origin. */
  hatch?: { width: number; gap: number; origin: Vec };
  /** Solid copper kept around same-net pads/vias in hatched fills so they always join the mesh. */
  halos: Cutout[];
}

/** Minimal copper item view needed by the filler. */
export type FillItem =
  | { kind: "pad"; key: string; pad: WorldPad }
  | { kind: "trace"; key: string; trace: Trace }
  | { kind: "via"; key: string; via: Via; layers: CopperLayer[] };

const onLayer = (it: FillItem, l: CopperLayer) => (it.kind === "pad" ? it.pad.layers.includes(l) : it.kind === "trace" ? it.trace.layer === l : it.layers.includes(l));

export function computeZoneFill(design: Design, zone: Zone, items: FillItem[], netOf: (it: FillItem) => string | undefined): ZoneFill {
  const zr = netRules(design, zone.net);
  const thermal = (zone.padConnection ?? "thermal") === "thermal";
  const gapT = zone.thermalGap ?? 0.5;
  const spokeW = zone.spokeWidth ?? Math.max(0.3, zr.traceWidth);
  const edgeClear = 0.5;
  const outline = boardOutline(design.board);
  const holes = design.board.cutouts ?? [];

  const cutouts: Cutout[] = [];
  const foreign: Cutout[] = [];
  const spokes: { points: Vec[]; width: number }[] = [];
  const same: FillItem[] = [];

  // Board edge and internal cutouts keep the pour away from the routed edge.
  cutouts.push({ kind: "line", points: [...outline, outline[0]], width: edgeClear * 2 });
  for (const h of holes) {
    cutouts.push({ kind: "polygon", points: h });
    cutouts.push({ kind: "line", points: [...h, h[0]], width: edgeClear * 2 });
  }
  for (const k of design.keepouts) if (k.noPours && k.layers.includes(zone.layer)) cutouts.push({ kind: "polygon", points: k.points });
  // Higher-priority pours of other nets win where they overlap, with clearance around them.
  for (const z2 of design.zones) {
    if (z2.id === zone.id || z2.layer !== zone.layer || z2.net === zone.net || (z2.priority ?? 0) <= (zone.priority ?? 0)) continue;
    const cl = Math.max(zr.clearance, netRules(design, z2.net).clearance);
    cutouts.push({ kind: "polygon", points: z2.points });
    cutouts.push({ kind: "line", points: [...z2.points, z2.points[0]], width: cl * 2 });
  }

  for (const it of items) {
    if (!onLayer(it, zone.layer)) continue;
    const net = netOf(it);
    if (net === zone.net) {
      same.push(it);
      if (it.kind === "pad" && thermal) {
        cutouts.push(padCutout(it.pad, gapT));
        const c = it.pad.world;
        const hx = it.pad.ww / 2 + gapT + spokeW;
        const hy = it.pad.wh / 2 + gapT + spokeW;
        // Spokes follow the pad's own axes.
        const at = (dx: number, dy: number) => {
          const q = rotate({ x: dx, y: dy }, it.pad.angle);
          return { x: c.x + q.x, y: c.y + q.y };
        };
        spokes.push({ points: [at(-hx, 0), at(hx, 0)], width: spokeW });
        spokes.push({ points: [at(0, -hy), at(0, hy)], width: spokeW });
      }
      continue;
    }
    const cl = Math.max(zr.clearance, netRules(design, net).clearance);
    let c: Cutout;
    if (it.kind === "pad") {
      c = padCutout(it.pad, cl);
    } else if (it.kind === "via") c = { kind: "circle", c: it.via, r: it.via.diameter / 2 + cl };
    else c = { kind: "line", points: it.trace.points, width: it.trace.width + 2 * cl };
    cutouts.push(c);
    foreign.push(c);
  }

  // ---------- raster pass for islands ----------
  const xs = zone.points.map((p) => p.x);
  const ys = zone.points.map((p) => p.y);
  const bx0 = Math.max(Math.min(...xs), 0);
  const by0 = Math.max(Math.min(...ys), 0);
  const bx1 = Math.min(Math.max(...xs), design.board.width);
  const by1 = Math.min(Math.max(...ys), design.board.height);
  const area = Math.max(0, bx1 - bx0) * Math.max(0, by1 - by0);
  const res = Math.max(0.1, Math.sqrt(area / 250_000));
  const nx = Math.max(1, Math.ceil((bx1 - bx0) / res) + 1);
  const ny = Math.max(1, Math.ceil((by1 - by0) / res) + 1);
  const grid = new Uint8Array(nx * ny); // 0 empty, 1 fill, 2 same-net copper
  const owner = new Int32Array(nx * ny).fill(-1);
  const cx = (i: number) => bx0 + i * res;
  const cy = (j: number) => by0 + j * res;
  const inPour = (p: Vec) => pointInPolygon(p, zone.points) && pointInPolygon(p, outline) && !holes.some((h) => pointInPolygon(p, h));

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const p = { x: cx(i), y: cy(j) };
      if (inPour(p)) grid[j * nx + i] = 1;
    }
  }
  const paint = (bbox: Rect, inside: (p: Vec) => boolean, value: number, ownerIdx = -1) => {
    const i0 = Math.max(0, Math.floor((bbox.x0 - bx0) / res));
    const j0 = Math.max(0, Math.floor((bbox.y0 - by0) / res));
    const i1 = Math.min(nx - 1, Math.ceil((bbox.x1 - bx0) / res));
    const j1 = Math.min(ny - 1, Math.ceil((bbox.y1 - by0) / res));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * nx + i;
        const p = { x: cx(i), y: cy(j) };
        if (!inside(p)) continue;
        // Added copper (spokes, same-net items) only counts inside the pour and the board.
        if (value > 0 && !inPour(p)) continue;
        grid[k] = value;
        if (ownerIdx >= 0) owner[k] = ownerIdx;
        else if (value === 0) owner[k] = -1;
      }
    }
  };
  const paintCutout = (c: Cutout, value: number, ownerIdx = -1) => {
    if (c.kind === "rect") paint(c.rect, (p) => p.x >= c.rect.x0 && p.x <= c.rect.x1 && p.y >= c.rect.y0 && p.y <= c.rect.y1, value, ownerIdx);
    else if (c.kind === "circle") paint({ x0: c.c.x - c.r, y0: c.c.y - c.r, x1: c.c.x + c.r, y1: c.c.y + c.r }, (p) => Math.hypot(p.x - c.c.x, p.y - c.c.y) <= c.r, value, ownerIdx);
    else if (c.kind === "polygon") {
      const px = c.points.map((p) => p.x);
      const py = c.points.map((p) => p.y);
      paint({ x0: Math.min(...px), y0: Math.min(...py), x1: Math.max(...px), y1: Math.max(...py) }, (p) => pointInPolygon(p, c.points), value, ownerIdx);
    } else {
      for (let k = 1; k < c.points.length; k++) {
        const a = c.points[k - 1];
        const b = c.points[k];
        const h = c.width / 2;
        paint({ x0: Math.min(a.x, b.x) - h, y0: Math.min(a.y, b.y) - h, x1: Math.max(a.x, b.x) + h, y1: Math.max(a.y, b.y) + h }, (p) => pointSegmentDistance(p, a, b) <= h, value, ownerIdx);
      }
    }
  };
  for (const c of cutouts) paintCutout(c, 0);
  // Spokes extend fill into the thermal gap; same-net copper is painted as part of the fill.
  for (const s of spokes) paintCutout({ kind: "line", points: s.points, width: s.width }, 1);
  same.forEach((it, idx) => {
    const c: Cutout =
      it.kind === "pad"
        ? padCutout(it.pad, 0)
        : it.kind === "via"
          ? { kind: "circle", c: it.via, r: it.via.diameter / 2 }
          : { kind: "line", points: it.trace.points, width: it.trace.width };
    paintCutout(c, 2, idx);
  });
  for (const c of foreign) paintCutout(c, 0);

  // Flood fill islands (4-connected).
  const label = new Int32Array(nx * ny).fill(-1);
  const islandsCells: number[][] = [];
  const stack: number[] = [];
  for (let k = 0; k < grid.length; k++) {
    if (!grid[k] || label[k] >= 0) continue;
    const id = islandsCells.length;
    const cells: number[] = [];
    label[k] = id;
    stack.push(k);
    while (stack.length) {
      const c = stack.pop()!;
      cells.push(c);
      const i = c % nx;
      const nb = [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, c - nx, c + nx];
      for (const n of nb) {
        if (n < 0 || n >= grid.length || !grid[n] || label[n] >= 0) continue;
        label[n] = id;
        stack.push(n);
      }
    }
    islandsCells.push(cells);
  }
  const removeIslands = zone.removeIslands ?? true;
  const islands: string[][] = [];
  const removedCells: number[] = [];
  for (const cells of islandsCells) {
    const members = new Set<string>();
    for (const c of cells) if (owner[c] >= 0) members.add(same[owner[c]].key);
    if (members.size || !removeIslands) islands.push([...members]);
    else for (const c of cells) removedCells.push(c);
  }
  let hatch: ZoneFill["hatch"];
  const halos: Cutout[] = [];
  if (zone.fill === "hatch") {
    const width = zone.hatchWidth ?? Math.max(0.25, zr.traceWidth);
    const gap = zone.hatchGap ?? 1;
    hatch = { width, gap, origin: { x: Math.min(...zone.points.map((p) => p.x)), y: Math.min(...zone.points.map((p) => p.y)) } };
    // A ring of solid copper (one hatch width beyond the thermal gap) around every same-net pad and via.
    for (const it of same) {
      if (it.kind === "pad") {
        halos.push(padCutout(it.pad, (thermal ? gapT : 0) + width));
      } else if (it.kind === "via") halos.push({ kind: "circle", c: it.via, r: it.via.diameter / 2 + width });
    }
  }
  return { zone, cutouts, spokes, clip: foreign, removed: cellsToRects(removedCells, nx, res, bx0, by0), islands, hatch, halos };
}

/** Merge raster cells into rectangles (row runs, then stacked identical runs). */
function cellsToRects(cells: number[], nx: number, res: number, x0: number, y0: number): Rect[] {
  if (!cells.length) return [];
  const rows = new Map<number, number[]>();
  for (const c of cells) {
    const j = Math.floor(c / nx);
    if (!rows.has(j)) rows.set(j, []);
    rows.get(j)!.push(c % nx);
  }
  type Run = { i0: number; i1: number; j0: number; j1: number };
  const open = new Map<string, Run>();
  const out: Run[] = [];
  for (const j of [...rows.keys()].sort((a, b) => a - b)) {
    const is = rows.get(j)!.sort((a, b) => a - b);
    const runs: [number, number][] = [];
    let s = is[0];
    let p = is[0];
    for (const i of is.slice(1)) {
      if (i === p + 1) p = i;
      else {
        runs.push([s, p]);
        s = p = i;
      }
    }
    runs.push([s, p]);
    const seen = new Set<string>();
    for (const [a, b] of runs) {
      const key = `${a}:${b}`;
      seen.add(key);
      const r = open.get(key);
      if (r && r.j1 === j - 1) r.j1 = j;
      else {
        if (r) out.push(r);
        open.set(key, { i0: a, i1: b, j0: j, j1: j });
      }
    }
    for (const [key, r] of open) if (!seen.has(key) && r.j1 < j) (out.push(r), open.delete(key));
  }
  out.push(...open.values());
  const h = res / 2;
  return out.map((r) => ({ x0: x0 + r.i0 * res - h, y0: y0 + r.j0 * res - h, x1: x0 + r.i1 * res + h, y1: y0 + r.j1 * res + h }));
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

/**
 * Square holes of a hatched fill, kept only where the whole hole lies inside the zone outline
 * at least one hatch width from its edge (so the fill keeps a solid border).
 */
export function hatchHoles(fill: ZoneFill): Rect[] {
  if (!fill.hatch) return [];
  const { width, gap, origin } = fill.hatch;
  const pitch = width + gap;
  const poly = fill.zone.points;
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  const x1 = Math.max(...xs);
  const y1 = Math.max(...ys);
  const edges = poly.map((p, i) => [p, poly[(i + 1) % poly.length]] as [Vec, Vec]);
  const out: Rect[] = [];
  for (let y = origin.y + width; y + gap <= y1 - width + 1e-9; y += pitch) {
    for (let x = origin.x + width; x + gap <= x1 - width + 1e-9; x += pitch) {
      const r = { x0: x, y0: y, x1: x + gap, y1: y + gap };
      const corners = [
        { x: r.x0, y: r.y0 },
        { x: r.x1, y: r.y0 },
        { x: r.x1, y: r.y1 },
        { x: r.x0, y: r.y1 },
      ];
      if (!corners.every((c) => pointInPolygon(c, poly))) continue;
      const c = { x: x + gap / 2, y: y + gap / 2 };
      if (edges.some(([a, b]) => pointSegmentDistance(c, a, b) < gap / 2 + width - 1e-9)) continue;
      out.push(r);
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
