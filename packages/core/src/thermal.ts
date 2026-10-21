// Steady-state board thermal model: the board as a 2D sheet on a grid. Each cell conducts in-plane
// through its laminate and the copper on every layer (pours, traces and pads, by coverage), and
// loses heat by convection from both faces. Parts inject their dissipated power over their
// footprint (by default the DC simulation's dissipation).
import { analyzeCopper } from "./copper";
import { courtyardCorners, padsOf, pointInPolygon, pointSegmentDistance } from "./geometry";
import { getPart } from "./library";
import { simulateDC } from "./sim";
import { copperLayers, OZ_MM, stackupOf } from "./stackup";
import { boardOutline } from "./doc";
import type { Design, Issue, Vec } from "./types";

const K_CU = 390; // W/m.K
const K_FR4 = 0.3; // W/m.K, in-plane

export interface ThermalOptions {
  /** Power per part (W), by reference; parts not listed use the DC simulation's dissipation. */
  power?: Record<string, number>;
  /** Ambient temperature (°C); default 25. */
  ambient?: number;
  /** Convection coefficient per face (W/m².K); default 10 (still air). */
  h?: number;
  /** Grid pitch (mm); default chosen from the board size. */
  pitch?: number;
  /** Maximum board temperature under a part before it is flagged (°C); default 85. */
  limit?: number;
}

export interface ThermalResult {
  ok: boolean;
  error?: string;
  pitch: number;
  nx: number;
  ny: number;
  /** Temperature per cell (°C), row-major from the board's top-left; NaN outside the board. */
  temps: Float64Array;
  max: number;
  ambient: number;
  totalPower: number;
  parts: { ref: string; power: number; temp: number }[];
  issues: Issue[];
}

export function thermalAnalysis(design: Design, opts: ThermalOptions = {}): ThermalResult {
  const W = design.board.width;
  const H = design.board.height;
  const pitch = opts.pitch ?? Math.max(0.5, Math.sqrt((W * H) / 12000));
  const nx = Math.max(2, Math.ceil(W / pitch));
  const ny = Math.max(2, Math.ceil(H / pitch));
  const ambient = opts.ambient ?? 25;
  const h = opts.h ?? 10;
  const s = stackupOf(design.board);
  const layers = copperLayers(design.board);
  const outline = boardOutline(design.board);
  const holes = design.board.cutouts ?? [];
  const center = (i: number, j: number): Vec => ({ x: (i + 0.5) * pitch, y: (j + 0.5) * pitch });
  const N = nx * ny;
  const onBoard = new Uint8Array(N);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const c = center(i, j);
      if (pointInPolygon(c, outline) && !holes.some((hh) => pointInPolygon(c, hh))) onBoard[j * nx + i] = 1;
    }

  // In-plane sheet conductance of each cell (W/K per square): laminate plus copper by coverage.
  const laminate = K_FR4 * (s.dielectrics.reduce((a, d) => a + d.thickness, 0) / 1000);
  const K = new Float64Array(N).fill(laminate);
  const analysis = analyzeCopper(design);
  for (const l of layers) {
    const tcu = (s.copperOz[layers.indexOf(l)] * OZ_MM) / 1000;
    const covered = new Uint8Array(N);
    for (const z of design.zones) {
      if (z.layer !== l) continue;
      const fill = analysis.fills.get(z.id);
      if (!fill) continue;
      for (let k = 0; k < N; k++) {
        if (!onBoard[k] || covered[k]) continue;
        const c = center(k % nx, Math.floor(k / nx));
        if (fill.polygons.some((isl) => pointInPolygon(c, isl[0]) && !isl.slice(1).some((hh) => pointInPolygon(c, hh)))) covered[k] = 1;
      }
    }
    // Traces cover the cells they pass over in proportion to their width.
    const partial = new Float64Array(N);
    for (const t of design.traces) {
      if (t.layer !== l) continue;
      for (let q = 1; q < t.points.length; q++) {
        const a = t.points[q - 1];
        const b = t.points[q];
        const L = Math.hypot(b.x - a.x, b.y - a.y);
        const steps = Math.max(1, Math.ceil(L / (pitch / 2)));
        const seen = new Set<number>();
        for (let st = 0; st <= steps; st++) {
          const p = { x: a.x + ((b.x - a.x) * st) / steps, y: a.y + ((b.y - a.y) * st) / steps };
          const k = Math.floor(p.y / pitch) * nx + Math.floor(p.x / pitch);
          if (k >= 0 && k < N && !seen.has(k) && pointSegmentDistance(center(k % nx, Math.floor(k / nx)), a, b) < pitch) {
            seen.add(k);
            partial[k] = Math.min(1, partial[k] + t.width / pitch);
          }
        }
      }
    }
    for (const c of design.components)
      for (const p of padsOf(c)) {
        if (!p.layers.includes(l)) continue;
        const k = Math.floor(p.world.y / pitch) * nx + Math.floor(p.world.x / pitch);
        if (k >= 0 && k < N) partial[k] = Math.min(1, partial[k] + (p.ww * p.wh) / (pitch * pitch));
      }
    for (let k = 0; k < N; k++) K[k] += K_CU * tcu * (covered[k] ? 1 : partial[k]);
  }

  // Heat sources.
  const sim = opts.power && design.components.every((c) => !getPart(c.partId)?.footprint || c.ref in opts.power!) ? null : simulateDC(design);
  const simPower = new Map<string, number>();
  if (sim?.ok)
    for (const e of sim.elements) {
      // Simulated units of one part (U1A, U1B) add up to the part.
      const ref = design.components.some((c) => c.ref === e.ref) ? e.ref : e.ref.replace(/[A-Z]$/, "");
      simPower.set(ref, (simPower.get(ref) ?? 0) + Math.abs(e.power));
    }
  const q = new Float64Array(N);
  const parts: { ref: string; power: number; cells: number[] }[] = [];
  for (const c of design.components) {
    const part = getPart(c.partId);
    if (!part?.footprint || c.dnp) continue;
    const P = opts.power?.[c.ref] ?? simPower.get(c.ref) ?? 0;
    const corners = courtyardCorners(c, 0);
    const cells: number[] = [];
    if (corners)
      for (let k = 0; k < N; k++) {
        if (!onBoard[k]) continue;
        if (pointInPolygon(center(k % nx, Math.floor(k / nx)), corners)) cells.push(k);
      }
    if (!cells.length) {
      const k = Math.floor(c.pcb.y / pitch) * nx + Math.floor(c.pcb.x / pitch);
      if (k >= 0 && k < N && onBoard[k]) cells.push(k);
    }
    for (const k of cells) q[k] += P / cells.length;
    parts.push({ ref: c.ref, power: P, cells });
  }
  const totalPower = parts.reduce((a, p) => a + p.power, 0);

  // Conductances: between neighbours (series of half cells), and to ambient from both faces.
  const area = (pitch / 1000) ** 2;
  const gAmb = 2 * h * area;
  const gE = new Float64Array(N);
  const gN = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    if (!onBoard[k]) continue;
    const i = k % nx;
    if (i < nx - 1 && onBoard[k + 1]) gE[k] = (2 * K[k] * K[k + 1]) / (K[k] + K[k + 1]);
    if (k + nx < N && onBoard[k + nx]) gN[k] = (2 * K[k] * K[k + nx]) / (K[k] + K[k + nx]);
  }
  const diag = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    if (!onBoard[k]) continue;
    diag[k] += gAmb + gE[k] + gN[k];
    if (k % nx > 0) diag[k] += gE[k - 1];
    if (k >= nx) diag[k] += gN[k - nx];
  }
  // Conjugate gradients for the temperature rise.
  const mul = (x: Float64Array, out: Float64Array) => {
    for (let k = 0; k < N; k++) {
      if (!onBoard[k]) continue;
      let v = diag[k] * x[k];
      if (k % nx < nx - 1) v -= gE[k] * x[k + 1];
      if (k % nx > 0) v -= gE[k - 1] * x[k - 1];
      if (k + nx < N) v -= gN[k] * x[k + nx];
      if (k >= nx) v -= gN[k - nx] * x[k - nx];
      out[k] = v;
    }
  };
  const x = new Float64Array(N);
  const r = Float64Array.from(q);
  const z = new Float64Array(N);
  const p = new Float64Array(N);
  const Ap = new Float64Array(N);
  let rz = 0;
  for (let k = 0; k < N; k++)
    if (onBoard[k]) {
      z[k] = r[k] / diag[k];
      p[k] = z[k];
      rz += r[k] * z[k];
    }
  const qn = q.reduce((a, v) => a + v * v, 0);
  for (let it = 0; it < 20000 && rz > 0; it++) {
    mul(p, Ap);
    let pAp = 0;
    for (let k = 0; k < N; k++) pAp += p[k] * Ap[k];
    const alpha = rz / pAp;
    let rr = 0;
    let rzn = 0;
    for (let k = 0; k < N; k++) {
      if (!onBoard[k]) continue;
      x[k] += alpha * p[k];
      r[k] -= alpha * Ap[k];
      rr += r[k] * r[k];
      z[k] = r[k] / diag[k];
      rzn += r[k] * z[k];
    }
    if (rr < 1e-24 * Math.max(qn, 1e-30)) break;
    const beta = rzn / rz;
    rz = rzn;
    for (let k = 0; k < N; k++) if (onBoard[k]) p[k] = z[k] + beta * p[k];
  }
  const temps = new Float64Array(N);
  let max = ambient;
  for (let k = 0; k < N; k++) {
    temps[k] = onBoard[k] ? ambient + x[k] : NaN;
    if (onBoard[k]) max = Math.max(max, temps[k]);
  }
  const limit = opts.limit ?? 85;
  const out = parts
    .filter((pp) => pp.cells.length)
    .map((pp) => ({ ref: pp.ref, power: pp.power, temp: Math.max(...pp.cells.map((k) => temps[k])) }))
    .sort((a, b) => b.temp - a.temp);
  const issues: Issue[] = out.filter((o) => o.temp > limit).map((o) => ({ severity: "warning" as const, code: "thermal", message: `${o.ref} sits on board copper at about ${o.temp.toFixed(0)}°C (${o.power.toFixed(2)} W), above ${limit}°C`, refs: [o.ref] }));
  if (sim && !sim.ok && !opts.power) issues.push({ severity: "warning", code: "thermal", message: `No DC simulation (${sim.error}); give part powers to model heat` });
  return { ok: true, pitch, nx, ny, temps, max, ambient, totalPower, parts: out, issues };
}
