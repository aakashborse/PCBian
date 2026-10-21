// 2D electrostatic field solver for transmission-line cross-sections: finite-volume Laplace on a
// graded rectilinear mesh, solved by conjugate gradients. Capacitance per length comes from the
// field energy, with the real dielectrics and with air, giving Z0 = 1 / (c * sqrt(C * C_air)) and
// eps_eff = C / C_air (quasi-TEM). Coupled lines are solved in odd and even mode.
import { copperLayers, OZ_MM, stackupOf } from "./stackup";
import type { BoardSettings, CopperLayer } from "./types";

const EPS0 = 8.8541878128e-12; // F/m
const C0 = 299792458; // m/s

export interface Region {
  x0?: number;
  x1?: number;
  y0: number;
  y1: number;
}
/** A dielectric region (later ones override earlier ones where they overlap); elsewhere is air. */
export interface DielectricRegion extends Region {
  er: number;
}
/** A conductor: "ground" is held at 0 V, "a" and "b" are the line(s) driven by each mode. */
export interface ConductorRegion extends Region {
  net: "ground" | "a" | "b";
}
export interface CrossSection {
  dielectrics: DielectricRegion[];
  conductors: ConductorRegion[];
  /** Solution box (mm); its edges are open (no normal flux). */
  bounds: { x0: number; x1: number; y0: number; y1: number };
  /** Smallest mesh step (mm) near edges. */
  minStep: number;
}

export interface FieldSolution {
  /** Single-ended (or odd-mode for a pair) characteristic impedance, ohms. */
  z0: number;
  eeff: number;
  /** For pairs: odd/even mode impedances and differential (2 x odd) / common (even / 2). */
  zodd?: number;
  zeven?: number;
  zdiff?: number;
  zcommon?: number;
  /** Capacitance per metre (F/m) in the solved mode(s). */
  capacitance: number;
  /** Mesh size used, for reporting. */
  nodes: number;
}

/** Grid lines through every key coordinate, graded from fine near them to coarse between. */
function gradedLines(keys: number[], lo: number, hi: number, hmin: number, hmax: number, ratio = 1.3): number[] {
  const ks = [...new Set([lo, hi, ...keys.filter((k) => k > lo && k < hi)].map((k) => Math.round(k * 1e9) / 1e9))].sort((a, b) => a - b);
  const out: number[] = [ks[0]];
  for (let i = 1; i < ks.length; i++) {
    const a = ks[i - 1];
    const b = ks[i];
    const len = b - a;
    // Steps growing from both ends toward the middle.
    const left: number[] = [];
    const right: number[] = [];
    let h = hmin;
    let used = 0;
    while (used + 2 * h < len) {
      left.push(h);
      right.push(h);
      used += 2 * h;
      h = Math.min(hmax, h * ratio);
    }
    const rest = len - used;
    const steps = [...left, ...(rest > 1e-12 ? [rest] : []), ...right.reverse()];
    // Avoid a needlessly tiny middle step by merging it into its neighbour.
    let x = a;
    for (const s of steps) {
      x += s;
      out.push(x);
    }
    out[out.length - 1] = b;
  }
  return out;
}

const inside = (r: Region, x: number, y: number, eps = 1e-9) => x >= (r.x0 ?? -Infinity) - eps && x <= (r.x1 ?? Infinity) + eps && y >= r.y0 - eps && y <= r.y1 + eps;

interface Mesh {
  xs: number[];
  ys: number[];
  /** Conductor index per node, -1 when free. */
  fixed: Int32Array;
  /** Edge conductances (relative permittivity x length ratio) to the east and north neighbour. */
  ge: Float64Array;
  gn: Float64Array;
}

function buildMesh(cs: CrossSection, air: boolean): Mesh {
  const { bounds: B, minStep } = cs;
  const xk = cs.conductors.flatMap((c) => [c.x0, c.x1]).filter((v): v is number => v !== undefined);
  const yk = [...cs.conductors.flatMap((c) => [c.y0, c.y1]), ...cs.dielectrics.flatMap((d) => [d.y0, d.y1])];
  const xkD = cs.dielectrics.flatMap((d) => [d.x0, d.x1]).filter((v): v is number => v !== undefined);
  const span = Math.max(B.x1 - B.x0, B.y1 - B.y0);
  const xs = gradedLines([...xk, ...xkD], B.x0, B.x1, minStep, span / 25);
  const ys = gradedLines(yk, B.y0, B.y1, minStep, span / 25);
  const nx = xs.length;
  const ny = ys.length;
  const fixed = new Int32Array(nx * ny).fill(-1);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = cs.conductors.findIndex((c) => inside(c, xs[i], ys[j]));
      fixed[j * nx + i] = k;
    }
  // Cell permittivity at cell centres.
  const er = new Float64Array((nx - 1) * (ny - 1)).fill(1);
  if (!air)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const cx = (xs[i] + xs[i + 1]) / 2;
        const cy = (ys[j] + ys[j + 1]) / 2;
        for (const d of cs.dielectrics) if (inside(d, cx, cy, 0)) er[j * (nx - 1) + i] = d.er;
      }
  const cell = (i: number, j: number) => (i < 0 || j < 0 || i >= nx - 1 || j >= ny - 1 ? 0 : er[j * (nx - 1) + i]);
  const ge = new Float64Array(nx * ny);
  const gn = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      if (i < nx - 1) {
        const dx = xs[i + 1] - xs[i];
        const below = j > 0 ? ys[j] - ys[j - 1] : 0;
        const above = j < ny - 1 ? ys[j + 1] - ys[j] : 0;
        ge[j * nx + i] = (cell(i, j - 1) * below + cell(i, j) * above) / 2 / dx;
      }
      if (j < ny - 1) {
        const dy = ys[j + 1] - ys[j];
        const left = i > 0 ? xs[i] - xs[i - 1] : 0;
        const right = i < nx - 1 ? xs[i + 1] - xs[i] : 0;
        gn[j * nx + i] = (cell(i - 1, j) * left + cell(i, j) * right) / 2 / dy;
      }
    }
  return { xs, ys, fixed, ge, gn };
}

/**
 * Potentials with each conductor at its given voltage (Jacobi-preconditioned conjugate gradients),
 * and the field energy as sum(G * dV^2) (so C = EPS0 * that / V^2 for a single excitation).
 */
function solveMesh(m: Mesh, volts: number[]): number {
  const nx = m.xs.length;
  const ny = m.ys.length;
  const N = nx * ny;
  // Vectors are padded by a row on each side so neighbour lookups never leave the array; the
  // conductance to a missing neighbour is zero.
  const P = nx;
  const v = new Float64Array(N + 2 * P);
  const isFree = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    if (m.fixed[k] >= 0) v[k + P] = volts[m.fixed[k]];
    else isFree[k] = 1;
  }
  const gE = new Float64Array(N);
  const gW = new Float64Array(N);
  const gN = new Float64Array(N);
  const gS = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    const i = k % nx;
    gE[k] = i < nx - 1 ? m.ge[k] : 0;
    gW[k] = i > 0 ? m.ge[k - 1] : 0;
    gN[k] = k + nx < N ? m.gn[k] : 0;
    gS[k] = k >= nx ? m.gn[k - nx] : 0;
  }
  const diag = new Float64Array(N);
  const b = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    if (!isFree[k]) continue;
    diag[k] = gE[k] + gW[k] + gN[k] + gS[k];
    // Fixed neighbours move to the right-hand side.
    const q = k + P;
    b[k] = (isFree[k + 1] ? 0 : gE[k] * v[q + 1]) + (isFree[k - 1] ? 0 : gW[k] * v[q - 1]) + (isFree[k + nx] ? 0 : gN[k] * v[q + nx]) + (isFree[k - nx] ? 0 : gS[k] * v[q - nx]);
  }
  // CG on free nodes; fixed entries of the search vector stay zero.
  const x = new Float64Array(N + 2 * P);
  const r = new Float64Array(N);
  const z = new Float64Array(N);
  const p = new Float64Array(N + 2 * P);
  const Ap = new Float64Array(N);
  let rz = 0;
  let bnorm = 0;
  // Symmetric Gauss-Seidel preconditioner: z = (D - U)^-1 D (D - L)^-1 r.
  const y = new Float64Array(N + 2 * P);
  const zp = new Float64Array(N + 2 * P);
  const precondition = () => {
    for (let k = 0; k < N; k++) {
      if (!isFree[k]) continue;
      const q = k + P;
      y[q] = (r[k] + gW[k] * y[q - 1] + gS[k] * y[q - nx]) / diag[k];
    }
    for (let k = N - 1; k >= 0; k--) {
      if (!isFree[k]) continue;
      const q = k + P;
      zp[q] = y[q] + (gE[k] * zp[q + 1] + gN[k] * zp[q + nx]) / diag[k];
      z[k] = zp[q];
    }
  };
  for (let k = 0; k < N; k++) {
    if (!isFree[k]) continue;
    r[k] = b[k];
    bnorm += b[k] * b[k];
  }
  precondition();
  for (let k = 0; k < N; k++) {
    if (!isFree[k]) continue;
    p[k + P] = z[k];
    rz += r[k] * z[k];
  }
  const tol = 1e-14 * Math.max(bnorm, 1e-30);
  for (let it = 0; it < 50000 && rz > 0; it++) {
    let pAp = 0;
    for (let k = 0; k < N; k++) {
      if (!isFree[k]) continue;
      const q = k + P;
      const a = diag[k] * p[q] - gE[k] * p[q + 1] - gW[k] * p[q - 1] - gN[k] * p[q + nx] - gS[k] * p[q - nx];
      Ap[k] = a;
      pAp += p[q] * a;
    }
    if (pAp <= 0) break;
    const alpha = rz / pAp;
    let rr = 0;
    let rzNew = 0;
    for (let k = 0; k < N; k++) {
      if (!isFree[k]) continue;
      x[k + P] += alpha * p[k + P];
      r[k] -= alpha * Ap[k];
      rr += r[k] * r[k];
    }
    if (rr < tol) break;
    precondition();
    for (let k = 0; k < N; k++) if (isFree[k]) rzNew += r[k] * z[k];
    const beta = rzNew / rz;
    rz = rzNew;
    for (let k = 0; k < N; k++) if (isFree[k]) p[k + P] = z[k] + beta * p[k + P];
  }
  for (let k = 0; k < N; k++) if (isFree[k]) v[k + P] = x[k + P];
  let w = 0;
  for (let k = 0; k < N; k++) {
    const q = k + P;
    w += gE[k] * (v[q + 1] - v[q]) ** 2 + gN[k] * (v[q + nx] - v[q]) ** 2;
  }
  return w;
}

/** Solve a cross-section with one line ("a") or a pair ("a", "b"). */
export function solveCrossSection(cs: CrossSection): FieldSolution {
  const pair = cs.conductors.some((c) => c.net === "b");
  const voltsFor = (va: number, vb: number) => cs.conductors.map((c) => (c.net === "a" ? va : c.net === "b" ? vb : 0));
  const meshD = buildMesh(cs, false);
  const meshA = buildMesh(cs, true);
  const nodes = meshD.xs.length * meshD.ys.length;
  // Lengths are in mm, but G is a ratio of lengths, so EPS0 * G is per metre directly.
  const cap = (m: Mesh, va: number, vb: number) => EPS0 * solveMesh(m, voltsFor(va, vb));
  const z = (c: number, ca: number) => 1 / (C0 * Math.sqrt(c * ca));
  if (!pair) {
    const c = cap(meshD, 1, 0);
    const ca = cap(meshA, 1, 0);
    return { z0: z(c, ca), eeff: c / ca, capacitance: c, nodes };
  }
  // Odd mode (+1, -1): energy = C_odd (per line); even mode (+1, +1): energy = C_even.
  const co = cap(meshD, 1, -1) / 2;
  const coa = cap(meshA, 1, -1) / 2;
  const ce = cap(meshD, 1, 1) / 2;
  const cea = cap(meshA, 1, 1) / 2;
  const zodd = z(co, coa);
  const zeven = z(ce, cea);
  return { z0: zodd, eeff: co / coa, zodd, zeven, zdiff: 2 * zodd, zcommon: zeven / 2, capacitance: co, nodes };
}

/**
 * The cross-section of a trace (or a pair, when `gap` is given) on a board layer, from the
 * stackup: the reference planes are the neighbouring copper layers; outer layers get the
 * soldermask over the trace and the laminate.
 */
export function layerCrossSection(board: Pick<BoardSettings, "layers" | "thickness" | "stackup">, layer: CopperLayer, w: number, gap?: number): CrossSection {
  const s = stackupOf(board);
  const all = copperLayers(board);
  const i = all.indexOf(layer);
  if (i < 0) throw new Error(`Layer ${layer} is not on this ${all.length}-layer board`);
  const t = s.copperOz[i] * OZ_MM;
  const lines = gap === undefined ? [{ net: "a" as const, x0: -w / 2, x1: w / 2 }] : [{ net: "a" as const, x0: -gap / 2 - w, x1: -gap / 2 }, { net: "b" as const, x0: gap / 2, x1: gap / 2 + w }];
  const outer = i === 0 || i === all.length - 1;
  const dielectrics: DielectricRegion[] = [];
  const conductors: ConductorRegion[] = [];
  let top: number;
  let h: number;
  if (outer) {
    // Mirror bottom-layer traces so the plane is always below: same geometry.
    const d = s.dielectrics[i === 0 ? 0 : i - 1];
    h = d.thickness;
    const tp = s.copperOz[i === 0 ? 1 : i - 1] * OZ_MM;
    conductors.push({ net: "ground", y0: -tp, y1: 0 });
    dielectrics.push({ y0: 0, y1: h, er: d.er });
    const mt = s.maskThickness ?? 0;
    if (mt > 0) {
      const mer = s.maskEr ?? 3.8;
      dielectrics.push({ y0: h, y1: h + mt, er: mer });
      for (const l of lines) dielectrics.push({ x0: l.x0 - mt, x1: l.x1 + mt, y0: h, y1: h + t + mt, er: mer });
    }
    for (const l of lines) conductors.push({ ...l, y0: h, y1: h + t });
    top = h + t + Math.max(mt, 0) + 12 * h;
  } else {
    const above = s.dielectrics[i - 1];
    const below = s.dielectrics[i];
    h = Math.min(above.thickness, below.thickness);
    // Below: dielectric `below` from the lower plane up to the trace; above: `above` over it.
    conductors.push({ net: "ground", y0: -0.035, y1: 0 });
    dielectrics.push({ y0: 0, y1: below.thickness, er: below.er });
    dielectrics.push({ y0: below.thickness, y1: below.thickness + t + above.thickness, er: above.er });
    for (const l of lines) conductors.push({ ...l, y0: below.thickness, y1: below.thickness + t });
    const yTop = below.thickness + t + above.thickness;
    conductors.push({ net: "ground", y0: yTop, y1: yTop + 0.035 });
    top = yTop + 0.035;
  }
  const xext = Math.max(...lines.map((l) => Math.abs(l.x1)), ...lines.map((l) => Math.abs(l.x0)));
  const margin = Math.max(12 * h, 3 * w);
  const minStep = Math.min(t, w, gap ?? Infinity, h) / 6;
  return { dielectrics, conductors, bounds: { x0: -xext - margin, x1: xext + margin, y0: conductors[0].y0, y1: top }, minStep };
}

/** Field-solved impedance of a trace (or a pair, when `gap` is given) on a board layer. */
export function fieldSolveImpedance(board: Pick<BoardSettings, "layers" | "thickness" | "stackup">, layer: CopperLayer, w: number, gap?: number): FieldSolution {
  return solveCrossSection(layerCrossSection(board, layer, w, gap));
}

/**
 * Width (mm) giving a target field-solved impedance (single-ended, or differential when `gap` is
 * given), by the secant method from the closed-form estimate; null when it does not converge.
 */
export function fieldWidthForImpedance(board: Pick<BoardSettings, "layers" | "thickness" | "stackup">, layer: CopperLayer, target: number, gap?: number, guess = 0.2): number | null {
  const z = (w: number) => {
    const r = fieldSolveImpedance(board, layer, w, gap);
    return (gap === undefined ? r.z0 : r.zdiff!) - target;
  };
  let a = Math.max(0.03, guess);
  let b = a * 1.25;
  let fa = z(a);
  let fb = z(b);
  for (let i = 0; i < 12; i++) {
    if (Math.abs(fb) < 0.05) return Math.round(b * 1e4) / 1e4;
    if (fb === fa) return null;
    // Impedance is close to linear in log(width); step there, clamped to a sane range.
    const la = Math.log(a);
    const lb = Math.log(b);
    const next = Math.exp(Math.min(Math.log(10), Math.max(Math.log(0.01), lb - (fb * (lb - la)) / (fb - fa))));
    [a, fa] = [b, fb];
    b = next;
    fb = z(b);
  }
  return Math.abs(fb) < 0.5 ? Math.round(b * 1e4) / 1e4 : null;
}
