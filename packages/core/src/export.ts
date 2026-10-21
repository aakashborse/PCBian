// Manufacturing outputs: BOM, netlist, Gerber RS-274X and Excellon drill files.
import { courtyardRect, ovalAxis, padCorners, padsOf, toWorld, type WorldPad } from "./geometry";
import { getPart } from "./library";
import { computeNets } from "./netlist";
import { analyzeCopper, boardTeardrops, zoneFill } from "./copper";
import { boardOutline } from "./doc";
import { copperLayers, layerLabel, stackupOf, stackupThickness, viaKind, viaLayers } from "./stackup";
import { strokeText } from "./font";
import { fracture } from "./poly";
import { zonesInDrawOrder } from "./zones";
import type { ComponentData, CopperLayer, Design, Shape, Side, Vec, Via } from "./types";

export function bomCsv(design: Design): string {
  const groups = new Map<string, { refs: string[]; value: string; part: string; footprint: string; mpn: string }>();
  for (const c of design.components) {
    const part = getPart(c.partId);
    if (!part || part.kind !== "part" || !part.footprint || c.dnp) continue;
    const key = `${c.partId}|${c.value}`;
    if (!groups.has(key)) groups.set(key, { refs: [], value: c.value, part: part.name, footprint: part.footprint?.name ?? "", mpn: part.mpn ?? "" });
    groups.get(key)!.refs.push(c.ref);
  }
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const rows = [...groups.values()]
    .map((g) => ({ ...g, refs: g.refs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) }))
    .sort((a, b) => a.refs[0].localeCompare(b.refs[0], undefined, { numeric: true }))
    .map((g) => [g.refs.join(" "), String(g.refs.length), g.value, g.part, g.footprint, g.mpn].map(esc).join(","));
  return ["References,Qty,Value,Part,Footprint,MPN", ...rows].join("\n") + "\n";
}

export function netlistText(design: Design): string {
  const byId = new Map(design.components.map((c) => [c.id, c]));
  const lines: string[] = [`# PCBian netlist: ${design.name}`];
  for (const n of computeNets(design)) {
    const pins = n.terminals
      .filter((t) => getPart(byId.get(t.comp)!.partId)?.kind === "part")
      .map((t) => `${byId.get(t.comp)!.ref}.${t.pin}`);
    if (pins.length) lines.push(`${n.name}: ${pins.join(" ")}`);
  }
  return lines.join("\n") + "\n";
}

// ---------- Gerber ----------

class Gerber {
  private apertures = new Map<string, number>();
  private body: string[] = [];
  private current = -1;
  constructor(
    private fileFunction: string,
    private boardHeight: number,
  ) {}

  private fmt(v: number) {
    return Math.round(v * 1e6).toString();
  }
  private xy(p: Vec) {
    return `X${this.fmt(p.x)}Y${this.fmt(this.boardHeight - p.y)}`;
  }
  private select(def: string) {
    let code = this.apertures.get(def);
    if (code === undefined) {
      code = 10 + this.apertures.size;
      this.apertures.set(def, code);
    }
    if (code !== this.current) {
      this.body.push(`D${code}*`);
      this.current = code;
    }
  }

  flash(shape: "C" | "R" | "O", w: number, h: number, at: Vec) {
    this.select(shape === "C" ? `C,${w.toFixed(4)}` : `${shape},${w.toFixed(4)}X${h.toFixed(4)}`);
    this.body.push(`${this.xy(at)}D03*`);
  }

  /** A pad of the given size; angled pads become exact regions (rects) or stroked lines (ovals). */
  pad(p: Pick<WorldPad, "world" | "angle" | "shape">, w: number, h: number) {
    const shape = p.shape === "circle" ? "C" : p.shape === "oval" ? "O" : "R";
    const q = { world: p.world, ww: w, wh: h, angle: p.angle };
    if (!p.angle || shape === "C") this.flash(shape, w, h, p.world);
    else if (shape === "O") this.polyline(Math.min(w, h), ovalAxis(q));
    else this.region(padCorners(q));
  }

  /** Switch between dark (adds copper) and clear (removes copper) polarity. */
  polarity(dark: boolean) {
    this.body.push(dark ? "%LPD*%" : "%LPC*%");
  }

  region(pts: Vec[]) {
    if (pts.length < 3) return;
    this.body.push("G36*", `${this.xy(pts[0])}D02*`);
    for (const p of [...pts.slice(1), pts[0]]) this.body.push(`${this.xy(p)}D01*`);
    this.body.push("G37*");
  }

  polyline(width: number, pts: Vec[]) {
    if (pts.length < 2) return;
    this.select(`C,${width.toFixed(4)}`);
    this.body.push(`${this.xy(pts[0])}D02*`);
    for (const p of pts.slice(1)) this.body.push(`${this.xy(p)}D01*`);
  }

  toString() {
    const head = ["%TF.GenerationSoftware,PCBian,0.1*%", `%TF.FileFunction,${this.fileFunction}*%`, "%FSLAX46Y46*%", "%MOMM*%", "%LPD*%"];
    const defs = [...this.apertures].map(([def, code]) => `%ADD${code}${def}*%`);
    return [...head, ...defs, "G01*", ...this.body, "M02*", ""].join("\n");
  }
}

const circlePts = (c: Vec, r: number, n = 24): Vec[] => Array.from({ length: n + 1 }, (_, i) => ({ x: c.x + r * Math.cos((2 * Math.PI * i) / n), y: c.y + r * Math.sin((2 * Math.PI * i) / n) }));

export function silkPolylines(shape: Shape, comp: ComponentData): Vec[][] {
  const mirror = comp.pcb.side === "bottom";
  const w = (p: Vec) => toWorld(p, comp.pcb, mirror);
  switch (shape.kind) {
    case "line":
      return [shape.points.map(w)];
    case "polygon":
      return [[...shape.points, shape.points[0]].map(w)];
    case "rect": {
      const { x, y, w: rw, h } = shape;
      return [[{ x, y }, { x: x + rw, y }, { x: x + rw, y: y + h }, { x, y: y + h }, { x, y }].map(w)];
    }
    case "circle":
      return [circlePts({ x: shape.x, y: shape.y }, shape.r).map(w)];
    default:
      return [];
  }
}

/** Gerber file naming in the usual Protel/KiCad style: gtl, g2, g3 … gbl. */
const layerFile = (l: CopperLayer): { tag: string; ext: string } =>
  l === "top" ? { tag: "F_Cu", ext: "gtl" } : l === "bottom" ? { tag: "B_Cu", ext: "gbl" } : { tag: `In${l.slice(2)}_Cu`, ext: `g${Number(l.slice(2)) + 1}` };

export function gerberFiles(design: Design): Record<string, string> {
  const H = design.board.height;
  const files: Record<string, string> = {};
  const parts = design.components.filter((c) => getPart(c.partId)?.footprint && !c.dnp);
  const allParts = design.components.filter((c) => getPart(c.partId)?.footprint);
  const layers = copperLayers(design.board);
  const analysis = design.zones.length || design.board.teardrops ? analyzeCopper(design) : null;
  const drops = analysis ? boardTeardrops(design, analysis) : [];

  layers.forEach((layer, i) => {
    const pos = i === 0 ? "Top" : i === layers.length - 1 ? "Bot" : "Inr";
    const cu = new Gerber(`Copper,L${i + 1},${pos}`, H);
    // Pours first, as plain dark regions (holes joined to their outline by cut-ins).
    for (const z of zonesInDrawOrder(design, layer)) for (const island of zoneFill(design, z, analysis!).polygons) cu.region(fracture(island));
    for (const td of drops.filter((t) => t.layer === layer)) cu.region(td.points);
    for (const c of allParts) {
      for (const p of padsOf(c)) {
        if (!p.layers.includes(layer)) continue;
        cu.pad(p, p.ww, p.wh);
      }
    }
    for (const t of design.traces) if (t.layer === layer) cu.polyline(t.width, t.points);
    for (const v of design.vias) if (viaLayers(design.board, v).includes(layer)) cu.flash("C", v.diameter, v.diameter, v);
    files[`${design.name}-${layerFile(layer).tag}.${layerFile(layer).ext}`] = cu.toString();
  });

  for (const side of ["top", "bottom"] as Side[]) {
    const tag = side === "top" ? "F" : "B";
    const mask = new Gerber(`Soldermask,${side === "top" ? "Top" : "Bot"}`, H);
    const silk = new Gerber(`Legend,${side === "top" ? "Top" : "Bot"}`, H);
    const paste = new Gerber(`Paste,${side === "top" ? "Top" : "Bot"}`, H);
    for (const c of allParts) {
      for (const p of padsOf(c)) {
        if (!p.layers.includes(side)) continue;
        mask.pad(p, p.ww + 0.1, p.wh + 0.1);
        if (!p.drill && parts.includes(c)) paste.pad(p, p.ww * 0.9, p.wh * 0.9);
      }
      if (c.pcb.side === side) {
        for (const s of getPart(c.partId)!.footprint!.silk) for (const pl of silkPolylines(s, c)) silk.polyline(0.15, pl);
        const r = courtyardRect(c)!;
        for (const stroke of strokeText(c.ref, { x: c.pcb.x, y: r.y0 - 0.9 }, 0.8, side === "bottom")) silk.polyline(0.12, stroke);
      }
    }
    // Clip silkscreen away from exposed copper.
    silk.polarity(false);
    for (const c of allParts) for (const p of padsOf(c)) if (p.layers.includes(side)) silk.pad({ ...p, shape: p.shape === "circle" ? "circle" : "rect" }, p.ww + 0.2, p.wh + 0.2);
    silk.polarity(true);
    files[`${design.name}-${tag}_Mask.${side === "top" ? "gts" : "gbs"}`] = mask.toString();
    files[`${design.name}-${tag}_Silkscreen.${side === "top" ? "gto" : "gbo"}`] = silk.toString();
    files[`${design.name}-${tag}_Paste.${side === "top" ? "gtp" : "gbp"}`] = paste.toString();
  }

  const edge = new Gerber("Profile,NP", H);
  for (const poly of [boardOutline(design.board), ...(design.board.cutouts ?? [])]) edge.polyline(0.1, [...poly, poly[0]]);
  files[`${design.name}-Edge_Cuts.gm1`] = edge.toString();
  Object.assign(files, drillFiles(design));
  files[`${design.name}-fab-notes.txt`] = fabNotes(design);
  return files;
}

export function fabNotes(design: Design): string {
  const b = design.board;
  const holes = new Set<string>();
  for (const c of design.components) for (const p of padsOf(c)) if (p.drill) holes.add(p.drill.toFixed(2));
  for (const v of design.vias) holes.add(v.drill.toFixed(2));
  return [
    `PCBian fabrication notes: ${design.name}`,
    `Board size: ${b.width} x ${b.height} mm, ${b.layers} copper layers, ${b.thickness} mm FR-4`,
    `Minimum trace/space: ${Math.min(b.defaultTraceWidth, ...design.netClasses.map((c) => c.traceWidth))} / ${Math.min(b.clearance, ...design.netClasses.map((c) => c.clearance))} mm`,
    `Drill sizes: ${[...holes].sort().join(", ") || "none"} mm`,
    `Finish: HASL lead-free (default), green soldermask, white silkscreen`,
    `Layer stack (top to bottom):`,
    ...stackupLines(b),
    ...viaSpanLines(design),
    ...(design.diffPairs.length || design.netClasses.some((c) => c.impedance) ? ["Controlled impedance: see net classes / differential pairs; fabricator to adjust widths to meet targets within ±10%"] : []),
    "",
  ].join("\n");
}

function stackupLines(b: Design["board"]): string[] {
  const s = stackupOf(b);
  const layers = copperLayers(b);
  const out: string[] = [];
  layers.forEach((l, i) => {
    out.push(`  L${i + 1} ${layerLabel(l)}: ${s.copperOz[i]} oz copper`);
    const d = s.dielectrics[i];
    if (d) out.push(`     ${d.kind} ${d.thickness.toFixed(3)} mm, er ${d.er}`);
  });
  out.push(`  Total ≈ ${stackupThickness(s).toFixed(2)} mm (nominal ${b.thickness} mm)`);
  return out;
}

function viaSpanLines(design: Design): string[] {
  const spans = new Map<string, number>();
  for (const v of design.vias) {
    const k = viaKind(design.board, v);
    if (k === "through") continue;
    const span = viaLayers(design.board, v);
    const key = `${k} via ${layerLabel(span[0])} - ${layerLabel(span[span.length - 1])}`;
    spans.set(key, (spans.get(key) ?? 0) + 1);
  }
  return [...spans].map(([k, n]) => `${k[0].toUpperCase() + k.slice(1)}: ${n}`);
}

/** Excellon drill files: one for through holes, plus one per blind/buried/micro via span. */
export function drillFiles(design: Design): Record<string, string> {
  const files: Record<string, string> = { [`${design.name}.drl`]: excellon(design) };
  const all = copperLayers(design.board);
  const spans = new Map<string, Via[]>();
  for (const v of design.vias) {
    if (viaKind(design.board, v) === "through") continue;
    const span = viaLayers(design.board, v);
    const key = `L${all.indexOf(span[0]) + 1}-L${all.indexOf(span[span.length - 1]) + 1}`;
    if (!spans.has(key)) spans.set(key, []);
    spans.get(key)!.push(v);
  }
  for (const [key, vias] of spans) files[`${design.name}-${key}.drl`] = excellon(design, vias, key);
  return files;
}

/** Excellon for the through holes (pads and through vias), or for a given set of span vias. */
export function excellon(design: Design, only?: Via[], span?: string): string {
  const holes = new Map<string, Vec[]>();
  const add = (d: number, p: Vec) => {
    const k = d.toFixed(3);
    if (!holes.has(k)) holes.set(k, []);
    holes.get(k)!.push(p);
  };
  if (only) for (const v of only) add(v.drill, v);
  else {
    for (const c of design.components) for (const p of padsOf(c)) if (p.drill) add(p.drill, p.world);
    for (const v of design.vias) if (viaKind(design.board, v) === "through") add(v.drill, v);
  }
  const H = design.board.height;
  const tools = [...holes.keys()];
  const out = ["M48", `; ${span ? `Layer pair ${span}` : "Plated through holes"}`, "METRIC,TZ", ...tools.map((d, i) => `T${i + 1}C${d}`), "%", "G90", "G05"];
  tools.forEach((d, i) => {
    out.push(`T${i + 1}`);
    for (const p of holes.get(d)!) out.push(`X${p.x.toFixed(3)}Y${(H - p.y).toFixed(3)}`);
  });
  out.push("M30", "");
  return out.join("\n");
}

/** Pick-and-place (centroid) file for assembly. */
export function pickAndPlaceCsv(design: Design): string {
  const rows = design.components
    .filter((c) => getPart(c.partId)?.footprint)
    .map((c) => [c.ref, c.value, getPart(c.partId)!.footprint!.name, c.pcb.x.toFixed(3), (design.board.height - c.pcb.y).toFixed(3), String(c.pcb.rot), c.pcb.side].join(","));
  return ["Ref,Val,Package,PosX,PosY,Rot,Side", ...rows].join("\n") + "\n";
}
