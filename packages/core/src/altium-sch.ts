// Altium Designer schematic import (.SchDoc, binary "Schematic Capture Binary File Version 5.0").
// Each file's FileHeader stream is a list of |KEY=VALUE| records; child records (pins, graphics,
// designators, parameters, footprint links) point at their component by record index. Records
// are already placed in sheet coordinates, so symbols are recovered in each part's own frame.
// Connectivity is resolved geometrically (wires, junctions, net labels, power ports, ports, sheet
// entries) and redrawn as PCBian nets, like the EAGLE importer does.
import * as CFB from "cfb";
import type * as Y from "yjs";
import { addComponent, addSheet, getDesign, setSchPlacement } from "./doc";
import { normAngle, pointSegmentDistance, rotate } from "./geometry";
import { footprintFromName, importBoard, type ImportCtx, type KicadImportReport, type PcbData } from "./kicad-import";
import { parsePcbDoc } from "./altium-import";
import { drawImportedNets } from "./netdraw";
import { UnionFind } from "./netlist";
import type { PartSymbol, PinSide, Rotation, Shape, SymbolPin, Terminal, Vec } from "./types";

type Rec = Record<string, string>;
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Records of a SchDoc's FileHeader stream (the header record itself excluded). */
export function schDocRecords(data: Uint8Array): Rec[] {
  // ASCII SchDoc: one "|KEY=VALUE|..." record per line, starting with the header.
  if (data[0] === 0x7c) {
    let text = "";
    for (const c of data) text += String.fromCharCode(c);
    const lines = text.split(/\r?\n/).filter((l) => l.includes("="));
    const recs = lines.map((l) => {
      const rec: Rec = {};
      for (const kv of l.split("|")) {
        const k = kv.indexOf("=");
        if (k > 0) rec[kv.slice(0, k).toUpperCase()] = kv.slice(k + 1);
      }
      return rec;
    });
    if (!/Schematic Capture/i.test(recs[0]?.HEADER ?? "")) throw new Error("Not an Altium schematic (unexpected header)");
    return recs.slice(1);
  }
  const cfb = CFB.read(data, { type: "array" });
  const i = cfb.FullPaths.findIndex((p) => /\/FileHeader$/.test(p));
  const content = i >= 0 ? cfb.FileIndex[i]?.content : undefined;
  if (!content) throw new Error("Not an Altium schematic (no FileHeader stream)");
  const buf = new Uint8Array(content as ArrayLike<number>);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: Rec[] = [];
  let pos = 0;
  let first = true;
  while (pos + 4 <= buf.length) {
    const raw = dv.getUint32(pos, true);
    const len = raw & 0xffffff;
    pos += 4;
    const bytes = buf.subarray(pos, pos + len);
    pos += len;
    const rec: Rec = {};
    if (!(raw & 0xff000000)) {
      let s = "";
      for (const c of bytes) if (c) s += String.fromCharCode(c);
      for (const kv of s.split("|")) {
        const k = kv.indexOf("=");
        if (k > 0) rec[kv.slice(0, k).toUpperCase()] = kv.slice(k + 1);
      }
    }
    if (first) {
      first = false;
      if (!/Schematic Capture Binary File/i.test(rec.HEADER ?? "")) throw new Error("Not an Altium schematic (unexpected header)");
      continue;
    }
    out.push(rec);
  }
  return out;
}

/** Altium schematic length (units of 10 mil plus a fraction) in PCBian schematic units (10 mil). */
const u = (r: Rec, k: string) => Number(r[k] ?? 0) + Number(r[`${k}_FRAC`] ?? 0) / 100000;
const ELECTRICAL: SymbolPin["type"][] = ["input", "bidirectional", "output", "open_collector", "passive", "tristate", "open_collector", "power_in"];
/** Pin direction (body to tip) by Altium orientation, in Altium's y-up frame. */
const DIRS: Vec[] = [
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 0, y: -1 },
];

export interface AltiumSchFile {
  name: string;
  data: Uint8Array;
}

interface Placed {
  sheet: number;
  rec: Rec;
  index: number;
  ref: string;
}

/** Import Altium schematics (one PCBian sheet per file) and/or a PcbDoc into an initialised document. */
export function importAltiumProject(doc: Y.Doc, input: { schematics?: AltiumSchFile[]; pcb?: Uint8Array }): KicadImportReport {
  const warnings: string[] = [];
  const pcb: PcbData | null = input.pcb ? parsePcbDoc(input.pcb, warnings) : null;
  const sch = input.schematics?.length ? input.schematics : null;
  return importBoard(doc, pcb, warnings, sch ? (ctx) => importAltiumSchematics(ctx, sch) : undefined, "Altium");
}

function importAltiumSchematics(ctx: ImportCtx, files: AltiumSchFile[]) {
  const { doc, report, warnings, pcbByRef, makePart, uidPart, pcbPlacement } = ctx;
  const parsed = files.map((f) => ({ name: f.name, recs: schDocRecords(f.data) }));
  // A file used by several sheet symbols is a repeated channel: it is imported once per symbol, its
  // parts named REF_<symbol designator> (Altium's default $Component_$RoomName).
  const symbolsOf = new Map<string, string[]>();
  const fileName = new Map(parsed.map((s) => [s.name.toLowerCase(), s.name]));
  for (const s of parsed)
    s.recs.forEach((r, i) => {
      if (r.RECORD !== "15") return;
      const file = (s.recs.find((x) => x.RECORD === "33" && Number(x.OWNERINDEX) === i)?.TEXT ?? "").toLowerCase();
      const des = s.recs.find((x) => x.RECORD === "32" && Number(x.OWNERINDEX) === i)?.TEXT ?? `S${i}`;
      if (!symbolsOf.has(file)) symbolsOf.set(file, []);
      symbolsOf.get(file)!.push(des);
    });
  const repeated = (file: string) => (symbolsOf.get(file.toLowerCase())?.length ?? 0) > 1;
  const sheets: { name: string; recs: Rec[]; channel?: string; portKey: string }[] = parsed.flatMap((s) =>
    repeated(s.name) ? symbolsOf.get(s.name.toLowerCase())!.map((ch) => ({ ...s, channel: ch, portKey: `${s.name.toLowerCase()}#${ch}` })) : [{ ...s, portKey: s.name.toLowerCase() }],
  );
  for (const [file, des] of symbolsOf) if (des.length > 1) warnings.push(`${fileName.get(file) ?? file} is a repeated sheet (${des.join(", ")}): each channel was imported as its own sheet, with parts named REF_${des[0]} and so on`);
  report.sheets = sheets.length;
  const first = getDesign(doc).sheets[0].id;
  const sheetIds = sheets.map((s, i) => (i === 0 ? first : addSheet(doc, s.name.replace(/\.SchDoc$/i, "") + (s.channel ? ` ${s.channel}` : "")).id));
  const hierarchical = sheets.some((s) => s.recs.some((r) => r.RECORD === "15"));
  if (hierarchical) warnings.push("Sheet symbols were flattened: each schematic file became one sheet, and ports join their sheet entries by name");

  // ---- components (multi-part components are grouped by designator) ----
  const byRef = new Map<string, Placed[]>();
  sheets.forEach((s, si) =>
    s.recs.forEach((rec, index) => {
      if (rec.RECORD !== "1") return;
      const des = s.recs.find((r) => r.RECORD === "34" && Number(r.OWNERINDEX) === index)?.TEXT ?? "";
      if (!des) return;
      const ref = s.channel ? `${des}_${s.channel}` : des;
      if (!byRef.has(ref)) byRef.set(ref, []);
      byRef.get(ref)!.push({ sheet: si, rec, index, ref });
    }),
  );

  const UF = new UnionFind();
  // Pin connection points per sheet (collected while components are built).
  const pointsBySheet = new Map<number, { node: string; p: Vec }[]>();
  const sheetPoints = (si: number) => {
    if (!pointsBySheet.has(si)) pointsBySheet.set(si, []);
    return pointsBySheet.get(si)!;
  };
  const pinNode = (si: number, index: number, pin: string) => `pin:${si}:${index}:${pin}`;
  /** PCBian terminal of each Altium pin node. */
  const terminalOf = new Map<string, Terminal>();
  /** Sheet index each component pin is drawn on (multi-part components can span sheets). */
  const pinSheet = new Map<string, number>();
  let hiddenPins = 0;
  const missingFootprints: string[] = [];

  for (const [ref, parts] of byRef) {
    // Each placed part (Altium's gates: U1A, U1B…) becomes one unit, in its own frame.
    const unitSyms: { shapes: Shape[]; pins: SymbolPin[]; pl: Placed }[] = [];
    const pinAt: { node: string; id: string; sheet: number }[] = [];
    const sorted = [...parts].sort((a, b) => Number(a.rec.CURRENTPARTID ?? 1) - Number(b.rec.CURRENTPARTID ?? 1));
    const main = sorted[0];
    for (const pl of sorted) {
      const symbol = { shapes: [] as Shape[], pins: [] as SymbolPin[] };
      const s = sheets[pl.sheet];
      const H = sheetHeight(s.recs);
      const P = (x: number, y: number): Vec => ({ x, y: H - y });
      const part = Number(pl.rec.CURRENTPARTID ?? 1);
      const mode = Number(pl.rec.DISPLAYMODE ?? 0) || 0;
      const owned = s.recs.filter((r) => Number(r.OWNERINDEX) === pl.index && (r.OWNERPARTID === undefined || Number(r.OWNERPARTID) <= 0 || Number(r.OWNERPARTID) === part) && Number(r.OWNERPARTDISPLAYMODE ?? 0) === mode);
      const L = P(u(pl.rec, "LOCATION.X"), u(pl.rec, "LOCATION.Y"));
      const rot = normAngle(360 - Number(pl.rec.ORIENTATION ?? 0) * 90);
      const mirror = pl.rec.ISMIRRORED === "T";
      // Sheet -> part frame (inverse of PCBian's mirror-then-rotate placement).
      const local = (w: Vec): Vec => {
        const q = rotate({ x: w.x - L.x, y: w.y - L.y }, -rot);
        return { x: r4(mirror ? -q.x : q.x), y: r4(q.y) };
      };
      const localDir = (d: Vec): Vec => {
        const q = rotate({ x: d.x, y: -d.y }, -rot);
        return { x: mirror ? -q.x : q.x, y: q.y };
      };
      for (const r of owned) {
        if (r.RECORD === "2") {
          const conglo = Number(r.PINCONGLOMERATE ?? 0);
          const o = conglo & 3;
          const len = u(r, "PINLENGTH");
          const base = { x: u(r, "LOCATION.X"), y: u(r, "LOCATION.Y") };
          const tip = P(base.x + DIRS[o].x * len, base.y + DIRS[o].y * len);
          const id = r.DESIGNATOR || r.NAME || String(unitSyms.reduce((n, x) => n + x.pins.length, 0) + symbol.pins.length + 1);
          if (conglo & 4) hiddenPins++;
          const d = localDir(DIRS[o]);
          const side: PinSide = Math.abs(d.x) > Math.abs(d.y) ? (d.x > 0 ? "right" : "left") : d.y < 0 ? "top" : "bottom";
          const at = local(tip);
          if (!symbol.pins.some((p) => p.id === id) && !unitSyms.some((x) => x.pins.some((p) => p.id === id))) symbol.pins.push({ id, name: (r.NAME ?? id).replace(/\\/g, ""), x: at.x, y: at.y, side, length: r4(len), showName: Boolean(conglo & 8), showNumber: Boolean(conglo & 16), type: ELECTRICAL[Number(r.ELECTRICAL ?? 4)] ?? "passive" });
          const node = pinNode(pl.sheet, pl.index, id);
          pinAt.push({ node, id, sheet: pl.sheet });
          sheetPoints(pl.sheet).push({ node, p: tip });
        } else {
          const sh = shapeOf(r, P, local);
          if (sh) symbol.shapes.push(sh);
        }
      }
      if (symbol.pins.length + symbol.shapes.length) unitSyms.push({ ...symbol, pl });
    }
    if (!unitSyms.some((x) => x.pins.length)) continue;
    const symbol: PartSymbol = {
      shapes: unitSyms[0].shapes,
      pins: unitSyms[0].pins,
      refPos: { x: 0, y: -8 },
      valuePos: { x: 0, y: 8 },
      ...(unitSyms.length > 1 ? { units: unitSyms.slice(1).map((x, i) => ({ name: String.fromCharCode(66 + i), shapes: x.shapes, pins: x.pins })) } : {}),
    };
    const s = sheets[main.sheet];
    const params = s.recs.filter((r) => r.RECORD === "41" && Number(r.OWNERINDEX) === main.index);
    const param = (n: string) => params.find((r) => (r.NAME ?? "").toLowerCase() === n.toLowerCase())?.TEXT;
    let value = param("Value") ?? param("Comment") ?? main.rec.LIBREFERENCE ?? "";
    if (value.startsWith("=")) value = param(value.slice(1)) ?? value.slice(1);
    const model = footprintModel(s.recs, main.index);
    const board = pcbByRef.get(ref);
    const footprint = board?.footprint ?? (model ? footprintFromName(model) : null);
    if (!footprint && !/^#/.test(ref)) missingFootprints.push(`${ref} (${model ?? "none"})`);
    const libref = main.rec.LIBREFERENCE ?? main.rec.DESIGNITEMID ?? "Part";
    const prefix = ref.match(/^[A-Za-z_#]+/)?.[0] ?? "U";
    const sig = JSON.stringify([libref, symbol, footprint]);
    const p = makePart(sig, () => ({ id: uidPart(), name: libref, category: "Imported (Altium)", description: main.rec.COMPONENTDESCRIPTION || libref, kind: "part", refPrefix: prefix, defaultValue: value, keywords: ["altium"], symbol, footprint: footprint && footprint.pads.length ? footprint : null }));
    const c = addComponent(doc, p.id, { x: 0, y: 0 }, { ref, value, pcb: pcbPlacement(ref) });
    // Each unit where Altium placed it.
    unitSyms.forEach(({ pl }, i) => {
      const H = sheetHeight(sheets[pl.sheet].recs);
      const sheet = sheetIds[pl.sheet];
      const sch = { x: r4(u(pl.rec, "LOCATION.X")), y: r4(H - u(pl.rec, "LOCATION.Y")), rot: normAngle(360 - Number(pl.rec.ORIENTATION ?? 0) * 90) as Rotation, ...(pl.rec.ISMIRRORED === "T" ? { mirror: true } : {}) };
      setSchPlacement(doc, c.id, i + 1, sch, sheet === first ? null : sheet);
    });
    for (const { node, id, sheet } of pinAt) {
      terminalOf.set(node, { comp: c.id, pin: id });
      pinSheet.set(`${c.id}\u0000${id}`, sheet);
    }
    report.components++;
  }
  if (missingFootprints.length) warnings.push(`${missingFootprints.length} part(s) have no footprint (import the PcbDoc too, or assign them later): ${missingFootprints.slice(0, 5).join(", ")}${missingFootprints.length > 5 ? ", …" : ""}`);
  if (hiddenPins) warnings.push(`${hiddenPins} hidden pin(s) were imported as ordinary pins (their implicit net connections are not)`);

  // ---- connectivity ----
  sheets.forEach((s, si) => {
    const H = sheetHeight(s.recs);
    const P = (x: number, y: number): Vec => ({ x, y: H - y });
    const wires: Vec[][] = [];
    for (const r of s.recs) {
      if (r.RECORD !== "27") continue;
      const n = Number(r.LOCATIONCOUNT ?? 0);
      const pts: Vec[] = [];
      for (let k = 1; k <= n; k++) pts.push(P(u(r, `X${k}`), u(r, `Y${k}`)));
      if (pts.length >= 2) wires.push(pts);
    }
    const wireNode = (k: number) => `wire:${si}:${k}`;
    wires.forEach((_, k) => UF.find(wireNode(k)));
    const onWire = (p: Vec, w: Vec[]) => w.some((q, i) => i > 0 && pointSegmentDistance(p, w[i - 1], q) < 0.01);
    const touch = (p: Vec, node: string) => {
      wires.forEach((w, k) => {
        if (onWire(p, w)) UF.union(node, wireNode(k));
      });
    };
    // Wire ends landing on another wire (T joints), and junction dots.
    wires.forEach((w, k) => {
      for (const end of [w[0], w[w.length - 1]]) wires.forEach((v, j) => j !== k && onWire(end, v) && UF.union(wireNode(k), wireNode(j)));
    });
    for (const r of s.recs.filter((x) => x.RECORD === "29")) {
      const p = P(u(r, "LOCATION.X"), u(r, "LOCATION.Y"));
      const hit = wires.map((w, k) => (onWire(p, w) ? k : -1)).filter((k) => k >= 0);
      for (const k of hit.slice(1)) UF.union(wireNode(hit[0]), wireNode(k));
    }
    // Pins on wires, and pins touching pins.
    const pins = sheetPoints(si);
    for (const a of pins) {
      touch(a.p, a.node);
      for (const b of pins) if (a !== b && Math.hypot(a.p.x - b.p.x, a.p.y - b.p.y) < 0.01) UF.union(a.node, b.node);
    }
    // Labels, power ports, ports and sheet entries join whatever their hotspot lands on: a wire,
    // a pin end, or another such hotspot.
    const spots: { p: Vec; key: string }[] = [];
    const attach = (p: Vec, key: string) => {
      UF.find(key);
      touch(p, key);
      for (const a of pins) if (Math.hypot(a.p.x - p.x, a.p.y - p.y) < 0.01) UF.union(a.node, key);
      for (const o of spots) if (Math.hypot(o.p.x - p.x, o.p.y - p.y) < 0.01) UF.union(o.key, key);
      spots.push({ p, key });
    };
    const fileKey = s.portKey;
    for (const r of s.recs) {
      const at = () => P(u(r, "LOCATION.X"), u(r, "LOCATION.Y"));
      if (r.RECORD === "17" && r.TEXT) attach(at(), `power:${r.TEXT}`);
      else if (r.RECORD === "25" && r.TEXT) attach(at(), hierarchical ? `label:${si}:${r.TEXT}` : `label:${r.TEXT}`);
      else if (r.RECORD === "18" && r.NAME) {
        const a = at();
        const vertical = [4, 5, 6, 7].includes(Number(r.STYLE ?? 0));
        const w = u(r, "WIDTH");
        const key = hierarchical ? `port:${fileKey}:${r.NAME}` : `label:${r.NAME}`;
        attach(a, key);
        attach(vertical ? { x: a.x, y: a.y + w } : { x: a.x + w, y: a.y }, key);
      } else if (r.RECORD === "16" && r.NAME) {
        const owner = s.recs[Number(r.OWNERINDEX)];
        if (!owner || owner.RECORD !== "15") continue;
        const file = s.recs.find((x) => x.RECORD === "33" && Number(x.OWNERINDEX) === Number(r.OWNERINDEX))?.TEXT ?? "";
        const des = s.recs.find((x) => x.RECORD === "32" && Number(x.OWNERINDEX) === Number(r.OWNERINDEX))?.TEXT ?? "";
        const tl = P(u(owner, "LOCATION.X"), u(owner, "LOCATION.Y"));
        const sx = u(owner, "XSIZE");
        const sy = u(owner, "YSIZE");
        const d = Number(r.DISTANCEFROMTOP ?? 0) * 10 + Number(r.DISTANCEFROMTOP_FRAC1 ?? 0) / 100000;
        const side = Number(r.SIDE ?? 0);
        const p = side === 0 ? { x: tl.x, y: tl.y + d } : side === 1 ? { x: tl.x + sx, y: tl.y + d } : side === 2 ? { x: tl.x + d, y: tl.y } : { x: tl.x + d, y: tl.y + sy };
        attach(p, `port:${file.toLowerCase()}${repeated(file) ? `#${des}` : ""}:${r.NAME}`);
      }
    }
  });

  // ---- nets ----
  const named = new Map<string, string>();
  const rank = (k: string) => (k.startsWith("power:") ? 0 : k.startsWith("label:") ? 1 : 2);
  const keys = [...UF.keys()].filter((k) => /^(power|label|port):/.test(k)).sort((a, b) => rank(a) - rank(b));
  // Distinct nets keep distinct names: a channel's port net takes the channel suffix (Input_CH2).
  const owner = new Map<string, string>();
  for (const k of keys) {
    const root = UF.find(k);
    if (named.has(root)) continue;
    let name = k.replace(/^(power|label):(\d+:)?/, "").replace(/^port:[^:]*:/, "");
    const ch = k.match(/^port:[^:#]*#([^:]*):/)?.[1];
    if (ch) name = `${name}_${ch}`;
    const base = name;
    for (let n = 2; owner.has(name) && owner.get(name) !== root; n++) name = `${base}_${n}`;
    owner.set(name, root);
    named.set(root, name);
  }
  const netSheets = new Map<string, Map<number, Terminal[]>>();
  for (const [node, t] of terminalOf) {
    const root = UF.find(node);
    const ref = getDesign(doc).components.find((c) => c.id === t.comp)?.ref ?? "?";
    const name = named.get(root) ?? `Net${ref}_${t.pin}`;
    if (!named.has(root)) named.set(root, name);
    if (!netSheets.has(name)) netSheets.set(name, new Map());
    const by = netSheets.get(name)!;
    const si = pinSheet.get(`${t.comp}\u0000${t.pin}`) ?? 0;
    if (!by.has(si)) by.set(si, []);
    const list = by.get(si)!;
    if (!list.some((x) => x.comp === t.comp && x.pin === t.pin)) list.push(t);
  }
  // Single-pin auto nets are just unconnected pins.
  for (const [name, by] of netSheets) if (/^Net/.test(name) && [...by.values()].flat().length < 2) netSheets.delete(name);
  report.nets = drawImportedNets(doc, netSheets, (n) => /^Net.+_/.test(n));
  for (const ref of pcbByRef.keys()) if (!byRef.has(ref)) warnings.push(`${ref} is on the board but not in the schematic; it was not imported`);
}

/** Top of the drawing in Altium's y-up frame: everything is flipped against it. */
function sheetHeight(recs: Rec[]): number {
  let max = 0;
  for (const r of recs) for (const k of ["LOCATION.Y", "CORNER.Y", "Y1", "Y2"]) if (r[k] !== undefined) max = Math.max(max, Number(r[k]));
  return Math.ceil((max + 50) / 10) * 10;
}

/** The current PCB footprint model linked to a component (via its implementation list). */
function footprintModel(recs: Rec[], comp: number): string | undefined {
  const lists = new Set(recs.map((r, i) => (r.RECORD === "44" && Number(r.OWNERINDEX) === comp ? i : -1)).filter((i) => i >= 0));
  const models = recs.filter((r) => r.RECORD === "45" && (r.MODELTYPE ?? "").toUpperCase() === "PCBLIB" && (lists.has(Number(r.OWNERINDEX)) || Number(r.OWNERINDEX) === comp));
  return (models.find((m) => m.ISCURRENT === "T") ?? models[0])?.MODELNAME;
}

/** A body graphic of a part, in the part's frame. */
function shapeOf(r: Rec, P: (x: number, y: number) => Vec, local: (w: Vec) => Vec): Shape | null {
  const at = (kx: string, ky: string) => local(P(u(r, kx), u(r, ky)));
  switch (r.RECORD) {
    case "13":
      return { kind: "line", points: [at("LOCATION.X", "LOCATION.Y"), at("CORNER.X", "CORNER.Y")] };
    case "14":
    case "10": {
      const a = at("LOCATION.X", "LOCATION.Y");
      const b = at("CORNER.X", "CORNER.Y");
      return { kind: "rect", x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: r4(Math.abs(b.x - a.x)), h: r4(Math.abs(b.y - a.y)) };
    }
    case "6":
    case "7": {
      const n = Number(r.LOCATIONCOUNT ?? 0);
      const pts: Vec[] = [];
      for (let k = 1; k <= n; k++) pts.push(at(`X${k}`, `Y${k}`));
      if (pts.length < 2) return null;
      return r.RECORD === "7" ? { kind: "polygon", points: pts, fill: r.ISSOLID === "T" } : { kind: "line", points: pts };
    }
    case "8": {
      const c = at("LOCATION.X", "LOCATION.Y");
      return { kind: "circle", x: c.x, y: c.y, r: r4(u(r, "RADIUS")) };
    }
    case "12":
    case "11": {
      const cx = u(r, "LOCATION.X");
      const cy = u(r, "LOCATION.Y");
      const rad = u(r, "RADIUS");
      const a0 = Number(r.STARTANGLE ?? 0);
      let a1 = Number(r.ENDANGLE ?? 360);
      if (a1 <= a0) a1 += 360;
      const n = Math.max(4, Math.ceil((a1 - a0) / 15));
      const pts: Vec[] = [];
      for (let k = 0; k <= n; k++) {
        const a = ((a0 + ((a1 - a0) * k) / n) * Math.PI) / 180;
        pts.push(local(P(cx + rad * Math.cos(a), cy + rad * Math.sin(a))));
      }
      return { kind: "line", points: pts };
    }
    default:
      return null;
  }
}
