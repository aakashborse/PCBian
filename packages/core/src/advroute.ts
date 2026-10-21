// Interactive/advanced routing helpers: length tuning with meanders, length matching for
// groups and differential pairs, and push-and-shove for manually drawn traces.
import { analyzeCopper, copperGap, netLengths, sharedLayers, traceLength, type CopperAnalysis, type CopperItem } from "./copper";
import { boardOutline, netRules } from "./doc";
import { padDistance, pointInPolygon, pointSegmentDistance, segmentSegmentDistance } from "./geometry";
import { viaLayers } from "./stackup";
import type { Design, Trace, Vec, Via } from "./types";

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
function checker(design: Design, analysis: CopperAnalysis, overrides: Map<string, Trace> = new Map(), extra: { item: CopperItem; net: string | undefined }[] = [], viaOverrides: Map<string, Via> = new Map(), conn: CopperAnalysis = analysis) {
  const outline = boardOutline(design.board);
  const holes = design.board.cutouts ?? [];
  const edges = [outline, ...holes].flatMap((poly) => poly.map((p, i) => [p, poly[(i + 1) % poly.length]] as [Vec, Vec]));
  const items = () => [
    ...analysis.items.map((it) => (it.kind === "trace" && overrides.has(it.trace.id) ? { ...it, trace: overrides.get(it.trace.id)! } : it.kind === "via" && viaOverrides.has(it.via.id) ? { ...it, via: viaOverrides.get(it.via.id)! } : it)),
    ...extra.map((e) => e.item),
  ];
  // Connectivity (nets, connected clusters) can come from another state of the board: when a via is
  // dragged onto copper, what it was connected to before the move is what counts.
  const netOf = (it: CopperItem) => extra.find((e) => e.item.key === it.key)?.net ?? conn.netOfItem(it);
  const inside = (p: Vec) => pointInPolygon(p, outline) && !holes.some((h) => pointInPolygon(p, h));
  return {
    items,
    /** Foreign items closer than the clearance rule to `t` (excluding `ignore` trace ids). */
    conflicts(t: Trace, net: string | undefined, ignore: Set<string> = new Set()): CopperItem[] {
      return this.conflictsOf({ kind: "trace", key: `trace:${t.id}`, trace: t }, net, new Set([...ignore].map((id) => `trace:${id}`)));
    },
    /** Foreign items closer than the clearance rule to any copper item (excluding `ignore` keys). */
    conflictsOf(me: CopperItem, net: string | undefined, ignore: Set<string> = new Set()): CopperItem[] {
      const cl = netRules(design, net).clearance;
      const out: CopperItem[] = [];
      // Copper already connected to `me` (one cluster) is never a clash, even with no net name.
      const mine = conn.clusterOf.get(me.key);
      for (const it of items()) {
        if (it.key === me.key || ignore.has(it.key)) continue;
        if (mine !== undefined && conn.clusterOf.get(it.key) === mine) continue;
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
  /** Existing vias moved out of the way (their traces follow, in `changes`). */
  viaMoves: { id: string; x: number; y: number }[];
  reason?: string;
}

const fail = (reason: string): ShoveResult => ({ ok: false, changes: [], viaMoves: [], reason });

/**
 * The shove engine: starting from a new or moved item, push whatever of another net it crowds,
 * recursively. Traces are bumped aside (around traces, vias and pads alike, trying the other side
 * when one is blocked); vias are moved away and their traces follow; pads never move.
 */
function shoveFrom(design: Design, head: { item: CopperItem; net: string | undefined; isNew: boolean }, maxDepth: number, conn?: CopperAnalysis): ShoveResult {
  const geometry = analyzeCopper(design);
  // Nets and connected clusters (from the board before a move, when given).
  const analysis = conn ?? geometry;
  const traceOver = new Map<string, Trace>();
  const viaOver = new Map<string, Via>();
  const chk = checker(design, geometry, traceOver, head.isNew ? [{ item: head.item, net: head.net }] : [], viaOver, analysis);
  if (!head.isNew && head.item.kind === "via") viaOver.set(head.item.via.id, head.item.via);
  const netOf = (it: CopperItem) => (it.key === head.item.key ? head.net : analysis.netOfItem(it));
  const current = (it: CopperItem): CopperItem =>
    it.kind === "trace" && traceOver.has(it.trace.id) ? { ...it, trace: traceOver.get(it.trace.id)! } : it.kind === "via" && viaOver.has(it.via.id) ? { ...it, via: viaOver.get(it.via.id)! } : it;
  const clearance = (a: string | undefined, b: string | undefined) => Math.max(netRules(design, a).clearance, netRules(design, b).clearance);
  const pads = (net: string | undefined) => chk.items().filter((it) => it.kind === "pad" && (!net || netOf(it) !== net));
  const clearOfPads = (it: CopperItem, net: string | undefined) => pads(net).every((p) => !sharedLayers(it, p).length || copperGap(it, p) >= clearance(net, netOf(p)) - 1e-6);
  const viaInside = (v: Via) => {
    const outline = boardOutline(design.board);
    const r = v.diameter / 2 + EDGE_CLEAR;
    return [0, 90, 180, 270].every((a) => pointInPolygon({ x: v.x + r * Math.cos((a * Math.PI) / 180), y: v.y + r * Math.sin((a * Math.PI) / 180) }, outline));
  };

  /** Traces of a via's net ending on it (on one of its layers): they follow the via. */
  const attached = (v: Via, net: string | undefined): Trace[] =>
    chk.items().flatMap((it) => {
      if (it.kind !== "trace" || !viaLayers(design.board, v).includes(it.trace.layer)) return [];
      const t = it.trace;
      const ends = [t.points[0], t.points[t.points.length - 1]];
      if (!ends.some((p) => Math.hypot(p.x - v.x, p.y - v.y) < 1e-3)) return [];
      return analysis.netOfItem(it) === net || !net ? [t] : [];
    });
  const follow = (t: Trace, from: Vec, to: Vec): Trace => ({
    ...t,
    points: t.points.map((p, i) => ((i === 0 || i === t.points.length - 1) && Math.hypot(p.x - from.x, p.y - from.y) < 1e-3 ? r4(to) : p)),
  });

  /** Push a trace off an obstacle, preferring the side the obstacle is not on. */
  const pushTrace = (victim: Trace, vnet: string | undefined, obstacle: CopperItem, onet: string | undefined): Trace | null => {
    const cl = clearance(vnet, onet);
    for (const side of [0, 1]) {
      const cand = bump(victim, obstacle, cl, side === 1);
      if (!cand || !chk.edgeOk(cand)) continue;
      const it: CopperItem = { kind: "trace", key: `trace:${cand.id}`, trace: cand };
      if (clearOfPads(it, vnet)) return cand;
    }
    return null;
  };
  /** Move a via off an obstacle: straight away from it, else turned up to 90° either way. */
  const pushVia = (victim: Via, vnet: string | undefined, obstacle: CopperItem, onet: string | undefined): Via | null => {
    const cl = clearance(vnet, onet);
    const layers = viaLayers(design.board, victim);
    const at = (v: Via): CopperItem => ({ kind: "via", key: `via:${v.id}`, via: v, layers });
    const e = 1e-3;
    const g = (q: Vec) => pointGap(q, obstacle);
    let dir = { x: g({ x: victim.x + e, y: victim.y }) - g({ x: victim.x - e, y: victim.y }), y: g({ x: victim.x, y: victim.y + e }) - g({ x: victim.x, y: victim.y - e }) };
    const l = Math.hypot(dir.x, dir.y);
    dir = l > 1e-9 ? mul(dir, 1 / l) : { x: 1, y: 0 };
    for (const turn of [0, 45, -45, 90, -90]) {
      const a = (turn * Math.PI) / 180;
      const d = { x: dir.x * Math.cos(a) - dir.y * Math.sin(a), y: dir.x * Math.sin(a) + dir.y * Math.cos(a) };
      for (let s = 0.025; s <= 3; s += 0.025) {
        const v = { ...victim, ...r4(add(victim, mul(d, s))) };
        if (copperGap(at(v), obstacle) < cl - 1e-6) continue;
        if (viaInside(v) && clearOfPads(at(v), vnet)) return v;
        break;
      }
    }
    return null;
  };

  const queue: { it: CopperItem; net: string | undefined; depth: number }[] = [{ it: head.item, net: head.net, depth: 0 }];
  const locked = new Set<string>([head.item.key]);
  while (queue.length) {
    const { it, net, depth } = queue.shift()!;
    const me = current(it);
    for (const hit of chk.conflictsOf(me, net, locked)) {
      const hnet = netOf(hit);
      if (hit.kind === "pad") {
        if (depth === 0) return fail(`blocked by ${hit.pad.ref} pad ${hit.pad.id} (pads do not move)`);
        return fail(`a pushed ${me.kind} would hit ${hit.pad.ref} pad ${hit.pad.id}`);
      }
      if (depth >= maxDepth) return fail("too many traces and vias would have to move");
      if (hit.kind === "trace") {
        const victim = traceOver.get(hit.trace.id) ?? hit.trace;
        const pushed = pushTrace(victim, hnet, me, net);
        if (!pushed) return fail("a trace cannot be pushed far enough (it crosses, or would hit a pad or the board edge)");
        traceOver.set(victim.id, pushed);
        locked.add(hit.key);
        queue.push({ it: { kind: "trace", key: hit.key, trace: pushed }, net: hnet, depth: depth + 1 });
      } else {
        const victim = viaOver.get(hit.via.id) ?? hit.via;
        const moved = pushVia(victim, hnet, me, net);
        if (!moved) return fail("a via cannot be moved clear (pads or the board edge are in the way)");
        viaOver.set(victim.id, moved);
        locked.add(hit.key);
        queue.push({ it: { ...hit, via: moved }, net: hnet, depth: depth + 1 });
        for (const t of attached(victim, hnet)) {
          const f = follow(traceOver.get(t.id) ?? t, victim, moved);
          traceOver.set(t.id, f);
          locked.add(`trace:${t.id}`);
          queue.push({ it: { kind: "trace", key: `trace:${t.id}`, trace: f }, net: hnet, depth: depth + 1 });
        }
      }
    }
  }
  // Final check: everything placed or moved is clear of all other copper.
  const moved: CopperItem[] = [current(head.item), ...[...traceOver.values()].map((t): CopperItem => ({ kind: "trace", key: `trace:${t.id}`, trace: t })), ...[...viaOver.values()].map((v): CopperItem => ({ kind: "via", key: `via:${v.id}`, via: v, layers: viaLayers(design.board, v) }))];
  for (const m of moved) if (chk.conflictsOf(m, m.key === head.item.key ? head.net : analysis.netOfItem(m)).length) return fail("no clean position found");
  return {
    ok: true,
    changes: [...traceOver].map(([id, t]) => ({ id, points: t.points })),
    viaMoves: [...viaOver].filter(([id]) => head.isNew || head.item.kind !== "via" || id !== head.item.via.id).map(([id, v]) => ({ id, x: v.x, y: v.y })),
  };
}

/**
 * Make room for a new trace by pushing conflicting traces and vias of other nets aside,
 * recursively (a pushed trace or via may push its neighbours). Pads never move.
 */
export function shoveTrace(design: Design, trace: Omit<Trace, "id">, net: string | undefined, maxDepth = 4): ShoveResult {
  return shoveFrom(design, { item: { kind: "trace", key: "trace:__shove_new", trace: { ...trace, id: "__shove_new" } }, net, isNew: true }, maxDepth);
}

/**
 * Place a new via, or move an existing one (give its id), pushing traces and vias of other nets
 * out of the way. A moved via's own traces follow it (in `changes`).
 */
export function shoveVia(design: Design, via: Omit<Via, "id"> & { id?: string }, net: string | undefined, maxDepth = 4): ShoveResult {
  const existing = via.id ? design.vias.find((v) => v.id === via.id) : undefined;
  if (!existing) {
    const v = { ...via, id: "__shove_via" };
    return shoveFrom(design, { item: { kind: "via", key: "via:__shove_via", via: v, layers: viaLayers(design.board, v) }, net, isNew: true }, maxDepth);
  }
  // Moving an existing via: it is the head, its traces follow and push too.
  const moved = { ...existing, x: via.x, y: via.y };
  const ownTraces = design.traces.filter((t) => viaLayers(design.board, existing).includes(t.layer) && [t.points[0], t.points[t.points.length - 1]].some((p) => Math.hypot(p.x - existing.x, p.y - existing.y) < 1e-3));
  const followed = ownTraces.map((t) => ({ ...t, points: t.points.map((p, i) => ((i === 0 || i === t.points.length - 1) && Math.hypot(p.x - existing.x, p.y - existing.y) < 1e-3 ? r4(moved) : p)) }));
  const d2: Design = { ...design, vias: design.vias.map((v) => (v.id === existing.id ? moved : v)), traces: design.traces.map((t) => followed.find((f) => f.id === t.id) ?? t) };
  // Shove from the via first, then from each of its traces in turn, accumulating the moves.
  // Connectivity is the board's before the move: copper the via now overlaps is not "its" copper.
  const conn = analyzeCopper(design);
  let cur = d2;
  const changes = new Map<string, Vec[]>(followed.map((t) => [t.id, t.points]));
  const viaMoves = new Map<string, { id: string; x: number; y: number }>();
  const heads: CopperItem[] = [{ kind: "via", key: `via:${moved.id}`, via: moved, layers: viaLayers(design.board, moved) }, ...followed.map((t): CopperItem => ({ kind: "trace", key: `trace:${t.id}`, trace: t }))];
  for (const h of heads) {
    const r = shoveFrom(cur, { item: h, net, isNew: false }, maxDepth, conn);
    if (!r.ok) return r;
    for (const c of r.changes) changes.set(c.id, c.points);
    for (const m of r.viaMoves) viaMoves.set(m.id, m);
    cur = { ...cur, traces: cur.traces.map((t) => (changes.has(t.id) ? { ...t, points: changes.get(t.id)! } : t)), vias: cur.vias.map((v) => (viaMoves.has(v.id) ? { ...v, ...viaMoves.get(v.id)! } : v)) };
  }
  return { ok: true, changes: [...changes].map(([id, points]) => ({ id, points })), viaMoves: [...viaMoves.values()] };
}

/** Push the conflicting stretch of `victim` away from `obstacle` (any copper) with 45° ramps. */
function bump(victim: Trace, obs: CopperItem, cl: number, otherSide = false): Trace | null {
  const need = cl + victim.width / 2;
  let pts = victim.points;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    // A crossing cannot be shoved sideways.
    if (obs.kind === "trace") for (let k = 1; k < obs.trace.points.length; k++) if (segmentSegmentDistance(a, b, obs.trace.points[k - 1], obs.trace.points[k]) < 1e-9) return null;
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
    const dir = (sideSum >= 0 ? 1 : -1) * (otherSide ? -1 : 1);
    // Grow the shift until the stretch clears the obstacle.
    let done = false;
    for (let shift = 0.05; shift <= 3 + 1e-9; shift += 0.05) {
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
        done = true;
        break;
      }
    }
    if (!done) return null;
  }
  return { ...victim, points: pts };
}

const dedupe = (pts: Vec[]) => pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 1e-6);
