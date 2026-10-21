// Altium Designer .PcbDoc import (OLE compound file with binary and property-list streams).
// Record layouts follow the community reverse engineering used by KiCad's Altium importer.
// The board becomes the shared intermediate board data; symbols are generated from footprints
// and the pad nets become labels (Altium boards carry every pad's net).
import * as CFB from "cfb";
import type * as Y from "yjs";
import { importBoard, type KicadImportReport, type PcbData, type PcbFootprint } from "./kicad-import";
import { normAngle, rotate } from "./geometry";
import { ALL_COPPER, type CopperLayer, type Pad, type Vec } from "./types";

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
/** Altium internal unit = 1/10000 mil. */
const IU = 0.00000254;
const NONE = 0xffff;

class Bin {
  pos = 0;
  private dv: DataView;
  constructor(private buf: Uint8Array) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  get left() {
    return this.buf.length - this.pos;
  }
  u8() {
    return this.dv.getUint8(this.pos++);
  }
  u16() {
    const v = this.dv.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32() {
    const v = this.dv.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  i32() {
    const v = this.dv.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f64() {
    const v = this.dv.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  skip(n: number) {
    this.pos += n;
  }
  /** Length-prefixed (u8) Latin-1 string. */
  str() {
    const n = this.u8();
    const s = latin1(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }
  unit() {
    return this.i32() * IU;
  }
  /** Position in mm with y flipped to point down. */
  pos2(): Vec {
    const x = this.unit();
    const y = -this.unit();
    return { x, y };
  }
  /** Property list record: u32 length then "|KEY=VALUE|..." text. */
  props(): Record<string, string> {
    const raw = this.u32();
    const len = raw & 0xffffff;
    const bytes = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    if (raw & 0xff000000) return {};
    const out: Record<string, string> = {};
    for (const kv of latin1(bytes).replace(/\0+$/, "").split("|")) {
      const i = kv.indexOf("=");
      if (i > 0) out[kv.slice(0, i).toUpperCase()] = kv.slice(i + 1);
    }
    return out;
  }
}

const latin1 = (b: Uint8Array) => {
  let s = "";
  for (const c of b) s += String.fromCharCode(c);
  return s;
};

/** "12.5mil", "1.27mm" or bare internal units -> mm. */
function unit(v: string | undefined, d = 0): number {
  if (!v) return d;
  const m = v.trim().match(/^([-\d.eE+]+)\s*(mil|mm|in)?$/i);
  if (!m) return d;
  const n = Number(m[1]);
  const u = (m[2] ?? "").toLowerCase();
  return u === "mm" ? n : u === "in" ? n * 25.4 : u === "mil" ? n * 0.0254 : n * IU;
}

/** Outline from VXi/VYi (KINDi = 1 marks an arc around CXi/CYi from SAi to EAi). */
function vertices(p: Record<string, string>): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; p[`VX${i}`] !== undefined; i++) {
    const v = { x: unit(p[`VX${i}`]), y: -unit(p[`VY${i}`]) };
    if (p[`KIND${i}`] === "1") {
      const c = { x: unit(p[`CX${i}`]), y: -unit(p[`CY${i}`]) };
      const r = unit(p[`R${i}`]);
      let sa = Number(p[`SA${i}`] ?? 0);
      let ea = Number(p[`EA${i}`] ?? 0);
      if (ea < sa) ea += 360;
      // Altium angles are CCW with y up; flipping y negates them. Walk from the end that meets
      // the vertex so the outline stays continuous.
      const steps = Math.max(2, Math.ceil((ea - sa) / 10));
      const pts = Array.from({ length: steps + 1 }, (_, k) => {
        const a = ((sa + ((ea - sa) * k) / steps) * Math.PI) / 180;
        return { x: c.x + r * Math.cos(a), y: c.y - r * Math.sin(a) };
      });
      const near = (q: Vec) => Math.hypot(q.x - v.x, q.y - v.y);
      out.push(...(near(pts[0]) <= near(pts[pts.length - 1]) ? pts : pts.reverse()));
    } else out.push(v);
  }
  return out.map((q) => ({ x: r4(q.x), y: r4(q.y) }));
}

function stream(cfb: CFB.CFB$Container, name: string): Uint8Array | null {
  const i = cfb.FullPaths.findIndex((p) => p.endsWith(`/${name}/Data`));
  const e = i >= 0 ? cfb.FileIndex[i] : undefined;
  return e?.content ? new Uint8Array(e.content as ArrayLike<number>) : null;
}

const ALTIUM_TOP = 1;
const ALTIUM_BOTTOM = 32;
const ALTIUM_MULTI = 74;
const ALTIUM_PLANE1 = 39;
const ALTIUM_PLANE16 = 54;
const isPlane = (l: number) => l >= ALTIUM_PLANE1 && l <= ALTIUM_PLANE16;
/** Signal layers and internal planes. */
const isCopper = (l: number) => (l >= ALTIUM_TOP && l <= ALTIUM_BOTTOM) || isPlane(l);

function layerName(s: string): number {
  const u = s.toUpperCase();
  if (u === "TOP") return ALTIUM_TOP;
  if (u === "BOTTOM") return ALTIUM_BOTTOM;
  if (u === "MULTILAYER") return ALTIUM_MULTI;
  const m = u.match(/^MID(\d+)$/);
  if (m) return 1 + Number(m[1]);
  const p = u.match(/^PLANE(\d+)$/);
  return p ? 38 + Number(p[1]) : 0;
}

export function parsePcbDoc(data: Uint8Array, warnings: string[]): PcbData {
  const cfb = CFB.read(data, { type: "array" });
  const need = (n: string) => {
    const s = stream(cfb, n);
    if (!s) throw new Error(`Not an Altium PcbDoc (missing ${n} stream)`);
    return new Bin(s);
  };

  const boardProps = need("Board6").props();
  const nets: string[] = [];
  const nb = stream(cfb, "Nets6");
  if (nb) for (const r = new Bin(nb); r.left > 4; ) nets.push(r.props().NAME ?? "");
  const netField = (n: number) => (n !== NONE && nets[n] ? { net: nets[n] } : {});

  interface Comp {
    ref: string;
    pattern: string;
    value: string;
    at: Vec;
    rot: number;
    side: "top" | "bottom";
  }
  const comps: Comp[] = [];
  const cb = stream(cfb, "Components6");
  if (cb)
    for (const r = new Bin(cb); r.left > 4; ) {
      const p = r.props();
      comps.push({ ref: p.SOURCEDESIGNATOR || `U${comps.length + 1}`, pattern: p.PATTERN ?? "Footprint", value: p.SOURCELIBREFERENCE ?? p.COMMENT ?? "", at: { x: unit(p.X), y: -unit(p.Y) }, rot: Number(p.ROTATION ?? 0), side: p.LAYER?.toUpperCase() === "BOTTOM" ? "bottom" : "top" });
    }

  // Copper layers in use (mid layers 2-31, planes 39-54), in stack order.
  const usedMid = new Set<number>();
  const note = (l: number) => {
    if ((l > ALTIUM_TOP && l < ALTIUM_BOTTOM) || isPlane(l)) usedMid.add(l);
  };

  interface RawPad {
    name: string;
    layer: number;
    net: number;
    comp: number;
    at: Vec;
    size: Vec;
    hole: number;
    shape: number;
    dir: number;
  }
  const pads: RawPad[] = [];
  const pb = stream(cfb, "Pads6");
  if (pb) {
    const r = new Bin(pb);
    while (r.left > 1) {
      if (r.u8() !== 2) throw new Error("Pads6 stream has an unexpected record type");
      r.u32();
      const name = r.str();
      for (let k = 0; k < 3; k++) r.skip(r.u32());
      const len = r.u32();
      const start = r.pos;
      const layer = r.u8();
      r.skip(2);
      const net = r.u16();
      r.skip(2);
      const comp = r.u16();
      r.skip(4);
      const at = r.pos2();
      const size = { x: r.unit(), y: r.unit() };
      r.skip(16); // mid and bottom sizes
      const hole = r.unit();
      const shape = r.u8();
      r.skip(2);
      const dir = r.f64();
      r.pos = start + len;
      r.skip(r.u32()); // subrecord 6
      pads.push({ name, layer, net, comp, at, size, hole, shape, dir });
    }
  }

  const traces: PcbData["traces"] = [];
  const tb = stream(cfb, "Tracks6");
  if (tb) {
    const r = new Bin(tb);
    while (r.left > 1) {
      if (r.u8() !== 4) throw new Error("Tracks6 stream has an unexpected record type");
      const len = r.u32();
      const start = r.pos;
      const layer = r.u8();
      r.skip(1);
      const keepout = r.u8() === 2;
      const net = r.u16();
      const polygon = r.u16();
      r.skip(6);
      const a = r.pos2();
      const b = r.pos2();
      const width = r.unit();
      r.pos = start + len;
      // Tracks that belong to a polygon are its hatch/fill primitives, rebuilt from the pour;
      // keepout tracks are restrictions, not copper.
      if (polygon !== NONE || keepout) continue;
      note(layer);
      if (layer >= ALTIUM_TOP && layer <= ALTIUM_BOTTOM) traces.push({ layer: layer as unknown as CopperLayer, width, points: [a, b], ...netField(net) });
    }
  }
  const ab = stream(cfb, "Arcs6");
  if (ab) {
    const r = new Bin(ab);
    while (r.left > 1) {
      if (r.u8() !== 1) throw new Error("Arcs6 stream has an unexpected record type");
      const len = r.u32();
      const start = r.pos;
      const layer = r.u8();
      r.skip(1);
      const keepout = r.u8() === 2;
      const net = r.u16();
      const polygon = r.u16();
      r.skip(6);
      const c = r.pos2();
      const radius = r.unit();
      let sa = r.f64();
      let ea = r.f64();
      const width = r.unit();
      r.pos = start + len;
      if (polygon !== NONE || keepout || !(layer >= ALTIUM_TOP && layer <= ALTIUM_BOTTOM)) continue;
      note(layer);
      if (ea < sa) ea += 360;
      const n = Math.max(2, Math.ceil((ea - sa) / 10));
      const pts = Array.from({ length: n + 1 }, (_, k) => {
        const a = ((sa + ((ea - sa) * k) / n) * Math.PI) / 180;
        return { x: r4(c.x + radius * Math.cos(a)), y: r4(c.y - radius * Math.sin(a)) };
      });
      traces.push({ layer: layer as unknown as CopperLayer, width, points: pts, ...netField(net) });
    }
  }
  const vias: PcbData["vias"] = [];
  const vb = stream(cfb, "Vias6");
  const rawVias: { at: Vec; dia: number; hole: number; a: number; b: number; net: number }[] = [];
  if (vb) {
    const r = new Bin(vb);
    while (r.left > 1) {
      if (r.u8() !== 3) throw new Error("Vias6 stream has an unexpected record type");
      const len = r.u32();
      const start = r.pos;
      r.skip(3);
      const net = r.u16();
      r.skip(2);
      r.u16();
      r.skip(4);
      const at = r.pos2();
      const dia = r.unit();
      const hole = r.unit();
      const a = r.u8();
      const b = r.u8();
      r.pos = start + len;
      note(a);
      note(b);
      rawVias.push({ at, dia, hole, a, b, net });
    }
  }

  const zones: PcbData["zones"] = [];
  const planePolys: { net: string; layer: number; points: Vec[] }[] = [];
  const polyb = stream(cfb, "Polygons6");
  if (polyb)
    for (const r = new Bin(polyb); r.left > 4; ) {
      const p = r.props();
      const layer = layerName(p.LAYER_V7 || p.LAYER || "");
      const net = nets[Number(p.NET ?? NONE)];
      const pts = vertices(p);
      note(layer);
      if (!net || pts.length < 3 || !isCopper(layer)) continue;
      if (isPlane(layer)) {
        // Internal planes: the largest polygon is the plane itself, the others are split islands on top of it.
        planePolys.push({ net, layer, points: pts });
        continue;
      }
      const hatch = p.HATCHSTYLE && p.HATCHSTYLE !== "Solid" && p.HATCHSTYLE !== "None";
      zones.push({ net, layer: layer as unknown as CopperLayer, points: pts, ...(hatch ? { fill: "hatch" as const, hatchWidth: unit(p.TRACKWIDTH, 0.25), hatchGap: Math.max(0.2, unit(p.GRIDSIZE, 1) - unit(p.TRACKWIDTH, 0.25)) } : {}), ...(Number(p.POURINDEX) ? { priority: Math.max(0, 100 - Number(p.POURINDEX)) } : {}) });
    }

  // Solid copper regions (not pour fills, which come back from the polygon outlines) and board cutouts.
  const cutouts: Vec[][] = [];
  const rb = stream(cfb, "Regions6");
  if (rb) {
    const r = new Bin(rb);
    while (r.left > 1) {
      if (r.u8() !== 11) throw new Error("Regions6 stream has an unexpected record type");
      const len = r.u32();
      const start = r.pos;
      const layer = r.u8();
      r.u8();
      const keepout = r.u8() === 2;
      const net = r.u16();
      const polygon = r.u16();
      r.u16();
      r.skip(5);
      const holes = r.u16();
      r.skip(2);
      const p = r.props();
      const n = r.u32();
      const pts: Vec[] = [];
      for (let k = 0; k < n; k++) {
        const x = r.f64() * IU;
        const y = -r.f64() * IU;
        pts.push({ x: r4(x), y: r4(y) });
      }
      for (let h = 0; h < holes; h++) r.skip(r.u32() * 16);
      r.pos = start + len;
      const kind = Number(p.KIND ?? 0);
      const l = layerName(p.V7_LAYER ?? "") || layer;
      if (kind === 0 && /^true$/i.test(p.ISBOARDCUTOUT ?? "")) cutouts.push(pts);
      else if (kind === 0 && !keepout && polygon === NONE && net !== NONE && nets[net] && l >= ALTIUM_TOP && l <= ALTIUM_BOTTOM && pts.length >= 3) {
        note(l);
        zones.push({ net: nets[net], layer: l as unknown as CopperLayer, points: pts, padConnection: "solid", priority: 1000, raw: true });
      }
    }
  }
  const fb = stream(cfb, "Fills6");
  if (fb) {
    const r = new Bin(fb);
    while (r.left > 1) {
      if (r.u8() !== 6) throw new Error("Fills6 stream has an unexpected record type");
      const len = r.u32();
      const start = r.pos;
      const layer = r.u8();
      r.u8();
      const keepout = r.u8() === 2;
      const net = r.u16();
      r.skip(8);
      const a = r.pos2();
      const b = r.pos2();
      const rot = r.f64();
      r.pos = start + len;
      if (keepout || net === NONE || !nets[net] || !(layer >= ALTIUM_TOP && layer <= ALTIUM_BOTTOM)) continue;
      note(layer);
      const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const hw = Math.abs(b.x - a.x) / 2;
      const hh = Math.abs(b.y - a.y) / 2;
      const t = (-rot * Math.PI) / 180;
      const pts = [
        [-hw, -hh],
        [hw, -hh],
        [hw, hh],
        [-hw, hh],
      ].map(([x, y]) => ({ x: r4(c.x + x * Math.cos(t) - y * Math.sin(t)), y: r4(c.y + x * Math.sin(t) + y * Math.cos(t)) }));
      zones.push({ net: nets[net], layer: layer as unknown as CopperLayer, points: pts, padConnection: "solid", priority: 1000, raw: true });
    }
  }

  // Map Altium layer numbers onto PCBian's stack now that the used mid layers are known.
  // Inner layers in stack order, following Board6's layer chain from the top (planes interleave with
  // mid layers); layers the chain does not reach keep their numeric order after it.
  const chain: number[] = [];
  for (let l = Number(boardProps.LAYER1NEXT ?? 0), guard = 0; l && l !== ALTIUM_BOTTOM && guard < 100; l = Number(boardProps[`LAYER${l}NEXT`] ?? 0), guard++) chain.push(l);
  const rank = (l: number) => (chain.includes(l) ? chain.indexOf(l) : 1000 + l);
  const mids = [...usedMid].sort((a, b) => rank(a) - rank(b));
  const toLayer = (l: number): CopperLayer | null => (l === ALTIUM_TOP ? "top" : l === ALTIUM_BOTTOM ? "bottom" : mids.includes(l) ? (`in${mids.indexOf(l) + 1}` as CopperLayer) : null);
  const fix = <T extends { layer: CopperLayer }>(items: T[]) => items.flatMap((t) => {
    const l = toLayer(t.layer as unknown as number);
    return l ? [{ ...t, layer: l }] : [];
  });
  const outTraces = fix(traces);
  const outZones = fix(zones);
  const area = (pts: Vec[]) => Math.abs(pts.reduce((acc, p, i) => acc + p.x * pts[(i + 1) % pts.length].y - pts[(i + 1) % pts.length].x * p.y, 0)) / 2;
  for (const plane of new Set(planePolys.map((p) => p.layer))) {
    const polys = planePolys.filter((p) => p.layer === plane).sort((a, b) => area(b.points) - area(a.points));
    const layer = toLayer(plane);
    // Splits rank by size (smaller wins) so neighbouring splits keep clearance from each other.
    if (layer) polys.forEach((p, i) => outZones.push({ net: p.net, layer, points: p.points, priority: i }));
  }
  for (const v of rawVias) vias.push({ ...v.at, diameter: v.dia, drill: v.hole, from: toLayer(v.a) ?? undefined, to: toLayer(v.b) ?? undefined, ...netField(v.net) });

  // Footprints: pads are stored in board coordinates; recover the local frame from each component.
  const footprints: PcbFootprint[] = comps.map((c, i) => {
    const pcbRot = normAngle(360 - c.rot);
    const toLocal = (w: Vec): Vec => {
      const l = rotate({ x: w.x - c.at.x, y: w.y - c.at.y }, -pcbRot);
      return { x: r4(c.side === "bottom" ? -l.x : l.x), y: r4(l.y) };
    };
    const own = pads.filter((p) => p.comp === i && p.name);
    const fpPads: Pad[] = [];
    const netMap = new Map<string, string>();
    for (const p of own) {
      // Pad angle relative to the footprint (mirrored on the bottom): quarter turns swap the size,
      // anything else is kept as the pad's own rotation.
      const rel = normAngle(c.side === "bottom" ? p.dir - c.rot : c.rot - p.dir);
      const q = Math.round(rel / 90);
      const axis = Math.abs(rel - q * 90) < 0.01;
      const [w, h] = axis && q % 2 !== 0 ? [p.size.y, p.size.x] : [p.size.x, p.size.y];
      const l = toLocal(p.at);
      const shape: Pad["shape"] = p.shape === 1 ? (Math.abs(w - h) < 1e-6 ? "circle" : "oval") : "rect";
      if (fpPads.some((q) => q.id === p.name)) continue;
      fpPads.push({ id: p.name, x: l.x, y: l.y, w: r4(w), h: r4(h), shape, ...(axis ? {} : { rot: r4(rel) }), ...(p.hole > 0 ? { drill: r4(p.hole) } : {}) });
      const net = nets[p.net];
      if (p.net !== NONE && net) netMap.set(p.name, net);
    }
    const xs = fpPads.flatMap((p) => [Math.abs(p.x) + p.w / 2]);
    const ys = fpPads.flatMap((p) => [Math.abs(p.y) + p.h / 2]);
    return {
      ref: c.ref,
      value: c.value,
      lib: c.pattern,
      placement: { x: r4(c.at.x), y: r4(c.at.y), rot: pcbRot, side: c.side },
      footprint: { name: c.pattern, pads: fpPads, silk: [], courtyard: { w: r4(2 * (Math.max(0.5, ...xs) + 0.25)), h: r4(2 * (Math.max(0.5, ...ys) + 0.25)) } },
      nets: netMap,
    };
  });
  // Free pads (not part of a component: test points, stitching and thermal pads) become copper
  // areas on their layers, plus a via for the hole when they are drilled.
  const allLayers = [...new Set([ALTIUM_TOP, ...mids, ALTIUM_BOTTOM].map(toLayer).filter((l): l is CopperLayer => !!l))];
  let freeSkipped = 0;
  let freeAreas = 0;
  for (const p of pads.filter((q) => q.comp === NONE)) {
    const net = p.net !== NONE ? nets[p.net] : undefined;
    const layers = p.layer === ALTIUM_MULTI ? allLayers : [toLayer(p.layer)].filter((l): l is CopperLayer => !!l);
    if (net && layers.length) {
      const outline = padOutline(p.at, p.size.x, p.size.y, p.shape === 1, normAngle(-p.dir));
      for (const layer of layers) outZones.push({ net, layer, points: outline, padConnection: "solid", priority: 1000, raw: true });
      freeAreas++;
    }
    if (p.hole > 0) vias.push({ ...p.at, diameter: Math.max(p.hole + 0.1, Math.min(p.size.x, p.size.y)), drill: p.hole, ...(net ? { net } : {}) });
    else if (!net && layers.length) freeSkipped++;
  }
  if (freeAreas) warnings.push(`${freeAreas} free pad(s) outside components were imported as copper areas`);
  if (freeSkipped) warnings.push(`${freeSkipped} free copper pad(s) with no net and no hole were skipped`);

  // Rooms become named rule areas and the file's rules become custom design rules.
  const { rules, rooms } = altiumRules(cfb, warnings);
  const keepouts: PcbData["keepouts"] = rooms.map((r) => ({ name: r.name, points: r.points, layers: [...ALL_COPPER], noTracks: false, noVias: false, noPours: false }));
  const outline = vertices(boardProps);
  const copper = 2 + mids.length;
  return { footprints: footprints.filter((f) => f.footprint.pads.length), traces: outTraces, vias, zones: outZones, keepouts, rules, outline: outline.length >= 3 ? [outline, ...cutouts] : [], thickness: 1.6, layers: Math.max(2, Math.min(32, Math.ceil(copper / 2) * 2)) };
}

/** Import an Altium .PcbDoc (board, components, copper, pours, outline). */
export function importAltiumPcb(doc: Y.Doc, data: Uint8Array): KicadImportReport {
  const warnings: string[] = [];
  const pcb = parsePcbDoc(data, warnings);
  return importBoard(doc, pcb, warnings, undefined, "Altium");
}

// ---------- design rules ----------

/** Translate an Altium query (rule scope) into a rule condition about item A or B; throws on unsupported terms. */
export function altiumQuery(q: string, obj: "A" | "B", netClasses: Map<string, string[]> = new Map()): string {
  const toks = q.match(/'[^']*'|[A-Za-z_]\w*|[()]|,|\S/g) ?? [];
  let i = 0;
  const arg = () => {
    if (toks[i] !== "(") throw new Error(`${toks[i - 1]} needs an argument`);
    const a = (toks[i + 1] ?? "").replace(/^'|'$/g, "");
    i += 3;
    return a.replace(/'/g, "");
  };
  const out: string[] = [];
  while (i < toks.length) {
    const t = toks[i++];
    const l = t.toLowerCase();
    if (t === "(" || t === ")") out.push(t);
    else if (l === "and") out.push("&&");
    else if (l === "or") out.push("||");
    else if (l === "not") out.push("!");
    else if (l === "all" || l === "true") out.push("true");
    else if (l === "false") out.push("false");
    else if (l === "innet") out.push(`${obj}.NetName == '${arg()}'`);
    else if (l === "innetclass") {
      // Altium nets may sit in several classes, so expand the class into its member nets.
      const members = netClasses.get(arg()) ?? [];
      out.push(members.length ? `(${members.map((n) => `${obj}.NetName == '${n.replace(/'/g, "")}'`).join(" || ")})` : "false");
    }
    else if (l === "incomponent") out.push(`${obj}.Reference == '${arg()}'`);
    else if (l === "hasfootprint" || l === "infootprint") out.push(`${obj}.Footprint == '${arg()}'`);
    else if (l === "withinroom") out.push(`${obj}.insideArea('${arg()}')`);
    else if (l === "touchesroom") out.push(`${obj}.intersectsArea('${arg()}')`);
    else if (l === "ispad") out.push(`${obj}.Type == 'pad'`);
    else if (l === "isvia") out.push(`${obj}.Type == 'via'`);
    else if (l === "istrack" || l === "isarc") out.push(`${obj}.Type == 'track'`);
    else if (l === "ontoplayer") out.push(`${obj}.Layer == 'top'`);
    else if (l === "onbottomlayer") out.push(`${obj}.Layer == 'bottom'`);
    // Pours, regions, silkscreen and plated-hole terms never match the copper the DRC checks here.
    else if (/^(isregion|ispolygon|inpoly|inpolygon|isfill|ontopsilkscreen|onbottomsilkscreen|ontopoverlay|onbottomoverlay|ismechanical)$/.test(l)) out.push("false");
    else throw new Error(`unsupported query term ${t}`);
  }
  return out.join(" ");
}

function altiumRules(cfb: CFB.CFB$Container, warnings: string[]): { rules: string; rooms: { name: string; points: Vec[] }[] } {
  const rb = stream(cfb, "Rules6");
  const rooms: { name: string; points: Vec[] }[] = [];
  if (!rb) return { rules: "", rooms };
  const netClasses = new Map<string, string[]>();
  const cl = stream(cfb, "Classes6");
  if (cl) {
    for (const r = new Bin(cl); r.left > 4; ) {
      const p = r.props();
      if (p.KIND !== "0" || !p.NAME) continue;
      const names: string[] = [];
      for (let i = 0; p[`M${i}`] !== undefined; i++) names.push(p[`M${i}`]);
      netClasses.set(p.NAME, names);
    }
  }
  const all: Record<string, string>[] = [];
  for (const r = new Bin(rb); r.left > 6; ) {
    r.skip(2);
    all.push(r.props());
  }
  const lines: { pri: number; text: string }[] = [];
  let skipped = 0;
  for (const p of all) {
    if (p.ENABLED === "FALSE") continue;
    const kind = p.RULEKIND ?? "";
    const name = (p.NAME ?? kind).replace(/"/g, "'");
    if (kind === "RoomDefinition") {
      const pts = vertices(p);
      if (pts.length >= 3) rooms.push({ name: p.NAME ?? `Room${rooms.length + 1}`, points: pts });
      continue;
    }
    const map: Record<string, () => string | null> = {
      Clearance: () => `(constraint clearance (min ${mm(p.GENERICCLEARANCE ?? p.GAP)}))`,
      BoardOutlineClearance: () => `(constraint edge_clearance (min ${mm(p.GENERICCLEARANCE ?? p.GAP)}))`,
      Width: () => (p.MINLIMIT || p.MAXLIMIT ? `(constraint track_width${p.MINLIMIT ? ` (min ${mm(p.MINLIMIT)})` : ""}${p.MAXLIMIT ? ` (max ${mm(p.MAXLIMIT)})` : ""})` : null),
      RoutingVias: () => (p.MINWIDTH ? `(constraint via_diameter (min ${mm(p.MINWIDTH)}))` : null),
      HoleSize: () => (p.MINLIMIT || p.MAXLIMIT ? `(constraint hole_size${p.MINLIMIT ? ` (min ${mm(p.MINLIMIT)})` : ""}${p.MAXLIMIT ? ` (max ${mm(p.MAXLIMIT)})` : ""})` : null),
    };
    const make = map[kind];
    if (!make) continue;
    try {
      const constraint = make();
      if (!constraint) continue;
      const pair = kind === "Clearance";
      const a = altiumQuery(p.SCOPE1EXPRESSION ?? "All", "A", netClasses);
      const b = pair ? altiumQuery(p.SCOPE2EXPRESSION ?? "All", "B", netClasses) : "true";
      const cond = [a, b].filter((x) => x !== "true").map((x) => `(${x})`).join(" && ");
      const pri = Number(p.PRIORITY ?? 1);
      lines.push({ pri, text: `(rule "${name}"${cond ? ` (condition "${cond}")` : ""} ${constraint})` });
      // Per-object-type clearances (e.g. track-to-track tighter than the generic value) refine the rule.
      if (pair && p.OBJECTCLEARANCES) {
        const generic = unit(p.GENERICCLEARANCE ?? p.GAP);
        for (const entry of p.OBJECTCLEARANCES.split(";")) {
          const m = entry.trim().match(/^ClearanceObj_(\w+)-ClearanceObj_(\w+):(\d+)$/);
          const ta = m && OBJ_TYPE[m[1]];
          const tb = m && OBJ_TYPE[m[2]];
          if (!m || !ta || !tb) continue;
          const v = Number(m[3]) * IU;
          if (Math.abs(v - generic) < 1e-6) continue;
          const types = `(A.${ta} && B.${tb})`;
          lines.push({ pri, text: `(rule "${name} ${m[1]}-${m[2]}" (condition "${cond ? `${cond} && ` : ""}${types}") (constraint clearance (min ${Math.round(v * 10000) / 10000}mm)))` });
        }
      }
    } catch {
      skipped++;
    }
  }
  // Altium checks only objects inside some rule's scope; mirror that for every imported kind
  // that has no unscoped rule, so PCBian's own defaults do not apply there.
  for (const kind of ["clearance", "edge_clearance", "track_width", "via_diameter", "hole_size"]) {
    const of = lines.filter((l) => l.text.includes(`(constraint ${kind} `));
    if (of.length && !of.some((l) => !l.text.includes("(condition"))) lines.push({ pri: Infinity, text: `(rule "Outside Altium ${kind} scopes" (constraint ${kind}${kind.endsWith("clearance") ? " (min 0mm)" : ""}))` });
  }
  if (skipped) warnings.push(`${skipped} Altium design rule(s) use query terms PCBian does not support and were skipped`);
  // Altium priority 1 is the strongest; PCBian lets later rules win, so the strongest goes last.
  lines.sort((x, y) => y.pri - x.pri);
  const rules = lines.length ? `# Imported from Altium (strongest rule last)\n${lines.map((l) => l.text).join("\n")}\n` : "";
  return { rules, rooms };
}

/** Altium clearance object kinds as rule-condition tests on one item (pours and holes are not paired here). */
const OBJ_TYPE: Record<string, string> = {
  Track: "Type == 'track'",
  Arc: "Type == 'track'",
  Via: "Type == 'via'",
  SMDPad: "PadType == 'smd'",
  THPad: "PadType == 'thru'",
};

const mm = (v: string | undefined) => `${Math.round(unit(v) * 10000) / 10000}mm`;

/** Outline of a pad (rectangle, or a round/oblong pad as a polygon) centred at `at`, turned by `angle`. */
function padOutline(at: Vec, w: number, h: number, round: boolean, angle: number): Vec[] {
  const local: Vec[] = [];
  if (!round) local.push({ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 });
  else {
    // Stadium: two semicircles joined along the long side (a circle when w == h).
    const r = Math.min(w, h) / 2;
    const dx = w / 2 - r;
    const dy = h / 2 - r;
    const n = 12;
    const arc = (cx: number, cy: number, a0: number) => {
      for (let k = 0; k <= n; k++) {
        const a = a0 + (Math.PI * k) / n;
        local.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
      }
    };
    if (w >= h) {
      arc(dx, 0, -Math.PI / 2);
      arc(-dx, 0, Math.PI / 2);
    } else {
      arc(0, dy, 0);
      arc(0, -dy, Math.PI);
    }
  }
  return local.map((q) => {
    const v = rotate(q, angle);
    return { x: r4(at.x + v.x), y: r4(at.y + v.y) };
  });
}
