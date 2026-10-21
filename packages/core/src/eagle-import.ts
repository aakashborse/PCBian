// Autodesk EAGLE / Fusion Electronics import: .brd boards and .sch schematics (XML, EAGLE 6+).
// Boards become the same intermediate board data the KiCad importer uses; schematics are
// connected by Eagle's explicit nets and redrawn as wires (plus labels for named nets).
import type * as Y from "yjs";
import { addComponent, addSheet, componentsMap, getDesign, updateComponent } from "./doc";
import { drawImportedNets } from "./netdraw";
import { importBoard, type ImportCtx, type KicadImportReport, type PcbData, type PcbFootprint } from "./kicad-import";
import { normAngle, rotate, schematicPins } from "./geometry";
import type { CopperLayer, Footprint, Pad, PartSymbol, PinSide, Rotation, Shape, SymbolPin, Terminal, Vec } from "./types";
import { parseXml, xkid, xkids, xpath, type XmlNode } from "./xml";

export interface EagleImportInput {
  schematic?: string;
  board?: string;
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const num = (n: XmlNode, k: string, d = 0) => (n.attrs[k] !== undefined && n.attrs[k] !== "" ? Number(n.attrs[k]) : d);
/** mm -> schematic units (10 units = 2.54 mm). */
const SK = 10 / 2.54;
const round90 = (deg: number) => ((((Math.round(deg / 90) * 90) % 360) + 360) % 360) as Rotation;
/** A pad's own Eagle rotation: quarter turns swap the size; other angles become the pad's rotation
 * in PCBian's y-down footprint frame (where Eagle's counter-clockwise turns read clockwise-negative). */
function padTurn(angle: number): { swap: boolean; rot?: number } {
  const q = Math.round(angle / 90);
  if (Math.abs(angle - q * 90) < 0.01) return { swap: q % 2 !== 0 };
  return { swap: false, rot: normAngle(-angle) };
}

/** Eagle rotation attribute: "R90", "MR180", "SMR45". */
function parseRot(rot: string | undefined) {
  const m = (rot ?? "R0").match(/^(S?)(M?)R?([-\d.]+)?$/);
  return { mirror: Boolean(m?.[2]), angle: Number(m?.[3] ?? 0) };
}

/** Apply an Eagle transform (mirror about y, then rotate CCW, then translate) in Eagle coordinates. */
function xf(p: Vec, at: Vec, rot: { mirror: boolean; angle: number }): Vec {
  const x = rot.mirror ? -p.x : p.x;
  const a = (rot.angle * Math.PI) / 180;
  return { x: at.x + x * Math.cos(a) - p.y * Math.sin(a), y: at.y + x * Math.sin(a) + p.y * Math.cos(a) };
}

/** Points along an Eagle wire, expanding arcs (curve = signed sweep in degrees, positive = CCW). */
function wirePoints(w: XmlNode): Vec[] {
  const a = { x: num(w, "x1"), y: num(w, "y1") };
  const b = { x: num(w, "x2"), y: num(w, "y2") };
  const curve = num(w, "curve");
  if (!curve) return [a, b];
  const theta = (curve * Math.PI) / 180;
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const h = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2));
  // Centre lies to the left of a->b for CCW sweeps under 180°.
  const nx = -(b.y - a.y) / chord;
  const ny = (b.x - a.x) / chord;
  const s = (theta > 0 ? 1 : -1) * (Math.abs(theta) <= Math.PI ? 1 : -1);
  const c = { x: mid.x + nx * h * s, y: mid.y + ny * h * s };
  const a0 = Math.atan2(a.y - c.y, a.x - c.x);
  const steps = Math.max(2, Math.ceil(Math.abs(curve) / 10));
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = a0 + (theta * i) / steps;
    return { x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) };
  });
}

interface EaglePackage {
  name: string;
  node: XmlNode;
}

/** Pads of a package in Eagle package coordinates (y up), with their own rotation applied to the size. */
function packagePads(pkg: XmlNode) {
  const out: { id: string; at: Vec; w: number; h: number; shape: Pad["shape"]; drill?: number; bottom: boolean; rot?: number }[] = [];
  for (const s of xkids(pkg, "smd")) {
    const { swap, rot } = padTurn(parseRot(s.attrs.rot).angle);
    const dx = num(s, "dx");
    const dy = num(s, "dy");
    const round = num(s, "roundness");
    const [w, h] = swap ? [dy, dx] : [dx, dy];
    out.push({ id: s.attrs.name, at: { x: num(s, "x"), y: num(s, "y") }, w, h, shape: round >= 100 ? (Math.abs(w - h) < 1e-6 ? "circle" : "oval") : "rect", bottom: s.attrs.layer === "16", rot });
  }
  for (const p of xkids(pkg, "pad")) {
    const drill = num(p, "drill");
    // Eagle "auto" diameter: drill plus a 25% (min 0.25mm) restring each side.
    const dia = num(p, "diameter") || drill + 2 * Math.max(0.25, drill * 0.25);
    const shape = p.attrs.shape ?? "round";
    const { swap, rot } = padTurn(parseRot(p.attrs.rot).angle);
    let w = dia;
    let h = dia;
    if (shape === "long" || shape === "offset") [w, h] = swap ? [dia, 2 * dia] : [2 * dia, dia];
    out.push({ id: p.attrs.name, at: { x: num(p, "x"), y: num(p, "y") }, w, h, shape: shape === "square" ? "rect" : shape === "long" || shape === "offset" ? "oval" : "circle", drill, bottom: false, rot });
  }
  return out;
}

/** Footprint in PCBian's frame (y down) straight from the package, for schematic-only imports. */
function footprintFromPackage(name: string, pkg: XmlNode): Footprint {
  const pads: Pad[] = packagePads(pkg).map((p) => ({ id: p.id, x: r4(p.at.x), y: r4(-p.at.y), w: r4(p.w), h: r4(p.h), shape: p.shape, ...(p.rot !== undefined ? { rot: p.rot } : {}), ...(p.drill ? { drill: p.drill } : {}) }));
  const silk: Shape[] = xkids(pkg, "wire")
    .filter((w) => w.attrs.layer === "21")
    .map((w) => ({ kind: "line" as const, points: wirePoints(w).map((p) => ({ x: r4(p.x), y: r4(-p.y) })) }));
  return { name, pads, silk, courtyard: courtyardOf(pads, silk) };
}

function courtyardOf(pads: Pad[], silk: Shape[]) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of pads) xs.push(Math.abs(p.x) + p.w / 2), ys.push(Math.abs(p.y) + p.h / 2);
  for (const s of silk) if (s.kind === "line") for (const p of s.points) xs.push(Math.abs(p.x)), ys.push(Math.abs(p.y));
  return { w: r4(2 * (Math.max(0.5, ...xs) + 0.25)), h: r4(2 * (Math.max(0.5, ...ys) + 0.25)) };
}

function libraries(root: XmlNode | undefined) {
  const pkgs = new Map<string, EaglePackage>();
  const symbols = new Map<string, XmlNode>();
  const devicesets = new Map<string, XmlNode>();
  for (const lib of xkids(xkid(root, "libraries"), "library")) {
    const ln = lib.attrs.name;
    for (const p of xkids(xkid(lib, "packages"), "package")) pkgs.set(`${ln}:${p.attrs.name}`, { name: p.attrs.name, node: p });
    for (const s of xkids(xkid(lib, "symbols"), "symbol")) symbols.set(`${ln}:${s.attrs.name}`, s);
    for (const d of xkids(xkid(lib, "devicesets"), "deviceset")) devicesets.set(`${ln}:${d.attrs.name}`, d);
  }
  return { pkgs, symbols, devicesets };
}

// ---------- board ----------

function parseBoard(text: string, warnings: string[]): PcbData {
  const root = parseXml(text);
  const board = xpath(root, "eagle/drawing/board");
  if (!board) throw new Error("Not an EAGLE board file (.brd)");
  const libs = libraries(board);
  // Copper layers in use: 1 = top, 16 = bottom, 2-15 inner (in stack order).
  const used = new Set<number>([1, 16]);
  const signals = xkids(xkid(board, "signals"), "signal");
  for (const s of signals) for (const w of [...xkids(s, "wire"), ...xkids(s, "polygon")]) if (Number(w.attrs.layer) >= 2 && Number(w.attrs.layer) <= 15) used.add(Number(w.attrs.layer));
  const inner = [...used].filter((l) => l > 1 && l < 16).sort((a, b) => a - b);
  const layerOf = (n: number): CopperLayer | null => (n === 1 ? "top" : n === 16 ? "bottom" : inner.includes(n) ? (`in${inner.indexOf(n) + 1}` as CopperLayer) : null);
  const flip = (p: Vec) => ({ x: r4(p.x), y: r4(-p.y) });

  // Net of every pad, from contactrefs.
  const padNet = new Map<string, string>();
  for (const s of signals) for (const c of xkids(s, "contactref")) for (const pad of c.attrs.pad.split(" ")) padNet.set(`${c.attrs.element}\u0000${pad}`, s.attrs.name);

  const footprints: PcbFootprint[] = [];
  for (const e of xkids(xkid(board, "elements"), "element")) {
    const pkg = libs.pkgs.get(`${e.attrs.library}:${e.attrs.package}`);
    if (!pkg) {
      warnings.push(`${e.attrs.name}: package ${e.attrs.package} not found in the board's libraries`);
      continue;
    }
    const rot = parseRot(e.attrs.rot);
    const at = { x: num(e, "x"), y: num(e, "y") };
    const side = rot.mirror ? "bottom" : "top";
    const pcbRot = normAngle(360 - rot.angle);
    const pos = flip(at);
    // World pads (y down) -> PCBian footprint-local frame, exactly like the KiCad importer.
    const toLocal = (w: Vec): Vec => {
      const l = rotate({ x: w.x - pos.x, y: w.y - pos.y }, -pcbRot);
      return { x: r4(side === "bottom" ? -l.x : l.x), y: r4(l.y) };
    };
    const pads: Pad[] = [];
    const nets = new Map<string, string>();
    for (const p of packagePads(pkg.node)) {
      // The footprint frame is the package frame flipped to y-down, so pad sizes and turns carry over.
      const l = toLocal(flip(xf(p.at, at, rot)));
      pads.push({ id: p.id, x: l.x, y: l.y, w: r4(p.w), h: r4(p.h), shape: p.shape, ...(p.rot !== undefined ? { rot: p.rot } : {}), ...(p.drill ? { drill: p.drill } : {}) });
      const net = padNet.get(`${e.attrs.name}\u0000${p.id}`);
      if (net) nets.set(p.id, net);
    }
    const silk: Shape[] = xkids(pkg.node, "wire")
      .filter((w) => w.attrs.layer === "21" || w.attrs.layer === "22")
      .map((w) => ({ kind: "line" as const, points: wirePoints(w).map((p) => toLocal(flip(xf(p, at, rot)))) }));
    footprints.push({ ref: e.attrs.name, value: e.attrs.value ?? "", lib: `${e.attrs.library}:${pkg.name}`, placement: { x: pos.x, y: pos.y, rot: pcbRot, side }, footprint: { name: pkg.name, pads, silk, courtyard: courtyardOf(pads, silk) }, nets });
  }

  const traces: PcbData["traces"] = [];
  const vias: PcbData["vias"] = [];
  const zones: PcbData["zones"] = [];
  const addWires = (ws: XmlNode[]) => {
    for (const w of ws) {
      const layer = layerOf(Number(w.attrs.layer));
      if (!layer) continue;
      traces.push({ layer, width: num(w, "width", 0.25) || 0.25, points: wirePoints(w).map(flip) });
    }
  };
  for (const s of signals) {
    addWires(xkids(s, "wire"));
    for (const v of xkids(s, "via")) {
      const [a, b] = (v.attrs.extent ?? "1-16").split("-").map(Number);
      const drill = num(v, "drill", 0.3);
      vias.push({ ...flip({ x: num(v, "x"), y: num(v, "y") }), drill, diameter: num(v, "diameter") || drill + 2 * Math.max(0.15, drill * 0.25), from: layerOf(a) ?? undefined, to: layerOf(b) ?? undefined });
    }
    for (const p of xkids(s, "polygon")) {
      const layer = layerOf(Number(p.attrs.layer));
      if (!layer) continue;
      const verts = xkids(p, "vertex");
      // Vertex "curve" bends the edge to the next vertex.
      const pts = verts.flatMap((v, i) => {
        const nx = verts[(i + 1) % verts.length];
        const edge: XmlNode = { tag: "wire", attrs: { x1: v.attrs.x, y1: v.attrs.y, x2: nx.attrs.x, y2: nx.attrs.y, curve: v.attrs.curve ?? "" }, children: [], text: "" };
        return wirePoints(edge).slice(0, -1);
      });
      if (pts.length < 3) continue;
      const rank = num(p, "rank");
      zones.push({ net: s.attrs.name, layer, points: pts.map(flip), ...(p.attrs.pour === "hatch" ? { fill: "hatch" as const, hatchWidth: num(p, "width", 0.25) || 0.25, hatchGap: num(p, "spacing", 1) } : {}), ...(p.attrs.thermals === "no" ? { padConnection: "solid" as const } : {}), ...(rank > 1 ? { priority: 7 - rank } : {}), ...(p.attrs.orphans === "yes" ? { removeIslands: false } : {}) });
    }
  }
  const plain = xkid(board, "plain");
  addWires(xkids(plain, "wire"));
  // Outline: Dimension layer (20) wires chained into closed loops; holes become cutouts.
  const segs = xkids(plain, "wire")
    .filter((w) => w.attrs.layer === "20")
    .flatMap((w) => {
      const pts = wirePoints(w).map(flip);
      return pts.slice(1).map((q, i) => [pts[i], q] as [Vec, Vec]);
    });
  const outline = chain(segs);
  for (const c of xkids(plain, "circle").filter((c) => c.attrs.layer === "20")) {
    const r = num(c, "radius");
    const cc = flip({ x: num(c, "x"), y: num(c, "y") });
    outline.push(Array.from({ length: 32 }, (_, i) => ({ x: r4(cc.x + r * Math.cos((i / 32) * 2 * Math.PI)), y: r4(cc.y + r * Math.sin((i / 32) * 2 * Math.PI)) })));
  }
  for (const h of xkids(plain, "hole")) {
    const r = num(h, "drill") / 2;
    const cc = flip({ x: num(h, "x"), y: num(h, "y") });
    outline.push(Array.from({ length: 16 }, (_, i) => ({ x: r4(cc.x + r * Math.cos((i / 16) * 2 * Math.PI)), y: r4(cc.y + r * Math.sin((i / 16) * 2 * Math.PI)) })));
  }
  const n = 2 + inner.length;
  return { footprints, traces, vias, zones, keepouts: [], outline, thickness: 1.6, layers: Math.max(2, Math.min(32, Math.ceil(n / 2) * 2)) };
}

/** Chain loose segments into closed loops (tolerance 1 µm). */
function chain(segs: [Vec, Vec][]): Vec[][] {
  const key = (p: Vec) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;
  const left = [...segs];
  const loops: Vec[][] = [];
  while (left.length) {
    const [a, b] = left.shift()!;
    const loop = [a, b];
    for (let guard = 0; guard < 100000 && key(loop[loop.length - 1]) !== key(loop[0]); guard++) {
      const end = key(loop[loop.length - 1]);
      const i = left.findIndex(([p, q]) => key(p) === end || key(q) === end);
      if (i < 0) break;
      const [p, q] = left.splice(i, 1)[0];
      loop.push(key(p) === end ? q : p);
    }
    if (loop.length >= 4 && key(loop[loop.length - 1]) === key(loop[0])) loops.push(loop.slice(0, -1));
  }
  return loops;
}

// ---------- schematic ----------

const PIN_LEN: Record<string, number> = { point: 0, short: 2.54, middle: 5.08, long: 7.62 };
const PIN_TYPE: Record<string, SymbolPin["type"]> = { in: "input", out: "output", io: "bidirectional", oc: "open_collector", hiz: "tristate", pas: "passive", pwr: "power_in", sup: "power_out", nc: "nc" };

/** PCBian symbol from the gates of an Eagle device (gates side by side), pins keyed by pad. */
/** A device's symbol: one unit per gate (each in its own frame), and the pads behind each gate pin. */
function deviceSymbol(ds: XmlNode, lib: string, symbols: Map<string, XmlNode>, connects: Map<string, string[]>): { symbol: PartSymbol; pinPads: Map<string, string[]>; gates: string[] } {
  const pinPads = new Map<string, string[]>();
  const units: { name: string; shapes: Shape[]; pins: SymbolPin[] }[] = [];
  const gates = xkids(xkid(ds, "gates"), "gate");
  for (const g of gates) {
    const sym = symbols.get(`${lib}:${g.attrs.symbol}`);
    if (!sym) continue;
    const shapes: Shape[] = [];
    const pins: SymbolPin[] = [];
    units.push({ name: g.attrs.name, shapes, pins });
    const P = (x: number, y: number): Vec => ({ x: r4(x * SK), y: r4(-y * SK) });
    for (const w of xkids(sym, "wire")) if (w.attrs.layer === "94") shapes.push({ kind: "line", points: wirePoints(w).map((p) => P(p.x, p.y)) });
    for (const r of xkids(sym, "rectangle")) {
      const a = P(num(r, "x1"), num(r, "y1"));
      const b = P(num(r, "x2"), num(r, "y2"));
      shapes.push({ kind: "rect", x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
    }
    for (const c of xkids(sym, "circle")) if (c.attrs.layer === "94") shapes.push({ kind: "circle", ...P(num(c, "x"), num(c, "y")), r: num(c, "radius") * SK });
    for (const p of xkids(sym, "pin")) {
      const pads = connects.get(`${g.attrs.name}\u0000${p.attrs.name}`) ?? [];
      if (!pads.length) continue;
      const a = parseRot(p.attrs.rot).angle;
      // Eagle pins point from the connection point into the body.
      const side: PinSide = a === 90 ? "bottom" : a === 180 ? "right" : a === 270 ? "top" : "left";
      const at = P(num(p, "x"), num(p, "y"));
      const name = p.attrs.name.replace(/@\d+$/, "");
      const vis = p.attrs.visible ?? "both";
      pads.forEach((pad, k) =>
        pins.push({ id: pad, name, x: at.x, y: at.y, side, length: k ? 0 : r4((PIN_LEN[p.attrs.length ?? "long"] ?? 7.62) * SK), showName: k === 0 && (vis === "both" || vis === "pin"), showNumber: k === 0 && (vis === "both" || vis === "pad"), type: PIN_TYPE[p.attrs.direction ?? "io"] ?? "passive" }),
      );
      pinPads.set(`${g.attrs.name}\u0000${p.attrs.name}`, pads);
    }
  }
  // Gates without pins (e.g. a supply gate whose pads are all elsewhere) still get a unit so the
  // gate list and the units stay aligned.
  const [u1, ...rest] = units.length ? units : [{ name: "", shapes: [], pins: [] }];
  return { symbol: { shapes: u1.shapes, pins: u1.pins, refPos: { x: 0, y: -12 }, valuePos: { x: 0, y: 14 }, ...(rest.length ? { units: rest } : {}) }, pinPads, gates: units.map((u) => u.name) };
}

function importEagleSchematic(ctx: ImportCtx, text: string) {
  const { doc, report, warnings, pcbByRef, makePart, uidPart, pcbPlacement } = ctx;
  const root = parseXml(text);
  const sch = xpath(root, "eagle/drawing/schematic");
  if (!sch) throw new Error("Not an EAGLE schematic file (.sch)");
  const libs = libraries(sch);
  const sheets = xkids(xkid(sch, "sheets"), "sheet");
  report.sheets = sheets.length;
  const sheetIds: string[] = [];
  // Sheet ids: the document's first sheet, then new ones.
  const first = getDesign(doc).sheets[0].id;
  sheets.forEach((_, i) => sheetIds.push(i === 0 ? first : addSheet(doc, `Sheet ${i + 1}`).id));

  // Parts -> components (placed at their first gate instance).
  const compOf = new Map<string, { id: string; pinPads: Map<string, string[]> }>();
  // Where each gate of each part is placed.
  const instances = new Map<string, { sheet: number; at: Vec; rot: { mirror: boolean; angle: number } }>();
  sheets.forEach((s, si) => {
    for (const inst of xkids(xkid(s, "instances"), "instance")) {
      const k = `${inst.attrs.part}\u0000${inst.attrs.gate}`;
      if (!instances.has(k)) instances.set(k, { sheet: si, at: { x: num(inst, "x"), y: num(inst, "y") }, rot: parseRot(inst.attrs.rot) });
    }
  });
  for (const part of xkids(xkid(sch, "parts"), "part")) {
    const ds = libs.devicesets.get(`${part.attrs.library}:${part.attrs.deviceset}`);
    const dev = ds && xkids(xkid(ds, "devices"), "device").find((d) => (d.attrs.name ?? "") === (part.attrs.device ?? ""));
    if (!ds || !dev) continue;
    // Supply symbols and frames have no package: their nets are named by the pin, nothing to place.
    if (!dev.attrs.package) continue;
    const connects = new Map<string, string[]>();
    for (const c of xkids(xkid(dev, "connects"), "connect")) connects.set(`${c.attrs.gate}\u0000${c.attrs.pin}`, c.attrs.pad.split(/\s+/).filter(Boolean));
    const { symbol, pinPads, gates } = deviceSymbol(ds, part.attrs.library, libs.symbols, connects);
    const board = pcbByRef.get(part.attrs.name);
    const pkg = libs.pkgs.get(`${part.attrs.library}:${dev.attrs.package}`);
    const footprint = board?.footprint ?? (pkg ? footprintFromPackage(pkg.name, pkg.node) : null);
    if (!footprint) warnings.push(`${part.attrs.name}: package ${dev.attrs.package} not found`);
    const prefix = ds.attrs.prefix || (part.attrs.name.match(/^[A-Za-z]+/)?.[0] ?? "U");
    const sig = JSON.stringify([part.attrs.library, part.attrs.deviceset, part.attrs.device, footprint]);
    const p = makePart(sig, () => ({ id: uidPart(), name: `${part.attrs.deviceset}${part.attrs.device ? `-${part.attrs.device}` : ""}`, category: "Imported (EAGLE)", description: `${part.attrs.deviceset} (${part.attrs.library})`, kind: "part", refPrefix: prefix, defaultValue: part.attrs.value ?? part.attrs.deviceset, keywords: ["eagle"], symbol, footprint: footprint && footprint.pads.length ? footprint : null }));
    // One placement per gate (unit); gates that were never placed sit beside the first one.
    const places = gates.map((g, i) => {
      const inst = instances.get(`${part.attrs.name}\u0000${g}`);
      const at = inst ? { x: r4(inst.at.x * SK), y: r4(-inst.at.y * SK) } : null;
      const sheet = sheetIds[inst?.sheet ?? 0];
      return { at, rot: inst ? round90(360 - inst.rot.angle) : (0 as Rotation), mirror: Boolean(inst?.rot.mirror), sheet: sheet === first ? undefined : sheet, i };
    });
    const p0 = places[0] ?? { at: null, rot: 0 as Rotation, mirror: false, sheet: undefined };
    const at0 = p0.at ?? { x: 0, y: 0 };
    const c = addComponent(doc, p.id, at0, { ref: part.attrs.name, value: part.attrs.value ?? part.attrs.deviceset, rot: p0.rot, sheet: p0.sheet, pcb: pcbPlacement(part.attrs.name) });
    updateComponent(doc, c.id, {
      sch: { x: at0.x, y: at0.y, rot: p0.rot, ...(p0.mirror ? { mirror: true } : {}) },
      ...(places.length > 1 ? { units: places.slice(1).map((q) => ({ x: q.at?.x ?? at0.x + 60 * q.i, y: q.at?.y ?? at0.y, rot: q.rot, ...(q.mirror ? { mirror: true } : {}), sheet: q.at ? q.sheet : p0.sheet })) } : {}),
    });
    compOf.set(part.attrs.name, { id: c.id, pinPads });
  }

  // Nets: Eagle lists every pin explicitly; nets with one name join across sheets.
  const netSheets = new Map<string, Map<number, Terminal[]>>();
  sheets.forEach((s, si) => {
    for (const net of xkids(xkid(s, "nets"), "net")) {
      for (const seg of xkids(net, "segment")) {
        for (const pr of xkids(seg, "pinref")) {
          const comp = compOf.get(pr.attrs.part);
          if (!comp) continue;
          const pads = comp.pinPads.get(`${pr.attrs.gate}\u0000${pr.attrs.pin}`) ?? [];
          if (!netSheets.has(net.attrs.name)) netSheets.set(net.attrs.name, new Map());
          const bySheet = netSheets.get(net.attrs.name)!;
          const owner = componentsMap(doc).get(comp.id)!;
          // The sheet this pin's gate (unit) is drawn on.
          const pinSheet = schematicPins(owner).find((x) => x.id === pads[0])?.sheet;
          const sIdx = Math.max(0, sheetIds.indexOf(pinSheet ?? first));
          if (!bySheet.has(sIdx)) bySheet.set(sIdx, []);
          for (const pad of pads) bySheet.get(sIdx)!.push({ comp: comp.id, pin: pad });
        }
      }
    }
  });
  const nets = drawImportedNets(doc, netSheets, (name) => /^N\$\d+$/.test(name), (name) => name.replace("$", "_"));
  report.nets = nets;
  for (const ref of pcbByRef.keys()) if (!compOf.has(ref)) warnings.push(`${ref} is on the board but not in the schematic; it was not imported`);
}

/** Import an EAGLE schematic and/or board into an initialised document. */
export function importEagleProject(doc: Y.Doc, input: EagleImportInput): KicadImportReport {
  const warnings: string[] = [];
  const pcb = input.board ? parseBoard(input.board, warnings) : null;
  return importBoard(doc, pcb, warnings, input.schematic ? (ctx) => importEagleSchematic(ctx, input.schematic!) : undefined, "EAGLE");
}
