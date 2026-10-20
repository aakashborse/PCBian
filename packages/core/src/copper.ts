// Copper connectivity, ratsnest and design-rule checks for the PCB.
import { courtyardRect, dist, padRect, padsOf, pointSegmentDistance, rectsOverlap, segmentRectDistance, segmentSegmentDistance, type Rect, type WorldPad } from "./geometry";
import { getPart } from "./library";
import { computeNets, netByTerminal, termKey, UnionFind } from "./netlist";
import type { CopperLayer, Design, Issue, Net, Trace, Vec, Via } from "./types";

type Item =
  | { kind: "pad"; key: string; pad: WorldPad; net?: string }
  | { kind: "trace"; key: string; trace: Trace }
  | { kind: "via"; key: string; via: Via };

const segs = (t: Trace): [Vec, Vec][] => t.points.slice(1).map((p, i) => [t.points[i], p]);

function onLayer(item: Item, layer: CopperLayer): boolean {
  if (item.kind === "pad") return item.pad.layers.includes(layer);
  if (item.kind === "trace") return item.trace.layer === layer;
  return true;
}

/** Distance between copper edges of two items on a shared layer (<= 0 means touching). */
function gap(a: Item, b: Item): number {
  if (a.kind === "trace" && b.kind !== "trace") return gap(b, a);
  if (a.kind === "via" && b.kind === "pad") return gap(b, a);
  if (a.kind === "pad" && b.kind === "pad") {
    const ra = padRect(a.pad);
    const rb = padRect(b.pad);
    const dx = Math.max(0, ra.x0 - rb.x1, rb.x0 - ra.x1);
    const dy = Math.max(0, ra.y0 - rb.y1, rb.y0 - ra.y1);
    return Math.hypot(dx, dy);
  }
  if (a.kind === "pad" && b.kind === "via") {
    const r = padRect(a.pad);
    return segmentRectDistance(b.via, b.via, r) - b.via.diameter / 2;
  }
  if (a.kind === "via" && b.kind === "via") return dist(a.via, b.via) - (a.via.diameter + b.via.diameter) / 2;
  if (a.kind === "pad" && b.kind === "trace") {
    const r = padRect(a.pad);
    return Math.min(...segs(b.trace).map(([p, q]) => segmentRectDistance(p, q, r))) - b.trace.width / 2;
  }
  if (a.kind === "via" && b.kind === "trace") {
    return Math.min(...segs(b.trace).map(([p, q]) => pointSegmentDistance(a.via, p, q))) - a.via.diameter / 2 - b.trace.width / 2;
  }
  if (a.kind === "trace" && b.kind === "trace") {
    let best = Infinity;
    for (const [p, q] of segs(a.trace)) for (const [r, s] of segs(b.trace)) best = Math.min(best, segmentSegmentDistance(p, q, r, s));
    return best - (a.trace.width + b.trace.width) / 2;
  }
  return Infinity;
}

const sharedLayers = (a: Item, b: Item): CopperLayer[] => (["top", "bottom"] as CopperLayer[]).filter((l) => onLayer(a, l) && onLayer(b, l));

export interface CopperAnalysis {
  nets: Net[];
  items: Item[];
  /** item key -> cluster root */
  clusterOf: Map<string, string>;
  /** cluster root -> net names of pads in it */
  clusterNets: Map<string, Set<string>>;
  /** Proximity pairs computed once, reused by DRC. */
  pairs: { a: Item; b: Item; gap: number }[];
}

export function analyzeCopper(design: Design, nets = computeNets(design)): CopperAnalysis {
  const netOf = netByTerminal(nets);
  const items: Item[] = [];
  for (const c of design.components) {
    padsOf(c).forEach((pad, i) => items.push({ kind: "pad", key: `pad:${c.id}:${i}`, pad, net: netOf.get(termKey({ comp: c.id, pin: pad.id })) }));
  }
  for (const t of design.traces) if (t.points.length >= 2) items.push({ kind: "trace", key: `trace:${t.id}`, trace: t });
  for (const v of design.vias) items.push({ kind: "via", key: `via:${v.id}`, via: v });

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
  const clusterOf = new Map<string, string>();
  const clusterNets = new Map<string, Set<string>>();
  for (const it of items) {
    const r = uf.find(it.key);
    clusterOf.set(it.key, r);
    if (!clusterNets.has(r)) clusterNets.set(r, new Set());
    if (it.kind === "pad" && it.net) clusterNets.get(r)!.add(it.net);
  }
  return { nets, items, clusterOf, clusterNets, pairs };
}

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

const itemLabel = (it: Item) => (it.kind === "pad" ? `${it.pad.ref} pad ${it.pad.id}` : it.kind === "trace" ? "trace" : "via");
const itemPos = (it: Item): Vec => (it.kind === "pad" ? it.pad.world : it.kind === "via" ? it.via : it.trace.points[0]);

export function runDrc(design: Design): Issue[] {
  const issues: Issue[] = [];
  const analysis = analyzeCopper(design);
  const board: Rect = { x0: 0, y0: 0, x1: design.board.width, y1: design.board.height };
  const clearance = design.board.clearance;

  // Shorts: a copper island that joins pads of different nets.
  for (const [root, nets] of analysis.clusterNets) {
    if (nets.size > 1) {
      const pad = analysis.items.find((it) => it.kind === "pad" && analysis.clusterOf.get(it.key) === root);
      issues.push({ severity: "error", code: "short", message: `Short circuit between nets ${[...nets].join(", ")}`, at: pad ? itemPos(pad) : undefined });
    }
  }

  // Clearance between copper that is not electrically connected.
  for (const { a, b, gap: g } of analysis.pairs) {
    if (g > 1e-6 && g < clearance && analysis.clusterOf.get(a.key) !== analysis.clusterOf.get(b.key)) {
      issues.push({
        severity: "error",
        code: "clearance",
        message: `Clearance violation (${g.toFixed(3)}mm < ${clearance}mm) between ${itemLabel(a)} and ${itemLabel(b)}`,
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
    if (r.x0 < board.x0 || r.y0 < board.y0 || r.x1 > board.x1 || r.y1 > board.y1) {
      issues.push({ severity: "error", code: "outside_board", message: `${c.ref} is outside the board outline (drag it onto the board or use Auto-place)`, at: { x: c.pcb.x, y: c.pcb.y }, refs: [c.ref] });
    }
  }
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      const bothTht = (c: typeof a) => getPart(c.partId)!.footprint!.pads.some((p) => p.drill);
      if (a.pcb.side !== b.pcb.side && !bothTht(a) && !bothTht(b)) continue;
      if (rectsOverlap(courtyardRect(a)!, courtyardRect(b)!)) {
        issues.push({ severity: "warning", code: "courtyard_overlap", message: `Courtyards of ${a.ref} and ${b.ref} overlap`, at: { x: a.pcb.x, y: a.pcb.y }, refs: [a.ref, b.ref] });
      }
    }
  }

  for (const t of design.traces) {
    if (t.width < 0.15) issues.push({ severity: "warning", code: "trace_width", message: `Trace width ${t.width}mm is below the 0.15mm manufacturing minimum`, at: t.points[0] });
    if (t.points.some((p) => p.x < board.x0 || p.y < board.y0 || p.x > board.x1 || p.y > board.y1)) {
      issues.push({ severity: "error", code: "trace_outside", message: "Trace runs outside the board outline", at: t.points[0] });
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
    if (n.terminals.length === 1 && phys.length === 1) {
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
  return issues;
}
