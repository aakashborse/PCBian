// Layer stack: layer naming and order, the dielectric stackup, via spans and
// controlled-impedance calculations (IPC-2141 / Wadell closed-form models).
import { MAX_LAYERS, type BoardSettings, type CopperLayer, type Dielectric, type Stackup, type Via } from "./types";

export const OZ_MM = 0.035;

/** Copper layers on a board, front to back. */
export function copperLayers(board: Pick<BoardSettings, "layers">): CopperLayer[] {
  const n = Math.max(2, Math.min(MAX_LAYERS, Math.round((board.layers || 2) / 2) * 2));
  return ["top", ...Array.from({ length: n - 2 }, (_, i) => `in${i + 1}` as CopperLayer), "bottom"];
}

/** Position of a layer in the stack (0 = top); -1 when the board does not have it. */
export function layerIndex(board: Pick<BoardSettings, "layers">, l: CopperLayer): number {
  return copperLayers(board).indexOf(l);
}

export const isCopperLayer = (s: string): s is CopperLayer => s === "top" || s === "bottom" || /^in([1-9]|[12]\d|30)$/.test(s);

export function layerLabel(l: CopperLayer): string {
  return l === "top" ? "Top" : l === "bottom" ? "Bottom" : `Inner ${l.slice(2)}`;
}

/** KiCad layer name (F.Cu, In1.Cu … B.Cu). */
export const kicadLayerName = (l: CopperLayer) => (l === "top" ? "F.Cu" : l === "bottom" ? "B.Cu" : `In${l.slice(2)}.Cu`);
export function fromKicadLayerName(s: string): CopperLayer | null {
  if (s === "F.Cu") return "top";
  if (s === "B.Cu") return "bottom";
  const m = s.match(/^In(\d+)\.Cu$/);
  return m && Number(m[1]) <= MAX_LAYERS - 2 ? (`in${m[1]}` as CopperLayer) : null;
}

/**
 * A conventional symmetric stack for the board thickness: outer 1 oz, inner 0.5 oz, alternating
 * prepreg and core (prepreg on the outside), FR-4 er 4.3 (prepreg 4.0... averaged to 4.2).
 */
export function defaultStackup(layers: number, thickness: number): Stackup {
  const n = copperLayers({ layers }).length;
  const copperOz = Array.from({ length: n }, (_, i) => (i === 0 || i === n - 1 ? 1 : 0.5));
  const copper = copperOz.reduce((a, oz) => a + oz * OZ_MM, 0);
  const mask = 0.02;
  const dielectricTotal = Math.max(0.05 * (n - 1), thickness - copper - 2 * mask);
  const count = n - 1;
  const dielectrics: Dielectric[] = [];
  if (n === 2) dielectrics.push({ thickness: r3(dielectricTotal), er: 4.5, kind: "core" });
  else {
    // Thin prepreg under the outer layers (tight coupling to the first planes), thicker cores inside.
    const outer = Math.min(0.2, dielectricTotal / count);
    const inner = (dielectricTotal - 2 * outer) / Math.max(1, count - 2);
    for (let i = 0; i < count; i++) {
      const isOuter = i === 0 || i === count - 1;
      dielectrics.push({ thickness: r3(isOuter ? outer : inner), er: isOuter ? 4.0 : 4.5, kind: isOuter || i % 2 === 0 ? "prepreg" : "core" });
    }
  }
  // Rounding each layer to the micron drifts the total; the middle dielectric absorbs it.
  const mid = Math.floor(count / 2);
  const drift = dielectricTotal - dielectrics.reduce((a, d) => a + d.thickness, 0);
  dielectrics[mid] = { ...dielectrics[mid], thickness: r3(dielectrics[mid].thickness + drift) };
  return { copperOz, dielectrics, maskThickness: mask, maskEr: 3.8 };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** The board's stackup, regenerated if it does not match the layer count. */
export function stackupOf(board: Pick<BoardSettings, "layers" | "thickness" | "stackup">): Stackup {
  const n = copperLayers(board).length;
  const s = board.stackup;
  if (s && s.copperOz.length === n && s.dielectrics.length === n - 1) return s;
  return defaultStackup(n, board.thickness);
}

export const stackupThickness = (s: Stackup) => s.copperOz.reduce((a, oz) => a + oz * OZ_MM, 0) + s.dielectrics.reduce((a, d) => a + d.thickness, 0) + 2 * (s.maskThickness ?? 0);

// ---------- vias ----------

export type ViaKind = "through" | "blind" | "buried" | "micro";

/** Copper layers a via connects, front to back. */
export function viaLayers(board: Pick<BoardSettings, "layers">, v: Pick<Via, "from" | "to">): CopperLayer[] {
  const all = copperLayers(board);
  let a = v.from ? all.indexOf(v.from) : 0;
  let b = v.to ? all.indexOf(v.to) : all.length - 1;
  if (a < 0) a = 0;
  if (b < 0) b = all.length - 1;
  if (a > b) [a, b] = [b, a];
  return all.slice(a, b + 1);
}

export function viaKind(board: Pick<BoardSettings, "layers">, v: Pick<Via, "from" | "to">): ViaKind {
  const span = viaLayers(board, v);
  const n = copperLayers(board).length;
  if (span.length === n) return "through";
  const outer = span[0] === "top" || span[span.length - 1] === "bottom";
  if (outer && span.length === 2) return "micro";
  return outer ? "blind" : "buried";
}

// ---------- impedance ----------

/** Height of a trace on `layer` above its nearest reference plane(s), plus dielectric constants. */
export function layerGeometry(board: Pick<BoardSettings, "layers" | "thickness" | "stackup">, layer: CopperLayer) {
  const s = stackupOf(board);
  const all = copperLayers(board);
  const i = all.indexOf(layer);
  if (i < 0) throw new Error(`Layer ${layer} is not on this ${all.length}-layer board`);
  const t = s.copperOz[i] * OZ_MM;
  if (i === 0 || i === all.length - 1) {
    const d = s.dielectrics[i === 0 ? 0 : i - 1];
    return { kind: "microstrip" as const, t, h: d.thickness, er: d.er, maskT: s.maskThickness ?? 0, maskEr: s.maskEr ?? 3.8 };
  }
  const above = s.dielectrics[i - 1];
  const below = s.dielectrics[i];
  return { kind: "stripline" as const, t, h1: above.thickness, h2: below.thickness, er: (above.er * above.thickness + below.er * below.thickness) / (above.thickness + below.thickness) };
}

/** Surface microstrip (IPC-2141A), with a first-order soldermask correction. */
export function microstripZ0(w: number, h: number, t: number, er: number, maskT = 0, maskEr = 3.8): number {
  const z = (87 / Math.sqrt(er + 1.41)) * Math.log((5.98 * h) / (0.8 * w + t));
  // Thin soldermask lowers Z by roughly 1-3 ohms; scale by its thickness relative to 25 um.
  return z - (maskT > 0 ? 2 * Math.min(1, maskT / 0.025) * ((maskEr - 1) / 2.8) : 0);
}

/** Symmetric stripline between planes `b` apart (IPC-2141A). */
export function striplineZ0(w: number, b: number, t: number, er: number): number {
  return (60 / Math.sqrt(er)) * Math.log((1.9 * b) / (0.8 * w + t));
}

/** Asymmetric (offset) stripline: parallel combination of the two symmetric cases. */
export function offsetStriplineZ0(w: number, h1: number, h2: number, t: number, er: number): number {
  const z1 = striplineZ0(w, 2 * h1 + t, t, er);
  const z2 = striplineZ0(w, 2 * h2 + t, t, er);
  return (2 * z1 * z2) / (z1 + z2);
}

/** Single-ended impedance of a trace of width `w` (mm) on `layer`. */
export function traceImpedance(board: Pick<BoardSettings, "layers" | "thickness" | "stackup">, layer: CopperLayer, w: number): number {
  const g = layerGeometry(board, layer);
  return g.kind === "microstrip" ? microstripZ0(w, g.h, g.t, g.er, g.maskT, g.maskEr) : offsetStriplineZ0(w, g.h1, g.h2, g.t, g.er);
}

/** Differential impedance of a pair with trace width `w` and edge-to-edge gap `s` (mm). */
export function diffImpedance(board: Pick<BoardSettings, "layers" | "thickness" | "stackup">, layer: CopperLayer, w: number, s: number): number {
  const g = layerGeometry(board, layer);
  const z0 = traceImpedance(board, layer, w);
  if (g.kind === "microstrip") return 2 * z0 * (1 - 0.48 * Math.exp((-0.96 * s) / g.h));
  const b = g.h1 + g.h2 + g.t;
  return 2 * z0 * (1 - 0.347 * Math.exp((-2.9 * s) / b));
}

/** Monotone bisection: impedance falls as width grows. */
function solve(f: (x: number) => number, target: number, lo: number, hi: number): number | null {
  if (!(f(lo) >= target && f(hi) <= target)) return null;
  for (let i = 0; i < 60; i++) {
    const m = (lo + hi) / 2;
    if (f(m) > target) lo = m;
    else hi = m;
  }
  return Math.round(((lo + hi) / 2) * 1e4) / 1e4;
}

/** Trace width (mm) for a target single-ended impedance on a layer, or null if out of range. */
export function widthForImpedance(board: Pick<BoardSettings, "layers" | "thickness" | "stackup">, layer: CopperLayer, z: number): number | null {
  return solve((w) => traceImpedance(board, layer, w), z, 0.02, 5);
}

/** Gap (mm) for a target differential impedance at a given width, or null if out of range. */
export function gapForDiffImpedance(board: Pick<BoardSettings, "layers" | "thickness" | "stackup">, layer: CopperLayer, w: number, zdiff: number): number | null {
  // Zdiff rises with the gap.
  const f = (s: number) => -diffImpedance(board, layer, w, s);
  return solve(f, -zdiff, 0.02, 5);
}
