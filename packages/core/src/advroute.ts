// Interactive/advanced routing helpers: length tuning with meanders, length matching for
// groups and differential pairs, and push-and-shove for manually drawn traces.
import { analyzeCopper, copperGap, netLengths, sharedLayers, traceLength, type CopperAnalysis, type CopperItem } from "./copper";
import { boardOutline, netRules } from "./doc";
import { padDistance, pointInPolygon, pointSegmentDistance, segmentSegmentDistance } from "./geometry";
import type { Design, Trace, Vec } from "./types";

const EDGE_CLEAR = 0.3;

export interface TraceChange {
  id: string;
  points: Vec[];
}

export interface TuneResult {
  ok: boolean;
  net: string;
  before: number;
  after: number;
  target: number;
  changes: TraceChange[];
  reason?: string;
}

const sub = (a: Vec, b: Vec) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Vec, b: Vec) => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Vec, k: number) => ({ x: a.x * k, y: a.y * k });
const r4 = (p: Vec) => ({ x: Math.round(p.x * 1e4) / 1e4, y: Math.round(p.y * 1e4) / 1e4 });

/** Distance from a point to an item's copper edge. */
function pointGap(q: Vec, it: CopperItem): number {
  if (it.kind === "pad") return padDistance(it.pad, q);
  if (it.kind === "via") return Math.hypot(q.x - it.via.x, q.y - it.via.y) - it.via.diameter / 2;
  let best = Infinity;
  const p = it.trace.points;
  for (let i = 1; i < p.length; i++) best = Math.min(best, pointSegmentDistance(q, p[i - 1], p[i]));
  return best - it.trace.width / 2;
}

/** Copper-geometry checker for candidate traces against everything not on `net`. */
function checker(design: Design, analysis: CopperAnalysis, overrides: Map<string, Trace> = new Map(), extra: { item: CopperItem; net: string | undefined }[] = []) {
  const outline = boardOutline(design.board);
  const holes = design.board.cutouts ?? [];
  const edges = [outline, ...holes].flatMap((poly) => poly.map((p, i) => [p, poly[(i + 1) % poly.length]] as [Vec, Vec]));
  const items = () => [...analysis.items.map((it) => (it.kind === "trace" && overrides.has(it.trace.id) ? { ...it, trace: overrides.get(it.trace.id)! } : it)), ...extra.map((e) => e.item)];
  const netOf = (it: CopperItem) => extra.find((e) => e.item.key === it.key)?.net ?? analysis.netOfItem(it);
  const inside = (p: Vec) => pointInPolygon(p, outline) && !holes.some((h) => pointInPolygon(p, h));
  return {
    items,
    /** Foreign items closer than the clearance rule to `t` (excluding `ignore` trace ids). */
    conflicts(t: Trace, net: string | undefined, ignore: Set<string> = new Set()): CopperItem[] {
      const me: CopperItem = { kind: "trace", key: `trace:${t.id}`, trace: t };
      const cl = netRules(design, net).clearance;
      const out: CopperItem[] = [];
      for (const it of items()) {
        if (it.kind === "trace" && (it.trace.id === t.id || ignore.has(it.trace.id))) continue;
        if (!sharedLayers(me, it).length) continue;
        const other = netOf(it);
        if (net && other === net) continue;
        if (copperGap(me, it) < Math.max(cl, netRules(design, other).clearance) - 1e-6) out.push(it);
      }
      return out;
    },
    edgeOk(t: Pick<Trace, "points" | "width">) {
      for (let i = 1; i < t.points.length; i++) {
        const a = t.points[i - 1];
        const b = t.points[i];
        if (!inside(a) || !inside(b)) return false;
        for (const [p, q] of edges) if (segmentSegmentDistance(a, b, p, q) < EDGE_CLEAR + t.width / 2 - 1e-6) return false;
      }
      return true;
    },
  };
}

// ---------- length tuning ----------

export interface TuneOptions {
  /** Maximum meander amplitude (mm). */
  maxAmplitude?: number;
  /** Acceptable error (mm). */
  tolerance?: number;
}

/**
 * Lengthen a net to `target` mm by inserting meanders (accordion bumps) into its longest straight
 * segments, keeping clearance to other nets and the board edge. Traces are never shortened.
 */
export function tuneLength(design: Design, net: string, target: number, opts: TuneOptions = {}): TuneResult {
  const analysis = analyzeCopper(design);
  const before = netLengths(design, analysis).get(net) ?? 0;
  const tol = opts.tolerance ?? 0.05;
  const res: TuneResult = { ok: true, net, before, after: before, target, changes: [] };
  let delta = target - before;
  if (delta <= tol) {
    if (delta < -tol) return { ...res, ok: false, reason: `${net} is already ${before.toFixed(2)}mm, longer than ${target.toFixed(2)}mm; meanders only add length` };
    return res;
  }
  const traces = analysis.items.filter((it): it is Extract<CopperItem, { kind: "trace" }> => it.kind === "trace" && analysis.netOfItem(it) === net).map((it) => it.trace);
  if (!traces.length) return { ...res, ok: false, reason: `${net} has no routed traces to tune` };
  const overrides = new Map<string, Trace>();
  const chk = checker(design, analysis, overrides);
  const maxA = opts.maxAmplitude ?? 2;

  // Longest segments first; each can take one meander run.
  const segs = traces.flatMap((t) => t.points.slice(1).map((b, i) => ({ t, i, len: Math.hypot(b.x - t.points[i].x, b.y - t.points[i].y) }))).sort((a, b) => b.len - a.len);
  for (const seg of segs) {
    if (delta <= tol) break;
    const t = overrides.get(seg.t.id) ?? seg.t;
    // The segment index may have shifted if this trace was already meandered; locate it by its end points.
    const a0 = seg.t.points[seg.i];
    const b0 = seg.t.points[seg.i + 1];
    const i = t.points.findIndex((p, k) => k < t.points.length - 1 && p.x === a0.x && p.y === a0.y && t.points[k + 1].x === b0.x && t.points[k + 1].y === b0.y);
    if (i < 0) continue;
    const s = Math.max(t.width + netRules(design, net).clearance, 3 * t.width);
    const usable = seg.len - 2 * s;
    const maxK = Math.floor(usable / (2 * s));
    if (maxK < 1) continue;
    const placed = tryMeander(t, i, s, delta, maxK, maxA, net, chk, overrides);
    if (!placed) continue;
    overrides.set(t.id, placed.trace);
    delta -= placed.added;
  }
  for (const [id, t] of overrides) res.changes.push({ id, points: t.points });
  res.after = target - delta;
  if (delta > tol) return { ...res, ok: false, reason: `Added ${(res.after - before).toFixed(2)}mm but ${delta.toFixed(2)}mm is still missing; free up space next to the traces or allow a larger amplitude` };
  return res;
}

function tryMeander(t: Trace, i: number, s: number, delta: number, maxK: number, maxA: number, net: string, chk: ReturnType<typeof checker>, overrides: Map<string, Trace>): { trace: Trace; added: number } | null {
  const a = t.points[i];
  const b = t.points[i + 1];
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const u = mul(sub(b, a), 1 / len);
  const n = { x: -u.y, y: u.x };
  const minA = Math.max(t.width, s / 2);
  // Prefer few large bumps (fewer corners), then more periods with smaller amplitude.
  for (let k = Math.min(maxK, Math.max(1, Math.ceil(delta / (2 * maxA)))); k <= maxK; k++) {
    for (const scale of [1, 0.75, 0.5]) {
      const A = Math.min(maxA * scale, delta / (2 * k));
      if (A < minA && k > 1) continue;
      for (const side of [1, -1]) {
        const start = (len - 2 * s * k) / 2;
        const pts: Vec[] = [];
        for (let j = 0; j < k; j++) {
          const p0 = add(a, mul(u, start + 2 * s * j));
          const p1 = add(p0, mul(u, s));
          const off = mul(n, side * A);
          pts.push(p0, add(p0, off), add(p1, off), p1);
        }
        const points = [...t.points.slice(0, i + 1), ...pts.map(r4), ...t.points.slice(i + 1)];
        const cand: Trace = { ...t, points };
        if (!chk.edgeOk(cand)) continue;
        overrides.set(t.id, cand);
        const bad = chk.conflicts(cand, net);
        overrides.set(t.id, t);
        if (bad.length) continue;
        return { trace: cand, added: traceLength(cand) - traceLength(t) };
      }
    }
  }
  return null;
}

/** Bring every net of a length group (or both nets of a pair) up to a common target length. */
export function matchLengths(design: Design, nets: string[], target?: number, opts: TuneOptions = {}): { target: number; results: TuneResult[]; changes: TraceChange[] } {
  const lens = netLengths(design);
  const goal = target ?? Math.max(0, ...nets.map((n) => lens.get(n) ?? 0));
  let cur = design;
  const results: TuneResult[] = [];
  const all = new Map<string, Vec[]>();
  for (const net of nets) {
    const r = tuneLength(cur, net, goal, opts);
    results.push(r);
    if (r.changes.length) {
      for (const c of r.changes) all.set(c.id, c.points);
      cur = { ...cur, traces: cur.traces.map((t) => (all.has(t.id) ? { ...t, points: all.get(t.id)! } : t)) };
    }
  }
  return { target: goal, results, changes: [...all].map(([id, points]) => ({ id, points })) };
}

// ---------- push and shove ----------

export interface ShoveResult {
  ok: boolean;
  /** Existing traces moved out of the way. */
  changes: TraceChange[];
  reason?: string;
}

/**
 * Make room for a new trace by pushing conflicting traces of other nets aside with local bumps,
 * recursively (a pushed trace may push its neighbours). Pads and vias never move.
 */
export function shoveTrace(design: Design, trace: Omit<Trace, "id">, net: string | undefined, maxDepth = 4): ShoveResult {
  const analysis = analyzeCopper(design);
  const overrides = new Map<string, Trace>();
  const head: Trace = { ...trace, id: "__shove_new" };
  const chk = checker(design, analysis, overrides, [{ item: { kind: "trace", key: "trace:__shove_new", trace: head }, net }]);
  const netOfTrace = (id: string) => {
    const it = analysis.items.find((x) => x.kind === "trace" && x.trace.id === id);
    return it ? analysis.netOfItem(it) : undefined;
  };
  // Work list of fixed obstacles (the new trace, then every trace already pushed).
  const queue: { t: Trace; net: string | undefined; depth: number }[] = [{ t: head, net, depth: 0 }];
  const locked = new Set<string>([head.id]);
  while (queue.length) {
    const { t, net: tn, depth } = queue.shift()!;
    for (const it of chk.conflicts(t, tn, locked)) {
      if (it.kind !== "trace") return { ok: false, changes: [], reason: `blocked by ${it.kind === "pad" ? `${it.pad.ref} pad ${it.pad.id}` : "a via"} (pads and vias are not shoved)` };
      if (depth >= maxDepth) return { ok: false, changes: [], reason: "too many traces would have to move" };
      const victim = overrides.get(it.trace.id) ?? it.trace;
      const vnet = netOfTrace(victim.id);
      const cl = Math.max(netRules(design, vnet).clearance, netRules(design, tn).clearance);
      const pushed = bump(victim, t, cl);
      if (!pushed || !chk.edgeOk(pushed)) return { ok: false, changes: [], reason: "a trace cannot be pushed far enough (it crosses the new trace or hits the board edge)" };
      overrides.set(victim.id, pushed);
      locked.add(victim.id);
      queue.push({ t: pushed, net: vnet, depth: depth + 1 });
    }
  }
  // Final check: the new trace and everything moved are clear of all other copper.
  for (const t of [head, ...overrides.values()]) {
    if (chk.conflicts(t, t.id === head.id ? net : netOfTrace(t.id)).length) return { ok: false, changes: [], reason: "no clean position found" };
  }
  return { ok: true, changes: [...overrides].map(([id, t]) => ({ id, points: t.points })) };
}

/** Push the conflicting stretch of `victim` away from `obstacle` with 45° ramps. */
function bump(victim: Trace, obstacle: Trace, cl: number): Trace | null {
  const obs: CopperItem = { kind: "trace", key: "obs", trace: obstacle };
  const need = cl + victim.width / 2;
  let pts = victim.points;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    // A crossing cannot be shoved sideways.
    for (let k = 1; k < obstacle.points.length; k++) if (segmentSegmentDistance(a, b, obstacle.points[k - 1], obstacle.points[k]) < 1e-9) return null;
    const u = mul(sub(b, a), 1 / len);
    const n = { x: -u.y, y: u.x };
    const step = Math.min(0.05, len / 20);
    let t0 = Infinity;
    let t1 = -Infinity;
    let sideSum = 0;
    for (let s = 0; s <= len + 1e-9; s += step) {
      const q = add(a, mul(u, s));
      if (pointGap(q, obs) < need - 1e-6) {
        t0 = Math.min(t0, s);
        t1 = Math.max(t1, s);
        // Which side of the victim is the obstacle on? Probe both normals.
        sideSum += pointGap(add(q, n), obs) - pointGap(sub(q, n), obs);
      }
    }
    if (t0 > t1) continue;
    const dir = sideSum >= 0 ? 1 : -1;
    // Grow the shift until the stretch clears the obstacle.
    for (let shift = 0.05; shift <= 3; shift += 0.05) {
      const s0 = Math.max(0, t0 - need - shift);
      const s1 = Math.min(len, t1 + need + shift);
      const p1 = add(a, mul(u, s0));
      const p2 = add(add(a, mul(u, Math.min(s1, s0 + shift))), mul(n, dir * shift));
      const p3 = add(add(a, mul(u, Math.max(s0, s1 - shift))), mul(n, dir * shift));
      const p4 = add(a, mul(u, s1));
      // Ends attached to pads stay put: if the stretch reaches an end, the ramp starts right there.
      const mid = [p1, p2, p3, p4].map(r4);
      const next = [...pts.slice(0, i + 1), ...mid, ...pts.slice(i + 1)];
      const cand: Trace = { ...victim, points: dedupe(next) };
      if (copperGap({ kind: "trace", key: "v", trace: cand }, obs) >= cl - 1e-6) {
        pts = cand.points;
        i += mid.length;
        break;
      }
      if (shift + 0.05 > 3) return null;
    }
  }
  return { ...victim, points: pts };
}

const dedupe = (pts: Vec[]) => pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 1e-6);
