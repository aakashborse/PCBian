// Auto-placement and a multi-layer, net-class-aware grid A* auto-router.
import { analyzeCopper, copperGap, ratsnest, sharedLayers, type CopperItem } from "./copper";
import { courtyardRect, dist, padDistance, padRect, pointInPolygon, pointSegmentDistance, polygonSpans, type Rect, type WorldPad } from "./geometry";
import { allPins, getPart } from "./library";
import { boardOutline, netRules } from "./doc";
import { copperLayers } from "./stackup";
import { computeNets } from "./netlist";
import type { ComponentData, CopperLayer, Design, PcbPlacement, Trace, Vec } from "./types";

// ---------- auto-placement ----------

export interface PlaceOptions {
  /** "cluster" (default) places parts by connectivity; "pack" shelf-packs them. */
  mode?: "cluster" | "pack";
  margin?: number;
  spacing?: number;
}

/** Auto-place footprints onto the board. */
export function autoPlace(design: Design, opts: PlaceOptions = {}): { placements: Map<string, PcbPlacement>; fits: boolean } {
  return (opts.mode ?? "cluster") === "pack" ? packPlace(design, opts.margin ?? 2, opts.spacing ?? 2) : clusterPlace(design, opts.margin ?? 1.5, opts.spacing ?? 1.2);
}

const isPowerNet = (name: string) => /^(A|D|P)?GND|^VSS$|^[+-]|^V(CC|DD|BUS|IN|BAT|SYS)\b|^\d+V\d*$/i.test(name.trim());

/**
 * Connectivity-driven placement: connectors on board edges, decoupling capacitors next to
 * the IC they serve, and every other part where it minimises weighted wire length to the
 * parts already placed.
 */
function clusterPlace(design: Design, margin: number, spacing: number): { placements: Map<string, PcbPlacement>; fits: boolean } {
  const W = design.board.width;
  const H = design.board.height;
  const outline = boardOutline(design.board);
  const holes = design.board.cutouts ?? [];
  const inside = (p: Vec) => pointInPolygon(p, outline) && !holes.some((h) => pointInPolygon(p, h));
  const parts = design.components.filter((c) => getPart(c.partId)?.footprint);
  const size = new Map(parts.map((c) => {
    const r = courtyardRect({ ...c, pcb: { ...c.pcb, x: 0, y: 0 } })!;
    return [c.id, { w: r.x1 - r.x0, h: r.y1 - r.y0 }];
  }));
  const pinCount = (id: string) => allPins(getPart(parts.find((c) => c.id === id)!.partId)!).length;

  // Pairwise attraction weights.
  const weight = new Map<string, Map<string, number>>();
  const addW = (a: string, b: string, w: number) => {
    if (a === b || w <= 0) return;
    for (const [x, y] of [[a, b], [b, a]]) {
      if (!weight.has(x)) weight.set(x, new Map());
      weight.get(x)!.set(y, (weight.get(x)!.get(y) ?? 0) + w);
    }
  };
  const ids = new Set(parts.map((c) => c.id));
  const nets = computeNets(design);
  const netsOf = new Map<string, Set<string>>();
  for (const n of nets) {
    const comps = [...new Set(n.terminals.map((t) => t.comp).filter((c) => ids.has(c)))];
    for (const c of comps) {
      if (!netsOf.has(c)) netsOf.set(c, new Set());
      netsOf.get(c)!.add(n.name);
    }
    if (comps.length < 2 || comps.length > 12 || isPowerNet(n.name)) continue;
    const w = 1 / (comps.length - 1);
    for (let i = 0; i < comps.length; i++) for (let j = i + 1; j < comps.length; j++) addW(comps[i], comps[j], w);
  }
  // Decoupling: a 2-pin part between two power nets hugs the IC with most pins on its supply net.
  for (const c of parts) {
    const ns = [...(netsOf.get(c.id) ?? [])];
    if (pinCount(c.id) !== 2 || ns.length !== 2 || !ns.every(isPowerNet)) continue;
    const supply = ns.find((n) => !/GND|VSS/i.test(n)) ?? ns[0];
    const net = nets.find((n) => n.name === supply)!;
    const counts = new Map<string, number>();
    for (const t of net.terminals) if (ids.has(t.comp) && t.comp !== c.id && pinCount(t.comp) >= 4) counts.set(t.comp, (counts.get(t.comp) ?? 0) + 1);
    const ic = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (ic) addW(c.id, ic, 4);
  }

  const placements = new Map<string, PcbPlacement>();
  const rects: Rect[] = [];
  const fitsAt = (id: string, x: number, y: number) => {
    const { w, h } = size.get(id)!;
    const r = { x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 };
    const m = { x0: r.x0 - margin, y0: r.y0 - margin, x1: r.x1 + margin, y1: r.y1 + margin };
    if (![{ x: m.x0, y: m.y0 }, { x: m.x1, y: m.y0 }, { x: m.x1, y: m.y1 }, { x: m.x0, y: m.y1 }].every(inside)) return null;
    for (const o of rects) if (r.x0 < o.x1 + spacing && o.x0 < r.x1 + spacing && r.y0 < o.y1 + spacing && o.y0 < r.y1 + spacing) return null;
    return r;
  };
  const place = (c: ComponentData, x: number, y: number) => {
    const r = fitsAt(c.id, x, y)!;
    rects.push(r);
    placements.set(c.id, { x: Math.round(x * 20) / 20, y: Math.round(y * 20) / 20, rot: c.pcb.rot, side: c.pcb.side });
  };
  const step = Math.max(0.5, Math.min(W, H) / 80);

  // Connectors on the edges: left, right, top, bottom in turn.
  const connectors = parts.filter((c) => /^(J|P|CN|USB|X)\d/i.test(c.ref)).sort((a, b) => a.sch.x - b.sch.x);
  connectors.forEach((c, i) => {
    const { w, h } = size.get(c.id)!;
    const edge = i % 4;
    const along: Vec[] = [];
    for (let t = 0.5; t > 0.05; t -= 0.05) for (const u of t === 0.5 ? [0.5] : [t, 1 - t]) along.push({ x: u, y: u });
    for (const u of along) {
      const x = edge === 0 ? margin + w / 2 : edge === 1 ? W - margin - w / 2 : u.x * W;
      const y = edge === 2 ? margin + h / 2 : edge === 3 ? H - margin - h / 2 : u.y * H;
      if (fitsAt(c.id, x, y)) {
        place(c, x, y);
        break;
      }
    }
  });

  const total = (id: string) => [...(weight.get(id)?.values() ?? [])].reduce((a, b) => a + b, 0);
  const rest = parts.filter((c) => !placements.has(c.id)).sort((a, b) => total(b.id) - total(a.id) || size.get(b.id)!.w * size.get(b.id)!.h - size.get(a.id)!.w * size.get(a.id)!.h);
  let fits = true;
  while (rest.length) {
    // Next: the part most strongly connected to what is already placed.
    let bi = 0;
    let bw = -1;
    rest.forEach((c, i) => {
      let w = 0;
      for (const [o, ww] of weight.get(c.id) ?? []) if (placements.has(o)) w += ww;
      if (w > bw) (bw = w), (bi = i);
    });
    const c = rest.splice(bi, 1)[0];
    const links = [...(weight.get(c.id) ?? [])].filter(([o]) => placements.has(o)).map(([o, w]) => ({ p: placements.get(o)!, w }));
    const placedPts = [...placements.values()];
    const centroid = placedPts.length ? { x: placedPts.reduce((a, p) => a + p.x, 0) / placedPts.length, y: placedPts.reduce((a, p) => a + p.y, 0) / placedPts.length } : { x: W / 2, y: H / 2 };
    let best: { x: number; y: number; cost: number } | null = null;
    for (let y = margin; y <= H - margin; y += step) {
      for (let x = margin; x <= W - margin; x += step) {
        if (!fitsAt(c.id, x, y)) continue;
        let cost = links.length ? links.reduce((a, l) => a + l.w * (Math.abs(l.p.x - x) + Math.abs(l.p.y - y)), 0) : 0;
        cost += 0.05 * (Math.abs(centroid.x - x) + Math.abs(centroid.y - y));
        if (!best || cost < best.cost) best = { x, y, cost };
      }
    }
    if (best) place(c, best.x, best.y);
    else {
      fits = false;
      placements.set(c.id, { ...c.pcb });
    }
  }
  return { placements, fits };
}

/** Shelf-pack all footprints onto the board, keeping roughly the schematic's left-to-right order. */
function packPlace(design: Design, margin: number, spacing: number): { placements: Map<string, PcbPlacement>; fits: boolean } {
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
  /** Only route these nets (default: all). */
  nets?: string[];
  /** Allow blind/buried vias that span only the layers they join (HDI boards). Default: through vias only. */
  blindVias?: boolean;
  /** Route differential pairs as coupled traces first (default true). */
  coupled?: boolean;
  /** Internal: connections to route instead of the ratsnest. */
  lines?: RouteLine[];
  /** Internal: treat these nets as the mapped net (a pair's two nets are one obstacle-free region). */
  mergeNets?: Record<string, string>;
  /** Internal: trace width for every connection (no net-class widths, no neck-down). */
  forceWidth?: number;
}

export interface RouteLine {
  net: string;
  a: Vec;
  b: Vec;
  /** Layers the connection may start/end on (default: the pad's layers). */
  layers?: CopperLayer[];
}

export interface RouteResult {
  traces: Omit<Trace, "id">[];
  vias: (Vec & { diameter: number; drill: number; from?: CopperLayer; to?: CopperLayer })[];
  routed: number;
  failed: { net: string; a: Vec; b: Vec }[];
  /** Differential pairs routed as coupled traces. */
  coupled?: string[];
}


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

function routeCore(design: Design, opts: RouteOptions = {}): RouteResult {
  const baseWidth = opts.width ?? design.board.defaultTraceWidth;
  const allowVias = opts.allowVias ?? true;
  const blind = opts.blindVias ?? false;
  const layers = copperLayers(design.board);
  const L = layers.length;
  const res = opts.grid ?? gridFor(design);
  const W = Math.floor(design.board.width / res) + 1;
  const H = Math.floor(design.board.height / res) + 1;
  const N = W * H;
  const boardClear = design.board.clearance;
  const analysis = analyzeCopper(design);

  // Influence radius of the clearance field: the largest clearance + half-width/via radius we will ever test.
  const classes = [netRules(design, undefined), ...design.netClasses.map((c) => netRules(design, c.nets[0]))];
  const maxClear = Math.max(boardClear, ...classes.map((c) => c.clearance));
  const pairWidths = design.diffPairs.map((p) => p.width);
  const maxHalf = Math.max(baseWidth, ...classes.map((c) => c.traceWidth), ...pairWidths, ...classes.map((c) => c.viaDiameter), opts.viaDiameter ?? 0, opts.forceWidth ?? 0) / 2;
  const fieldR = maxClear * 2 + maxHalf + 2 * res;

  // Per layer: distance to nearest copper (d1, its net n1) and to the nearest copper of a different net (d2).
  const d1 = layers.map(() => new Float32Array(N).fill(Infinity));
  const d2 = layers.map(() => new Float32Array(N).fill(Infinity));
  const n1 = layers.map(() => new Int32Array(N).fill(-1));
  const netIndex = new Map<string, number>();
  const idx = (name: string) => {
    const net = opts.mergeNets?.[name] ?? name;
    if (!netIndex.has(net)) netIndex.set(net, netIndex.size);
    return netIndex.get(net)!;
  };
  let anon = 1_000_000;
  const surplusOf = (net: string | undefined) => Math.max(0, netRules(design, net).clearance - boardClear);

  const stamp = (layer: number, net: number, bbox: { x0: number; y0: number; x1: number; y1: number }, d: (p: Vec) => number, surplus: number) => {
    const gx0 = Math.max(0, Math.floor((bbox.x0 - fieldR) / res));
    const gy0 = Math.max(0, Math.floor((bbox.y0 - fieldR) / res));
    const gx1 = Math.min(W - 1, Math.ceil((bbox.x1 + fieldR) / res));
    const gy1 = Math.min(H - 1, Math.ceil((bbox.y1 + fieldR) / res));
    const D1 = d1[layer];
    const D2 = d2[layer];
    const N1 = n1[layer];
    for (let gy = gy0; gy <= gy1; gy++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const dd = d({ x: gx * res, y: gy * res }) - surplus;
        if (dd > fieldR) continue;
        const i = gy * W + gx;
        if (N1[i] === net) {
          if (dd < D1[i]) D1[i] = dd;
        } else if (dd < D1[i]) {
          // The previous nearest belongs to another net, so it becomes a "different net" distance.
          if (D1[i] < D2[i]) D2[i] = D1[i];
          D1[i] = dd;
          N1[i] = net;
        } else if (dd < D2[i]) D2[i] = dd;
      }
    }
  };
  const stampTrace = (layer: number, net: number, pts: Vec[], w: number, surplus: number) => {
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1];
      const b = pts[k];
      const bbox = { x0: Math.min(a.x, b.x) - w / 2, y0: Math.min(a.y, b.y) - w / 2, x1: Math.max(a.x, b.x) + w / 2, y1: Math.max(a.y, b.y) + w / 2 };
      stamp(layer, net, bbox, (p) => pointSegmentDistance(p, a, b) - w / 2, surplus);
    }
  };
  const stampVia = (net: number, v: Vec, dia: number, surplus: number, lo = 0, hi = L - 1) => {
    for (let l = lo; l <= hi; l++) stamp(l, net, { x0: v.x - dia / 2, y0: v.y - dia / 2, x1: v.x + dia / 2, y1: v.y + dia / 2 }, (p) => Math.hypot(p.x - v.x, p.y - v.y) - dia / 2, surplus);
  };

  // Existing copper.
  const padAt = new Map<string, WorldPad>();
  for (const it of analysis.items) {
    const itemNet = analysis.netOfItem(it);
    const net = itemNet !== undefined ? idx(itemNet) : anon++;
    const surplus = surplusOf(itemNet);
    if (it.kind === "pad") {
      const r = padRect(it.pad);
      padAt.set(`${it.pad.world.x.toFixed(4)},${it.pad.world.y.toFixed(4)}`, it.pad);
      const pad = it.pad;
      for (const l of it.pad.layers) if (layers.includes(l)) stamp(layers.indexOf(l), net, r, (p) => padDistance(pad, p), surplus);
    } else if (it.kind === "trace") {
      if (layers.includes(it.trace.layer)) stampTrace(layers.indexOf(it.trace.layer), net, it.trace.points, it.trace.width, surplus);
    } else {
      const span = it.layers.map((l) => layers.indexOf(l)).filter((i) => i >= 0);
      if (span.length) stampVia(net, it.via, it.via.diameter, surplus, Math.min(...span), Math.max(...span));
    }
  }

  // Board edge distance field (custom outlines, cutouts): -1 outside the board, else distance to the nearest edge.
  const outline = boardOutline(design.board);
  const holes = design.board.cutouts ?? [];
  const edgeD = new Float32Array(N).fill(-1);
  for (let gy = 0; gy < H; gy++) {
    const y = gy * res;
    const spans = polygonSpans(outline, y);
    const holeSpans = holes.flatMap((h) => polygonSpans(h, y));
    for (const [a, b] of spans) {
      for (let gx = Math.max(0, Math.ceil(a / res)); gx <= Math.min(W - 1, Math.floor(b / res)); gx++) {
        const x = gx * res;
        if (!holeSpans.some(([c, d]) => x >= c && x <= d)) edgeD[gy * W + gx] = Infinity;
      }
    }
  }
  const EDGE_R = 0.3 + maxHalf + 2 * res;
  for (const poly of [outline, ...holes]) {
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k];
      const b = poly[(k + 1) % poly.length];
      const gx0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - EDGE_R) / res));
      const gx1 = Math.min(W - 1, Math.ceil((Math.max(a.x, b.x) + EDGE_R) / res));
      const gy0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - EDGE_R) / res));
      const gy1 = Math.min(H - 1, Math.ceil((Math.max(a.y, b.y) + EDGE_R) / res));
      for (let gy = gy0; gy <= gy1; gy++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          const i = gy * W + gx;
          if (edgeD[i] < 0) continue;
          const d = pointSegmentDistance({ x: gx * res, y: gy * res }, a, b);
          if (d < edgeD[i]) edgeD[i] = d;
        }
      }
    }
  }
  // Keepouts: no-tracks areas behave like foreign copper; no-vias areas are flagged per cell.
  const noVia = new Uint8Array(N);
  for (const k of design.keepouts) {
    const xs = k.points.map((p) => p.x);
    const ys = k.points.map((p) => p.y);
    const bbox = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    const dist = (p: Vec) => (pointInPolygon(p, k.points) ? -1 : Math.min(...k.points.map((q, i) => pointSegmentDistance(p, q, k.points[(i + 1) % k.points.length]))));
    if (k.noTracks) for (const l of k.layers) if (layers.includes(l)) stamp(layers.indexOf(l), -2, bbox, dist, 0);
    if (k.noVias) {
      for (let gy = Math.max(0, Math.floor(bbox.y0 / res) - 2); gy <= Math.min(H - 1, Math.ceil(bbox.y1 / res) + 2); gy++) {
        for (let gx = Math.max(0, Math.floor(bbox.x0 / res) - 2); gx <= Math.min(W - 1, Math.ceil(bbox.x1 / res) + 2); gx++) if (dist({ x: gx * res, y: gy * res }) < maxHalf) noVia[gy * W + gx] = 1;
      }
    }
  }

  const result: RouteResult = { traces: [], vias: [], routed: 0, failed: [] };
  const lines: RouteLine[] = (opts.lines ?? ratsnest(design, analysis))
    .filter((l) => !opts.nets || opts.nets.includes(l.net))
    .sort((a, b) => Math.hypot(a.a.x - a.b.x, a.a.y - a.b.y) - Math.hypot(b.a.x - b.b.x, b.a.y - b.b.y));
  const g = new Float32Array(L * N);
  const came = new Int32Array(L * N);
  const closed = new Uint8Array(L * N);
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
  // Diagonal segments between two valid cells can dip slightly closer to obstacles than either end.
  const margin = res * 0.3;

  const search = (line: (typeof lines)[number], width: number, viaD: number) => {
    const net = idx(line.net);
    const rules = netRules(design, line.net);
    const need = Math.max(rules.clearance, boardClear, opts.clearance ?? 0) + width / 2 + margin;
    const needVia = Math.max(rules.clearance, boardClear, opts.clearance ?? 0) + viaD / 2 + margin;
    const edge = 0.3 + width / 2;
    const edgeVia = 0.3 + viaD / 2;
    const pa = padAt.get(`${line.a.x.toFixed(4)},${line.a.y.toFixed(4)}`);
    const pb = padAt.get(`${line.b.x.toFixed(4)},${line.b.y.toFixed(4)}`);
    const layerIdx = (ls: CopperLayer[] | undefined) => (ls ?? layers).filter((l) => layers.includes(l)).map((l) => layers.indexOf(l));
    const layersA = layerIdx(line.layers ?? pa?.layers);
    const layersB = new Set(layerIdx(line.layers ?? pb?.layers));
    const ax = Math.round(line.a.x / res);
    const ay = Math.round(line.a.y / res);
    const bx = Math.round(line.b.x / res);
    const by = Math.round(line.b.y / res);
    const clearOf = (l: number, i: number) => (n1[l][i] === net ? d2[l][i] : d1[l][i]);
    const edgeOk = (gx: number, gy: number, e: number) => edgeD[gy * W + gx] >= e;
    const ok = (l: number, gx: number, gy: number) => clearOf(l, gy * W + gx) >= need && edgeOk(gx, gy, edge);
    const viaOk = (gx: number, gy: number, lo = 0, hi = L - 1) => {
      if (!edgeOk(gx, gy, edgeVia) || noVia[gy * W + gx]) return false;
      for (let l = lo; l <= hi; l++) if (clearOf(l, gy * W + gx) < needVia) return false;
      return true;
    };
    const h = (gx: number, gy: number) => {
      const dx = Math.abs(gx - bx);
      const dy = Math.abs(gy - by);
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };
    // Pads themselves are allowed as start/end cells even when the escape is tight.
    const isEnd = (gx: number, gy: number) => (gx === ax && gy === ay) || (gx === bx && gy === by);

    g.fill(Infinity);
    came.fill(-1);
    closed.fill(0);
    const heap = new MinHeap();
    for (const l of layersA) {
      const id = l * N + ay * W + ax;
      g[id] = 0;
      heap.push(id, h(ax, ay));
    }
    const viaCost = Math.max(12, 1.2 / res);
    let goal = -1;
    let budget = 3_000_000;
    while (heap.size && budget-- > 0) {
      const id = heap.pop();
      if (closed[id]) continue;
      closed[id] = 1;
      const l = Math.floor(id / N);
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
        if (!ok(l, nx, ny) && !isEnd(nx, ny)) continue;
        if (dx && dy && ((!ok(l, nx, gy) && !isEnd(nx, gy)) || (!ok(l, gx, ny) && !isEnd(gx, ny)))) continue;
        const nid = l * N + ny * W + nx;
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
      if (allowVias && L > 1) {
        let checked: boolean | null = null;
        for (let l2 = 0; l2 < L; l2++) {
          if (l2 === l) continue;
          const nid = l2 * N + cell;
          // Blind vias cost a little more per layer they cross; through vias cost the same anywhere.
          const ng = g[id] + viaCost * (blind ? 1 + 0.15 * (Math.abs(l2 - l) - 1) : 1);
          if (ng >= g[nid]) continue;
          if (blind) {
            if (!viaOk(gx, gy, Math.min(l, l2), Math.max(l, l2))) continue;
          } else {
            checked ??= viaOk(gx, gy);
            if (!checked) break;
          }
          g[nid] = ng;
          came[nid] = id;
          heap.push(nid, ng + h(gx, gy));
        }
      }
    }
    return goal;
  };

  for (const line of lines) {
    const net = idx(line.net);
    const rules = netRules(design, line.net);
    const viaD = opts.viaDiameter ?? rules.viaDiameter;
    const viaDrill = opts.viaDrill ?? rules.viaDrill;
    let width = opts.forceWidth ?? (rules.className === "Default" ? baseWidth : rules.traceWidth);
    let goal = search(line, width, viaD);
    // Neck down: if a wide net-class trace cannot escape fine-pitch pads, retry at the base width.
    if (goal < 0 && width > baseWidth && !opts.forceWidth) {
      width = baseWidth;
      goal = search(line, width, viaD);
    }
    if (goal < 0) {
      result.failed.push(line);
      continue;
    }

    // Reconstruct path and split into per-layer runs.
    const path: { l: number; p: Vec }[] = [];
    for (let id = goal; id >= 0; id = came[id]) {
      const l = Math.floor(id / N);
      const cell = id - l * N;
      path.push({ l, p: { x: (cell % W) * res, y: Math.floor(cell / W) * res } });
    }
    path.reverse();
    path[0].p = { ...line.a };
    path[path.length - 1].p = { ...line.b };
    let run: Vec[] = [];
    let runLayer = path[0].l;
    const surplus = surplusOf(line.net);
    const flush = () => {
      const pts = simplify(run);
      if (pts.length >= 2) {
        result.traces.push({ layer: layers[runLayer], width, points: pts });
        stampTrace(runLayer, net, pts, width, surplus);
      }
    };
    for (const step of path) {
      if (step.l !== runLayer) {
        flush();
        const v = run[run.length - 1];
        const lo = blind ? Math.min(runLayer, step.l) : 0;
        const hi = blind ? Math.max(runLayer, step.l) : L - 1;
        const span = lo === 0 && hi === L - 1 ? {} : { from: layers[lo], to: layers[hi] };
        result.vias.push({ ...v, diameter: viaD, drill: viaDrill, ...span });
        stampVia(net, v, viaD, surplus, lo, hi);
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


/**
 * Grid resolution: fine enough that pad centres (placed on a 0.05mm grid) line up with
 * routing cells for fine-pitch parts, capped so the search grid stays around 2M nodes.
 */
export function gridFor(design: Design): number {
  let minPitch = Infinity;
  for (const c of design.components) {
    const pads = getPart(c.partId)?.footprint?.pads ?? [];
    for (let i = 0; i < pads.length; i++) {
      for (let j = i + 1; j < pads.length; j++) {
        const d = Math.hypot(pads[i].x - pads[j].x, pads[i].y - pads[j].y);
        if (d > 0.05) minPitch = Math.min(minPitch, d);
      }
    }
  }
  let res = minPitch <= 0.65 ? 0.05 : minPitch < 1.0 ? 0.1 : 0.25;
  const layers = design.board.layers;
  while ((design.board.width / res) * (design.board.height / res) * layers > 2_000_000) res = Math.round(res * 2 * 100) / 100;
  return res;
}

// ---------- differential pairs ----------

/**
 * Route every connection: differential pairs first as coupled traces, then the rest.
 * A pair is routed as one wide centreline (2·width + gap) that treats both nets as its own copper,
 * then split into two parallel traces; pairs that cannot be coupled fall back to normal routing.
 */
export function autoRoute(design: Design, opts: RouteOptions = {}): RouteResult {
  if (opts.lines || opts.coupled === false || !design.diffPairs.length) return routeCore(design, opts);
  const pairs = routeDiffPairs(design, opts);
  const withPairs: Design = { ...design, traces: [...design.traces, ...pairs.traces.map((t, i) => ({ ...t, id: `__pair${i}` }))] };
  const rest = routeCore(withPairs, opts);
  return { traces: [...pairs.traces, ...rest.traces], vias: rest.vias, routed: pairs.routed + rest.routed, failed: rest.failed, coupled: pairs.coupled };
}

function routeDiffPairs(design: Design, opts: RouteOptions) {
  const out = { traces: [] as Omit<Trace, "id">[], routed: 0, coupled: [] as string[] };
  let cur = design;
  for (const pair of design.diffPairs) {
    if (opts.nets && !opts.nets.includes(pair.positive) && !opts.nets.includes(pair.negative)) continue;
    const analysis = analyzeCopper(cur);
    const rats = ratsnest(cur, analysis);
    const pos = rats.filter((r) => r.net === pair.positive);
    const neg = rats.filter((r) => r.net === pair.negative);
    const pitch = pair.width + pair.gap;
    const padAt = (p: Vec): WorldPad | undefined => {
      for (const it of analysis.items) if (it.kind === "pad" && Math.hypot(it.pad.world.x - p.x, it.pad.world.y - p.y) < 1e-6) return it.pad;
      return undefined;
    };
    const padLayersAt = (p: Vec): CopperLayer[] => padAt(p)?.layers ?? [];
    const cl = Math.max(netRules(cur, pair.positive).clearance, netRules(cur, pair.negative).clearance);
    const fat = 2 * pair.width + pair.gap;
    /** Coupling point just outside a pad pair, on the side facing `toward`. */
    const breakout = (pp: Vec, nn: Vec, toward: Vec): Vec => {
      const mid = { x: (pp.x + nn.x) / 2, y: (pp.y + nn.y) / 2 };
      const vx = nn.x - pp.x;
      const vy = nn.y - pp.y;
      const vl = Math.hypot(vx, vy) || 1;
      let dx = -vy / vl;
      let dy = vx / vl;
      if (dx * (toward.x - mid.x) + dy * (toward.y - mid.y) < 0) (dx = -dx), (dy = -dy);
      const half = Math.max(...[padAt(pp), padAt(nn)].map((pd) => (pd ? Math.max(pd.ww, pd.wh) / 2 : 0)));
      const d = half + cl + fat / 2 + 0.1;
      return { x: Math.round((mid.x + dx * d) * 1e4) / 1e4, y: Math.round((mid.y + dy * d) * 1e4) / 1e4 };
    };
    const used = new Set<number>();
    let any = false;
    for (const p of pos) {
      // Match the P connection with the N connection whose ends sit next to it.
      let best = -1;
      let bestCost = Infinity;
      let flip = false;
      neg.forEach((n, j) => {
        if (used.has(j)) return;
        const c1 = dist(p.a, n.a) + dist(p.b, n.b);
        const c2 = dist(p.a, n.b) + dist(p.b, n.a);
        if (Math.min(c1, c2) < bestCost) (bestCost = Math.min(c1, c2)), (best = j), (flip = c2 < c1);
      });
      if (best < 0) continue;
      const n = neg[best];
      const na = flip ? n.b : n.a;
      const nb = flip ? n.a : n.b;
      if (dist(p.a, na) > 4 * pitch + 2 || dist(p.b, nb) > 4 * pitch + 2) continue;
      const boardLayers = copperLayers(cur.board);
      const common = [p.a, na, p.b, nb].map(padLayersAt).reduce((acc, ls) => acc.filter((l) => ls.includes(l)), boardLayers);
      if (!common.length) continue;
      // The coupled run starts and ends just outside each pad pair; short breakouts join it to the pads.
      const ca = breakout(p.a, na, { x: (p.b.x + nb.x) / 2, y: (p.b.y + nb.y) / 2 });
      const cb = breakout(p.b, nb, { x: (p.a.x + na.x) / 2, y: (p.a.y + na.y) / 2 });
      // A net of its own: the pair's pads are obstacles for the wide centreline, like everything else.
      const r = routeCore(cur, { ...opts, nets: undefined, lines: [{ net: `__pair_${pair.name}`, a: ca, b: cb, layers: common }], forceWidth: fat, clearance: cl, allowVias: false });
      if (r.failed.length || r.traces.length !== 1) continue;
      // Extend the centreline back to each pad pair's midpoint so the breakout corners get proper mitres.
      const centre = [{ x: (p.a.x + na.x) / 2, y: (p.a.y + na.y) / 2 }, ...r.traces[0].points, { x: (p.b.x + nb.x) / 2, y: (p.b.y + nb.y) / 2 }];
      const split = splitPair(centre, p.a, na, p.b, nb, pitch / 2);
      if (!split) continue;
      const tP = { layer: r.traces[0].layer, width: pair.width, points: split.p };
      const tN = { layer: r.traces[0].layer, width: pair.width, points: split.n };
      if (!pairClear(cur, analysis, tP, tN, pair.positive, pair.negative, pair.gap)) continue;
      out.traces.push(tP, tN);
      out.routed += 2;
      used.add(best);
      any = true;
      cur = { ...cur, traces: [...cur.traces, { ...tP, id: `__p${out.traces.length}` }, { ...tN, id: `__n${out.traces.length}` }] };
    }
    if (any) out.coupled.push(pair.name);
  }
  return out;
}

/** Offset a polyline sideways by d (positive = left of travel), with mitred corners. */
export function offsetPolyline(pts: Vec[], d: number): Vec[] {
  const n = pts.length;
  const normal = (a: Vec, b: Vec) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: -dy / len, y: dx / len };
  };
  return pts.map((p, i) => {
    const n1 = normal(pts[Math.max(0, i - 1)], pts[Math.max(1, i)]);
    const n2 = normal(pts[Math.min(n - 2, i)], pts[Math.min(n - 1, i + 1)]);
    const mx = n1.x + n2.x;
    const my = n1.y + n2.y;
    const ml = Math.hypot(mx, my) || 1;
    // Mitre length grows as 1/cos(θ/2); 45° and 90° corners stay well under 1.5×.
    const scale = d / Math.max(0.35, (mx * n1.x + my * n1.y) / ml);
    return { x: p.x + (mx / ml) * scale, y: p.y + (my / ml) * scale };
  });
}

function splitPair(center: Vec[], pa: Vec, na: Vec, pb: Vec, nb: Vec, h: number): { p: Vec[]; n: Vec[] } | null {
  if (center.length < 2) return null;
  const side = (a: Vec, b: Vec, pp: Vec, nn: Vec) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return Math.sign(-dy * (pp.x - nn.x) + dx * (pp.y - nn.y));
  };
  const s0 = side(center[0], center[1], pa, na);
  const s1 = side(center[center.length - 2], center[center.length - 1], pb, nb);
  // P must stay on the same side from end to end; a polarity swap needs a crossover, which we leave to the user.
  if (!s0 || s0 !== s1) return null;
  return { p: simplify([pa, ...offsetPolyline(center, s0 * h), pb]), n: simplify([na, ...offsetPolyline(center, -s0 * h), nb]) };
}

function pairClear(design: Design, analysis: ReturnType<typeof analyzeCopper>, tP: Omit<Trace, "id">, tN: Omit<Trace, "id">, pNet: string, nNet: string, pairGap: number): boolean {
  const itP: CopperItem = { kind: "trace", key: "pairP", trace: { ...tP, id: "pairP" } };
  const itN: CopperItem = { kind: "trace", key: "pairN", trace: { ...tN, id: "pairN" } };
  if (copperGap(itP, itN) < pairGap - 1e-6) return false;
  for (const [mine, net, partner] of [
    [itP, pNet, nNet],
    [itN, nNet, pNet],
  ] as const) {
    const cl = netRules(design, net).clearance;
    for (const it of analysis.items) {
      if (!sharedLayers(mine, it).length) continue;
      const other = analysis.netOfItem(it);
      if (other === net) continue;
      // Partner pads keep full clearance; partner traces may run at the pair gap.
      const need = other === partner && it.kind === "trace" ? pairGap : Math.max(cl, netRules(design, other).clearance);
      if (copperGap(mine, it) < need - 1e-6) return false;
    }
  }
  return true;
}
