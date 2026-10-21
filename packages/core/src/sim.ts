// Circuit simulation: modified nodal analysis with Newton-Raphson for nonlinear devices.
// Analyses: DC operating point, transient (backward Euler) and AC small-signal sweeps.
// Supplies come from power-rail net names (+5V, +3V3, VBUS...) unless a modelled source
// (simulation source or regulator output) already drives the net.
import { getPart } from "./library";
import { computeNets, netByTerminal, termKey } from "./netlist";
import type { ComponentData, Design } from "./types";

const PREFIX: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };

/** Parse engineering values: 10k, 4k7, 4.7k, 100nF, 330R, 2R2, 1M, 500mA, 1e-3. */
export function parseValue(raw: string): number | null {
  const s = raw.trim().replace(/\s+/g, "").replace(/(Ω|ohms?|F|H|A|V|W|Hz|s)$/i, "");
  if (/^[-+]?\d*\.?\d+e[-+]?\d+$/i.test(s)) return Number(s);
  let m = s.match(/^(\d+)([pnuµmkKMGR])(\d+)$/);
  if (m) return Number(`${m[1]}.${m[3]}`) * (m[2] === "R" ? 1 : PREFIX[m[2]]);
  m = s.match(/^([-+]?\d*\.?\d+)([pnuµmkKMGR]?)$/);
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

// ---------- sources ----------

export interface SourceSpec {
  dc: number;
  ac: number;
  wave?: { kind: "pulse"; v1: number; v2: number; td: number; tr: number; tf: number; pw: number; per: number } | { kind: "sin"; vo: number; va: number; f: number; td: number };
}

/** Parse "DC 5", "5", "PULSE(0 5 0 1u 1u 0.5m 1m)", "SIN(0 1 1k)", each optionally followed by "AC 1". */
export function parseSource(spec: string): SourceSpec {
  const s = spec.trim();
  const ac = s.match(/\bAC\s+([^\s)]+)/i);
  const out: SourceSpec = { dc: 0, ac: ac ? parseValue(ac[1]) ?? 0 : 0 };
  const nums = (body: string) => body.split(/[\s,]+/).filter(Boolean).map((x) => parseValue(x) ?? 0);
  const pulse = s.match(/PULSE\s*\(([^)]*)\)/i);
  const sin = s.match(/SIN\s*\(([^)]*)\)/i);
  if (pulse) {
    const [v1 = 0, v2 = 1, td = 0, tr = 1e-9, tf = 1e-9, pw = 1e-3, per = 2e-3] = nums(pulse[1]);
    out.wave = { kind: "pulse", v1, v2, td, tr: tr || 1e-9, tf: tf || 1e-9, pw, per: per || Infinity };
    out.dc = v1;
  } else if (sin) {
    const [vo = 0, va = 1, f = 1e3, td = 0] = nums(sin[1]);
    out.wave = { kind: "sin", vo, va, f, td };
    out.dc = vo;
  } else {
    const dc = s.match(/^(?:DC\s+)?([^\s]+)/i);
    if (dc && !/^AC$/i.test(dc[1])) out.dc = parseValue(dc[1]) ?? 0;
  }
  return out;
}

export function sourceAt(s: SourceSpec, t: number): number {
  const w = s.wave;
  if (!w) return s.dc;
  if (w.kind === "sin") return t < w.td ? w.vo : w.vo + w.va * Math.sin(2 * Math.PI * w.f * (t - w.td));
  if (t < w.td) return w.v1;
  const tp = (t - w.td) % w.per;
  if (tp < w.tr) return w.v1 + ((w.v2 - w.v1) * tp) / w.tr;
  if (tp < w.tr + w.pw) return w.v2;
  if (tp < w.tr + w.pw + w.tf) return w.v2 + ((w.v1 - w.v2) * (tp - w.tr - w.pw)) / w.tf;
  return w.v1;
}

// ---------- circuit model ----------

const VT = 0.02585;
const GMIN = 1e-12;
const RATED_W: Record<string, number> = { "0402": 0.0625, "0603": 0.1, "0805": 0.125, "1206": 0.25 };

/** exp() with a linear extension above x=40 so Newton never overflows. */
const sexp = (x: number) => (x < 40 ? Math.exp(x) : Math.exp(40) * (1 + x - 40));

interface Linear {
  kind: "R" | "C" | "L";
  ref: string;
  label: string;
  a: number;
  b: number;
  value: number;
  ratedW?: number;
}
interface VSource {
  ref: string;
  label: string;
  p: number;
  n: number;
  spec: SourceSpec;
  supply: boolean;
}
interface ISource {
  ref: string;
  label: string;
  p: number;
  n: number;
  spec: SourceSpec;
}
interface Device {
  kind: "D" | "Q" | "M" | "OPAMP" | "555" | "LDO";
  ref: string;
  label: string;
  nodes: number[];
  /** Currents flowing INTO the device at each terminal (sum to zero). */
  f: (v: number[]) => number[];
  /** Index of the terminal whose current is reported, and its sign. */
  report: { terminal: number; across: [number, number] };
  led?: boolean;
  /** Stateful devices (555) update their state after a solution; returns true if it changed. */
  update?: (v: number[]) => boolean;
}

interface Circuit {
  nodeNames: string[];
  linear: Linear[];
  vsrc: VSource[];
  isrc: ISource[];
  devices: Device[];
  notModeled: string[];
  warnings: string[];
  /** Op-amp open-loop gain; lowered temporarily for gain-stepping continuation. */
  params: { opGain: number };
}

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

function buildCircuit(design: Design): Circuit | string {
  const nets = computeNets(design);
  const netOf = netByTerminal(nets);
  const ground = nets.find((n) => isGroundNet(n.name));
  if (!ground) return "No ground net. Add a GND power symbol so the simulator has a reference.";
  const nodeIdx = new Map<string, number>();
  const nodeNames: string[] = [];
  const node = (net: string | undefined) => {
    if (!net || net === ground.name) return -1;
    if (!nodeIdx.has(net)) {
      nodeIdx.set(net, nodeNames.length);
      nodeNames.push(net);
    }
    return nodeIdx.get(net)!;
  };
  const ckt: Circuit = { nodeNames, linear: [], vsrc: [], isrc: [], devices: [], notModeled: [], warnings: [], params: { opGain: 1e5 } };
  const params = ckt.params;
  const driven = new Set<number>();

  for (const c of design.components) {
    const part = getPart(c.partId);
    if (!part || part.kind !== "part" || c.dnp) continue;
    const id = c.partId;
    const pn = (pin: string) => node(netOf.get(termKey({ comp: c.id, pin })));
    const label = `${c.ref} ${c.value}`;
    if (id.startsWith("resistor")) {
      const r = parseValue(c.value);
      if (!r || r <= 0) ckt.warnings.push(`${c.ref}: cannot parse resistance "${c.value}"`);
      else ckt.linear.push({ kind: "R", ref: c.ref, label, a: pn("1"), b: pn("2"), value: r, ratedW: RATED_W[part.footprint?.name ?? ""] });
    } else if (id.startsWith("ferrite")) ckt.linear.push({ kind: "R", ref: c.ref, label, a: pn("1"), b: pn("2"), value: 0.05 });
    else if (id.startsWith("fuse")) ckt.linear.push({ kind: "R", ref: c.ref, label, a: pn("1"), b: pn("2"), value: 0.1 });
    else if (id.startsWith("inductor")) ckt.linear.push({ kind: "L", ref: c.ref, label, a: pn("1"), b: pn("2"), value: parseValue(c.value) ?? 1e-5 });
    else if (id.startsWith("capacitor")) ckt.linear.push({ kind: "C", ref: c.ref, label, a: pn("1"), b: pn("2"), value: parseValue(c.value) ?? 1e-7 });
    else if (id.startsWith("led") || id.startsWith("diode") || id.startsWith("schottky")) {
      const { vf, n, led } = diodeParams(c);
      const nvt = n * VT;
      const is = 0.01 / Math.exp(vf / nvt);
      ckt.devices.push({
        kind: "D",
        ref: c.ref,
        label,
        led,
        nodes: [pn("2"), pn("1")], // anode, cathode
        f: ([va, vk]) => {
          const i = is * (sexp((va - vk) / nvt) - 1);
          return [i, -i];
        },
        report: { terminal: 0, across: [0, 1] },
      });
    } else if (id.startsWith("npn")) {
      const IS = 1e-14;
      const BF = 200;
      const BR = 2;
      ckt.devices.push({
        kind: "Q",
        ref: c.ref,
        label,
        nodes: [pn("3"), pn("1"), pn("2")], // C, B, E
        f: ([vc, vb, ve]) => {
          const fe = sexp((vb - ve) / VT) - 1;
          const fc = sexp((vb - vc) / VT) - 1;
          const ict = IS * (fe - fc);
          const ic = ict - (IS / BR) * fc;
          const ib = (IS / BF) * fe + (IS / BR) * fc;
          return [ic, ib, -(ic + ib)];
        },
        report: { terminal: 0, across: [0, 2] },
      });
    } else if (id.startsWith("nmos")) {
      const VTH = 1.0;
      const K = 10;
      const LAMBDA = 0.01;
      const soft = 2 * VT;
      ckt.devices.push({
        kind: "M",
        ref: c.ref,
        label,
        nodes: [pn("3"), pn("1"), pn("2")], // D, G, S
        f: ([vd, vg, vs]) => {
          // Symmetric level-1 model with a smooth turn-on.
          const flip = vd < vs;
          const d = flip ? vs : vd;
          const s = flip ? vd : vs;
          const vov = soft * Math.log1p(sexp((vg - s - VTH) / soft));
          const vds = d - s;
          const id = vds < vov ? K * (vov * vds - (vds * vds) / 2) * (1 + LAMBDA * vds) : (K / 2) * vov * vov * (1 + LAMBDA * vds);
          const i = flip ? -id : id;
          return [i, 0, -i];
        },
        report: { terminal: 0, across: [0, 2] },
      });
    } else if (id.startsWith("lm358")) {
      const amp = (inp: string, inn: string, out: string, label2: string) => ({
        kind: "OPAMP" as const,
        ref: `${c.ref}${label2}`,
        label: `${c.ref}${label2} op-amp`,
        nodes: [pn(inp), pn(inn), pn(out), pn("8"), pn("4")],
        f: ([vp, vn, vo, vcc, vee]: number[]) => {
          const lo = vee + 0.02;
          const hi = vcc - 1.5;
          const span = Math.max(0.1, hi - lo);
          const target = lo + span * 0.5 * (1 + Math.tanh((params.opGain * (vp - vn)) / span));
          const iout = (vo - target) / 10; // into the output pin
          const s = 0.5 * (1 - Math.tanh(iout / 1e-3)); // sourcing comes from V+, sinking goes to V-
          const iq = 3.5e-4 * Math.tanh((vcc - vee) / 0.5);
          return [vp * GMIN, vn * GMIN, iout, iq - iout * s, -iq - iout * (1 - s) - (vp + vn) * GMIN];
        },
        report: { terminal: 2, across: [2, 4] as [number, number] },
      });
      ckt.devices.push(amp("3", "2", "1", "A"), amp("5", "6", "7", "B"));
      driven.add(pn("1")).add(pn("7"));
    } else if (id.startsWith("ne555")) {
      let q = 1;
      const nodes = [pn("1"), pn("2"), pn("3"), pn("4"), pn("5"), pn("6"), pn("7"), pn("8")];
      ckt.devices.push({
        kind: "555",
        ref: c.ref,
        label: `${c.ref} 555 timer`,
        nodes,
        f: ([g, , out, , cv, , dis, vcc]) => {
          const i = new Array(8).fill(0);
          // Internal 5k/5k/5k divider sets the 2/3 and 1/3 thresholds.
          const iTop = (vcc - cv) / 5000;
          const iBot = (cv - g) / 10000;
          i[7] += iTop;
          i[4] += -iTop + iBot;
          i[0] -= iBot;
          // Quiescent supply current.
          const iq = (vcc - g) / 1600;
          i[7] += iq;
          i[0] -= iq;
          // Output stage: high = Vcc-1.7V, low = 0.1V, 10 ohm.
          const target = q ? vcc - 1.7 : g + 0.1;
          const io = (out - target) / 10;
          i[2] += io;
          if (q) i[7] -= io;
          else i[0] -= io;
          // Discharge transistor on while the output is low.
          const idis = (dis - g) * (q ? 1e-9 : 1 / 10);
          i[6] += idis;
          i[0] -= idis;
          return i;
        },
        update: ([g, trig, , reset, cv, thr, , vcc]) => {
          const prev = q;
          if (reset - g < 0.7 || vcc - g < 1) q = 0;
          else if (trig - g < (cv - g) / 2) q = 1;
          else if (thr - g > cv - g) q = 0;
          return q !== prev;
        },
        report: { terminal: 2, across: [2, 0] },
      });
      driven.add(pn("3"));
    } else if (id.startsWith("ams1117")) {
      const vset = parseValue(c.value.replace(/^.*-/, "")) ?? 3.3;
      ckt.devices.push({
        kind: "LDO",
        ref: c.ref,
        label: `${c.ref} ${c.value}`,
        nodes: [pn("3"), pn("2"), pn("1")], // VIN, VOUT, GND
        f: ([vin, vout, g]) => {
          const head = vin - g - 1.1;
          const target = g + Math.min(vset, head);
          const iout = (vout - Math.max(g, target)) / 0.05;
          const iq = 5e-3 * Math.tanh(Math.max(0, vin - g) / 0.5);
          return [-iout + iq, iout, -iq];
        },
        report: { terminal: 1, across: [1, 2] },
      });
      driven.add(pn("2"));
    } else if (id === "sim_vsource") {
      const p = pn("1");
      ckt.vsrc.push({ ref: c.ref, label: `${c.ref} ${c.value}`, p, n: pn("2"), spec: parseSource(c.value), supply: false });
      driven.add(p);
    } else if (id === "sim_isource") {
      ckt.isrc.push({ ref: c.ref, label: `${c.ref} ${c.value}`, p: pn("1"), n: pn("2"), spec: parseSource(c.value) });
    } else if (id.startsWith("crystal") || id.startsWith("button") || id.startsWith("header") || id.startsWith("usb") || id.startsWith("mounting") || id === "fiducial") {
      // Open circuit (connectors are just nodes).
    } else {
      ckt.notModeled.push(`${c.ref} (${part.name})`);
    }
  }
  // Rails become ideal supplies unless a modelled source already drives them.
  for (const n of nets) {
    const v = railVoltage(n.name);
    if (v === null || !n.named) continue;
    const k = node(n.name);
    if (driven.has(k)) continue;
    ckt.vsrc.push({ ref: n.name, label: `${n.name} supply`, p: k, n: -1, spec: { dc: v, ac: 0 }, supply: true });
  }
  if (!nodeNames.length) return "Nothing to simulate: the circuit has no nodes besides ground.";
  return ckt;
}

// ---------- solver ----------

interface Mode {
  kind: "dc" | "tran";
  dt?: number;
  t?: number;
  /** Previous-step capacitor voltages and inductor currents (transient). */
  capV?: Map<Linear, number>;
  indI?: Map<Linear, number>;
  scale?: number;
}

function assembleAndSolve(ckt: Circuit, x0: Float64Array, mode: Mode): Float64Array | null {
  const n = ckt.nodeNames.length;
  const size = n + ckt.vsrc.length;
  let x: Float64Array = Float64Array.from(x0);
  const scale = mode.scale ?? 1;
  const V = (k: number, xs: Float64Array) => (k < 0 ? 0 : xs[k]);
  for (let iter = 0; iter < 200; iter++) {
    const A = Array.from({ length: size }, () => new Float64Array(size));
    const z = new Float64Array(size);
    for (let i = 0; i < n; i++) A[i][i] += GMIN;
    const G = (a: number, b: number, g: number) => {
      if (a >= 0) A[a][a] += g;
      if (b >= 0) A[b][b] += g;
      if (a >= 0 && b >= 0) {
        A[a][b] -= g;
        A[b][a] -= g;
      }
    };
    const I = (a: number, b: number, i: number) => {
      // Current i flows from node a to node b through the element.
      if (a >= 0) z[a] -= i;
      if (b >= 0) z[b] += i;
    };
    for (const e of ckt.linear) {
      if (e.kind === "R") G(e.a, e.b, 1 / e.value);
      else if (e.kind === "C") {
        if (mode.kind === "tran") {
          const g = e.value / mode.dt!;
          G(e.a, e.b, g);
          I(e.a, e.b, -g * (mode.capV!.get(e) ?? 0));
        }
      } else if (mode.kind === "tran") {
        const g = mode.dt! / e.value;
        G(e.a, e.b, g);
        I(e.a, e.b, mode.indI!.get(e) ?? 0);
      } else G(e.a, e.b, 1e3);
    }
    const t = mode.t ?? 0;
    for (const s of ckt.isrc) I(s.n, s.p, scale * (mode.kind === "tran" ? sourceAt(s.spec, t) : s.spec.dc));
    ckt.vsrc.forEach((s, j) => {
      const row = n + j;
      if (s.p >= 0) (A[s.p][row] += 1), (A[row][s.p] += 1);
      if (s.n >= 0) (A[s.n][row] -= 1), (A[row][s.n] -= 1);
      z[row] = scale * (mode.kind === "tran" ? sourceAt(s.spec, t) : s.spec.dc);
    });
    for (const d of ckt.devices) {
      const v = d.nodes.map((k) => V(k, x));
      const i0 = d.f(v);
      const h = 1e-6;
      const J: number[][] = d.nodes.map(() => new Array(d.nodes.length).fill(0));
      d.nodes.forEach((km, m) => {
        if (km < 0) return;
        const vp = [...v];
        vp[m] += h;
        const i1 = d.f(vp);
        for (let k = 0; k < d.nodes.length; k++) J[k][m] = (i1[k] - i0[k]) / h;
      });
      d.nodes.forEach((kk, k) => {
        if (kk < 0) return;
        let lin = i0[k];
        d.nodes.forEach((km, m) => {
          if (km < 0) return;
          A[kk][km] += J[k][m];
          lin -= J[k][m] * v[m];
        });
        z[kk] -= lin;
      });
    }
    const next = gauss(A, z);
    if (!next) return null;
    let maxDelta = 0;
    for (let i = 0; i < n; i++) maxDelta = Math.max(maxDelta, Math.abs(next[i] - x[i]));
    const damp = maxDelta > 1 ? 1 / maxDelta : 1;
    const out = new Float64Array(size);
    for (let i = 0; i < size; i++) out[i] = x[i] + (next[i] - x[i]) * (i < n ? damp : 1);
    x = out;
    if (maxDelta < 1e-7) return x;
  }
  return null;
}

/** DC solution with source stepping as a fallback for hard circuits. */
function solveOp(ckt: Circuit): { x: Float64Array; converged: boolean } {
  const size = ckt.nodeNames.length + ckt.vsrc.length;
  const zero = new Float64Array(size);
  if (ckt.devices.some((d) => d.kind === "OPAMP")) {
    // Gain stepping: high-gain feedback loops converge from a low-gain solution.
    let guess: Float64Array = zero;
    let ok = true;
    // Doubling keeps each new starting point inside the op-amp's linear region.
    for (let g = 1; ; g = Math.min(1e5, g * 2)) {
      ckt.params.opGain = g;
      const r = assembleAndSolve(ckt, guess, { kind: "dc" });
      if (r) guess = r;
      else ok = false;
      if (g === 1e5) break;
    }
    ckt.params.opGain = 1e5;
    if (ok) return { x: guess, converged: true };
  }
  let x: Float64Array | null = assembleAndSolve(ckt, zero, { kind: "dc" });
  if (!x) {
    let guess: Float64Array = zero;
    for (let s = 1; s <= 10; s++) {
      const r = assembleAndSolve(ckt, guess, { kind: "dc", scale: s / 10 });
      if (!r) return { x: guess, converged: false };
      guess = r;
    }
    x = guess;
  }
  return { x, converged: true };
}

function gauss(A: Float64Array[], b: Float64Array): Float64Array | null {
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

// ---------- results ----------

export interface SimElementResult {
  ref: string;
  label: string;
  /** Current through the element (a->b, anode->cathode, into collector/drain/output). */
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

function elementResults(ckt: Circuit, x: Float64Array, capI?: Map<Linear, number>, indI?: Map<Linear, number>): SimElementResult[] {
  const V = (k: number) => (k < 0 ? 0 : x[k]);
  const out: SimElementResult[] = [];
  for (const e of ckt.linear) {
    const v = V(e.a) - V(e.b);
    const i = e.kind === "R" ? v / e.value : e.kind === "C" ? capI?.get(e) ?? 0 : indI?.get(e) ?? v * 1e3;
    out.push({ ref: e.ref, label: e.label, current: i, voltage: v, power: v * i });
  }
  for (const d of ckt.devices) {
    const v = d.nodes.map(V);
    const i = d.f(v)[d.report.terminal];
    const vv = v[d.report.across[0]] - v[d.report.across[1]];
    out.push({ ref: d.ref, label: d.label, current: i, voltage: vv, power: vv * i });
  }
  return out;
}

function settle555(ckt: Circuit, x: Float64Array): { x: Float64Array; stable: boolean } {
  const stateful = ckt.devices.filter((d) => d.update);
  if (!stateful.length) return { x, stable: true };
  for (let k = 0; k < 6; k++) {
    const V = (n: number) => (n < 0 ? 0 : x[n]);
    const changed = stateful.map((d) => d.update!(d.nodes.map(V))).some(Boolean);
    if (!changed) return { x, stable: true };
    const r = assembleAndSolve(ckt, x, { kind: "dc" });
    if (!r) break;
    x = r;
  }
  return { x, stable: false };
}

export function simulateDC(design: Design): SimResult {
  const empty: SimResult = { ok: false, nodes: [], elements: [], supplies: [], warnings: [], notModeled: [], iterations: 0 };
  const ckt = buildCircuit(design);
  if (typeof ckt === "string") return { ...empty, error: ckt };
  const op = solveOp(ckt);
  if (!op.converged) return { ...empty, error: "The DC solution did not converge (check for shorted supplies or floating source loops)." };
  const settled = settle555(ckt, op.x);
  const x = settled.x;
  const warnings = [...ckt.warnings];
  if (!settled.stable) warnings.push(`${ckt.devices.filter((d) => d.update).map((d) => d.ref).join(", ")}: no stable DC state (astable oscillator) — run a transient analysis to see it oscillate`);
  const results = elementResults(ckt, x);
  for (const r of results) {
    const lin = ckt.linear.find((e) => e.ref === r.ref);
    if (lin?.ratedW && Math.abs(r.power) > lin.ratedW) warnings.push(`${r.ref} dissipates ${(Math.abs(r.power) * 1000).toFixed(0)}mW, above its ${lin.ratedW * 1000}mW rating`);
    const dev = ckt.devices.find((d) => d.ref === r.ref);
    if (dev?.led && r.current > 0.02) warnings.push(`${r.ref} LED current ${(r.current * 1000).toFixed(1)}mA exceeds the typical 20mA maximum`);
    if (dev?.led && r.current < 0.0005) warnings.push(`${r.ref} LED current is only ${(r.current * 1000).toFixed(2)}mA; it will be dim or off`);
  }
  for (const c of design.components) {
    if (!c.partId.startsWith("fuse")) continue;
    const r = results.find((x) => x.ref === c.ref);
    const rating = parseValue(c.value);
    if (r && rating && Math.abs(r.current) > rating) warnings.push(`${c.ref} carries ${(Math.abs(r.current) * 1000).toFixed(0)}mA, above its ${c.value} rating`);
  }
  const n = ckt.nodeNames.length;
  const supplies = ckt.vsrc.map((s, j) => {
    const i = -x[n + j];
    const v = s.spec.dc;
    return { name: s.supply ? s.ref : s.label, voltage: v, current: i, power: v * i };
  });
  const ground = computeNets(design).find((m) => isGroundNet(m.name))!.name;
  const nodes = [{ net: ground, voltage: 0 }, ...ckt.nodeNames.map((net, k) => ({ net, voltage: x[k] }))].sort((a, b) => a.net.localeCompare(b.net, undefined, { numeric: true }));
  if (ckt.notModeled.length) warnings.push(`Not simulated (no model yet): ${ckt.notModeled.join(", ")}`);
  return { ok: true, nodes, elements: results, supplies, warnings, notModeled: ckt.notModeled, iterations: 0 };
}

// ---------- transient ----------

export interface TransientResult {
  ok: boolean;
  error?: string;
  time: number[];
  /** Node voltages over time, by net name. */
  nodes: Record<string, number[]>;
  /** Element currents over time, by reference. */
  currents: Record<string, number[]>;
  warnings: string[];
}

/**
 * Transient analysis from power-on: capacitors start discharged and inductors without current,
 * supplies are on from t=0. Fixed time step (backward Euler).
 */
export function simulateTransient(design: Design, opts: { tstop: number; points?: number }): TransientResult {
  const fail = (error: string): TransientResult => ({ ok: false, error, time: [], nodes: {}, currents: {}, warnings: [] });
  const ckt = buildCircuit(design);
  if (typeof ckt === "string") return fail(ckt);
  if (!(opts.tstop > 0)) return fail("Stop time must be positive");
  const points = Math.min(20000, Math.max(10, Math.round(opts.points ?? 1000)));
  const dt = opts.tstop / points;
  const n = ckt.nodeNames.length;
  const warnings = [...ckt.warnings];
  const capV = new Map<Linear, number>();
  const indI = new Map<Linear, number>();
  for (const e of ckt.linear) {
    if (e.kind === "C") capV.set(e, 0);
    if (e.kind === "L") indI.set(e, 0);
  }
  const time: number[] = [0];
  const nodes: Record<string, number[]> = {};
  ckt.nodeNames.forEach((nm) => (nodes[nm] = [0]));
  const refs = [...ckt.linear.map((e) => e.ref), ...ckt.devices.map((d) => d.ref), ...ckt.vsrc.filter((s) => !s.supply).map((s) => s.ref)];
  const currents: Record<string, number[]> = {};
  refs.forEach((r) => (currents[r] = [0]));
  let x: Float64Array = new Float64Array(n + ckt.vsrc.length);
  let failures = 0;
  const V = (k: number, xs: Float64Array) => (k < 0 ? 0 : xs[k]);
  for (let step = 1; step <= points; step++) {
    const t = step * dt;
    let r = assembleAndSolve(ckt, x, { kind: "tran", dt, t, capV, indI });
    // A state change in a stateful device (555) re-solves the same step with the new state.
    if (r && ckt.devices.some((d) => d.update)) {
      const changed = ckt.devices.filter((d) => d.update).map((d) => d.update!(d.nodes.map((k) => V(k, r!)))).some(Boolean);
      if (changed) r = assembleAndSolve(ckt, r, { kind: "tran", dt, t, capV, indI }) ?? r;
    }
    if (!r) {
      failures++;
      if (failures > 20) return { ...fail(`Transient analysis failed to converge at t=${t.toExponential(2)}s`), warnings };
      r = x;
    }
    x = r;
    const capI = new Map<Linear, number>();
    for (const e of ckt.linear) {
      const v = V(e.a, x) - V(e.b, x);
      if (e.kind === "C") {
        capI.set(e, (e.value / dt) * (v - capV.get(e)!));
        capV.set(e, v);
      } else if (e.kind === "L") indI.set(e, indI.get(e)! + (dt / e.value) * v);
    }
    time.push(t);
    ckt.nodeNames.forEach((nm, k) => nodes[nm].push(x[k]));
    const er = elementResults(ckt, x, capI, indI);
    for (const e of er) currents[e.ref]?.push(e.current);
    ckt.vsrc.forEach((s, j) => !s.supply && currents[s.ref].push(-x[n + j]));
  }
  for (const d of ckt.devices) {
    if (!d.led) continue;
    const peak = Math.max(...currents[d.ref]);
    if (peak > 0.02) warnings.push(`${d.ref} LED peaks at ${(peak * 1000).toFixed(1)}mA (above 20mA)`);
  }
  if (failures) warnings.push(`${failures} time step(s) did not converge and were held`);
  if (ckt.notModeled.length) warnings.push(`Not simulated (no model yet): ${ckt.notModeled.join(", ")}`);
  return { ok: true, time, nodes, currents, warnings };
}

// ---------- AC ----------

export interface ACResult {
  ok: boolean;
  error?: string;
  freq: number[];
  /** Magnitude (dB re 1V) and phase (degrees) per net. */
  nodes: Record<string, { mag: number[]; phase: number[] }>;
  warnings: string[];
}

/** Small-signal AC sweep around the DC operating point. Sources with "AC <mag>" excite the circuit. */
export function simulateAC(design: Design, opts: { fstart: number; fstop: number; pointsPerDecade?: number }): ACResult {
  const fail = (error: string): ACResult => ({ ok: false, error, freq: [], nodes: {}, warnings: [] });
  const ckt = buildCircuit(design);
  if (typeof ckt === "string") return fail(ckt);
  if (!ckt.vsrc.some((s) => s.spec.ac) && !ckt.isrc.some((s) => s.spec.ac)) return fail('No AC source. Add a simulation voltage source with a value like "DC 0 AC 1".');
  const op = solveOp(ckt);
  if (!op.converged) return fail("The DC operating point did not converge.");
  const x = settle555(ckt, op.x).x;
  const n = ckt.nodeNames.length;
  const size = n + ckt.vsrc.length;
  const V = (k: number) => (k < 0 ? 0 : x[k]);
  // Real (conductance) part: resistors, inductor-free DC network and device Jacobians at the OP.
  const G = Array.from({ length: size }, () => new Float64Array(size));
  const stampG = (a: number, b: number, g: number, M: Float64Array[]) => {
    if (a >= 0) M[a][a] += g;
    if (b >= 0) M[b][b] += g;
    if (a >= 0 && b >= 0) (M[a][b] -= g), (M[b][a] -= g);
  };
  for (let i = 0; i < n; i++) G[i][i] += GMIN;
  for (const e of ckt.linear) if (e.kind === "R") stampG(e.a, e.b, 1 / e.value, G);
  for (const d of ckt.devices) {
    const v = d.nodes.map(V);
    const i0 = d.f(v);
    d.nodes.forEach((km, m) => {
      if (km < 0) return;
      const vp = [...v];
      vp[m] += 1e-6;
      const i1 = d.f(vp);
      d.nodes.forEach((kk, k) => kk >= 0 && (G[kk][km] += (i1[k] - i0[k]) / 1e-6));
    });
  }
  ckt.vsrc.forEach((s, j) => {
    const row = n + j;
    if (s.p >= 0) (G[s.p][row] += 1), (G[row][s.p] += 1);
    if (s.n >= 0) (G[s.n][row] -= 1), (G[row][s.n] -= 1);
  });
  const ppd = Math.max(1, Math.round(opts.pointsPerDecade ?? 20));
  const decades = Math.log10(opts.fstop / opts.fstart);
  if (!(decades > 0)) return fail("fstop must be greater than fstart");
  const count = Math.max(2, Math.round(decades * ppd) + 1);
  const freq: number[] = [];
  const nodes: Record<string, { mag: number[]; phase: number[] }> = {};
  ckt.nodeNames.forEach((nm) => (nodes[nm] = { mag: [], phase: [] }));
  for (let k = 0; k < count; k++) {
    const f = opts.fstart * 10 ** ((decades * k) / (count - 1));
    const w = 2 * Math.PI * f;
    const B = Array.from({ length: size }, () => new Float64Array(size));
    for (const e of ckt.linear) {
      if (e.kind === "C") stampG(e.a, e.b, w * e.value, B);
      if (e.kind === "L") stampG(e.a, e.b, -1 / (w * e.value), B);
    }
    const zr = new Float64Array(size);
    const zi = new Float64Array(size);
    ckt.vsrc.forEach((s, j) => (zr[n + j] = s.spec.ac));
    for (const s of ckt.isrc) {
      if (s.n >= 0) zr[s.n] -= s.spec.ac;
      if (s.p >= 0) zr[s.p] += s.spec.ac;
    }
    const sol = complexSolve(G, B, zr, zi);
    if (!sol) return fail(`AC matrix is singular at ${f.toPrecision(3)}Hz`);
    freq.push(f);
    ckt.nodeNames.forEach((nm, i) => {
      const mag = Math.hypot(sol.re[i], sol.im[i]);
      nodes[nm].mag.push(20 * Math.log10(Math.max(mag, 1e-15)));
      nodes[nm].phase.push((Math.atan2(sol.im[i], sol.re[i]) * 180) / Math.PI);
    });
  }
  return { ok: true, freq, nodes, warnings: ckt.notModeled.length ? [`Not simulated (no model yet): ${ckt.notModeled.join(", ")}`] : [] };
}

/** Solve (G + jB) x = zr + j zi as a 2n real system. */
function complexSolve(G: Float64Array[], B: Float64Array[], zr: Float64Array, zi: Float64Array): { re: Float64Array; im: Float64Array } | null {
  const n = zr.length;
  const A = Array.from({ length: 2 * n }, () => new Float64Array(2 * n));
  const z = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      A[i][j] = G[i][j];
      A[i][j + n] = -B[i][j];
      A[i + n][j] = B[i][j];
      A[i + n][j + n] = G[i][j];
    }
    z[i] = zr[i];
    z[i + n] = zi[i];
  }
  const x = gauss(A, z);
  return x ? { re: x.slice(0, n), im: x.slice(n) } : null;
}
