// Copper connectivity, ratsnest, copper pour (zone) fills and design-rule checks.
import { boardOutline, netRules, pairOf } from "./doc";
import { copperLayers, diffImpedance, traceImpedance, viaKind, viaLayers } from "./stackup";
import {
  courtyardRect,
  dist,
  ovalAxis,
  padCorners,
  padRect,
  polygonPolygonDistance,
  padsOf,
  pointInPolygon,
  polylineTouchesPolygon,
  rectsOverlap,
  segmentPolygonDistance,
  segmentRectDistance,
  segmentSegmentDistance,
  toWorld,
  type Rect,
  type WorldPad,
} from "./geometry";
import { getPart } from "./library";
import { computeNets, netByTerminal, termKey, UnionFind } from "./netlist";
import { computeZoneFill, teardrops, type Cutout, type ZoneFill } from "./zones";
import { ALL_COPPER, type CopperLayer, type Design, type Issue, type Net, type PinType, type Trace, type Vec, type Via, type Zone } from "./types";

export type CopperItem =
  | { kind: "pad"; key: string; pad: WorldPad; net?: string }
  | { kind: "trace"; key: string; trace: Trace }
  | { kind: "via"; key: string; via: Via; layers: CopperLayer[] };

const segs = (t: Trace): [Vec, Vec][] => t.points.slice(1).map((p, i) => [t.points[i], p]);

export function itemOnLayer(item: CopperItem, layer: CopperLayer): boolean {
  if (item.kind === "pad") return item.pad.layers.includes(layer);
  if (item.kind === "trace") return item.trace.layer === layer;
  return item.layers.includes(layer);
}

/** Distance between copper edges of two items on a shared layer (<= 0 means touching). */
export function copperGap(a: CopperItem, b: CopperItem): number {
  return gap(a, b);
}
/** Copper of an item as capsules (segment + radius) and rectangles. */
type Prim = { kind: "cap"; a: Vec; b: Vec; r: number } | { kind: "rect"; r: Rect } | { kind: "poly"; pts: Vec[] };
function prims(it: CopperItem): Prim[] {
  if (it.kind === "via") return [{ kind: "cap", a: it.via, b: it.via, r: it.via.diameter / 2 }];
  if (it.kind === "trace") return segs(it.trace).map(([a, b]) => ({ kind: "cap", a, b, r: it.trace.width / 2 }));
  const p = it.pad;
  // Round pads are circles and oval pads are stadiums, not their bounding boxes.
  if (p.shape === "circle") return [{ kind: "cap", a: p.world, b: p.world, r: Math.min(p.ww, p.wh) / 2 }];
  if (p.shape === "oval") {
    const [a, b] = ovalAxis(p);
    return [{ kind: "cap", a, b, r: Math.min(p.ww, p.wh) / 2 }];
  }
  // Angled rectangular pads are exact rotated polygons.
  if (p.angle) return [{ kind: "poly", pts: padCorners(p) }];
  return [{ kind: "rect", r: padRect(p) }];
}
const rectPts = (r: Rect): Vec[] => [
  { x: r.x0, y: r.y0 },
  { x: r.x1, y: r.y0 },
  { x: r.x1, y: r.y1 },
  { x: r.x0, y: r.y1 },
];
function primGap(a: Prim, b: Prim): number {
  if (a.kind === "poly" || b.kind === "poly") {
    if (b.kind === "cap") return primGap(b, a);
    const pa = a.kind === "poly" ? a.pts : a.kind === "rect" ? rectPts(a.r) : null;
    const pb = b.kind === "poly" ? b.pts : rectPts(b.r);
    if (!pa) {
      const c = a as { a: Vec; b: Vec; r: number };
      return segmentPolygonDistance(c.a, c.b, pb) - c.r;
    }
    return polygonPolygonDistance(pa, pb);
  }
  if (a.kind === "cap" && b.kind === "cap") return segmentSegmentDistance(a.a, a.b, b.a, b.b) - a.r - b.r;
  if (a.kind === "cap" && b.kind === "rect") return segmentRectDistance(a.a, a.b, b.r) - a.r;
  if (a.kind === "rect" && b.kind === "cap") return primGap(b, a);
  const ra = (a as { r: Rect }).r;
  const rb = (b as { r: Rect }).r;
  return Math.hypot(Math.max(0, ra.x0 - rb.x1, rb.x0 - ra.x1), Math.max(0, ra.y0 - rb.y1, rb.y0 - ra.y1));
}
function gap(a: CopperItem, b: CopperItem): number {
  let best = Infinity;
  for (const p of prims(a)) for (const q of prims(b)) best = Math.min(best, primGap(p, q));
  return best;
}

export const sharedLayers = (a: CopperItem, b: CopperItem): CopperLayer[] => ALL_COPPER.filter((l) => itemOnLayer(a, l) && itemOnLayer(b, l));

export interface CopperAnalysis {
  nets: Net[];
  items: CopperItem[];
  /** item key (or `zone:<id>`) -> cluster root */
  clusterOf: Map<string, string>;
  /** cluster root -> net names of pads (and zones) in it */
  clusterNets: Map<string, Set<string>>;
  /** Proximity pairs computed once, reused by DRC. */
  pairs: { a: CopperItem; b: CopperItem; gap: number }[];
  /** Net carried by an item (from its pads or zone), when unambiguous. */
  netOfItem: (it: CopperItem) => string | undefined;
  /** Computed copper pour fills by zone id. */
  fills: Map<string, ZoneFill>;
}

export function analyzeCopper(design: Design, nets = computeNets(design)): CopperAnalysis {
  const netOf = netByTerminal(nets);
  const items: CopperItem[] = [];
  for (const c of design.components) {
    padsOf(c).forEach((pad, i) => items.push({ kind: "pad", key: `pad:${c.id}:${i}`, pad, net: netOf.get(termKey({ comp: c.id, pin: pad.id })) }));
  }
  for (const t of design.traces) if (t.points.length >= 2) items.push({ kind: "trace", key: `trace:${t.id}`, trace: t });
  for (const v of design.vias) items.push({ kind: "via", key: `via:${v.id}`, via: v, layers: viaLayers(design.board, v) });

  const uf = new UnionFind();
  items.forEach((it) => uf.find(it.key));
  const pairs: CopperAnalysis["pairs"] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (sharedLayers(a, b).length === 0) continue;
      // Pads of the same footprint are never "connected" by proximity; their own pins define that.
      if (a.kind === "pad" && b.kind === "pad" && a.pad.comp === b.pad.comp) {
        if (a.pad.id === b.pad.id) uf.union(a.key, b.key);
        continue;
      }
      const g = gap(a, b);
      if (g < 2) pairs.push({ a, b, gap: g });
      if (g <= 1e-6) uf.union(a.key, b.key);
    }
  }

  const netsOfRoot = () => {
    const m = new Map<string, Set<string>>();
    for (const it of items) {
      const r = uf.find(it.key);
      if (!m.has(r)) m.set(r, new Set());
      if (it.kind === "pad" && it.net) m.get(r)!.add(it.net);
    }
    return m;
  };

  // Zones: each surviving fill island joins the same-net copper it touches.
  const fills = new Map<string, ZoneFill>();
  const islandKeys: { key: string; net: string }[] = [];
  if (design.zones.length) {
    const pre = netsOfRoot();
    const netPre = (it: CopperItem) => {
      if (it.kind === "pad" && it.net) return it.net;
      const s = pre.get(uf.find(it.key));
      return s && s.size === 1 ? [...s][0] : undefined;
    };
    for (const z of design.zones) {
      const fill = computeZoneFill(design, z, items, netPre as (it: unknown) => string | undefined);
      fills.set(z.id, fill);
      fill.islands.forEach((members, k) => {
        const key = `zone:${z.id}:${k}`;
        uf.find(key);
        for (const m of members) uf.union(key, m);
        islandKeys.push({ key, net: z.net });
      });
    }
  }

  const clusterOf = new Map<string, string>();
  for (const it of items) clusterOf.set(it.key, uf.find(it.key));
  for (const z of islandKeys) clusterOf.set(z.key, uf.find(z.key));
  const clusterNets = netsOfRoot();
  for (const z of islandKeys) {
    const r = uf.find(z.key);
    if (!clusterNets.has(r)) clusterNets.set(r, new Set());
    clusterNets.get(r)!.add(z.net);
  }
  const netOfItem = (it: CopperItem) => {
    if (it.kind === "pad" && it.net) return it.net;
    const s = clusterNets.get(clusterOf.get(it.key)!);
    return s && s.size === 1 ? [...s][0] : undefined;
  };
  return { nets, items, clusterOf, clusterNets, pairs, netOfItem, fills };
}

// ---------- zone fills ----------

export type { Cutout, ZoneFill };

/** The computed fill of a pour (outline minus cut-outs, plus spokes, minus removed islands). */
export function zoneFill(design: Design, zone: Zone, analysis = analyzeCopper(design)): ZoneFill {
  return analysis.fills.get(zone.id) ?? computeZoneFill(design, zone, analysis.items, analysis.netOfItem as (it: unknown) => string | undefined);
}

/** Teardrop polygons for the board (empty unless board.teardrops is enabled). */
export function boardTeardrops(design: Design, analysis = analyzeCopper(design)) {
  if (!design.board.teardrops) return [];
  return teardrops(design, analysis.items, (a, b) => analysis.clusterOf.get(a) === analysis.clusterOf.get(b));
}

// ---------- ratsnest ----------

export interface RatLine {
  net: string;
  a: Vec;
  b: Vec;
}

/** Unrouted connections: per net, a minimum spanning tree between copper islands. */
export function ratsnest(design: Design, analysis = analyzeCopper(design)): RatLine[] {
  const lines: RatLine[] = [];
  const padsByNet = new Map<string, WorldPad[]>();
  const clusterByPad = new Map<WorldPad, string>();
  for (const it of analysis.items) {
    if (it.kind !== "pad" || !it.net) continue;
    if (!padsByNet.has(it.net)) padsByNet.set(it.net, []);
    padsByNet.get(it.net)!.push(it.pad);
    clusterByPad.set(it.pad, analysis.clusterOf.get(it.key)!);
  }
  for (const [net, pads] of padsByNet) {
    const islands = new Map<string, WorldPad[]>();
    for (const p of pads) {
      const c = clusterByPad.get(p)!;
      if (!islands.has(c)) islands.set(c, []);
      islands.get(c)!.push(p);
    }
    const groups = [...islands.values()];
    if (groups.length < 2) continue;
    // Prim's algorithm over islands, edge weight = closest pad pair.
    const inTree = new Set<number>([0]);
    while (inTree.size < groups.length) {
      let best: { d: number; j: number; a: Vec; b: Vec } | null = null;
      for (const i of inTree) {
        for (let j = 0; j < groups.length; j++) {
          if (inTree.has(j)) continue;
          for (const pa of groups[i]) for (const pb of groups[j]) {
            const d = dist(pa.world, pb.world);
            if (!best || d < best.d) best = { d, j, a: pa.world, b: pb.world };
          }
        }
      }
      if (!best) break;
      inTree.add(best.j);
      lines.push({ net, a: best.a, b: best.b });
    }
  }
  return lines;
}

// ---------- DRC ----------

const itemLabel = (it: CopperItem) => (it.kind === "pad" ? `${it.pad.ref} pad ${it.pad.id}` : it.kind === "trace" ? `trace on ${it.trace.layer}` : "via");
const itemPos = (it: CopperItem): Vec => (it.kind === "pad" ? it.pad.world : it.kind === "via" ? it.via : it.trace.points[0]);

export function runDrc(design: Design): Issue[] {
  const issues: Issue[] = [];
  const analysis = analyzeCopper(design);
  const outline = boardOutline(design.board);
  const holes = design.board.cutouts ?? [];
  const insideBoard = (p: Vec) => pointInPolygon(p, outline) && !holes.some((h) => pointInPolygon(p, h));
  const edges = [outline, ...holes].flatMap((poly) => poly.map((p, i) => [p, poly[(i + 1) % poly.length]] as [Vec, Vec]));
  const edgeDistance = (a: Vec, b: Vec) => Math.min(...edges.map(([p, q]) => segmentSegmentDistance(a, b, p, q)));
  const layers = copperLayers(design.board);

  // Shorts: a copper island that joins pads of different nets.
  for (const [root, nets] of analysis.clusterNets) {
    if (nets.size > 1) {
      const pad = analysis.items.find((it) => it.kind === "pad" && analysis.clusterOf.get(it.key) === root);
      issues.push({ severity: "error", code: "short", message: `Short circuit between nets ${[...nets].join(", ")}`, at: pad ? itemPos(pad) : undefined });
    }
  }

  // Clearance between copper that is not electrically connected (net-class aware).
  for (const { a, b, gap: g } of analysis.pairs) {
    if (g <= 1e-6 || analysis.clusterOf.get(a.key) === analysis.clusterOf.get(b.key)) continue;
    const na = analysis.netOfItem(a);
    const nb = analysis.netOfItem(b);
    let required = Math.max(netRules(design, na).clearance, netRules(design, nb).clearance);
    // The two traces of a differential pair run at the pair gap, which may be tighter than the clearance rule.
    const dp = pairOf(design, na);
    if (dp && dp.partner === nb && a.kind === "trace" && b.kind === "trace") required = Math.min(required, dp.pair.gap);
    if (g < required - 1e-9) {
      issues.push({
        severity: "error",
        code: "clearance",
        message: `Clearance violation (${g.toFixed(3)}mm < ${required}mm) between ${itemLabel(a)} and ${itemLabel(b)}`,
        at: itemPos(a),
        refs: [a, b].flatMap((x) => (x.kind === "pad" ? [x.pad.ref] : [])),
      });
    }
  }

  // Unrouted nets.
  const rats = ratsnest(design, analysis);
  const unrouted = new Map<string, number>();
  for (const r of rats) unrouted.set(r.net, (unrouted.get(r.net) ?? 0) + 1);
  for (const [net, n] of unrouted) {
    const first = rats.find((r) => r.net === net)!;
    issues.push({ severity: "warning", code: "unrouted", message: `Net ${net} has ${n} unrouted connection${n > 1 ? "s" : ""}`, at: first.a });
  }

  // Placement: components must sit inside the board and not collide.
  const placed = design.components.filter((c) => getPart(c.partId)?.footprint);
  for (const c of placed) {
    const r = courtyardRect(c)!;
    const corners = [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];
    // Pads off the board are a real error; a body overhanging the edge (edge connectors) only warrants a check.
    if (padsOf(c).some((pd) => !insideBoard(pd.world))) {
      issues.push({ severity: "error", code: "outside_board", message: `${c.ref} is outside the board outline (drag it onto the board or use Auto-place)`, at: { x: c.pcb.x, y: c.pcb.y }, refs: [c.ref] });
    } else if (corners.some((p) => !insideBoard(p))) {
      issues.push({ severity: "warning", code: "overhang", message: `${c.ref} overhangs the board edge (fine for edge connectors)`, at: { x: c.pcb.x, y: c.pcb.y }, refs: [c.ref] });
    }
  }
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      const tht = (c: typeof a) => getPart(c.partId)!.footprint!.pads.some((p) => p.drill);
      if (a.pcb.side !== b.pcb.side && !tht(a) && !tht(b)) continue;
      if (rectsOverlap(courtyardRect(a)!, courtyardRect(b)!)) {
        issues.push({ severity: "warning", code: "courtyard_overlap", message: `Courtyards of ${a.ref} and ${b.ref} overlap`, at: { x: a.pcb.x, y: a.pcb.y }, refs: [a.ref, b.ref] });
      }
    }
  }

  for (const t of design.traces) {
    const it = analysis.items.find((x) => x.key === `trace:${t.id}`);
    const rules = netRules(design, it && analysis.netOfItem(it));
    if (!layers.includes(t.layer)) issues.push({ severity: "error", code: "layer", message: `Trace on ${t.layer} but the board has ${design.board.layers} layers`, at: t.points[0] });
    if (t.width < 0.15) issues.push({ severity: "warning", code: "trace_width", message: `Trace width ${t.width}mm is below the 0.15mm manufacturing minimum`, at: t.points[0] });
    else if (t.width + 1e-9 < rules.traceWidth) issues.push({ severity: "warning", code: "netclass_width", message: `Trace width ${t.width}mm is narrower than net class ${rules.className} (${rules.traceWidth}mm)`, at: t.points[0] });
    if (t.points.some((p) => !insideBoard(p))) {
      issues.push({ severity: "error", code: "trace_outside", message: "Trace runs outside the board outline", at: t.points[0] });
    } else {
      const d = Math.min(...segs(t).map(([a, b]) => edgeDistance(a, b)));
      if (d - t.width / 2 < EDGE_CLEAR - 1e-9) issues.push({ severity: "error", code: "edge_clearance", message: `Trace is ${(d - t.width / 2).toFixed(2)}mm from the board edge (minimum ${EDGE_CLEAR}mm)`, at: t.points[0] });
    }
    // Acid traps: acute angles between consecutive segments trap etchant.
    for (let i = 1; i < t.points.length - 1; i++) {
      const a = t.points[i - 1];
      const b = t.points[i];
      const c = t.points[i + 1];
      const v1 = { x: a.x - b.x, y: a.y - b.y };
      const v2 = { x: c.x - b.x, y: c.y - b.y };
      const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1);
      if (cos > 0.0001) issues.push({ severity: "warning", code: "acid_trap", message: `Acute trace corner (${Math.round((Math.acos(Math.min(1, cos)) * 180) / Math.PI)}°) may trap etchant`, at: b });
    }
    // Keepouts.
    for (const k of design.keepouts) {
      if (!k.noTracks || !k.layers.includes(t.layer)) continue;
      if (polylineTouchesPolygon(t.points, k.points)) issues.push({ severity: "error", code: "keepout", message: `Trace on ${t.layer} enters a no-tracks keepout`, at: t.points[0] });
    }
  }
  for (const v of design.vias) {
    for (const k of design.keepouts) if (k.noVias && pointInPolygon(v, k.points)) issues.push({ severity: "error", code: "keepout", message: "Via inside a no-vias keepout", at: v });
    if (!insideBoard(v)) issues.push({ severity: "error", code: "via_outside", message: "Via outside the board outline", at: v });
  }
  for (const it of analysis.items) {
    if (it.kind !== "pad") continue;
    const cs = padCorners(it.pad);
    const d = Math.min(...cs.map((q, i) => edgeDistance(q, cs[(i + 1) % cs.length])));
    if (insideBoard(it.pad.world) && d < EDGE_CLEAR - 1e-9) issues.push({ severity: "warning", code: "edge_clearance", message: `${it.pad.ref} pad ${it.pad.id} is ${d.toFixed(2)}mm from the board edge`, at: it.pad.world, refs: [it.pad.ref] });
  }
  issues.push(...silkAndMaskChecks(design, analysis));
  issues.push(...lengthIssues(design, analysis));
  for (const v of design.vias) {
    // Laser-drilled microvias go down to 0.1mm; mechanical drills stop at about 0.2mm.
    const kind = viaKind(design.board, v);
    const minDrill = kind === "micro" ? 0.1 : 0.2;
    if (v.drill < minDrill) issues.push({ severity: "warning", code: "via_drill", message: `Via drill ${v.drill}mm is below the ${minDrill}mm minimum for ${kind} vias`, at: v });
    for (const l of [v.from, v.to]) if (l && !layers.includes(l)) issues.push({ severity: "error", code: "layer", message: `Via spans ${l}, which this ${design.board.layers}-layer board does not have`, at: v });
    if (kind === "micro" && v.drill > 0.15) issues.push({ severity: "warning", code: "via_drill", message: `Microvia drill ${v.drill}mm is larger than the usual 0.1-0.15mm laser drill`, at: v });
    if (v.diameter - v.drill < 0.2) issues.push({ severity: "warning", code: "annular_ring", message: `Via annular ring ${((v.diameter - v.drill) / 2).toFixed(2)}mm is below 0.1mm`, at: v });
  }
  const netNames = new Set(analysis.nets.map((n) => n.name));
  for (const z of design.zones) {
    if (!layers.includes(z.layer)) issues.push({ severity: "error", code: "layer", message: `Zone ${z.net} is on ${z.layer} but the board has ${design.board.layers} layers`, at: z.points[0] });
    if (!netNames.has(z.net)) issues.push({ severity: "warning", code: "zone_net", message: `Zone on ${z.layer} uses net ${z.net}, which does not exist in the schematic`, at: z.points[0] });
  }
  return issues;
}

// ---------- lengths, skew and impedance ----------

export const traceLength = (t: Pick<Trace, "points">) => t.points.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - t.points[i].x, p.y - t.points[i].y), 0);

/** Routed trace length per net (mm). */
export function netLengths(design: Design, analysis = analyzeCopper(design)): Map<string, number> {
  const out = new Map<string, number>();
  for (const it of analysis.items) {
    if (it.kind !== "trace") continue;
    const net = analysis.netOfItem(it);
    if (net) out.set(net, (out.get(net) ?? 0) + traceLength(it.trace));
  }
  return out;
}

/** Length-group, differential-pair skew and impedance checks. */
export function lengthIssues(design: Design, analysis = analyzeCopper(design)): Issue[] {
  const issues: Issue[] = [];
  const len = netLengths(design, analysis);
  const rats = ratsnest(design, analysis);
  const unrouted = new Set(rats.map((r) => r.net));
  for (const g of design.lengthGroups) {
    const nets = g.nets.filter((n) => len.has(n) && !unrouted.has(n));
    if (nets.length < (g.target ? 1 : 2)) continue;
    const target = g.target ?? Math.max(...nets.map((n) => len.get(n)!));
    for (const n of nets) {
      const d = len.get(n)! - target;
      if (Math.abs(d) > g.tolerance + 1e-6)
        issues.push({ severity: "warning", code: "length", message: `${n} is ${len.get(n)!.toFixed(2)}mm, ${d > 0 ? "over" : "under"} the ${g.name} target ${target.toFixed(2)}mm by ${Math.abs(d).toFixed(2)}mm (±${g.tolerance}mm)` });
    }
  }
  for (const p of design.diffPairs) {
    const a = len.get(p.positive);
    const b = len.get(p.negative);
    if (a === undefined || b === undefined || unrouted.has(p.positive) || unrouted.has(p.negative)) continue;
    if (Math.abs(a - b) > p.maxSkew + 1e-6) issues.push({ severity: "warning", code: "skew", message: `Pair ${p.name}: ${p.positive} ${a.toFixed(2)}mm vs ${p.negative} ${b.toFixed(2)}mm, skew ${Math.abs(a - b).toFixed(2)}mm > ${p.maxSkew}mm` });
    if (p.gap < 0.1) issues.push({ severity: "warning", code: "pair_gap", message: `Pair ${p.name}: ${p.gap}mm gap is below the usual 0.1mm fabrication minimum; widen the traces or accept a different impedance` });
    if (p.impedance) {
      const z = diffImpedance(design.board, "top", p.width, p.gap);
      if (Math.abs(z - p.impedance) / p.impedance > 0.1) issues.push({ severity: "warning", code: "impedance", message: `Pair ${p.name}: ${p.width}/${p.gap}mm gives ${z.toFixed(0)}Ω on the outer layers, target ${p.impedance}Ω` });
    }
  }
  for (const nc of design.netClasses) {
    if (!nc.impedance) continue;
    const seen = new Set<string>();
    for (const it of analysis.items) {
      if (it.kind !== "trace") continue;
      const net = analysis.netOfItem(it);
      if (!net || !nc.nets.includes(net) || seen.has(`${net}:${it.trace.layer}`)) continue;
      const z = traceImpedance(design.board, it.trace.layer, it.trace.width);
      if (Math.abs(z - nc.impedance) / nc.impedance > 0.1) {
        seen.add(`${net}:${it.trace.layer}`);
        issues.push({ severity: "warning", code: "impedance", message: `${net} on ${it.trace.layer}: ${it.trace.width}mm is ${z.toFixed(0)}Ω, class ${nc.name} targets ${nc.impedance}Ω`, at: it.trace.points[0] });
      }
    }
  }
  return issues;
}

/** Electrical rules check on the schematic. */
export function runErc(design: Design, nets = computeNets(design)): Issue[] {
  const issues: Issue[] = [];
  const byId = new Map(design.components.map((c) => [c.id, c]));
  for (const n of nets) {
    const phys = n.terminals.filter((t) => getPart(byId.get(t.comp)!.partId)?.kind === "part");
    // A pin is intentionally unconnected if flagged, or if its electrical type is "not connected".
    const isNc = (t: { comp: string; pin: string }) => {
      const c = byId.get(t.comp)!;
      return (c.noConnect?.includes(t.pin) ?? false) || getPart(c.partId)?.symbol.pins.find((p) => p.id === t.pin)?.type === "nc";
    };
    for (const t of phys.filter(isNc)) {
      if (n.terminals.length > 1) {
        const c = byId.get(t.comp)!;
        issues.push({ severity: "warning", code: "nc_connected", message: `${c.ref} pin ${t.pin} is marked no-connect but is wired to net ${n.name}`, refs: [c.ref] });
      }
    }
    // Mounting holes and fiducials may be left floating; they are mechanical, not circuit pins.
    if (n.terminals.length === 1 && phys.length === 1 && !isNc(phys[0]) && getPart(byId.get(phys[0].comp)!.partId)?.category !== "Mechanical") {
      const c = byId.get(phys[0].comp)!;
      const pin = getPart(c.partId)!.symbol.pins.find((p) => p.id === phys[0].pin);
      issues.push({ severity: "warning", code: "unconnected_pin", message: `${c.ref} pin ${phys[0].pin} (${pin?.name}) is not connected`, refs: [c.ref] });
    } else if (phys.length === 1 && n.named) {
      const c = byId.get(phys[0].comp)!;
      issues.push({ severity: "warning", code: "single_pin_net", message: `Net ${n.name} only connects to ${c.ref} pin ${phys[0].pin}`, refs: [c.ref] });
    }
  }
  const refs = new Map<string, number>();
  for (const c of design.components) if (getPart(c.partId)?.kind === "part") refs.set(c.ref, (refs.get(c.ref) ?? 0) + 1);
  for (const [ref, n] of refs) if (n > 1) issues.push({ severity: "error", code: "duplicate_ref", message: `Reference ${ref} is used ${n} times`, refs: [ref] });
  issues.push(...pinTypeErc(design, nets), ...hierarchyErc(design));
  const sheetIds = new Set(design.sheets.map((s) => s.id));
  for (const c of design.components) {
    if (c.sheet && !sheetIds.has(c.sheet)) issues.push({ severity: "error", code: "orphan_sheet", message: `${c.ref} is on a sheet that no longer exists`, refs: [c.ref] });
  }
  return issues;
}

// ---------- ERC: pin-type conflict matrix ----------

const DRIVERS = new Set<PinType>(["output", "bidirectional", "tristate", "power_out", "open_collector", "passive", "unspecified"]);

/** KiCad/Altium-style pin conflict checks: competing outputs, undriven inputs, undriven power pins. */
export function pinTypeErc(design: Design, nets: Net[]): Issue[] {
  const issues: Issue[] = [];
  const byId = new Map(design.components.map((c) => [c.id, c]));
  for (const n of nets) {
    const pins = n.terminals.flatMap((t) => {
      const c = byId.get(t.comp)!;
      const part = getPart(c.partId)!;
      if (part.kind !== "part" || c.noConnect?.includes(t.pin)) return [];
      const pin = part.symbol.pins.find((p) => p.id === t.pin);
      return pin ? [{ ref: c.ref, pin: t.pin, name: pin.name, type: (pin.type ?? "passive") as PinType }] : [];
    });
    if (pins.length < 1) continue;
    const of = (...types: PinType[]) => pins.filter((p) => types.includes(p.type));
    const label = (p: (typeof pins)[number]) => `${p.ref}.${p.pin} (${p.name})`;
    const hasPowerSymbol = n.terminals.some((t) => getPart(byId.get(t.comp)!.partId)?.kind === "power");
    const outs = of("output");
    const pouts = of("power_out");
    if (outs.length > 1) issues.push({ severity: "error", code: "pin_conflict", message: `Net ${n.name}: outputs ${outs.map(label).join(", ")} drive each other`, refs: outs.map((p) => p.ref) });
    if (outs.length && pouts.length) issues.push({ severity: "error", code: "pin_conflict", message: `Net ${n.name}: output ${label(outs[0])} is connected to power output ${label(pouts[0])}`, refs: [outs[0].ref, pouts[0].ref] });
    if (pouts.length > 1) issues.push({ severity: "error", code: "pin_conflict", message: `Net ${n.name}: power outputs ${pouts.map(label).join(", ")} are shorted together`, refs: pouts.map((p) => p.ref) });
    if (outs.length && of("open_collector", "tristate").length) issues.push({ severity: "warning", code: "pin_conflict", message: `Net ${n.name}: push-pull output ${label(outs[0])} shares the net with ${label(of("open_collector", "tristate")[0])}`, refs: [outs[0].ref] });
    const inputs = of("input");
    if (inputs.length && !pins.some((p) => DRIVERS.has(p.type)) && n.terminals.length > 1) {
      issues.push({ severity: "warning", code: "undriven_input", message: `Net ${n.name}: input ${inputs.map(label).join(", ")} is not driven by any output`, refs: inputs.map((p) => p.ref) });
    }
    const pins_in = of("power_in");
    if (pins_in.length && !pouts.length && !hasPowerSymbol && n.terminals.length > 1) {
      issues.push({ severity: "warning", code: "undriven_power", message: `Net ${n.name}: power input ${label(pins_in[0])} has no power source (add a power symbol or a regulator output)`, refs: [pins_in[0].ref] });
    }
  }
  return issues;
}

/** Hierarchy checks: recursive sheet symbols, repeated instances, unused hierarchical ports. */
export function hierarchyErc(design: Design): Issue[] {
  const issues: Issue[] = [];
  const first = design.sheets[0]?.id;
  const sheetOfC = (c: { sheet?: string }) => c.sheet ?? first;
  const children = new Map<string, string[]>();
  const instances = new Map<string, number>();
  for (const c of design.components) {
    if (getPart(c.partId)?.kind !== "sheet") continue;
    const parent = sheetOfC(c)!;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push(c.value);
    instances.set(c.value, (instances.get(c.value) ?? 0) + 1);
  }
  const name = (id: string) => design.sheets.find((s) => s.id === id)?.name ?? id;
  // Cycle detection (DFS).
  const state = new Map<string, number>();
  const visit = (s: string, path: string[]): void => {
    if (state.get(s) === 1) {
      issues.push({ severity: "error", code: "sheet_recursion", message: `Sheet hierarchy is recursive: ${[...path, s].map(name).join(" → ")}` });
      return;
    }
    if (state.get(s) === 2) return;
    state.set(s, 1);
    for (const ch of children.get(s) ?? []) visit(ch, [...path, s]);
    state.set(s, 2);
  };
  for (const s of design.sheets) visit(s.id, []);
  for (const [sheet, n] of instances) {
    if (n > 1) issues.push({ severity: "warning", code: "sheet_reuse", message: `Sheet "${name(sheet)}" is instantiated ${n} times; instances share the same nets (repeated channels are not supported yet)` });
  }
  return issues;
}

const EDGE_CLEAR = 0.3;

/** Silkscreen over pads (it gets clipped at fabrication) and solder-mask webs too thin to manufacture. */
export function silkAndMaskChecks(design: Design, analysis: CopperAnalysis): Issue[] {
  const issues: Issue[] = [];
  const pads = analysis.items.filter((it): it is Extract<CopperItem, { kind: "pad" }> => it.kind === "pad").map((it) => it.pad);
  for (const c of design.components) {
    const part = getPart(c.partId);
    if (!part?.footprint) continue;
    const side = c.pcb.side;
    const mirror = side === "bottom";
    let flagged = false;
    for (const sh of part.footprint.silk) {
      if (flagged) break;
      const pts = sh.kind === "line" ? sh.points : sh.kind === "polygon" ? [...sh.points, sh.points[0]] : sh.kind === "rect" ? [{ x: sh.x, y: sh.y }, { x: sh.x + sh.w, y: sh.y }, { x: sh.x + sh.w, y: sh.y + sh.h }, { x: sh.x, y: sh.y + sh.h }, { x: sh.x, y: sh.y }] : [];
      const world = pts.map((p) => toWorld(p, c.pcb, mirror));
      for (const pad of pads) {
        if (!pad.layers.includes(side)) continue;
        const r = padRect(pad);
        const rr = { x0: r.x0 - 0.05, y0: r.y0 - 0.05, x1: r.x1 + 0.05, y1: r.y1 + 0.05 };
        if (world.slice(1).some((p, i) => segmentRectDistance(world[i], p, rr) === 0)) {
          issues.push({ severity: "warning", code: "silk_over_pad", message: `${c.ref} silkscreen overlaps ${pad.ref} pad ${pad.id} (it will be clipped)`, at: pad.world, refs: [c.ref] });
          flagged = true;
          break;
        }
      }
    }
  }
  // Mask webs: openings are pads grown by 0.05mm; a web thinner than 0.1mm cannot be printed.
  for (let i = 0; i < pads.length; i++) {
    for (let j = i + 1; j < pads.length; j++) {
      const a = pads[i];
      const b = pads[j];
      if (!a.layers.some((l) => b.layers.includes(l) && (l === "top" || l === "bottom"))) continue;
      const ra = padRect(a);
      const rb = padRect(b);
      const dx = Math.max(0, ra.x0 - rb.x1, rb.x0 - ra.x1);
      const dy = Math.max(0, ra.y0 - rb.y1, rb.y0 - ra.y1);
      const web = Math.hypot(dx, dy) - 0.1;
      if (web > 0 && web < 0.1 - 1e-9) issues.push({ severity: "warning", code: "mask_sliver", message: `Solder-mask web between ${a.ref}.${a.id} and ${b.ref}.${b.id} is only ${web.toFixed(3)}mm`, at: a.world, refs: [a.ref] });
    }
  }
  return issues;
}
