// Import KiCad 6/7/8 projects: schematics (.kicad_sch, multi-sheet/hierarchical) and boards (.kicad_pcb).
// Connectivity is resolved from KiCad geometry, then rebuilt in PCBian as pin-to-pin wires and labels.
import type * as Y from "yjs";
import { addComponent, addCustomPart, addKeepout, addSchGraphic, addSheet, addTrace, addVia, addWire, addZone, componentsMap, getDesign, renameSheet, setBoard, setBoardOutline, sheetPartId, updateComponent } from "./doc";
import { copperLayers, fromKicadLayerName } from "./stackup";
import { analyzeCopper } from "./copper";
import { attachNet } from "./edit";
import * as fp from "./footprints";
import { rotate } from "./geometry";
import { symbolFromSExpr, parseSExpr, type SExpr } from "./kicad";
import { getPart, icSymbol } from "./library";
import { computeNets, netByTerminal, termKey, UnionFind } from "./netlist";
import { ALL_COPPER, type CopperLayer, type Footprint, type Pad, type PartDef, type PcbPlacement, type Rotation, type Shape, type Terminal, type Vec } from "./types";

const isList = (e: SExpr): e is SExpr[] => Array.isArray(e);
const head = (e: SExpr) => (isList(e) && typeof e[0] === "string" ? e[0] : "");
const kids = (e: SExpr, name: string) => (isList(e) ? e.filter((c) => head(c) === name) : []) as SExpr[][];
const kid = (e: SExpr, name: string) => kids(e, name)[0];
const num = (e: SExpr | undefined, i: number, d = 0) => (e && isList(e) && typeof e[i] === "string" ? Number(e[i]) : d);
const prop = (e: SExpr, name: string) => kids(e, "property").find((p) => p[1] === name)?.[2] as string | undefined;

/** mm -> schematic units (10 units = 2.54 mm). */
const SK = 10 / 2.54;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
/** KiCad rotation (counter-clockwise on screen, y down). */
const rotK = (p: Vec, deg: number): Vec => {
  const a = (deg * Math.PI) / 180;
  return { x: r4(p.x * Math.cos(a) + p.y * Math.sin(a)), y: r4(-p.x * Math.sin(a) + p.y * Math.cos(a)) };
};
const round90 = (deg: number) => ((((Math.round(deg / 90) * 90) % 360) + 360) % 360) as Rotation;
const invRotate = (p: Vec, rot: Rotation): Vec => rotate(p, ((360 - rot) % 360) as Rotation);

export interface KicadImportInput {
  /** Schematic files; the root sheet is the one not referenced by another sheet. */
  schematics?: { name: string; text: string }[];
  pcb?: string;
}

export interface KicadImportReport {
  components: number;
  nets: number;
  sheets: number;
  traces: number;
  vias: number;
  zones: number;
  warnings: string[];
}

// ---------- board parsing ----------

export interface PcbFootprint {
  ref: string;
  value: string;
  lib: string;
  placement: PcbPlacement;
  footprint: Footprint;
  /** Net name per pad id. */
  nets: Map<string, string>;
}


function parsePcbFootprint(f: SExpr[], warnings: string[]): PcbFootprint | null {
  const layer = kid(f, "layer")?.[1] as string;
  const side = layer === "B.Cu" ? "bottom" : "top";
  const at = kid(f, "at");
  const pos = { x: num(at, 1), y: num(at, 2) };
  const angle = num(at, 3);
  const rot = round90(360 - angle);
  const ref = prop(f, "Reference") ?? (kids(f, "fp_text").find((t) => t[1] === "reference")?.[2] as string) ?? "";
  const value = prop(f, "Value") ?? (kids(f, "fp_text").find((t) => t[1] === "value")?.[2] as string) ?? "";
  if (Math.abs(((angle % 90) + 90) % 90) > 0.01) warnings.push(`${ref}: rotation ${angle}° rounded to ${(360 - rot) % 360}°`);
  const mirror = side === "bottom";
  // World -> PCBian footprint-local coordinates.
  const toLocal = (w: Vec): Vec => {
    const l = invRotate({ x: w.x - pos.x, y: w.y - pos.y }, rot);
    return { x: r4(mirror ? -l.x : l.x), y: r4(l.y) };
  };
  const fromKLocal = (p: Vec) => {
    const w = rotK(p, angle);
    return { x: pos.x + w.x, y: pos.y + w.y };
  };
  const pads: Pad[] = [];
  const nets = new Map<string, string>();
  for (const p of kids(f, "pad")) {
    const [, id, type, shape] = p as string[];
    if (!id || type === "np_thru_hole") continue;
    const pat = kid(p, "at");
    const world = fromKLocal({ x: num(pat, 1), y: num(pat, 2) });
    const padAbs = num(pat, 3);
    let w = num(kid(p, "size"), 1);
    let h = num(kid(p, "size"), 2);
    // Pad size is in the pad's own orientation; express it in the footprint frame.
    const rel = (((padAbs - angle) % 180) + 180) % 180;
    if (Math.abs(rel - 90) < 1) [w, h] = [h, w];
    const drill = kid(p, "drill");
    const drillD = drill ? Number(drill.find((x) => typeof x === "string" && /^[\d.]+$/.test(x)) ?? 0) : 0;
    const local = toLocal(world);
    pads.push({ id: String(id), x: local.x, y: local.y, w: r4(w), h: r4(h), shape: shape === "circle" ? "circle" : shape === "oval" ? "oval" : "rect", ...(type === "thru_hole" && drillD ? { drill: drillD } : {}) });
    const net = kid(p, "net");
    if (net && net[2]) nets.set(String(id), String(net[2]));
  }
  if (!pads.length) return null;
  const silk: Shape[] = [];
  const crt: Vec[] = [];
  for (const g of kids(f, "fp_line")) {
    const l = kid(g, "layer")?.[1] as string;
    const a = toLocal(fromKLocal({ x: num(kid(g, "start"), 1), y: num(kid(g, "start"), 2) }));
    const b = toLocal(fromKLocal({ x: num(kid(g, "end"), 1), y: num(kid(g, "end"), 2) }));
    if (/SilkS/.test(l)) silk.push({ kind: "line", points: [a, b] });
    if (/CrtYd/.test(l)) crt.push(a, b);
  }
  for (const g of kids(f, "fp_rect")) {
    const l = kid(g, "layer")?.[1] as string;
    const a = toLocal(fromKLocal({ x: num(kid(g, "start"), 1), y: num(kid(g, "start"), 2) }));
    const b = toLocal(fromKLocal({ x: num(kid(g, "end"), 1), y: num(kid(g, "end"), 2) }));
    if (/SilkS/.test(l)) silk.push({ kind: "line", points: [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a] });
    if (/CrtYd/.test(l)) crt.push(a, b);
  }
  for (const g of kids(f, "fp_circle")) {
    const l = kid(g, "layer")?.[1] as string;
    const c = toLocal(fromKLocal({ x: num(kid(g, "center"), 1), y: num(kid(g, "center"), 2) }));
    const e = toLocal(fromKLocal({ x: num(kid(g, "end"), 1), y: num(kid(g, "end"), 2) }));
    const r = Math.hypot(e.x - c.x, e.y - c.y);
    if (/SilkS/.test(l)) silk.push({ kind: "circle", x: c.x, y: c.y, r });
    if (/CrtYd/.test(l)) crt.push({ x: c.x - r, y: c.y - r }, { x: c.x + r, y: c.y + r });
  }
  const pts = crt.length ? crt : pads.flatMap((p) => [{ x: p.x - p.w / 2 - 0.25, y: p.y - p.h / 2 - 0.25 }, { x: p.x + p.w / 2 + 0.25, y: p.y + p.h / 2 + 0.25 }]);
  const cw = 2 * Math.max(...pts.map((p) => Math.abs(p.x)));
  const ch = 2 * Math.max(...pts.map((p) => Math.abs(p.y)));
  const lib = String(f[1] ?? "");
  return { ref, value, lib, placement: { x: pos.x, y: pos.y, rot, side }, footprint: { name: lib.replace(/^.*:/, ""), pads, courtyard: { w: r4(cw), h: r4(ch) }, silk }, nets };
}

export interface PcbData {
  footprints: PcbFootprint[];
  traces: { layer: CopperLayer; width: number; points: Vec[] }[];
  vias: { x: number; y: number; diameter: number; drill: number; from?: CopperLayer; to?: CopperLayer }[];
  zones: ({ net: string; layer: CopperLayer; points: Vec[] } & ReturnType<typeof zoneStyle>)[];
  keepouts: { layers: CopperLayer[]; points: Vec[]; noTracks: boolean; noVias: boolean; noPours: boolean }[];
  outline: Vec[][];
  thickness: number;
  layers: number;
}

/** Fill style, priority and pad connection of a KiCad zone. */
function zoneStyle(z: SExpr[]) {
  const fill = kid(z, "fill") ?? [];
  const hatch = kid(fill, "mode")?.[1] === "hatch";
  const connect = kid(z, "connect_pads");
  const priority = num(kid(z, "priority"), 1, 0);
  return {
    ...(priority ? { priority } : {}),
    ...(hatch ? { fill: "hatch" as const, hatchWidth: num(kid(fill, "hatch_thickness"), 1, 0.25), hatchGap: num(kid(fill, "hatch_gap"), 1, 1) } : {}),
    ...(connect?.[1] === "yes" ? { padConnection: "solid" as const } : {}),
    ...(kid(fill, "thermal_gap") ? { thermalGap: num(kid(fill, "thermal_gap"), 1, 0.5) } : {}),
    ...(kid(fill, "thermal_bridge_width") ? { spokeWidth: num(kid(fill, "thermal_bridge_width"), 1, 0.5) } : {}),
  };
}

function parsePcb(text: string, warnings: string[]): PcbData {
  const root = parseSExpr(text);
  if (head(root) !== "kicad_pcb") throw new Error("Not a KiCad board file (.kicad_pcb)");
  const layerDefs = (kid(root, "layers") ?? []).filter(isList) as SExpr[][];
  const copperCount = layerDefs.filter((l) => /\.Cu$/.test(String(l[1]))).length;
  if (copperCount > 32) warnings.push(`Board has ${copperCount} copper layers; only 32 are supported`);
  const footprints: PcbFootprint[] = [];
  for (const f of [...kids(root, "footprint"), ...kids(root, "module")]) {
    const p = parsePcbFootprint(f, warnings);
    if (p) footprints.push(p);
  }
  const traces: PcbData["traces"] = [];
  for (const s of kids(root, "segment")) {
    const layer = fromKicadLayerName(String(kid(s, "layer")?.[1] ?? ""));
    if (!layer) continue;
    traces.push({ layer, width: num(kid(s, "width"), 1, 0.25), points: [{ x: num(kid(s, "start"), 1), y: num(kid(s, "start"), 2) }, { x: num(kid(s, "end"), 1), y: num(kid(s, "end"), 2) }] });
  }
  for (const s of kids(root, "arc")) {
    const layer = fromKicadLayerName(String(kid(s, "layer")?.[1] ?? ""));
    if (!layer) continue;
    traces.push({ layer, width: num(kid(s, "width"), 1, 0.25), points: ["start", "mid", "end"].map((k) => ({ x: num(kid(s, k), 1), y: num(kid(s, k), 2) })) });
  }
  // Blind/buried/micro vias keep their layer span.
  const vias = kids(root, "via").map((v) => {
    const ls = (kid(v, "layers") ?? []).slice(1).map((x) => fromKicadLayerName(String(x)) ?? undefined);
    return { x: num(kid(v, "at"), 1), y: num(kid(v, "at"), 2), diameter: num(kid(v, "size"), 1, 0.6), drill: num(kid(v, "drill"), 1, 0.3), from: ls[0], to: ls[1] };
  });
  const zones: PcbData["zones"] = [];
  const keepouts: PcbData["keepouts"] = [];
  for (const z of kids(root, "zone")) {
    const net = String(kid(z, "net_name")?.[1] ?? "");
    const layerNames = [...(kid(z, "layer")?.slice(1) ?? []), ...(kid(z, "layers")?.slice(1) ?? [])].map(String);
    const poly = kids(kid(kid(z, "polygon") ?? [], "pts") ?? [], "xy").map((xy) => ({ x: num(xy, 1), y: num(xy, 2) }));
    const ko = kid(z, "keepout");
    if (ko) {
      // Rule areas: "*.Cu" and "F&B.Cu" expand to the copper layers they cover.
      const layers = [...new Set(layerNames.flatMap((ln): CopperLayer[] => (ln === "*.Cu" ? ALL_COPPER : ln === "F&B.Cu" ? ["top", "bottom"] : fromKicadLayerName(ln) ? [fromKicadLayerName(ln)!] : [])))];
      const banned = (k: string) => kid(ko, k)?.[1] === "not_allowed";
      if (layers.length && poly.length >= 3) keepouts.push({ layers, points: poly, noTracks: banned("tracks"), noVias: banned("vias"), noPours: banned("copperpour") });
      if (banned("footprints") || banned("pads")) warnings.push("Keepout footprint/pad restrictions are not enforced");
      continue;
    }
    for (const ln of layerNames) {
      const layer = fromKicadLayerName(ln);
      if (layer && net && poly.length >= 3) zones.push({ net, layer, points: poly, ...zoneStyle(z) });
    }
  }
  // Board outline from Edge.Cuts graphics.
  const segs: [Vec, Vec][] = [];
  const loops: Vec[][] = [];
  const onEdge = (g: SExpr[]) => kid(g, "layer")?.[1] === "Edge.Cuts";
  for (const g of kids(root, "gr_line").filter(onEdge)) segs.push([{ x: num(kid(g, "start"), 1), y: num(kid(g, "start"), 2) }, { x: num(kid(g, "end"), 1), y: num(kid(g, "end"), 2) }]);
  for (const g of kids(root, "gr_arc").filter(onEdge)) {
    const pts = ["start", "mid", "end"].map((k) => ({ x: num(kid(g, k), 1), y: num(kid(g, k), 2) }));
    segs.push([pts[0], pts[1]], [pts[1], pts[2]]);
  }
  for (const g of kids(root, "gr_rect").filter(onEdge)) {
    const a = { x: num(kid(g, "start"), 1), y: num(kid(g, "start"), 2) };
    const b = { x: num(kid(g, "end"), 1), y: num(kid(g, "end"), 2) };
    loops.push([a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }]);
  }
  for (const g of kids(root, "gr_poly").filter(onEdge)) loops.push(kids(kid(g, "pts") ?? [], "xy").map((xy) => ({ x: num(xy, 1), y: num(xy, 2) })));
  for (const g of kids(root, "gr_circle").filter(onEdge)) {
    const c = { x: num(kid(g, "center"), 1), y: num(kid(g, "center"), 2) };
    const r = Math.hypot(num(kid(g, "end"), 1) - c.x, num(kid(g, "end"), 2) - c.y);
    loops.push(Array.from({ length: 32 }, (_, i) => ({ x: r4(c.x + r * Math.cos((i * Math.PI) / 16)), y: r4(c.y + r * Math.sin((i * Math.PI) / 16)) })));
  }
  loops.push(...chainSegments(segs));
  const thickness = num(kid(kid(root, "general") ?? [], "thickness"), 1, 1.6);
  return { footprints, traces, vias, zones, keepouts, outline: loops, thickness, layers: Math.max(2, Math.min(32, Math.ceil(copperCount / 2) * 2)) };
}

/** Join loose outline segments end to end into closed loops. */
function chainSegments(segs: [Vec, Vec][]): Vec[][] {
  const same = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y) < 0.01;
  const rest = [...segs];
  const loops: Vec[][] = [];
  while (rest.length) {
    const [a, b] = rest.shift()!;
    const loop = [a, b];
    for (let guard = 0; guard < 10000 && rest.length; guard++) {
      const end = loop[loop.length - 1];
      const i = rest.findIndex(([p, q]) => same(p, end) || same(q, end));
      if (i < 0) break;
      const [p, q] = rest.splice(i, 1)[0];
      loop.push(same(p, end) ? q : p);
      if (same(loop[loop.length - 1], loop[0])) break;
    }
    if (same(loop[loop.length - 1], loop[0])) loop.pop();
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

// ---------- footprint fallback from KiCad names ----------

/** Map common KiCad library footprint names to PCBian generators (used when no board is imported). */
export function footprintFromName(name: string): Footprint | null {
  const n = name.replace(/^.*:/, "");
  let m = n.match(/^(?:R|C|L|LED|D|F|FB)_(0402|0603|0805|1206)/);
  if (m) return fp.chip(m[1] as "0402" | "0603" | "0805" | "1206");
  if (/SOD-123/.test(n)) return fp.sod123();
  if (/^SOT-223/.test(n)) return fp.sot223();
  if (/^SOT-23(?!-)/.test(n)) return fp.sot23();
  if ((m = n.match(/^SOIC-(\d+)/))) return fp.soic(Number(m[1]));
  if ((m = n.match(/^DIP-(\d+)/))) return fp.dip(Number(m[1]));
  if ((m = n.match(/^[LT]QFP-(\d+).*_P([\d.]+)mm/))) return fp.qfp(Number(m[1]), Number(m[2]), Number(m[1]) / 4 * Number(m[2]) + 2.5);
  if ((m = n.match(/^PinHeader_1x(\d+)_P2\.54mm/))) return fp.header(Number(m[1]));
  return null;
}

// ---------- schematic parsing ----------

interface SchSymbolInstance {
  libId: string;
  ref: string;
  value: string;
  footprint: string;
  at: Vec; // schematic units
  rot: Rotation;
  mirror: boolean;
  /** KiCad world pin positions (schematic units) by pin number. */
  pins: Map<string, Vec>;
  power: boolean;
  dnp: boolean;
}

function symbolInstances(
  root: SExpr[],
  libs: Map<string, ReturnType<typeof symbolFromSExpr>>,
  rawLibs: Map<string, SExpr[]>,
  resolveRef: (sym: SExpr[]) => { ref: string; unit: number } | undefined,
): SchSymbolInstance[] {
  const out: SchSymbolInstance[] = [];
  for (const s of kids(root, "symbol")) {
    const libId = String(kid(s, "lib_id")?.[1] ?? "");
    const lib = libs.get(libId);
    const raw = rawLibs.get(libId);
    if (!lib || !raw) continue;
    const at = kid(s, "at");
    const a = num(at, 3);
    const mir = kid(s, "mirror")?.[1] as string | undefined;
    const pos = { x: num(at, 1), y: num(at, 2) };
    // KiCad pin positions: lib coordinates (y up) -> rotate (CCW on screen) -> mirror.
    const pins = new Map<string, Vec>();
    const walk = (e: SExpr[]) => {
      for (const p of kids(e, "pin")) {
        const n = String(kid(p, "number")?.[1] ?? "");
        if (pins.has(n)) continue;
        let v = rotK({ x: num(kid(p, "at"), 1), y: -num(kid(p, "at"), 2) }, a);
        if (mir === "x") v = { x: v.x, y: -v.y };
        if (mir === "y") v = { x: -v.x, y: v.y };
        pins.set(n, { x: r4((pos.x + v.x) * SK), y: r4((pos.y + v.y) * SK) });
      }
      // Sub-symbols are NAME_unit_style: unit 0 is shared by all units; style 2 is the De Morgan body.
      for (const sub of kids(e, "symbol")) {
        const m = String(sub[1]).match(/_(\d+)_(\d+)$/);
        if (m && (m[2] === "2" || (m[1] !== "0" && Number(m[1]) !== unit))) continue;
        walk(sub);
      }
    };
    const own = resolveRef(s);
    const unit = own?.unit ?? num(kid(s, "unit"), 1, 1);
    walk(raw);
    // Equivalent PCBian placement: R_our(rot) ∘ mirrorX(local).
    const rot = mir === "y" ? round90(a) : mir === "x" ? round90(180 + a) : round90(360 - a);
    out.push({
      libId,
      ref: own?.ref || (prop(s, "Reference") ?? "?"),
      value: prop(s, "Value") ?? "",
      footprint: prop(s, "Footprint") ?? "",
      at: { x: r4(pos.x * SK), y: r4(pos.y * SK) },
      rot,
      mirror: Boolean(mir),
      pins,
      power: lib.power,
      dnp: kid(s, "dnp")?.[1] === "yes" || kid(s, "in_bom")?.[1] === "no",
    });
  }
  return out;
}

// ---------- import ----------

export function importKicadProject(doc: Y.Doc, input: KicadImportInput): KicadImportReport {
  const warnings: string[] = [];
  const pcb = input.pcb ? parsePcb(input.pcb, warnings) : null;
  return importBoard(doc, pcb, warnings, input.schematics?.length ? (ctx) => importKicadSchematics(ctx, input.schematics!) : undefined, "KiCad");
}

/** Shared state handed to a format-specific schematic importer. */
export interface ImportCtx {
  doc: Y.Doc;
  report: KicadImportReport;
  warnings: string[];
  pcbByRef: Map<string, PcbFootprint>;
  makePart: (sig: string, build: () => PartDef) => PartDef;
  uidPart: () => string;
  pcbPlacement: (ref: string) => Partial<PcbPlacement> | undefined;
  placed: Set<string>;
}

/**
 * Format-neutral import: the board (if any) as parsed board data, plus an optional schematic
 * importer. Without a schematic, symbols are generated from footprints and nets become labels.
 */
export function importBoard(doc: Y.Doc, pcb: PcbData | null, warnings: string[], schematic: ((ctx: ImportCtx) => void) | undefined, source: string): KicadImportReport {
  const report: KicadImportReport = { components: 0, nets: 0, sheets: 0, traces: 0, vias: 0, zones: 0, warnings };

  // Board origin: shift everything so the outline's top-left corner is (0,0).
  let shift = { x: 0, y: 0 };
  if (pcb) {
    const all = pcb.outline.flat();
    const src = all.length ? all : [...pcb.footprints.map((f) => f.placement), ...pcb.traces.flatMap((t) => t.points)];
    if (src.length) shift = { x: Math.min(...src.map((p) => p.x)) - (all.length ? 0 : 2), y: Math.min(...src.map((p) => p.y)) - (all.length ? 0 : 2) };
  }
  const sh = (p: Vec) => ({ x: r4(p.x - shift.x), y: r4(p.y - shift.y) });
  const pcbByRef = new Map(pcb?.footprints.map((f) => [f.ref, f]) ?? []);
  const partBySig = new Map<string, PartDef>();
  const makePart = (sig: string, build: () => PartDef) => {
    let p = partBySig.get(sig);
    if (!p) {
      p = addCustomPart(doc, build());
      partBySig.set(sig, p);
    }
    return p;
  };
  const uidPart = () => `${source.toLowerCase()}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const placed = new Set<string>();

  doc.transact(() => {
    if (schematic) schematic({ doc, report, warnings, pcbByRef, makePart, uidPart, pcbPlacement, placed });
    else if (pcb) importBoardOnlyComponents();
    if (pcb) importBoardCopper();
  });
  report.components = [...componentsMap(doc).values()].filter((c) => getPart(c.partId)?.kind === "part").length;
  return report;

  function pcbPlacement(ref: string): Partial<PcbPlacement> | undefined {
    const f = pcbByRef.get(ref);
    if (!f) return undefined;
    placed.add(ref);
    const p = sh(f.placement);
    return { x: p.x, y: p.y, rot: f.placement.rot, side: f.placement.side };
  }

  // ----- board-only import: generate symbols and connect pads with labels -----
  function importBoardOnlyComponents() {
    const byNet = new Map<string, Terminal[]>();
    pcb!.footprints.forEach((f, i) => {
      const ids = [...new Set(f.footprint.pads.map((p) => p.id))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const sig = JSON.stringify(f.footprint);
      const prefix = (f.ref.match(/^[A-Za-z]+/)?.[0] ?? "U").toUpperCase();
      const part = makePart(sig, () => ({ id: uidPart(), name: f.footprint.name, category: `Imported (${source})`, description: `Imported from ${source} footprint ${f.lib}`, kind: "part", refPrefix: prefix, defaultValue: f.value, keywords: [source.toLowerCase()], symbol: icSymbol(ids.slice(0, Math.ceil(ids.length / 2)).map((x) => [x, x]), ids.slice(Math.ceil(ids.length / 2)).map((x) => [x, x]), ""), footprint: f.footprint }));
      const c = addComponent(doc, part.id, { x: (i % 6) * 180, y: Math.floor(i / 6) * 160 }, { ref: f.ref || undefined, value: f.value, pcb: pcbPlacement(f.ref) });
      for (const [pad, net] of f.nets) {
        if (!byNet.has(net)) byNet.set(net, []);
        if (!byNet.get(net)!.some((t) => t.comp === c.id && t.pin === pad)) byNet.get(net)!.push({ comp: c.id, pin: pad });
      }
    });
    for (const [net, terms] of byNet) {
      if (terms.length < 2 && !/^[+]|GND|VCC|VDD/i.test(net)) continue;
      report.nets++;
      const auto = /^unconnected-/i.test(net);
      if (auto) for (let i = 1; i < terms.length; i++) addWire(doc, terms[i - 1], terms[i]);
      else {
        const name = net.replace(/^\//, "");
        for (const t of terms) attachNet(doc, `${componentsMap(doc).get(t.comp)!.ref}.${t.pin}`, name);
      }
    }
  }

  // ----- copper, outline, stackup -----
  function importBoardCopper() {
    const b = pcb!;
    setBoard(doc, { thickness: b.thickness, layers: b.layers });
    const outer = b.outline.length ? b.outline.reduce((a, c) => (area(c) > area(a) ? c : a)) : null;
    if (outer) {
      const shifted = outer.map(sh);
      const mx = Math.max(...shifted.map((q) => q.x));
      const my = Math.max(...shifted.map((q) => q.y));
      const near = (v: number, t: number) => Math.abs(v - t) < 1e-3;
      const isRect = shifted.length === 4 && shifted.every((p) => (near(p.x, 0) || near(p.x, mx)) && (near(p.y, 0) || near(p.y, my)));
      if (isRect) setBoard(doc, { width: r4(mx), height: r4(my), outline: undefined });
      else setBoardOutline(doc, shifted);
      const holes = b.outline.filter((l) => l !== outer).map((l) => l.map(sh));
      if (holes.length) setBoard(doc, { cutouts: holes });
    } else {
      const pts = [...b.footprints.map((f) => sh(f.placement)), ...b.traces.flatMap((t) => t.points.map(sh))];
      setBoard(doc, { width: Math.ceil(Math.max(...pts.map((p) => p.x)) + 4), height: Math.ceil(Math.max(...pts.map((p) => p.y)) + 4) });
      warnings.push("No Edge.Cuts outline found; the board size was estimated from the parts");
    }
    for (const t of b.traces) addTrace(doc, { layer: t.layer, width: t.width, points: t.points.map(sh) });
    for (const v of b.vias) addVia(doc, sh(v), v.diameter, v.drill, { from: v.from, to: v.to });
    // Zone nets: map KiCad net names to PCBian nets through the pads KiCad assigned to them.
    const d = getDesign(doc);
    const ourNet = netByTerminal(computeNets(d));
    const byRef = new Map(d.components.map((c) => [c.ref, c]));
    const netMap = new Map<string, string>();
    for (const f of b.footprints) {
      const c = byRef.get(f.ref);
      if (!c) continue;
      for (const [pad, kn] of f.nets) {
        const n = ourNet.get(termKey({ comp: c.id, pin: pad }));
        if (n && !netMap.has(kn)) netMap.set(kn, n);
      }
    }
    let unmapped = 0;
    for (const z of b.zones) {
      const net = netMap.get(z.net);
      if (!net) unmapped++;
      addZone(doc, { ...z, net: net ?? z.net, points: z.points.map(sh) });
    }
    if (unmapped) warnings.push(`${unmapped} pour(s) use nets with no imported pads`);
    const layersNow = copperLayers(getDesign(doc).board);
    for (const k of b.keepouts) {
      const layers = k.layers.filter((l) => layersNow.includes(l));
      if (layers.length) addKeepout(doc, { ...k, layers, points: k.points.map(sh) });
    }
    // KiCad keeps design rules in the .kicad_pro file; adopt the clearance the board actually uses.
    const used = minClearance(getDesign(doc));
    if (used < getDesign(doc).board.clearance) {
      const c = Math.max(0.05, Math.floor(used * 1000) / 1000);
      setBoard(doc, { clearance: c, defaultTraceWidth: Math.min(0.25, Math.min(...b.traces.map((t) => t.width), 0.25)) });
      warnings.push(`Board clearance set to ${c}mm to match the imported layout (design rules are not part of the imported files)`);
    }
    report.traces = b.traces.length;
    report.vias = b.vias.length;
    report.zones = b.zones.length;
  }
}

function area(poly: Vec[]) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  return Math.abs(a / 2);
}

/** Smallest gap between electrically separate copper (used to adopt imported design rules). */
function minClearance(design: ReturnType<typeof getDesign>): number {
  const a = analyzeCopper(design);
  let best = Infinity;
  for (const p of a.pairs) if (p.gap > 1e-6 && a.clusterOf.get(p.a.key) !== a.clusterOf.get(p.b.key)) best = Math.min(best, p.gap);
  return best;
}

// ----- KiCad schematic import -----
function importKicadSchematics(ctx: ImportCtx, files: { name: string; text: string }[]) {
  const { doc, report, warnings, pcbByRef, makePart, uidPart, pcbPlacement, placed } = ctx;
  {
    const parsed = files.map((f) => ({ name: f.name.replace(/^.*[\\/]/, ""), root: parseSExpr(f.text) as SExpr[] }));
    for (const p of parsed) if (head(p.root) !== "kicad_sch") throw new Error(`${p.name} is not a KiCad schematic`);
    const base = (f: string) => f.replace(/^.*[\\/]/, "");
    const byName = new Map(parsed.map((p) => [p.name, p]));
    const referenced = new Set(parsed.flatMap((p) => kids(p.root, "sheet").map((s) => base(String(prop(s, "Sheetfile") ?? "")))));
    const rootFile = parsed.find((p) => !referenced.has(p.name)) ?? parsed[0];
    const rootUuid = String(kid(rootFile.root, "uuid")?.[1] ?? "");
    // KiCad 6 keeps per-instance references in the root file, keyed by sheet path (without the root) + symbol uuid.
    const legacyRefs = new Map<string, { ref: string; unit: number }>();
    for (const pth of kids(kid(rootFile.root, "symbol_instances") ?? [], "path")) legacyRefs.set(String(pth[1]), { ref: String(kid(pth, "reference")?.[1] ?? ""), unit: num(kid(pth, "unit"), 1, 1) });

    // Every sheet symbol is its own instance (one file may be used several times); each becomes a PCBian sheet.
    interface SheetInst {
      file: (typeof parsed)[number];
      /** KiCad instance path: /root-uuid/sheet-uuid/... */
      path: string;
      sheet: string;
    }
    const instances: SheetInst[] = [];
    const missing = new Set<string>();
    const design0 = getDesign(doc);
    renameSheet(doc, design0.sheets[0].id, "Root");
    const usedNames = new Set(["Root"]);
    const visit = (file: SheetInst["file"], path: string, sheet: string, depth: number) => {
      instances.push({ file, path, sheet });
      if (depth >= 16) return void warnings.push(`Sheet hierarchy below ${path} is deeper than 16 levels and was truncated`);
      for (const sh of kids(file.root, "sheet")) {
        const childFile = base(String(prop(sh, "Sheetfile") ?? ""));
        const child = byName.get(childFile);
        if (!child) {
          missing.add(childFile);
          continue;
        }
        const stem = String(prop(sh, "Sheetname") ?? prop(sh, "Sheet name") ?? "") || childFile.replace(/\.kicad_sch$/, "");
        let name = stem;
        for (let k = 2; usedNames.has(name); k++) name = `${stem}_${k}`;
        usedNames.add(name);
        visit(child, `${path}/${String(kid(sh, "uuid")?.[1] ?? "")}`, addSheet(doc, name).id, depth + 1);
      }
    };
    visit(rootFile, `/${rootUuid}`, design0.sheets[0].id, 0);
    for (const m of missing) warnings.push(`Sub-sheet file ${m} was not provided; its contents are missing`);
    for (const p of parsed) if (!instances.some((i) => i.file === p)) warnings.push(`${p.name} is not used by the root sheet's hierarchy and was skipped`);
    report.sheets = instances.length;

    type Pt = { key: string; at: Vec; term?: Terminal; noConnect?: boolean };
    const perFile: { file: (typeof parsed)[number]; sheet: string; points: Pt[]; wires: [Vec, Vec][]; sheetPins: { comp?: string; name: string; at: Vec; child: string }[] }[] = [];
    const firstSheet = getDesign(doc).sheets[0].id;

    for (const inst of instances) {
      const p = inst.file;
      const sheet = inst.sheet;
      // This instance's own reference designators (and units) for the symbols in a reused file.
      const resolveRef = (sym: SExpr[]) => {
        for (const proj of kids(kid(sym, "instances") ?? [], "project"))
          for (const pth of kids(proj, "path")) if (String(pth[1]) === inst.path) return { ref: String(kid(pth, "reference")?.[1] ?? ""), unit: num(kid(pth, "unit"), 1, 1) };
        return legacyRefs.get(`${inst.path.slice(rootUuid.length + 1)}/${String(kid(sym, "uuid")?.[1] ?? "")}`);
      };
      const libs = new Map<string, ReturnType<typeof symbolFromSExpr>>();
      const rawLibs = new Map<string, SExpr[]>();
      for (const ls of kids(kid(p.root, "lib_symbols") ?? [], "symbol")) {
        try {
          libs.set(String(ls[1]), symbolFromSExpr(ls));
          rawLibs.set(String(ls[1]), ls);
        } catch (e) {
          warnings.push(`Symbol ${ls[1]}: ${(e as Error).message}`);
        }
      }
      const points: Pt[] = [];
      const pt = (at: Vec) => ({ key: `${Math.round(at.x * 100)},${Math.round(at.y * 100)}`, at });
      const insts = symbolInstances(p.root, libs, rawLibs, resolveRef);
      const seenRefs = new Map<string, string>();
      for (const inst of insts) {
        const lib = libs.get(inst.libId)!;
        if (inst.power) {
          const name = inst.value || lib.value;
          // PWR_FLAG only tells KiCad's ERC that a net is driven; it does not name a net.
          if (/^PWR_FLAG$/i.test(name) || /PWR_FLAG/i.test(inst.libId)) continue;
          const pinPos = [...inst.pins.values()][0] ?? inst.at;
          const isGnd = /GND|VSS/i.test(name);
          const c = addComponent(doc, isGnd ? "power_gnd" : "power_rail", pinPos, { value: name, sheet: sheet === firstSheet ? undefined : sheet });
          points.push({ ...pt(pinPos), term: { comp: c.id, pin: "1" } });
          continue;
        }
        // Multi-unit symbols share a reference: merge units into one component.
        let compId = seenRefs.get(inst.ref);
        if (!compId) {
          const board = pcbByRef.get(inst.ref);
          const footprint = board?.footprint ?? footprintFromName(inst.footprint);
          const pinIds = new Set(lib.pins.map((x) => x.id));
          if (footprint) {
            const dropped = footprint.pads.filter((pd) => !pinIds.has(pd.id)).map((pd) => pd.id);
            if (dropped.length) warnings.push(`${inst.ref}: footprint pads ${[...new Set(dropped)].join(", ")} have no symbol pin and were dropped`);
            footprint.pads = footprint.pads.filter((pd) => pinIds.has(pd.id));
          } else warnings.push(`${inst.ref}: no footprint geometry for "${inst.footprint || "(none)"}"; import the .kicad_pcb too to place it`);
          const sig = JSON.stringify([inst.libId, lib.symbol.pins.map((x) => x.id), footprint]);
          const part = makePart(sig, () => ({ id: uidPart(), name: lib.name, category: "Imported (KiCad)", description: lib.description || lib.name, kind: "part", refPrefix: lib.refPrefix, defaultValue: lib.value, keywords: ["kicad"], symbol: lib.symbol, footprint: footprint && footprint.pads.length ? footprint : null }));
          const c = addComponent(doc, part.id, inst.at, { ref: inst.ref, value: inst.value, rot: inst.rot, sheet: sheet === firstSheet ? undefined : sheet, pcb: pcbPlacement(inst.ref) });
          updateComponent(doc, c.id, { sch: { x: inst.at.x, y: inst.at.y, rot: inst.rot, mirror: inst.mirror }, ...(inst.dnp ? { dnp: true } : {}) });
          compId = c.id;
          seenRefs.set(inst.ref, compId);
        } else if (!warnings.some((w) => w.startsWith(`${inst.ref}: multi-unit`))) warnings.push(`${inst.ref}: multi-unit symbol merged into one component`);
        for (const [pin, at] of inst.pins) points.push({ ...pt(at), term: { comp: compId, pin } });
      }
      const labelKinds: [string, string][] = [
        ["label", "local_label"],
        ["global_label", "net_label"],
        ["hierarchical_label", "hier_label"],
      ];
      for (const [k, partId] of labelKinds) {
        for (const l of kids(p.root, k)) {
          const at = { x: r4(num(kid(l, "at"), 1) * SK), y: r4(num(kid(l, "at"), 2) * SK) };
          const ang = num(kid(l, "at"), 3);
          const c = addComponent(doc, partId, at, { value: String(l[1]), sheet: sheet === firstSheet ? undefined : sheet });
          if (Math.round(ang) === 180) updateComponent(doc, c.id, { sch: { x: at.x, y: at.y, rot: 0, mirror: true } });
          points.push({ ...pt(at), term: { comp: c.id, pin: "1" } });
        }
      }
      for (const j of kids(p.root, "junction")) points.push(pt({ x: r4(num(kid(j, "at"), 1) * SK), y: r4(num(kid(j, "at"), 2) * SK) }));
      for (const n of kids(p.root, "no_connect")) points.push({ ...pt({ x: r4(num(kid(n, "at"), 1) * SK), y: r4(num(kid(n, "at"), 2) * SK) }), noConnect: true });
      const wires: [Vec, Vec][] = [];
      for (const w of kids(p.root, "wire")) {
        const xy = kids(kid(w, "pts") ?? [], "xy").map((v) => ({ x: r4(num(v, 1) * SK), y: r4(num(v, 2) * SK) }));
        for (let i = 1; i < xy.length; i++) wires.push([xy[i - 1], xy[i]]);
      }
      for (const b of kids(p.root, "bus")) {
        const xy = kids(kid(b, "pts") ?? [], "xy").map((v) => ({ x: r4(num(v, 1) * SK), y: r4(num(v, 2) * SK) }));
        addSchGraphic(doc, { sheet, kind: "bus", points: xy });
      }
      for (const t of kids(p.root, "text")) addSchGraphic(doc, { sheet, kind: "text", points: [{ x: r4(num(kid(t, "at"), 1) * SK), y: r4(num(kid(t, "at"), 2) * SK) }], text: String(t[1]), size: 8 });
      const sheetPins: { name: string; at: Vec; child: string }[] = [];
      for (const s of kids(p.root, "sheet")) {
        const child = instances.find((i) => i.path === `${inst.path}/${String(kid(s, "uuid")?.[1] ?? "")}`)?.sheet;
        if (!child) continue;
        for (const sp of kids(s, "pin")) sheetPins.push({ name: String(sp[1]), at: { x: r4(num(kid(sp, "at"), 1) * SK), y: r4(num(kid(sp, "at"), 2) * SK) }, child });
        sheetPins.push({ name: "", at: { x: r4(num(kid(s, "at"), 1) * SK), y: r4(num(kid(s, "at"), 2) * SK) }, child });
      }
      perFile.push({ file: p, sheet, points, wires, sheetPins });
    }

    // Sheet symbols need the child's hierarchical labels, which now exist.
    getDesign(doc);
    for (const f of perFile) {
      const byChild = new Map<string, string>();
      for (const sp of f.sheetPins.filter((x) => x.name === "")) {
        const c = addComponent(doc, sheetPartId(sp.child), sp.at, { value: sp.child, sheet: f.sheet === firstSheet ? undefined : f.sheet });
        byChild.set(sp.child, c.id);
      }
      for (const sp of f.sheetPins.filter((x) => x.name !== "")) {
        const comp = byChild.get(sp.child);
        if (comp) f.points.push({ key: `${Math.round(sp.at.x * 100)},${Math.round(sp.at.y * 100)}`, at: sp.at, term: { comp, pin: sp.name } });
      }
    }

    // Resolve KiCad geometric connectivity per sheet and rebuild it as wires.
    let netCount = 0;
    for (const f of perFile) {
      const uf = new UnionFind();
      const onSeg = (p: Vec, [a, b]: [Vec, Vec]) => {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy || 1e-12;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
        return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) < 0.05;
      };
      const key = (p: Vec) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;
      f.wires.forEach(([a, b]) => uf.union(key(a), key(b)));
      // Wire endpoints and every other point connect to any wire they lie on (T-junctions).
      const allPts = [...f.points.map((p) => p.at), ...f.wires.flat()];
      for (const p of allPts) for (const w of f.wires) if (onSeg(p, w)) uf.union(key(p), key(w[0]));
      const groups = new Map<string, Pt[]>();
      for (const p of f.points) {
        const r = uf.find(p.key);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r)!.push(p);
      }
      for (const pts of groups.values()) {
        const terms = pts.filter((p) => p.term);
        if (pts.some((p) => p.noConnect)) {
          for (const t of terms) {
            const c = componentsMap(doc).get(t.term!.comp);
            if (c && getPart(c.partId)?.kind === "part") updateComponent(doc, c.id, { noConnect: [...new Set([...(c.noConnect ?? []), t.term!.pin])] });
          }
        }
        if (terms.length < 2) continue;
        netCount++;
        // Minimum spanning tree keeps the rebuilt wiring short and readable.
        const inTree = [terms[0]];
        const rest = terms.slice(1);
        while (rest.length) {
          let best = { i: 0, j: 0, d: Infinity };
          inTree.forEach((a, i) => rest.forEach((b, j) => {
            const d = Math.abs(a.at.x - b.at.x) + Math.abs(a.at.y - b.at.y);
            if (d < best.d) best = { i, j, d };
          }));
          const b = rest.splice(best.j, 1)[0];
          addWire(doc, inTree[best.i].term!, b.term!);
          inTree.push(b);
        }
      }
    }
    report.nets = netCount;
    for (const ref of pcbByRef.keys()) if (!placed.has(ref) && !ref.startsWith("#")) warnings.push(`${ref} is on the board but not in the schematic; it was not imported`);
  }
}

