// Altium Designer .PcbDoc import (OLE compound file with binary and property-list streams).
// Record layouts follow the community reverse engineering used by KiCad's Altium importer.
// The board becomes the shared intermediate board data; symbols are generated from footprints
// and the pad nets become labels (Altium boards carry every pad's net).
import * as CFB from "cfb";
import type * as Y from "yjs";
import { importBoard, type KicadImportReport, type PcbData, type PcbFootprint } from "./kicad-import";
import { normAngle, rotate } from "./geometry";
import type { CopperLayer, Pad, Vec } from "./types";

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
    if (l > ALTIUM_TOP && l < ALTIUM_BOTTOM) usedMid.add(l);
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
      r.skip(2);
      r.u16(); // net (connectivity comes from the copper itself)
      const polygon = r.u16();
      r.skip(6);
      const a = r.pos2();
      const b = r.pos2();
      const width = r.unit();
      r.pos = start + len;
      // Tracks that belong to a polygon are its hatch/fill primitives, rebuilt from the pour.
      if (polygon !== NONE) continue;
      note(layer);
      if (layer >= ALTIUM_TOP && layer <= ALTIUM_BOTTOM) traces.push({ layer: layer as unknown as CopperLayer, width, points: [a, b] });
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
      r.skip(2);
      r.u16();
      const polygon = r.u16();
      r.skip(6);
      const c = r.pos2();
      const radius = r.unit();
      let sa = r.f64();
      let ea = r.f64();
      const width = r.unit();
      r.pos = start + len;
      if (polygon !== NONE || !(layer >= ALTIUM_TOP && layer <= ALTIUM_BOTTOM)) continue;
      note(layer);
      if (ea < sa) ea += 360;
      const n = Math.max(2, Math.ceil((ea - sa) / 10));
      const pts = Array.from({ length: n + 1 }, (_, k) => {
        const a = ((sa + ((ea - sa) * k) / n) * Math.PI) / 180;
        return { x: r4(c.x + radius * Math.cos(a)), y: r4(c.y - radius * Math.sin(a)) };
      });
      traces.push({ layer: layer as unknown as CopperLayer, width, points: pts });
    }
  }
  const vias: PcbData["vias"] = [];
  const vb = stream(cfb, "Vias6");
  const rawVias: { at: Vec; dia: number; hole: number; a: number; b: number }[] = [];
  if (vb) {
    const r = new Bin(vb);
    while (r.left > 1) {
      if (r.u8() !== 3) throw new Error("Vias6 stream has an unexpected record type");
      const len = r.u32();
      const start = r.pos;
      r.skip(3);
      r.u16();
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
      rawVias.push({ at, dia, hole, a, b });
    }
  }

  const zones: PcbData["zones"] = [];
  const polyb = stream(cfb, "Polygons6");
  if (polyb)
    for (const r = new Bin(polyb); r.left > 4; ) {
      const p = r.props();
      const layer = layerName(p.LAYER_V7 || p.LAYER || "");
      const net = nets[Number(p.NET ?? NONE)];
      const pts = vertices(p);
      note(layer);
      if (!net || pts.length < 3 || !(layer >= ALTIUM_TOP && layer <= ALTIUM_BOTTOM)) continue;
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
        zones.push({ net: nets[net], layer: l as unknown as CopperLayer, points: pts, padConnection: "solid", priority: 1000 });
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
      zones.push({ net: nets[net], layer: layer as unknown as CopperLayer, points: pts, padConnection: "solid", priority: 1000 });
    }
  }

  // Map Altium layer numbers onto PCBian's stack now that the used mid layers are known.
  const mids = [...usedMid].sort((a, b) => a - b);
  const toLayer = (l: number): CopperLayer | null => (l === ALTIUM_TOP ? "top" : l === ALTIUM_BOTTOM ? "bottom" : mids.includes(l) ? (`in${mids.indexOf(l) + 1}` as CopperLayer) : null);
  const fix = <T extends { layer: CopperLayer }>(items: T[]) => items.flatMap((t) => {
    const l = toLayer(t.layer as unknown as number);
    return l ? [{ ...t, layer: l }] : [];
  });
  const outTraces = fix(traces);
  const outZones = fix(zones);
  for (const v of rawVias) vias.push({ ...v.at, diameter: v.dia, drill: v.hole, from: toLayer(v.a) ?? undefined, to: toLayer(v.b) ?? undefined });

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
  const free = pads.filter((p) => p.comp === NONE).length;
  if (free) warnings.push(`${free} free pad(s) outside components were skipped`);

  const outline = vertices(boardProps);
  const copper = 2 + mids.length;
  return { footprints: footprints.filter((f) => f.footprint.pads.length), traces: outTraces, vias, zones: outZones, keepouts: [], outline: outline.length >= 3 ? [outline, ...cutouts] : [], thickness: 1.6, layers: Math.max(2, Math.min(32, Math.ceil(copper / 2) * 2)) };
}

/** Import an Altium .PcbDoc (board, components, copper, pours, outline). */
export function importAltiumPcb(doc: Y.Doc, data: Uint8Array): KicadImportReport {
  const warnings: string[] = [];
  const pcb = parsePcbDoc(data, warnings);
  return importBoard(doc, pcb, warnings, undefined, "Altium");
}
