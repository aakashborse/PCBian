// Power integrity: DC IR drop across a power net's copper (traces, vias and pours as a resistor
// network solved for the load currents), current capacity of its traces, and decoupling-capacitor
// placement next to IC power pins.
import { analyzeCopper, type CopperAnalysis, type CopperItem } from "./copper";
import { padDistance, padsOf, pointInPolygon, pointSegmentDistance, type WorldPad } from "./geometry";
import { allPins, getPart } from "./library";
import { netByTerminal } from "./netlist";
import { isGroundNet, railVoltage } from "./sim";
import { copperLayers, OZ_MM, stackupOf, viaLayers } from "./stackup";
import type { CopperLayer, Design, Issue, Vec } from "./types";

/** Copper resistivity at 20 °C (ohm mm). */
const RHO = 1.72e-5;
/** Via barrel plating thickness (mm). */
const PLATING = 0.025;

export interface IrLoad {
  ref: string;
  /** Pin on the net (default: every pin of the part on the net, sharing the current). */
  pin?: string;
  current: number;
}

export interface IrDropOptions {
  /** Where the net is fed: a part pin ("U1.3" or a ref, using its pins on the net). */
  source: string;
  loads: IrLoad[];
  /** Pour mesh pitch (mm); default chosen from the board size. */
  pitch?: number;
  /** Allowed trace temperature rise for the current-capacity check (°C); default 10. */
  tempRise?: number;
}

export interface IrDropResult {
  ok: boolean;
  error?: string;
  net: string;
  /** Nominal net voltage from its name (e.g. +3V3), when it has one. */
  nominal: number | null;
  loads: { ref: string; pin: string; current: number; drop: number; voltage: number | null }[];
  maxDrop: number;
  /** Traces carrying more than their IPC-2221 capacity for the temperature rise. */
  hotTraces: { id: string; layer: CopperLayer; width: number; current: number; capacity: number }[];
  /** Total copper resistance seen from the source by the summed load (ohms). */
  nodes: number;
  issues: Issue[];
}

/** IPC-2221 trace current capacity: I = k * dT^0.44 * A^0.725 (A in square mils; k = 0.048 outer, 0.024 inner). */
export function traceCapacity(width: number, thickness: number, outer: boolean, tempRise = 10): number {
  const area = (width / 0.0254) * (thickness / 0.0254);
  return (outer ? 0.048 : 0.024) * tempRise ** 0.44 * area ** 0.725;
}

/** Sparse conductance network: nodes, edges, then solved for node voltages by CG. */
class Network {
  edges: { a: number; b: number; g: number; tag?: string }[] = [];
  size = 0;
  node() {
    return this.size++;
  }
  connect(a: number, b: number, g: number, tag?: string) {
    if (a !== b && g > 0 && Number.isFinite(g)) this.edges.push({ a, b, g, tag });
  }
  /** Voltages with `fixed` held at 0 and `inject` currents (A) drawn out of nodes. */
  solve(fixed: number, draw: Map<number, number>): Float64Array | null {
    const n = this.size;
    const adj: { n: number; g: number }[][] = Array.from({ length: n }, () => []);
    const diag = new Float64Array(n);
    for (const e of this.edges) {
      adj[e.a].push({ n: e.b, g: e.g });
      adj[e.b].push({ n: e.a, g: e.g });
      diag[e.a] += e.g;
      diag[e.b] += e.g;
    }
    const b = new Float64Array(n);
    for (const [k, i] of draw) b[k] -= i;
    const free = (k: number) => k !== fixed;
    const x = new Float64Array(n);
    const r = Float64Array.from(b);
    r[fixed] = 0;
    const z = new Float64Array(n);
    const p = new Float64Array(n);
    const Ap = new Float64Array(n);
    let rz = 0;
    for (let k = 0; k < n; k++) {
      if (!free(k) || !diag[k]) continue;
      z[k] = r[k] / diag[k];
      p[k] = z[k];
      rz += r[k] * z[k];
    }
    const bn = b.reduce((s, v) => s + v * v, 0);
    for (let it = 0; it < 20000 && rz > 0; it++) {
      let pAp = 0;
      for (let k = 0; k < n; k++) {
        if (!free(k)) continue;
        let s = diag[k] * p[k];
        for (const e of adj[k]) if (free(e.n)) s -= e.g * p[e.n];
        Ap[k] = s;
        pAp += p[k] * s;
      }
      if (pAp <= 0) break;
      const alpha = rz / pAp;
      let rr = 0;
      let rzn = 0;
      for (let k = 0; k < n; k++) {
        if (!free(k)) continue;
        x[k] += alpha * p[k];
        r[k] -= alpha * Ap[k];
        rr += r[k] * r[k];
        z[k] = diag[k] ? r[k] / diag[k] : 0;
        rzn += r[k] * z[k];
      }
      if (rr < 1e-24 * Math.max(bn, 1e-30)) break;
      const beta = rzn / rz;
      rz = rzn;
      for (let k = 0; k < n; k++) if (free(k)) p[k] = z[k] + beta * p[k];
    }
    // A load on copper that never reaches the source cannot be solved.
    for (const [k] of draw) if (!Number.isFinite(x[k])) return null;
    return x;
  }
}

/** DC voltage drop from a source to loads across one net's copper. */
export function irDrop(design: Design, net: string, opts: IrDropOptions, analysis: CopperAnalysis = analyzeCopper(design)): IrDropResult {
  const fail = (error: string): IrDropResult => ({ ok: false, error, net, nominal: railVoltage(net), loads: [], maxDrop: 0, hotTraces: [], nodes: 0, issues: [] });
  const s = stackupOf(design.board);
  const layers = copperLayers(design.board);
  const thick = (l: CopperLayer) => s.copperOz[layers.indexOf(l)] * OZ_MM;
  const on = (it: CopperItem) => analysis.netOfItem(it) === net;
  const items = analysis.items.filter(on);
  const pads = items.filter((it): it is Extract<CopperItem, { kind: "pad" }> => it.kind === "pad").map((it) => it.pad);
  const traces = items.filter((it): it is Extract<CopperItem, { kind: "trace" }> => it.kind === "trace").map((it) => it.trace);
  const vias = items.filter((it): it is Extract<CopperItem, { kind: "via" }> => it.kind === "via");
  const zones = design.zones.filter((z) => z.net === net && analysis.fills.get(z.id)?.polygons.length);
  if (!pads.length) return fail(`${net} has no pads`);

  const nw = new Network();
  // Pads: one node per copper layer they are on (through-hole barrels join them).
  const padNode = new Map<WorldPad, Map<CopperLayer, number>>();
  for (const p of pads) {
    const m = new Map<CopperLayer, number>();
    for (const l of p.layers.filter((l) => layers.includes(l))) m.set(l, nw.node());
    const ls = [...m.values()];
    for (let i = 1; i < ls.length; i++) nw.connect(ls[i - 1], ls[i], 1e6);
    padNode.set(p, m);
  }
  // Vias: a node per layer, barrel segments between consecutive layers.
  const viaNode = new Map<string, Map<CopperLayer, number>>();
  for (const it of vias) {
    const v = it.via;
    const span = viaLayers(design.board, v);
    const m = new Map<CopperLayer, number>(span.map((l) => [l, nw.node()]));
    const area = Math.PI * (v.drill + PLATING) * PLATING;
    for (let i = 1; i < span.length; i++) {
      const len = s.dielectrics[layers.indexOf(span[i - 1])]?.thickness ?? 0.2;
      nw.connect(m.get(span[i - 1])!, m.get(span[i])!, area / (RHO * len), "via");
    }
    viaNode.set(v.id, m);
  }

  // Attachment points on each layer: pads, vias and trace ends, used to split traces into pieces.
  type Anchor = { at: Vec; node: number; r: number };
  const anchors = new Map<CopperLayer, Anchor[]>();
  const anchor = (l: CopperLayer, a: Anchor) => (anchors.get(l) ?? anchors.set(l, []).get(l)!).push(a);
  for (const [p, m] of padNode) for (const [l, k] of m) anchor(l, { at: p.world, node: k, r: Math.min(p.ww, p.wh) / 2 });
  for (const it of vias) for (const [l, k] of viaNode.get(it.via.id)!) anchor(l, { at: it.via, node: k, r: it.via.diameter / 2 });

  // Traces: nodes at every vertex and wherever something attaches mid-segment.
  const vertexNode = new Map<string, number>();
  const vkey = (l: CopperLayer, p: Vec) => `${l}:${Math.round(p.x * 1000)}:${Math.round(p.y * 1000)}`;
  const vertex = (l: CopperLayer, p: Vec) => {
    const k = vkey(l, p);
    if (!vertexNode.has(k)) vertexNode.set(k, nw.node());
    return vertexNode.get(k)!;
  };
  for (const t of traces) for (const p of t.points) anchor(t.layer, { at: p, node: vertex(t.layer, p), r: t.width / 2 });
  for (const t of traces) {
    const G = (len: number) => (t.width * thick(t.layer)) / (RHO * Math.max(len, 1e-4));
    for (let i = 1; i < t.points.length; i++) {
      const a = t.points[i - 1];
      const b = t.points[i];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      // Anything touching the segment's centreline splits it there.
      const cuts = (anchors.get(t.layer) ?? [])
        .filter((x) => pointSegmentDistance(x.at, a, b) <= Math.max(x.r, t.width / 2) + 1e-6)
        .map((x) => ({ x, f: L > 0 ? Math.max(0, Math.min(1, ((x.at.x - a.x) * (b.x - a.x) + (x.at.y - a.y) * (b.y - a.y)) / (L * L))) : 0 }))
        .sort((p, q) => p.f - q.f);
      let prev = { node: vertex(t.layer, a), f: 0 };
      for (const c of cuts) {
        if (c.x.node === prev.node) continue;
        const len = (c.f - prev.f) * L;
        nw.connect(prev.node, c.x.node, G(len), len > 1e-6 ? `trace:${t.id}` : undefined);
        prev = { node: c.x.node, f: c.f };
      }
      const nb = vertex(t.layer, b);
      if (prev.node !== nb) nw.connect(prev.node, nb, G((1 - prev.f) * L), `trace:${t.id}`);
    }
  }

  // Pours: a square mesh over each fill; anchors inside join their cell.
  const pitch = opts.pitch ?? Math.max(0.25, Math.sqrt((design.board.width * design.board.height) / 15000));
  for (const z of zones) {
    const fill = analysis.fills.get(z.id)!;
    const sheet = thick(z.layer) / RHO; // conductance of one square
    const inFill = (p: Vec) => fill.polygons.some((isl) => pointInPolygon(p, isl[0]) && !isl.slice(1).some((h) => pointInPolygon(p, h)));
    const cells = new Map<string, number>();
    const nx = Math.ceil(design.board.width / pitch) + 1;
    const ny = Math.ceil(design.board.height / pitch) + 1;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = { x: (i + 0.5) * pitch, y: (j + 0.5) * pitch };
        if (inFill(c)) cells.set(`${i},${j}`, nw.node());
      }
    for (const [key, k] of cells) {
      const [i, j] = key.split(",").map(Number);
      const e = cells.get(`${i + 1},${j}`);
      const n = cells.get(`${i},${j + 1}`);
      if (e !== undefined) nw.connect(k, e, sheet);
      if (n !== undefined) nw.connect(k, n, sheet);
    }
    for (const a of anchors.get(z.layer) ?? []) {
      const i = Math.floor(a.at.x / pitch);
      const j = Math.floor(a.at.y / pitch);
      const k = cells.get(`${i},${j}`);
      // Pad/via to pour: about one square of spreading resistance.
      if (k !== undefined) nw.connect(a.node, k, sheet * 2);
    }
  }

  // Source and loads.
  const pinPads = (spec: string): WorldPad[] => {
    const [ref, pin] = spec.includes(".") ? spec.split(".") : [spec, undefined];
    return pads.filter((p) => p.ref === ref && (!pin || p.id === pin));
  };
  const firstNode = (p: WorldPad) => [...padNode.get(p)!.values()][0];
  const src = pinPads(opts.source);
  if (!src.length) return fail(`${opts.source} has no pad on ${net}`);
  const srcNode = nw.node();
  for (const p of src) nw.connect(srcNode, firstNode(p), 1e6);
  const draw = new Map<number, number>();
  const loadPads: { ref: string; pin: string; node: number; current: number }[] = [];
  for (const l of opts.loads) {
    const lp = pinPads(l.pin ? `${l.ref}.${l.pin}` : l.ref);
    if (!lp.length) return fail(`${l.ref}${l.pin ? `.${l.pin}` : ""} has no pad on ${net}`);
    for (const p of lp) {
      const k = firstNode(p);
      draw.set(k, (draw.get(k) ?? 0) + l.current / lp.length);
      loadPads.push({ ref: p.ref, pin: p.id, node: k, current: l.current / lp.length });
    }
  }
  // Nodes that reach neither the source nor a load (stray copper) are tied weakly to the source.
  for (let k = 0; k < nw.size; k++) nw.connect(k, srcNode, 1e-12);
  const v = nw.solve(srcNode, draw);
  if (!v) return fail("the network could not be solved");
  const nominal = railVoltage(net);
  const loads = loadPads.map((l) => ({ ref: l.ref, pin: l.pin, current: l.current, drop: -v[l.node], voltage: nominal === null ? null : nominal + v[l.node] }));
  // Current in each trace: the largest through any of its pieces.
  const traceI = new Map<string, number>();
  for (const e of nw.edges) if (e.tag?.startsWith("trace:")) traceI.set(e.tag.slice(6), Math.max(traceI.get(e.tag.slice(6)) ?? 0, Math.abs(v[e.a] - v[e.b]) * e.g));
  const dT = opts.tempRise ?? 10;
  const hotTraces = traces
    .map((t) => ({ id: t.id, layer: t.layer, width: t.width, current: traceI.get(t.id) ?? 0, capacity: traceCapacity(t.width, thick(t.layer), t.layer === "top" || t.layer === "bottom", dT) }))
    .filter((t) => t.current > t.capacity);
  const maxDrop = Math.max(0, ...loads.map((l) => l.drop));
  const issues: Issue[] = [];
  for (const l of loads)
    if (nominal && l.drop > 0.03 * Math.abs(nominal)) issues.push({ severity: "warning", code: "ir-drop", message: `${l.ref}.${l.pin} on ${net} sees ${(l.drop * 1000).toFixed(0)} mV drop (${((l.drop / Math.abs(nominal)) * 100).toFixed(1)}% of ${nominal} V) at ${l.current} A` });
  for (const t of hotTraces) issues.push({ severity: "warning", code: "current", message: `A ${t.width}mm ${net} trace on ${t.layer} carries ${t.current.toFixed(2)} A, above its ${t.capacity.toFixed(2)} A capacity for a ${dT}°C rise` });
  return { ok: true, net, nominal, loads, maxDrop, hotTraces, nodes: nw.size, issues };
}

export interface DecouplingResult {
  /** IC power pins and their nearest decoupling capacitor (pad-to-pad distance, mm). */
  pins: { ref: string; pin: string; net: string; cap?: string; distance?: number }[];
  issues: Issue[];
}

/**
 * Decoupling: every power pin of an IC (a part with 5+ pins) should have a capacitor between its
 * net and ground close by. Reports the nearest one per pin.
 */
export function decouplingCheck(design: Design, maxDistance = 3): DecouplingResult {
  const nets = netByTerminal(analyzeCopper(design).nets);
  const caps = design.components.filter((c) => /^capacitor|^cap/i.test(c.partId) && !c.dnp);
  const capNets = caps.map((c) => {
    const pins = allPins(getPart(c.partId)!).map((p) => nets.get(`${c.id}:${p.id}`) ?? "");
    return { c, pins, pads: padsOf(c) };
  });
  const pins: DecouplingResult["pins"] = [];
  const issues: Issue[] = [];
  for (const c of design.components) {
    const part = getPart(c.partId);
    if (!part?.footprint || part.kind !== "part" || allPins(part).length < 5 || c.dnp) continue;
    const pads = padsOf(c);
    for (const pin of allPins(part)) {
      const net = nets.get(`${c.id}:${pin.id}`);
      if (!net || isGroundNet(net)) continue;
      const power = pin.type === "power_in" || railVoltage(net) !== null;
      if (!power) continue;
      const pad = pads.find((p) => p.id === pin.id);
      if (!pad) continue;
      let best: { cap: string; distance: number } | undefined;
      for (const k of capNets) {
        const i = k.pins.indexOf(net);
        if (i < 0 || !k.pins.some((n, j) => j !== i && isGroundNet(n))) continue;
        const cp = k.pads.find((p) => p.id === allPins(getPart(k.c.partId)!)[i].id);
        if (!cp) continue;
        const d = Math.max(0, padDistance(pad, cp.world) - Math.min(cp.ww, cp.wh) / 2);
        if (!best || d < best.distance) best = { cap: k.c.ref, distance: d };
      }
      pins.push({ ref: c.ref, pin: pin.id, net, ...(best ? { cap: best.cap, distance: Math.round(best.distance * 100) / 100 } : {}) });
      if (!best) issues.push({ severity: "warning", code: "decoupling", message: `${c.ref} pin ${pin.id} (${net}) has no decoupling capacitor to ground`, refs: [c.ref], at: pad.world });
      else if (best.distance > maxDistance) issues.push({ severity: "warning", code: "decoupling", message: `${c.ref} pin ${pin.id} (${net}): nearest decoupling capacitor ${best.cap} is ${best.distance.toFixed(1)}mm away (keep it within ${maxDistance}mm)`, refs: [c.ref, best.cap], at: pad.world });
    }
  }
  return { pins, issues };
}
