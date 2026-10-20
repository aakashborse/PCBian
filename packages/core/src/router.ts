// Auto-placement and a two-layer grid-based A* auto-router.
import { analyzeCopper, ratsnest } from "./copper";
import { courtyardRect, padRect, pointSegmentDistance, segmentRectDistance, type WorldPad } from "./geometry";
import { getPart } from "./library";
import type { CopperLayer, Design, PcbPlacement, Trace, Vec } from "./types";

// ---------- auto-placement ----------

/** Shelf-pack all footprints onto the board, keeping roughly the schematic's left-to-right order. */
export function autoPlace(design: Design, margin = 2, spacing = 2): { placements: Map<string, PcbPlacement>; fits: boolean } {
  const parts = design.components
    .filter((c) => getPart(c.partId)?.footprint)
    .sort((a, b) => a.sch.y - b.sch.y || a.sch.x - b.sch.x);
  // Bigger parts first in each row looks tidier; group into rows of decreasing height.
  const sized = parts.map((c) => {
    const r = courtyardRect({ ...c, pcb: { ...c.pcb, x: 0, y: 0 } })!;
    return { c, w: r.x1 - r.x0, h: r.y1 - r.y0 };
  });
  sized.sort((a, b) => b.h - a.h);
  const placements = new Map<string, PcbPlacement>();
  let x = margin;
  let y = margin;
  let rowH = 0;
  let fits = true;
  for (const s of sized) {
    if (x + s.w > design.board.width - margin && x > margin) {
      x = margin;
      y += rowH + spacing;
      rowH = 0;
    }
    if (y + s.h > design.board.height - margin) fits = false;
    placements.set(s.c.id, { x: x + s.w / 2, y: y + s.h / 2, rot: s.c.pcb.rot, side: s.c.pcb.side });
    x += s.w + spacing;
    rowH = Math.max(rowH, s.h);
  }
  // Centre the packed group on the board.
  if (fits && placements.size) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of sized) {
      const p = placements.get(s.c.id)!;
      x0 = Math.min(x0, p.x - s.w / 2);
      y0 = Math.min(y0, p.y - s.h / 2);
      x1 = Math.max(x1, p.x + s.w / 2);
      y1 = Math.max(y1, p.y + s.h / 2);
    }
    const dx = Math.round(((design.board.width - (x1 - x0)) / 2 - x0) * 20) / 20;
    const dy = Math.round(((design.board.height - (y1 - y0)) / 2 - y0) * 20) / 20;
    for (const p of placements.values()) {
      p.x += dx;
      p.y += dy;
    }
  }
  for (const p of placements.values()) {
    p.x = Math.round(p.x * 20) / 20;
    p.y = Math.round(p.y * 20) / 20;
  }
  return { placements, fits };
}

// ---------- auto-routing ----------

export interface RouteOptions {
  width?: number;
  clearance?: number;
  grid?: number;
  allowVias?: boolean;
  viaDiameter?: number;
  viaDrill?: number;
}

export interface RouteResult {
  traces: Omit<Trace, "id">[];
  vias: Vec[];
  routed: number;
  failed: { net: string; a: Vec; b: Vec }[];
}

const FREE = -1;
const BLOCKED = -2;
const LAYERS: CopperLayer[] = ["top", "bottom"];

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size() {
    return this.ids.length;
  }
  push(id: number, key: number) {
    const ids = this.ids;
    const keys = this.keys;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= keys[i]) break;
      [ids[p], ids[i]] = [ids[i], ids[p]];
      [keys[p], keys[i]] = [keys[i], keys[p]];
      i = p;
    }
  }
  pop(): number {
    const ids = this.ids;
    const keys = this.keys;
    const top = ids[0];
    const lastId = ids.pop()!;
    const lastKey = keys.pop()!;
    if (ids.length) {
      ids[0] = lastId;
      keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < ids.length && keys[l] < keys[m]) m = l;
        if (r < ids.length && keys[r] < keys[m]) m = r;
        if (m === i) break;
        [ids[m], ids[i]] = [ids[i], ids[m]];
        [keys[m], keys[i]] = [keys[i], keys[m]];
        i = m;
      }
    }
    return top;
  }
}

export function autoRoute(design: Design, opts: RouteOptions = {}): RouteResult {
  const width = opts.width ?? design.board.defaultTraceWidth;
  const clearance = opts.clearance ?? design.board.clearance;
  const res = opts.grid ?? 0.25;
  const viaD = opts.viaDiameter ?? 0.6;
  const allowVias = opts.allowVias ?? true;
  const W = Math.floor(design.board.width / res) + 1;
  const H = Math.floor(design.board.height / res) + 1;
  const N = W * H;
  const owner = [new Int32Array(N).fill(FREE), new Int32Array(N).fill(FREE)];

  const analysis = analyzeCopper(design);
  const netIndex = new Map<string, number>();
  const idx = (net: string) => {
    if (!netIndex.has(net)) netIndex.set(net, netIndex.size);
    return netIndex.get(net)!;
  };
  let anon = 1_000_000;
  const inflate = clearance + width / 2;

  const stamp = (layer: number, net: number, bbox: { x0: number; y0: number; x1: number; y1: number }, d: (p: Vec) => number, pad = inflate) => {
    const gx0 = Math.max(0, Math.floor((bbox.x0 - pad) / res));
    const gy0 = Math.max(0, Math.floor((bbox.y0 - pad) / res));
    const gx1 = Math.min(W - 1, Math.ceil((bbox.x1 + pad) / res));
    const gy1 = Math.min(H - 1, Math.ceil((bbox.y1 + pad) / res));
    const o = owner[layer];
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        if (d({ x: gx * res, y: gy * res }) > pad) continue;
        const i = gy * W + gx;
        if (o[i] === FREE) o[i] = net;
        else if (o[i] !== net) o[i] = BLOCKED;
      }
    }
  };
  const stampTrace = (layer: number, net: number, pts: Vec[], w: number) => {
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1];
      const b = pts[k];
      const bbox = { x0: Math.min(a.x, b.x) - w / 2, y0: Math.min(a.y, b.y) - w / 2, x1: Math.max(a.x, b.x) + w / 2, y1: Math.max(a.y, b.y) + w / 2 };
      stamp(layer, net, bbox, (p) => pointSegmentDistance(p, a, b) - w / 2);
    }
  };
  const stampVia = (net: number, v: Vec, d: number) => {
    for (const l of [0, 1]) stamp(l, net, { x0: v.x - d / 2, y0: v.y - d / 2, x1: v.x + d / 2, y1: v.y + d / 2 }, (p) => Math.hypot(p.x - v.x, p.y - v.y) - d / 2);
  };

  // Existing copper.
  const padAt = new Map<string, WorldPad>();
  for (const it of analysis.items) {
    const nets = analysis.clusterNets.get(analysis.clusterOf.get(it.key)!)!;
    const net = it.kind === "pad" && it.net ? idx(it.net) : nets.size === 1 ? idx([...nets][0]) : anon++;
    if (it.kind === "pad") {
      const r = padRect(it.pad);
      padAt.set(`${it.pad.world.x.toFixed(4)},${it.pad.world.y.toFixed(4)}`, it.pad);
      for (const l of it.pad.layers) stamp(LAYERS.indexOf(l), net, r, (p) => segmentRectDistance(p, p, r));
    } else if (it.kind === "trace") {
      stampTrace(LAYERS.indexOf(it.trace.layer), net, it.trace.points, it.trace.width);
    } else {
      stampVia(net, it.via, it.via.diameter);
    }
  }
  // Board edge keepout.
  const edge = Math.ceil((width / 2 + 0.3) / res);
  for (const o of owner) {
    for (let gy = 0; gy < H; gy++) {
      for (let gx = 0; gx < W; gx++) if (gx < edge || gy < edge || gx >= W - edge || gy >= H - edge) o[gy * W + gx] = BLOCKED;
    }
  }

  const result: RouteResult = { traces: [], vias: [], routed: 0, failed: [] };
  const lines = ratsnest(design, analysis).sort((a, b) => Math.hypot(a.a.x - a.b.x, a.a.y - a.b.y) - Math.hypot(b.a.x - b.b.x, b.a.y - b.b.y));
  const viaR = Math.ceil((viaD / 2 + clearance) / res);
  const g = new Float32Array(2 * N);
  const came = new Int32Array(2 * N);
  const closed = new Uint8Array(2 * N);
  const DIRS = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
  ];

  for (const line of lines) {
    const net = idx(line.net);
    const pa = padAt.get(`${line.a.x.toFixed(4)},${line.a.y.toFixed(4)}`);
    const pb = padAt.get(`${line.b.x.toFixed(4)},${line.b.y.toFixed(4)}`);
    const layersA = pa ? pa.layers.map((l) => LAYERS.indexOf(l)) : [0, 1];
    const layersB = new Set(pb ? pb.layers.map((l) => LAYERS.indexOf(l)) : [0, 1]);
    const ax = Math.round(line.a.x / res);
    const ay = Math.round(line.a.y / res);
    const bx = Math.round(line.b.x / res);
    const by = Math.round(line.b.y / res);
    const free = (l: number, i: number) => {
      const o = owner[l][i];
      return o === FREE || o === net;
    };
    const viaOk = (gx: number, gy: number) => {
      for (let dy = -viaR; dy <= viaR; dy++) {
        for (let dx = -viaR; dx <= viaR; dx++) {
          if (dx * dx + dy * dy > viaR * viaR) continue;
          const x = gx + dx;
          const y = gy + dy;
          if (x < 0 || y < 0 || x >= W || y >= H) return false;
          if (!free(0, y * W + x) || !free(1, y * W + x)) return false;
        }
      }
      return true;
    };
    const h = (gx: number, gy: number) => {
      const dx = Math.abs(gx - bx);
      const dy = Math.abs(gy - by);
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };

    g.fill(Infinity);
    came.fill(-1);
    closed.fill(0);
    const heap = new MinHeap();
    for (const l of layersA) {
      const id = l * N + ay * W + ax;
      g[id] = 0;
      heap.push(id, h(ax, ay));
    }
    let goal = -1;
    let budget = 400_000;
    while (heap.size && budget-- > 0) {
      const id = heap.pop();
      if (closed[id]) continue;
      closed[id] = 1;
      const l = id >= N ? 1 : 0;
      const cell = id - l * N;
      const gx = cell % W;
      const gy = (cell - gx) / W;
      if (gx === bx && gy === by && layersB.has(l)) {
        goal = id;
        break;
      }
      for (const [dx, dy, cost] of DIRS) {
        const nx = gx + dx;
        const ny = gy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (!free(l, ni)) continue;
        if (dx && dy && (!free(l, gy * W + nx) || !free(l, ny * W + gx))) continue;
        const nid = l * N + ni;
        // Small penalty for changing direction keeps traces straight.
        const prev = came[id];
        let turn = 0;
        if (prev >= 0 && prev % N !== cell) {
          const pc = prev % N;
          const pdx = gx - (pc % W);
          const pdy = gy - Math.floor(pc / W);
          if (pdx !== dx || pdy !== dy) turn = 0.4;
        }
        const ng = g[id] + cost + turn;
        if (ng < g[nid]) {
          g[nid] = ng;
          came[nid] = id;
          heap.push(nid, ng + h(nx, ny));
        }
      }
      if (allowVias) {
        const nid = (1 - l) * N + cell;
        const ng = g[id] + 12;
        if (ng < g[nid] && viaOk(gx, gy)) {
          g[nid] = ng;
          came[nid] = id;
          heap.push(nid, ng + h(gx, gy));
        }
      }
    }
    if (goal < 0) {
      result.failed.push(line);
      continue;
    }

    // Reconstruct path and split into per-layer runs.
    const path: { l: number; p: Vec }[] = [];
    for (let id = goal; id >= 0; id = came[id]) {
      const l = id >= N ? 1 : 0;
      const cell = id - l * N;
      path.push({ l, p: { x: (cell % W) * res, y: Math.floor(cell / W) * res } });
    }
    path.reverse();
    path[0].p = { ...line.a };
    path[path.length - 1].p = { ...line.b };
    let run: Vec[] = [];
    let runLayer = path[0].l;
    const flush = () => {
      const pts = simplify(run);
      if (pts.length >= 2) {
        result.traces.push({ layer: LAYERS[runLayer], width, points: pts });
        stampTrace(runLayer, net, pts, width);
      }
    };
    for (const step of path) {
      if (step.l !== runLayer) {
        flush();
        const v = run[run.length - 1];
        result.vias.push(v);
        stampVia(net, v, viaD);
        run = [v];
        runLayer = step.l;
      }
      run.push(step.p);
    }
    flush();
    result.routed++;
  }
  return result;
}

function simplify(pts: Vec[]): Vec[] {
  const out: Vec[] = [];
  for (const p of pts) {
    if (out.length && Math.abs(out[out.length - 1].x - p.x) < 1e-9 && Math.abs(out[out.length - 1].y - p.y) < 1e-9) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      const cross = (b.x - a.x) * (p.y - b.y) - (b.y - a.y) * (p.x - b.x);
      if (Math.abs(cross) < 1e-9) {
        out[out.length - 1] = p;
        continue;
      }
    }
    out.push(p);
  }
  return out.map((p) => ({ x: Math.round(p.x * 1e4) / 1e4, y: Math.round(p.y * 1e4) / 1e4 }));
}

