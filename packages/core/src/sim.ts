// DC operating-point circuit simulation (modified nodal analysis with Newton-Raphson
// for diodes). Supply rails come from power-symbol net names such as +5V, +3V3, VBUS.
import { getPart } from "./library";
import { computeNets, netByTerminal, termKey } from "./netlist";
import type { ComponentData, Design } from "./types";

const PREFIX: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };

/** Parse engineering values: 10k, 4k7, 4.7k, 100nF, 330R, 2R2, 1M, 500mA. */
export function parseValue(raw: string): number | null {
  const s = raw.trim().replace(/\s+/g, "").replace(/(Ω|ohms?|F|H|A|V|W)$/i, "");
  let m = s.match(/^(\d+)([pnuµmkKMGR])(\d+)$/);
  if (m) return Number(`${m[1]}.${m[3]}`) * (m[2] === "R" ? 1 : PREFIX[m[2]]);
  m = s.match(/^(\d*\.?\d+)([pnuµmkKMGR]?)$/);
  if (m) return Number(m[1]) * (m[2] === "" || m[2] === "R" ? 1 : PREFIX[m[2]]);
  return null;
}

/** Voltage implied by a rail name: +5V, 5V, +3V3, 3.3V, 1V8, -12V, VBUS. */
export function railVoltage(name: string): number | null {
  const n = name.trim().toUpperCase();
  if (/^VBUS$|^USB_?5V$/.test(n)) return 5;
  let m = n.match(/^([+-])?(\d+)V(\d+)$/);
  if (m) return (m[1] === "-" ? -1 : 1) * Number(`${m[2]}.${m[3]}`);
  m = n.match(/^([+-])?(\d*\.?\d+)V$/);
  if (m) return (m[1] === "-" ? -1 : 1) * Number(m[2]);
  return null;
}

export const isGroundNet = (name: string) => /^(A|D|P|SIG)?GND$|^VSS$|^0V$/i.test(name.trim());

type Element =
  | { kind: "R"; ref: string; a: number; b: number; r: number; ratedW?: number; label: string }
  | { kind: "D"; ref: string; a: number; k: number; is: number; nvt: number; label: string; led: boolean }
  | { kind: "V"; ref: string; p: number; n: number; v: number; label: string };

export interface SimElementResult {
  ref: string;
  label: string;
  /** Current through the element in amps (anode->cathode, a->b, + -> - inside). */
  current: number;
  voltage: number;
  power: number;
}

export interface SimResult {
  ok: boolean;
  error?: string;
  nodes: { net: string; voltage: number }[];
  elements: SimElementResult[];
  supplies: { name: string; voltage: number; current: number; power: number }[];
  warnings: string[];
  notModeled: string[];
  iterations: number;
}

const VT = 0.02585;

function diodeParams(c: ComponentData): { vf: number; n: number; led: boolean } {
  const id = c.partId;
  if (id.startsWith("led")) {
    const v = c.value.toLowerCase();
    const vf = /blue|white|uv|pink|purple/.test(v) ? 3.0 : /green/.test(v) ? 2.1 : /yellow|orange|amber/.test(v) ? 2.0 : 1.9;
    return { vf, n: 2, led: true };
  }
  if (id.startsWith("schottky")) return { vf: 0.35, n: 1.5, led: false };
  return { vf: 0.7, n: 1.8, led: false };
}

const RATED_W: Record<string, number> = { "0402": 0.0625, "0603": 0.1, "0805": 0.125, "1206": 0.25 };

export function simulateDC(design: Design): SimResult {
  const nets = computeNets(design);
  const netOf = netByTerminal(nets);
  const empty: SimResult = { ok: false, nodes: [], elements: [], supplies: [], warnings: [], notModeled: [], iterations: 0 };
  const ground = nets.find((n) => isGroundNet(n.name));
  if (!ground) return { ...empty, error: "No ground net. Add a GND power symbol so the simulator has a reference." };

  // Node numbering: ground = -1, others 0..n-1.
  const nodeIdx = new Map<string, number>();
  const node = (net: string | undefined) => {
    if (!net || net === ground.name) return -1;
    if (!nodeIdx.has(net)) nodeIdx.set(net, nodeIdx.size);
    return nodeIdx.get(net)!;
  };
  const pinNet = (c: ComponentData, pin: string) => netOf.get(termKey({ comp: c.id, pin }));
  const elements: Element[] = [];
  const notModeled: string[] = [];
  const warnings: string[] = [];

  for (const n of nets) {
    const v = railVoltage(n.name);
    if (v !== null && n.named) elements.push({ kind: "V", ref: n.name, p: node(n.name), n: -1, v, label: `${n.name} supply` });
  }

  for (const c of design.components) {
    const part = getPart(c.partId);
    if (!part || part.kind !== "part" || c.dnp) continue;
    const id = c.partId;
    const n1 = () => node(pinNet(c, "1"));
    const n2 = () => node(pinNet(c, "2"));
    if (id.startsWith("resistor")) {
      const r = parseValue(c.value);
      if (!r || r <= 0) {
        warnings.push(`${c.ref}: cannot parse resistance "${c.value}"`);
        continue;
      }
      elements.push({ kind: "R", ref: c.ref, a: n1(), b: n2(), r, ratedW: RATED_W[part.footprint?.name ?? ""], label: `${c.ref} ${c.value}` });
    } else if (id.startsWith("ferrite") || id.startsWith("inductor")) {
      elements.push({ kind: "R", ref: c.ref, a: n1(), b: n2(), r: 0.05, label: `${c.ref} ${c.value}` });
    } else if (id.startsWith("fuse")) {
      elements.push({ kind: "R", ref: c.ref, a: n1(), b: n2(), r: 0.1, label: `${c.ref} ${c.value}` });
    } else if (id.startsWith("led") || id.startsWith("diode") || id.startsWith("schottky")) {
      const { vf, n, led } = diodeParams(c);
      const nvt = n * VT;
      elements.push({ kind: "D", ref: c.ref, a: n2(), k: n1(), is: 0.01 / Math.exp(vf / nvt), nvt, label: `${c.ref} ${c.value}`, led });
    } else if (id.startsWith("capacitor") || id.startsWith("crystal") || id.startsWith("button") || id.startsWith("header") || id.startsWith("usb")) {
      // Open circuit at DC (connectors are just nodes).
    } else if (id.startsWith("ams1117")) {
      const v = parseValue(c.value.replace(/^.*-/, "")) ?? 3.3;
      const vin = pinNet(c, "3");
      const vinV = vin ? railVoltage(vin) : null;
      if (vinV !== null && vinV < v + 1.1) warnings.push(`${c.ref}: input ${vinV}V is below the ~${(v + 1.1).toFixed(1)}V needed for regulation`);
      elements.push({ kind: "V", ref: c.ref, p: node(pinNet(c, "2")), n: node(pinNet(c, "1")), v, label: `${c.ref} output` });
    } else {
      notModeled.push(`${c.ref} (${part.name})`);
    }
  }

  const n = nodeIdx.size;
  const sources = elements.filter((e): e is Extract<Element, { kind: "V" }> => e.kind === "V");
  // Two sources forcing the same node pair would make the matrix singular; keep the first.
  const seen = new Set<string>();
  const vs = sources.filter((s) => {
    const k = `${Math.min(s.p, s.n)}:${Math.max(s.p, s.n)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const size = n + vs.length;
  if (n === 0) return { ...empty, error: "Nothing to simulate: the circuit has no nodes besides ground." };

  let x = new Float64Array(size);
  let iterations = 0;
  let converged = false;
  for (; iterations < 300; iterations++) {
    const A = Array.from({ length: size }, () => new Float64Array(size));
    const z = new Float64Array(size);
    const gmin = 1e-12;
    for (let i = 0; i < n; i++) A[i][i] += gmin;
    const stampG = (a: number, b: number, g: number) => {
      if (a >= 0) A[a][a] += g;
      if (b >= 0) A[b][b] += g;
      if (a >= 0 && b >= 0) {
        A[a][b] -= g;
        A[b][a] -= g;
      }
    };
    const stampI = (a: number, b: number, i: number) => {
      // Current i flowing from a to b through the element.
      if (a >= 0) z[a] -= i;
      if (b >= 0) z[b] += i;
    };
    const V = (k: number) => (k < 0 ? 0 : x[k]);
    for (const e of elements) {
      if (e.kind === "R") stampG(e.a, e.b, 1 / e.r);
      else if (e.kind === "D") {
        const vd = Math.min(V(e.a) - V(e.k), 40 * e.nvt * 1.5);
        const ex = Math.exp(vd / e.nvt);
        const id = e.is * (ex - 1);
        const gd = (e.is / e.nvt) * ex + 1e-12;
        stampG(e.a, e.k, gd);
        stampI(e.a, e.k, id - gd * vd);
      }
    }
    vs.forEach((s, j) => {
      const row = n + j;
      if (s.p >= 0) {
        A[s.p][row] += 1;
        A[row][s.p] += 1;
      }
      if (s.n >= 0) {
        A[s.n][row] -= 1;
        A[row][s.n] -= 1;
      }
      z[row] = s.v;
    });
    const next = solve(A, z);
    if (!next) return { ...empty, error: "The circuit matrix is singular (two supplies shorted together, or a floating supply loop)." };
    // Damp diode voltage steps for robust convergence.
    let maxDelta = 0;
    for (let i = 0; i < size; i++) maxDelta = Math.max(maxDelta, Math.abs(next[i] - x[i]));
    const damp = maxDelta > 0.5 && iterations > 0 ? 0.5 / maxDelta : 1;
    const blended = new Float64Array(size);
    for (let i = 0; i < size; i++) blended[i] = x[i] + (next[i] - x[i]) * damp;
    x = blended;
    if (maxDelta < 1e-9) {
      converged = true;
      break;
    }
  }
  if (!converged) warnings.push("Simulation did not fully converge; results are approximate.");

  const V = (k: number) => (k < 0 ? 0 : x[k]);
  const results: SimElementResult[] = [];
  for (const e of elements) {
    if (e.kind === "R") {
      const v = V(e.a) - V(e.b);
      const i = v / e.r;
      results.push({ ref: e.ref, label: e.label, current: i, voltage: v, power: v * i });
      if (e.ratedW && Math.abs(v * i) > e.ratedW) warnings.push(`${e.ref} dissipates ${(Math.abs(v * i) * 1000).toFixed(0)}mW, above its ${e.ratedW * 1000}mW rating`);
    } else if (e.kind === "D") {
      const v = V(e.a) - V(e.k);
      const i = e.is * (Math.exp(Math.min(v, 40 * e.nvt * 1.5) / e.nvt) - 1);
      results.push({ ref: e.ref, label: e.label, current: i, voltage: v, power: v * i });
      if (e.led && i > 0.02) warnings.push(`${e.ref} LED current ${(i * 1000).toFixed(1)}mA exceeds the typical 20mA maximum`);
      if (e.led && i < 0.0005) warnings.push(`${e.ref} LED current is only ${(i * 1000).toFixed(2)}mA; it will be dim or off`);
    }
  }
  for (const c of design.components) {
    if (!c.partId.startsWith("fuse")) continue;
    const r = results.find((x) => x.ref === c.ref);
    const rating = parseValue(c.value);
    if (r && rating && Math.abs(r.current) > rating) warnings.push(`${c.ref} carries ${(Math.abs(r.current) * 1000).toFixed(0)}mA, above its ${c.value} rating`);
  }
  const supplies = vs.map((s, j) => {
    const i = -x[n + j];
    return { name: s.ref === s.label.split(" ")[0] ? s.ref : s.label, voltage: s.v, current: i, power: s.v * i };
  });
  const nodes = [{ net: ground.name, voltage: 0 }, ...[...nodeIdx].map(([net, k]) => ({ net, voltage: x[k] }))].sort((a, b) => a.net.localeCompare(b.net, undefined, { numeric: true }));
  if (notModeled.length) warnings.push(`Not simulated (no model yet): ${notModeled.join(", ")}`);
  return { ok: true, nodes, elements: results, supplies, warnings, notModeled, iterations };
}

/** Gaussian elimination with partial pivoting. Returns null when singular. */
function solve(A: Float64Array[], b: Float64Array): Float64Array | null {
  const n = b.length;
  const M = A.map((row, i) => {
    const r = new Float64Array(n + 1);
    r.set(row);
    r[n] = b[i];
    return r;
  });
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-18) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}
