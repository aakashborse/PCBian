// Signal integrity checks on the routed board: per-net impedance along the route against its
// target, propagation delay, via count, return-path gaps in the reference plane, and coupled-length
// crosstalk between neighbouring nets.
import { analyzeCopper, netLengths, type CopperAnalysis } from "./copper";
import { pairOf } from "./doc";
import { fieldSolveImpedance } from "./fieldsolver";
import { pointInPolygon } from "./geometry";
import { copperLayers, diffImpedance, layerGeometry, traceImpedance } from "./stackup";
import type { CopperLayer, Design, Issue, Trace, Vec } from "./types";

const C_MM_PER_PS = 0.299792458;

export interface SiSegment {
  layer: CopperLayer;
  width: number;
  length: number;
  /** Single-ended impedance of this width on this layer (differential for a pair's segments). */
  z: number;
  eeff: number;
}

export interface SiNet {
  net: string;
  length: number;
  /** Propagation delay along the routed length (ps). */
  delay: number;
  vias: number;
  segments: SiSegment[];
  zMin: number;
  zMax: number;
  /** Target impedance from the net class (single-ended) or diff pair (differential). */
  target?: number;
  differential: boolean;
  /** Length of route without a reference plane under it (mm), where the board has planes. */
  unreferenced: number;
}

export interface Crosstalk {
  a: string;
  b: string;
  layer: CopperLayer;
  /** Parallel run length (mm) and the edge-to-edge gap over it (mm). */
  coupled: number;
  gap: number;
  /** Estimated near-end (backward) crosstalk, as a fraction of the aggressor swing. */
  next: number;
}

export interface SiOptions {
  /** Nets to analyse (default: every routed net). */
  nets?: string[];
  /** Signal rise time (ns) for the saturation length of backward crosstalk; default 1 ns. */
  riseTime?: number;
  /** Crosstalk reported above this fraction; default 0.03 (3%). */
  crosstalkLimit?: number;
  /** Impedance tolerance against targets; default 0.1 (10%). */
  tolerance?: number;
  /** Use the field solver for impedance (slower, about 1% accurate). */
  fieldSolve?: boolean;
}

export interface SiReport {
  nets: SiNet[];
  crosstalk: Crosstalk[];
  issues: Issue[];
}

/** Effective permittivity of a trace on a layer (closed form). */
function eeffOf(design: Design, layer: CopperLayer, w: number): number {
  const g = layerGeometry(design.board, layer);
  if (g.kind === "stripline") return g.er;
  return (g.er + 1) / 2 + ((g.er - 1) / 2) / Math.sqrt(1 + (12 * g.h) / w);
}

/** Height of a trace above its nearest reference plane (mm). */
function heightOf(design: Design, layer: CopperLayer): number {
  const g = layerGeometry(design.board, layer);
  return g.kind === "microstrip" ? g.h : Math.min(g.h1, g.h2);
}

const segLen = (a: Vec, b: Vec) => Math.hypot(b.x - a.x, b.y - a.y);

/** Whether a point sits over poured copper on a layer. */
function overPour(analysis: CopperAnalysis, design: Design, layer: CopperLayer, p: Vec): boolean {
  for (const z of design.zones) {
    if (z.layer !== layer) continue;
    const fill = analysis.fills.get(z.id);
    if (!fill) continue;
    for (const island of fill.polygons) if (pointInPolygon(p, island[0]) && !island.slice(1).some((h) => pointInPolygon(p, h))) return true;
  }
  return false;
}

export function signalIntegrity(design: Design, opts: SiOptions = {}): SiReport {
  const analysis = analyzeCopper(design);
  const lengths = netLengths(design, analysis);
  const layers = copperLayers(design.board);
  const tol = opts.tolerance ?? 0.1;
  const limit = opts.crosstalkLimit ?? 0.03;
  const tr = (opts.riseTime ?? 1) * 1000; // ps
  const tracesByNet = new Map<string, Trace[]>();
  for (const it of analysis.items) {
    if (it.kind !== "trace") continue;
    const n = analysis.netOfItem(it);
    if (!n) continue;
    if (!tracesByNet.has(n)) tracesByNet.set(n, []);
    tracesByNet.get(n)!.push(it.trace);
  }
  const viaCount = new Map<string, number>();
  for (const it of analysis.items) {
    if (it.kind !== "via") continue;
    const n = analysis.netOfItem(it);
    if (n) viaCount.set(n, (viaCount.get(n) ?? 0) + 1);
  }
  // Layers with pours: a trace next to one is expected to have it as its reference.
  const pourLayers = new Set(design.zones.map((z) => z.layer));
  const zCache = new Map<string, { z: number; eeff: number }>();
  const zOf = (layer: CopperLayer, w: number, gap?: number) => {
    const key = `${layer}|${w}|${gap ?? ""}`;
    if (!zCache.has(key)) {
      if (opts.fieldSolve) {
        const r = fieldSolveImpedance(design.board, layer, w, gap);
        zCache.set(key, { z: gap === undefined ? r.z0 : r.zdiff!, eeff: r.eeff });
      } else zCache.set(key, { z: gap === undefined ? traceImpedance(design.board, layer, w) : diffImpedance(design.board, layer, w, gap), eeff: eeffOf(design, layer, w) });
    }
    return zCache.get(key)!;
  };

  const issues: Issue[] = [];
  const nets: SiNet[] = [];
  const wanted = opts.nets ? new Set(opts.nets) : null;
  for (const [net, traces] of tracesByNet) {
    if (wanted && !wanted.has(net)) continue;
    const pair = pairOf(design, net);
    const nc = design.netClasses.find((c) => c.nets.includes(net));
    const target = pair ? pair.pair.impedance : nc?.impedance;
    const segments: SiSegment[] = [];
    let delay = 0;
    let unreferenced = 0;
    for (const t of traces) {
      const len = t.points.slice(1).reduce((s, p, i) => s + segLen(t.points[i], p), 0);
      const { z, eeff } = zOf(t.layer, t.width, pair ? pair.pair.gap : undefined);
      segments.push({ layer: t.layer, width: t.width, length: len, z, eeff });
      delay += (len * Math.sqrt(eeff)) / C_MM_PER_PS;
      // Return path: the neighbouring layers' pours should run under the whole trace.
      const i = layers.indexOf(t.layer);
      const refs = [layers[i - 1], layers[i + 1]].filter((l): l is CopperLayer => !!l && pourLayers.has(l));
      if (!refs.length) continue;
      for (let k = 1; k < t.points.length; k++) {
        const a = t.points[k - 1];
        const b = t.points[k];
        const L = segLen(a, b);
        const n = Math.max(1, Math.ceil(L / 0.25));
        let gapRun = 0;
        for (let s = 0; s < n; s++) {
          const f = (s + 0.5) / n;
          const p = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
          if (!refs.some((l) => overPour(analysis, design, l, p))) gapRun += L / n;
        }
        unreferenced += gapRun;
      }
    }
    const zs = segments.map((s) => s.z);
    const report: SiNet = {
      net,
      length: lengths.get(net) ?? 0,
      delay,
      vias: viaCount.get(net) ?? 0,
      segments,
      zMin: Math.min(...zs),
      zMax: Math.max(...zs),
      target,
      differential: !!pair,
      unreferenced,
    };
    nets.push(report);
    if (target) {
      const off = segments.filter((s) => Math.abs(s.z / target - 1) > tol);
      if (off.length)
        issues.push({
          severity: "warning",
          code: "impedance",
          message: `${net}: ${off.map((s) => `${s.width}mm on ${s.layer} is ${s.z.toFixed(1)}Ω`).filter((v, i, a) => a.indexOf(v) === i).join(", ")}; target ${target}Ω${pair ? " differential" : ""} ±${Math.round(tol * 100)}%`,
        });
    }
    if (unreferenced > 0.5) issues.push({ severity: target || pair ? "error" : "warning", code: "return-path", message: `${net}: ${unreferenced.toFixed(1)}mm of route crosses a gap in its reference plane (the return current has to detour)` });
  }

  // Crosstalk between parallel runs of different nets on one layer.
  const crosstalk: Crosstalk[] = [];
  const segs: { net: string; layer: CopperLayer; a: Vec; b: Vec; w: number }[] = [];
  for (const [net, traces] of tracesByNet) for (const t of traces) for (let k = 1; k < t.points.length; k++) segs.push({ net, layer: t.layer, a: t.points[k - 1], b: t.points[k], w: t.width });
  const coupled = new Map<string, Crosstalk>();
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i];
      const o = segs[j];
      if (s.layer !== o.layer || s.net === o.net) continue;
      if (wanted && !wanted.has(s.net) && !wanted.has(o.net)) continue;
      const h = heightOf(design, s.layer);
      const L1 = segLen(s.a, s.b);
      const L2 = segLen(o.a, o.b);
      if (L1 < 1e-6 || L2 < 1e-6) continue;
      const u = { x: (s.b.x - s.a.x) / L1, y: (s.b.y - s.a.y) / L1 };
      const v = { x: (o.b.x - o.a.x) / L2, y: (o.b.y - o.a.y) / L2 };
      if (Math.abs(u.x * v.y - u.y * v.x) > Math.sin((10 * Math.PI) / 180)) continue;
      // Overlap along s's direction, and the perpendicular centre spacing.
      const proj = (p: Vec) => (p.x - s.a.x) * u.x + (p.y - s.a.y) * u.y;
      const t0 = Math.max(0, Math.min(proj(o.a), proj(o.b)));
      const t1 = Math.min(L1, Math.max(proj(o.a), proj(o.b)));
      const overlap = t1 - t0;
      if (overlap <= 0.5) continue;
      const mid = { x: (o.a.x + o.b.x) / 2, y: (o.a.y + o.b.y) / 2 };
      const D = Math.abs((mid.x - s.a.x) * -u.y + (mid.y - s.a.y) * u.x);
      if (D > 10 * h) continue;
      const key = [s.net, o.net].sort().join("\u0000") + s.layer;
      const gap = D - (s.w + o.w) / 2;
      const prev = coupled.get(key);
      if (prev) {
        prev.coupled += overlap;
        prev.gap = Math.min(prev.gap, gap);
      } else coupled.set(key, { a: s.net < o.net ? s.net : o.net, b: s.net < o.net ? o.net : s.net, layer: s.layer, coupled: overlap, gap, next: 0 });
    }
  for (const c of coupled.values()) {
    const h = heightOf(design, c.layer);
    const w = Math.max(0.1, ...segs.filter((s) => s.net === c.a || s.net === c.b).map((s) => s.w));
    const D = c.gap + w;
    // Coupling coefficient of two traces over a plane ~ 1 / (1 + (D/H)^2) (centre spacing D, height
    // H); saturated backward crosstalk is about half of it, reduced when the parallel run is shorter
    // than half the rise-time length.
    const sat = 0.5 / (1 + (D / h) ** 2);
    const eeff = eeffOf(design, c.layer, w);
    const lsat = (tr * C_MM_PER_PS) / Math.sqrt(eeff) / 2;
    c.next = sat * Math.min(1, c.coupled / lsat);
    if (c.next >= limit) crosstalk.push(c);
  }
  crosstalk.sort((x, y) => y.next - x.next);
  for (const c of crosstalk)
    issues.push({ severity: "warning", code: "crosstalk", message: `${c.a} and ${c.b} run ${c.coupled.toFixed(1)}mm side by side on ${c.layer} ${c.gap.toFixed(2)}mm apart: about ${(c.next * 100).toFixed(1)}% backward crosstalk` });
  nets.sort((a, b) => b.length - a.length);
  return { nets, crosstalk, issues };
}
