// Manufacturing outputs: BOM, netlist, Gerber RS-274X and Excellon drill files.
import { courtyardRect, padsOf, toWorld } from "./geometry";
import { getPart } from "./library";
import { computeNets } from "./netlist";
import { analyzeCopper, zoneCutouts } from "./copper";
import { copperLayers } from "./doc";
import { strokeText } from "./font";
import type { ComponentData, CopperLayer, Design, Shape, Side, Vec } from "./types";

export function bomCsv(design: Design): string {
  const groups = new Map<string, { refs: string[]; value: string; part: string; footprint: string; mpn: string }>();
  for (const c of design.components) {
    const part = getPart(c.partId);
    if (!part || part.kind !== "part" || c.dnp) continue;
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

function silkPolylines(shape: Shape, comp: ComponentData): Vec[][] {
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

const LAYER_FILE: Record<CopperLayer, { tag: string; ext: string }> = {
  top: { tag: "F_Cu", ext: "gtl" },
  in1: { tag: "In1_Cu", ext: "g2" },
  in2: { tag: "In2_Cu", ext: "g3" },
  bottom: { tag: "B_Cu", ext: "gbl" },
};

export function gerberFiles(design: Design): Record<string, string> {
  const H = design.board.height;
  const files: Record<string, string> = {};
  const parts = design.components.filter((c) => getPart(c.partId)?.footprint && !c.dnp);
  const allParts = design.components.filter((c) => getPart(c.partId)?.footprint);
  const layers = copperLayers(design.board);
  const analysis = design.zones.length ? analyzeCopper(design) : null;

  layers.forEach((layer, i) => {
    const pos = i === 0 ? "Top" : i === layers.length - 1 ? "Bot" : "Inr";
    const cu = new Gerber(`Copper,L${i + 1},${pos}`, H);
    // Pours first: dark region, then clear-polarity cut-outs around other-net copper.
    for (const z of design.zones.filter((z) => z.layer === layer)) {
      cu.polarity(true);
      cu.region(z.points);
      cu.polarity(false);
      for (const c of zoneCutouts(design, z, analysis!)) {
        if (c.kind === "rect") cu.flash("R", c.rect.x1 - c.rect.x0, c.rect.y1 - c.rect.y0, { x: (c.rect.x0 + c.rect.x1) / 2, y: (c.rect.y0 + c.rect.y1) / 2 });
        else if (c.kind === "circle") cu.flash("C", c.r * 2, c.r * 2, c.c);
        else cu.polyline(c.width, c.points);
      }
      cu.polarity(true);
    }
    for (const c of allParts) {
      for (const p of padsOf(c)) {
        if (!p.layers.includes(layer)) continue;
        cu.flash(p.shape === "circle" ? "C" : p.shape === "oval" ? "O" : "R", p.ww, p.wh, p.world);
      }
    }
    for (const t of design.traces) if (t.layer === layer) cu.polyline(t.width, t.points);
    for (const v of design.vias) cu.flash("C", v.diameter, v.diameter, v);
    files[`${design.name}-${LAYER_FILE[layer].tag}.${LAYER_FILE[layer].ext}`] = cu.toString();
  });

  for (const side of ["top", "bottom"] as Side[]) {
    const tag = side === "top" ? "F" : "B";
    const mask = new Gerber(`Soldermask,${side === "top" ? "Top" : "Bot"}`, H);
    const silk = new Gerber(`Legend,${side === "top" ? "Top" : "Bot"}`, H);
    const paste = new Gerber(`Paste,${side === "top" ? "Top" : "Bot"}`, H);
    for (const c of allParts) {
      for (const p of padsOf(c)) {
        if (!p.layers.includes(side)) continue;
        const shape = p.shape === "circle" ? "C" : p.shape === "oval" ? "O" : "R";
        mask.flash(shape, p.ww + 0.1, p.wh + 0.1, p.world);
        if (!p.drill && parts.includes(c)) paste.flash(shape, p.ww * 0.9, p.wh * 0.9, p.world);
      }
      if (c.pcb.side === side) {
        for (const s of getPart(c.partId)!.footprint!.silk) for (const pl of silkPolylines(s, c)) silk.polyline(0.15, pl);
        const r = courtyardRect(c)!;
        for (const stroke of strokeText(c.ref, { x: c.pcb.x, y: r.y0 - 0.9 }, 0.8, side === "bottom")) silk.polyline(0.12, stroke);
      }
    }
    files[`${design.name}-${tag}_Mask.${side === "top" ? "gts" : "gbs"}`] = mask.toString();
    files[`${design.name}-${tag}_Silkscreen.${side === "top" ? "gto" : "gbo"}`] = silk.toString();
    files[`${design.name}-${tag}_Paste.${side === "top" ? "gtp" : "gbp"}`] = paste.toString();
  }

  const edge = new Gerber("Profile,NP", H);
  const { width: W } = design.board;
  edge.polyline(0.1, [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }, { x: 0, y: 0 }]);
  files[`${design.name}-Edge_Cuts.gm1`] = edge.toString();
  files[`${design.name}.drl`] = excellon(design);
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
    `Finish: HASL lead-free (default), green soldermask, white silkscreen, 1 oz copper`,
    `Layer stack: ${copperLayers(b).join(" / ")}`,
    "",
  ].join("\n");
}

export function excellon(design: Design): string {
  const holes = new Map<string, Vec[]>();
  const add = (d: number, p: Vec) => {
    const k = d.toFixed(3);
    if (!holes.has(k)) holes.set(k, []);
    holes.get(k)!.push(p);
  };
  for (const c of design.components) for (const p of padsOf(c)) if (p.drill) add(p.drill, p.world);
  for (const v of design.vias) add(v.drill, v);
  const H = design.board.height;
  const tools = [...holes.keys()];
  const out = ["M48", "METRIC,TZ", ...tools.map((d, i) => `T${i + 1}C${d}`), "%", "G90", "G05"];
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
