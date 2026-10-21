// Ordered, polarity-aware layer features shared by the IPC-2581 and ODB++ writers.
// The order mirrors the Gerber writer: pours (dark outline, clear cut-outs, dark spokes, clear
// clip and removed islands), teardrops, pads, traces, vias.
import { analyzeCopper, boardTeardrops, zoneFill } from "./copper";
import { silkPolylines } from "./export";
import { strokeText } from "./font";
import { courtyardRect, ovalAxis, padCorners, padsOf, type WorldPad } from "./geometry";
import { getPart } from "./library";
import { netByTerminal, termKey } from "./netlist";
import { copperLayers, viaKind, viaLayers } from "./stackup";
import { zonesInDrawOrder } from "./zones";
import type { CopperLayer, Design, Side, Vec } from "./types";

export type Feature =
  | { kind: "surface"; points: Vec[]; holes?: Vec[][]; dark: boolean; net?: string }
  | { kind: "line"; points: Vec[]; width: number; dark: boolean; net?: string }
  | { kind: "pad"; shape: "rect" | "circle" | "oval"; at: Vec; w: number; h: number; dark: boolean; net?: string; ref?: string; pin?: string };

export interface Hole {
  at: Vec;
  diameter: number;
  plated: boolean;
  net?: string;
  via?: boolean;
}

export interface FabData {
  copper: { layer: CopperLayer; features: Feature[] }[];
  mask: Record<Side, Feature[]>;
  paste: Record<Side, Feature[]>;
  silk: Record<Side, Feature[]>;
  /** Drill sets: "through" plus one per blind/buried span (from/to layer indices, 0-based). */
  drills: { name: string; from: number; to: number; holes: Hole[] }[];
}

const circle = (c: Vec, r: number, n = 24): Vec[] => Array.from({ length: n }, (_, i) => ({ x: c.x + r * Math.cos((2 * Math.PI * i) / n), y: c.y + r * Math.sin((2 * Math.PI * i) / n) }));

/** A pad feature of the given size; angled pads become exact surfaces (rects) or round lines (ovals). */
function padFeature(p: WorldPad, w: number, h: number, dark: boolean, extra: { net?: string; ref?: string; pin?: string } = {}, shape: WorldPad["shape"] = p.shape): Feature {
  const q = { world: p.world, ww: w, wh: h, angle: p.angle };
  if (!p.angle || shape === "circle") return { kind: "pad", shape, at: p.world, w, h, dark, ...extra };
  if (shape === "oval") return { kind: "line", points: ovalAxis(q), width: Math.min(w, h), dark, net: extra.net };
  return { kind: "surface", points: padCorners(q), dark, net: extra.net };
}

export function fabData(design: Design): FabData {
  const analysis = analyzeCopper(design);
  const netOf = netByTerminal(analysis.nets);
  const layers = copperLayers(design.board);
  const parts = design.components.filter((c) => getPart(c.partId)?.footprint);
  const drops = design.board.teardrops ? boardTeardrops(design, analysis) : [];
  const traceNet = new Map<string, string | undefined>();
  const viaNet = new Map<string, string | undefined>();
  for (const it of analysis.items) {
    if (it.kind === "trace") traceNet.set(it.trace.id, analysis.netOfItem(it));
    if (it.kind === "via") viaNet.set(it.via.id, analysis.netOfItem(it));
  }
  const copper = layers.map((layer) => {
    const f: Feature[] = [];
    for (const z of zonesInDrawOrder(design, layer)) {
      // Pours are plain copper islands (with holes), so the layer image needs no clear polarity.
      for (const island of zoneFill(design, z, analysis).polygons) f.push({ kind: "surface", points: island[0], holes: island.slice(1), dark: true, net: z.net });
    }
    for (const td of drops.filter((t) => t.layer === layer)) f.push({ kind: "surface", points: td.points, dark: true });
    for (const c of parts)
      for (const p of padsOf(c)) if (p.layers.includes(layer)) f.push(padFeature(p, p.ww, p.wh, true, { net: netOf.get(termKey({ comp: c.id, pin: p.id })), ref: c.ref, pin: p.id }));
    for (const t of design.traces) if (t.layer === layer) f.push({ kind: "line", points: t.points, width: t.width, dark: true, net: traceNet.get(t.id) });
    for (const v of design.vias) if (viaLayers(design.board, v).includes(layer)) f.push({ kind: "pad", shape: "circle", at: v, w: v.diameter, h: v.diameter, dark: true, net: viaNet.get(v.id) });
    return { layer, features: f };
  });

  const side = (s: Side) => {
    const mask: Feature[] = [];
    const paste: Feature[] = [];
    const silk: Feature[] = [];
    for (const c of parts) {
      for (const p of padsOf(c)) {
        if (!p.layers.includes(s)) continue;
        mask.push(padFeature(p, p.ww + 0.1, p.wh + 0.1, true));
        if (!p.drill && !c.dnp) paste.push(padFeature(p, p.ww * 0.9, p.wh * 0.9, true));
      }
      if (c.pcb.side === s) {
        for (const sh of getPart(c.partId)!.footprint!.silk) for (const pl of silkPolylines(sh, c)) silk.push({ kind: "line", points: pl, width: 0.15, dark: true });
        const r = courtyardRect(c)!;
        for (const stroke of strokeText(c.ref, { x: c.pcb.x, y: r.y0 - 0.9 }, 0.8, s === "bottom")) silk.push({ kind: "line", points: stroke, width: 0.12, dark: true });
      }
    }
    // Silkscreen never prints on exposed copper.
    for (const c of parts) for (const p of padsOf(c)) if (p.layers.includes(s)) silk.push(padFeature(p, p.ww + 0.2, p.wh + 0.2, false, {}, p.shape === "circle" ? "circle" : "rect"));
    return { mask, paste, silk };
  };
  const top = side("top");
  const bottom = side("bottom");

  const through: Hole[] = [];
  for (const c of parts) for (const p of padsOf(c)) if (p.drill) through.push({ at: p.world, diameter: p.drill, plated: !/MOUNT|HOLE/i.test(getPart(c.partId)!.footprint!.name) || p.ww > p.drill + 0.05, net: netOf.get(termKey({ comp: c.id, pin: p.id })) });
  const drills: FabData["drills"] = [{ name: "drill", from: 0, to: layers.length - 1, holes: through }];
  for (const v of design.vias) {
    const span = viaLayers(design.board, v);
    const from = layers.indexOf(span[0]);
    const to = layers.indexOf(span[span.length - 1]);
    const name = viaKind(design.board, v) === "through" ? "drill" : `drill_${from + 1}-${to + 1}`;
    let set = drills.find((d) => d.name === name);
    if (!set) drills.push((set = { name, from, to, holes: [] }));
    set.holes.push({ at: v, diameter: v.drill, plated: true, net: viaNet.get(v.id), via: true });
  }
  return { copper, mask: { top: top.mask, bottom: bottom.mask }, paste: { top: top.paste, bottom: bottom.paste }, silk: { top: top.silk, bottom: bottom.silk }, drills };
}

/** Outline points of a pad-like feature (for formats that need explicit polygons). */
export function padOutline(f: Extract<Feature, { kind: "pad" }>): Vec[] {
  if (f.shape === "circle") return circle(f.at, f.w / 2);
  const { x, y } = f.at;
  const hw = f.w / 2;
  const hh = f.h / 2;
  return [
    { x: x - hw, y: y - hh },
    { x: x + hw, y: y - hh },
    { x: x + hw, y: y + hh },
    { x: x - hw, y: y + hh },
  ];
}
