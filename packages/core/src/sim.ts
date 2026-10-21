// Circuit simulation: modified nodal analysis with Newton-Raphson for nonlinear devices.
// Analyses: DC operating point, transient (backward Euler) and AC small-signal sweeps.
// Supplies come from power-rail net names (+5V, +3V3, VBUS...) unless a modelled source
// (simulation source or regulator output) already drives the net.
import { getPart } from "./library";
import { computeNets, netByTerminal, termKey } from "./netlist";
import { parseModelCard, spiceNumber, subcktInstances } from "./spice";
import type { ComponentData, Design, SpiceModel, SpiceModelType, SpiceSubckt } from "./types";

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
  /** Inside a subcircuit: simulated but not listed in results. */
  internal?: boolean;
}
interface VSource {
  ref: string;
  label: string;
  p: number;
  n: number;
  spec: SourceSpec;
  supply: boolean;
  internal?: boolean;
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
  internal?: boolean;
}

/**
 * Controlled sources from subcircuits, with linear polynomial control (SPICE POLY):
 * output = offset + sum(gain * control), each control a node-pair voltage or a voltage source's
 * branch current. Voltage outputs (E, H) add a branch-current row; current outputs (G, F) stamp
 * into the node rows.
 */
interface Controlled {
  kind: "E" | "F" | "G" | "H";
  ref: string;
  p: number;
  n: number;
  terms: { cp: number; cn: number; ctrl?: string; gain: number }[];
  offset: number;
}

interface Circuit {
  nodeNames: string[];
  linear: Linear[];
  vsrc: VSource[];
  isrc: ISource[];
  devices: Device[];
  controlled: Controlled[];
  /** Nodes inside subcircuits (simulated, not reported). */
  internalNodes: Set<string>;
  notModeled: string[];
  warnings: string[];
  /** Op-amp open-loop gain; lowered temporarily for gain-stepping continuation. */
  params: { opGain: number };
}

/** Unknowns: node voltages, then voltage-source currents, then E/H branch currents. */
const systemSize = (ckt: Circuit) => ckt.nodeNames.length + ckt.vsrc.length + ckt.controlled.filter((c) => c.kind === "E" || c.kind === "H").length;

/**
 * Stamp the controlled sources (frequency independent, so DC, transient and AC share this). With
 * `z`, their constant offsets go to the right-hand side too (not for small-signal AC).
 */
function stampControlled(ckt: Circuit, A: Float64Array[], z?: Float64Array, scale = 1) {
  const n = ckt.nodeNames.length;
  let row = n + ckt.vsrc.length;
  const add = (r: number, c: number, v: number) => {
    if (r >= 0 && c >= 0) A[r][c] += v;
  };
  const branch = (ref: string | undefined) => {
    const j = ckt.vsrc.findIndex((v) => v.ref === ref);
    return j < 0 ? -1 : n + j;
  };
  for (const s of ckt.controlled) {
    if (s.kind === "G" || s.kind === "F") {
      // Current flows from p, through the source, to n.
      for (const t of s.terms) {
        if (t.ctrl !== undefined) {
          const c = branch(t.ctrl);
          add(s.p, c, t.gain);
          add(s.n, c, -t.gain);
        } else {
          add(s.p, t.cp, t.gain);
          add(s.p, t.cn, -t.gain);
          add(s.n, t.cp, -t.gain);
          add(s.n, t.cn, t.gain);
        }
      }
      if (z && s.offset) {
        if (s.p >= 0) z[s.p] -= scale * s.offset;
        if (s.n >= 0) z[s.n] += scale * s.offset;
      }
    } else {
      const r = row++;
      add(s.p, r, 1);
      add(s.n, r, -1);
      add(r, s.p, 1);
      add(r, s.n, -1);
      for (const t of s.terms) {
        if (t.ctrl !== undefined) add(r, branch(t.ctrl), -t.gain);
        else {
          add(r, t.cp, -t.gain);
          add(r, t.cn, t.gain);
        }
      }
      if (z) z[r] = scale * s.offset;
    }
  }
}

// ---------- device equations (shared by library parts and subcircuit elements) ----------

function diodeDevice(ref: string, label: string, a: number, k: number, is: number, nvt: number, rs: number, led = false): Device {
  return {
    kind: "D",
    ref,
    label,
    led,
    nodes: [a, k],
    f: ([va, vk]) => {
      const i = diodeCurrent(va - vk, is, nvt, rs);
      return [i, -i];
    },
    report: { terminal: 0, across: [0, 1] },
  };
}

function bjtDevice(ref: string, label: string, c: number, b: number, e: number, P: Record<string, number>, pnp: boolean): Device {
  const IS = P.IS ?? 1e-14;
  const BF = P.BF ?? 200;
  const BR = P.BR ?? 2;
  const nf = (P.NF ?? 1) * VT;
  const nr = (P.NR ?? 1) * VT;
  const VAF = P.VAF ?? Infinity;
  const pol = pnp ? -1 : 1;
  return {
    kind: "Q",
    ref,
    label,
    nodes: [c, b, e],
    f: ([vc, vb, ve]) => {
      // Ebers-Moll transport model with the Early effect; PNP is the NPN with all polarities flipped.
      const fe = sexp((pol * (vb - ve)) / nf) - 1;
      const fc = sexp((pol * (vb - vc)) / nr) - 1;
      const early = Number.isFinite(VAF) ? Math.max(0.1, 1 + (pol * (vc - ve)) / VAF) : 1;
      const ict = IS * (fe - fc) * early;
      const ic = ict - (IS / BR) * fc;
      const ib = (IS / BF) * fe + (IS / BR) * fc;
      return [pol * ic, pol * ib, -pol * (ic + ib)];
    },
    report: { terminal: 0, across: [0, 2] },
  };
}

function mosDevice(ref: string, label: string, d: number, g: number, s: number, P: Record<string, number>, pmos: boolean, defaultK = 10): Device {
  const VTH = Math.abs(P.VTO ?? 1.0);
  // KP is per square; SPICE level-1 cards give W and L, power-MOSFET (VDMOS) cards fold them into KP.
  const K = P.KP !== undefined ? P.KP * ((P.W ?? 1) / (P.L ?? 1)) : defaultK;
  const LAMBDA = P.LAMBDA ?? 0.01;
  const soft = 2 * VT;
  const pol = pmos ? -1 : 1;
  return {
    kind: "M",
    ref,
    label,
    nodes: [d, g, s],
    f: ([vd0, vg0, vs0]) => {
      // Symmetric level-1 model with a smooth turn-on; PMOS mirrors every voltage and current.
      const vd = pol * vd0;
      const vg = pol * vg0;
      const vs = pol * vs0;
      const flip = vd < vs;
      const dd = flip ? vs : vd;
      const ss = flip ? vd : vs;
      const vov = soft * Math.log1p(sexp((vg - ss - VTH) / soft));
      const vds = dd - ss;
      const id = vds < vov ? K * (vov * vds - (vds * vds) / 2) * (1 + LAMBDA * vds) : (K / 2) * vov * vov * (1 + LAMBDA * vds);
      const i = pol * (flip ? -id : id);
      return [i, 0, -i];
    },
    report: { terminal: 0, across: [0, 2] },
  };
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

/** Diode current with series resistance: solve the junction voltage so that v = vj + i·RS. */
function diodeCurrent(v: number, is: number, nvt: number, rs: number): number {
  if (rs <= 0) return is * (sexp(v / nvt) - 1);
  let vj = Math.min(v, nvt * Math.log(1 + 1 / (is * rs)));
  for (let k = 0; k < 40; k++) {
    const e = sexp(vj / nvt);
    const h = vj + rs * is * (e - 1) - v;
    const dh = 1 + (rs * is * e) / nvt;
    const step = h / dh;
    vj -= step;
    if (Math.abs(step) < 1e-12) break;
  }
  return is * (sexp(vj / nvt) - 1);
}

interface ExpandCtx {
  node: (net: string | undefined) => number;
  models: Map<string, SpiceModel>;
  subckts: Map<string, SpiceSubckt>;
}

const num = (s: string | undefined) => (s === undefined ? null : spiceNumber(s.replace(/^\{|\}$/g, "")));

/** DC (and AC magnitude) of a subcircuit V/I element's value text. */
function elementSource(rest: string[]): SourceSpec {
  const t = rest.join(" ");
  const ac = t.match(/\bAC\s+(\S+)/i);
  const dc = t.match(/^(?:DC\s+)?(\S+)/i);
  const spec = /PULSE|SIN/i.test(t) ? parseSource(t) : { dc: dc && !/^AC$/i.test(dc[1]) ? num(dc[1]) ?? 0 : 0, ac: 0 };
  return { ...spec, ac: ac ? num(ac[1]) ?? 0 : spec.ac };
}

/**
 * An E/F/G/H line: plain ("E1 p n cp cn gain", "F1 p n Vname gain") or linear POLY(k)
 * ("E1 p n POLY(2) (a,b) (c,d) p0 p1 p2", "F1 p n POLY(2) V1 V2 p0 p1 p2"). Nonlinear polynomial
 * terms are not supported.
 */
function controlledSource(kind: "E" | "F" | "G" | "H", line: string, ref: (name: string) => string, nd: (name: string) => number): Controlled | string {
  const toks = line.replace(/[(),]/g, " ").split(/\s+/).filter(Boolean);
  const [name, p, n] = toks;
  const byCurrent = kind === "F" || kind === "H";
  const rest = toks.slice(3);
  const polyAt = rest.findIndex((t) => /^POLY$/i.test(t));
  let k = 1;
  let args = rest;
  if (polyAt === 0) {
    k = Number(rest[1]);
    if (!(k >= 1)) return "bad POLY order";
    args = rest.slice(2);
  }
  const per = byCurrent ? 1 : 2;
  const ctrl = args.slice(0, k * per);
  const coef = args.slice(k * per).map((t) => spiceNumber(t));
  if (ctrl.length < k * per || coef.some((c) => c === null)) return "cannot read its control or coefficients";
  let offset = 0;
  let gains: number[];
  if (polyAt === 0) {
    offset = coef[0] ?? 0;
    gains = Array.from({ length: k }, (_, i) => coef[i + 1] ?? 0);
    if (coef.length > k + 1 && coef.slice(k + 1).some((c) => c !== 0)) return "nonlinear POLY terms are not supported";
  } else {
    if (coef.length !== 1) return "cannot read its gain";
    gains = [coef[0]!];
  }
  const terms = gains.map((gain, i) =>
    byCurrent ? { cp: -1, cn: -1, ctrl: ref(ctrl[i]), gain } : { cp: nd(ctrl[2 * i]), cn: nd(ctrl[2 * i + 1]), gain },
  );
  void name;
  return { kind, ref: ref(name), p: nd(p), n: nd(n), terms, offset };
}

/**
 * Add a subcircuit instance's elements to the circuit. Ports map to the outer nodes; internal nodes
 * and element names are prefixed with the instance path (U1A.Q1); node 0 is ground.
 */
function expandSubckt(ckt: Circuit, sub: SpiceSubckt, outer: number[], prefix: string, ctx: ExpandCtx, depth: number) {
  if (depth > 10) return void ckt.warnings.push(`${prefix}: subcircuits nested too deeply`);
  const local = new Map<string, number>(sub.ports.map((p, i) => [p.toUpperCase(), outer[i]]));
  const nd = (name: string) => {
    const u = name.toUpperCase();
    if (u === "0" || u === "GND") return -1;
    if (!local.has(u)) {
      ckt.internalNodes.add(`${prefix}.${u}`);
      local.set(u, ctx.node(`${prefix}.${u}`));
    }
    return local.get(u)!;
  };
  // Local .model cards and nested .subckt definitions shadow the design's.
  const models = new Map(ctx.models);
  const subckts = new Map(ctx.subckts);
  const body: string[] = [];
  let nested: SpiceSubckt | null = null;
  let depthN = 0;
  for (const line of sub.lines) {
    const def = line.match(/^\.subckt\s+(\S+)\s*(.*)$/i);
    if (nested) {
      if (def) depthN++;
      if (/^\.ends\b/i.test(line) && depthN-- === 0) {
        subckts.set(nested.name, nested);
        nested = null;
      } else nested.lines.push(line);
      continue;
    }
    if (def) {
      nested = { name: def[1].toUpperCase(), ports: def[2].split(/\s+/).filter((t) => t && !t.includes("=") && !/^params:$/i.test(t)), lines: [] };
      depthN = 0;
      continue;
    }
    const card = parseModelCard(line);
    if (card && typeof card !== "string") models.set(card.name, card);
    else if (!card && !line.startsWith(".")) body.push(line);
  }
  const skipped = new Set<string>();
  const ref = (name: string) => `${prefix}.${name.toUpperCase()}`;
  const value = (t: string | undefined, what: string, name: string) => {
    const v = num(t);
    if (v === null) skipped.add(`${name} (${what} "${t ?? ""}")`);
    return v;
  };
  // Voltage sources first: F and H elements refer to them by name.
  const ordered = [...body.filter((l) => /^V/i.test(l)), ...body.filter((l) => !/^V/i.test(l))];
  for (const line of ordered) {
    const tok = line.split(/\s+/);
    const name = tok[0];
    const kind = name[0].toUpperCase();
    const behavioural = /\b(VALUE|TABLE|LAPLACE)\b|[{]/i.test(line) && kind !== "X";
    if (behavioural && "EFGHB".includes(kind)) {
      skipped.add(`${name} (behavioural source)`);
      continue;
    }
    switch (kind) {
      case "R":
      case "C":
      case "L": {
        const v = value(tok[3], "value", name);
        if (v !== null && (kind !== "R" || v > 0)) ckt.linear.push({ kind, ref: ref(name), label: ref(name), a: nd(tok[1]), b: nd(tok[2]), value: v, internal: true });
        break;
      }
      case "V":
        ckt.vsrc.push({ ref: ref(name), label: ref(name), p: nd(tok[1]), n: nd(tok[2]), spec: elementSource(tok.slice(3)), supply: false, internal: true });
        break;
      case "I":
        // SPICE drives the current from n+ through the source and out at n-; this circuit's
        // current sources push their current out at p.
        ckt.isrc.push({ ref: ref(name), label: ref(name), p: nd(tok[2]), n: nd(tok[1]), spec: elementSource(tok.slice(3)) });
        break;
      case "E":
      case "F":
      case "G":
      case "H": {
        const ctl = controlledSource(kind, line, ref, nd);
        if (typeof ctl === "string") skipped.add(`${name} (${ctl})`);
        else ckt.controlled.push(ctl);
        break;
      }
      case "D": {
        const m = models.get((tok[3] ?? "").toUpperCase());
        if (!m || m.type !== "D") {
          skipped.add(`${name} (no diode model ${tok[3]})`);
          break;
        }
        const area = num(tok[4]) ?? 1;
        const d = diodeDevice(ref(name), ref(name), nd(tok[1]), nd(tok[2]), (m.params.IS ?? 1e-14) * area, (m.params.N ?? 1) * VT, (m.params.RS ?? 0) / area);
        ckt.devices.push({ ...d, internal: true });
        break;
      }
      case "Q": {
        // Q c b e [substrate] model
        const mi = tok.findIndex((t, i) => i >= 4 && models.has(t.toUpperCase()));
        const m = mi >= 0 ? models.get(tok[mi].toUpperCase()) : undefined;
        if (!m || (m.type !== "NPN" && m.type !== "PNP")) {
          skipped.add(`${name} (no BJT model)`);
          break;
        }
        const area = num(tok[mi + 1]) ?? 1;
        const P = { ...m.params, IS: (m.params.IS ?? 1e-14) * area };
        ckt.devices.push({ ...bjtDevice(ref(name), ref(name), nd(tok[1]), nd(tok[2]), nd(tok[3]), P, m.type === "PNP"), internal: true });
        break;
      }
      case "M": {
        // M d g s b model [W= L=]
        const m = models.get((tok[5] ?? "").toUpperCase());
        if (!m || (m.type !== "NMOS" && m.type !== "PMOS")) {
          skipped.add(`${name} (no MOSFET model ${tok[5]})`);
          break;
        }
        const kv = Object.fromEntries(tok.slice(6).map((t) => t.split("=")).filter((x) => x.length === 2).map(([k, v]) => [k.toUpperCase(), num(v) ?? 0]));
        // Level-1 KP is per square: W/L from the instance when the card has none.
        const P = { ...m.params, ...(kv.W && !m.params.W ? { W: kv.W } : {}), ...(kv.L && !m.params.L ? { L: kv.L } : {}) };
        ckt.devices.push({ ...mosDevice(ref(name), ref(name), nd(tok[1]), nd(tok[2]), nd(tok[3]), P, m.type === "PMOS", 2e-5), internal: true });
        break;
      }
      case "X": {
        // X n1 n2 ... subname [params]
        const args = tok.slice(1).filter((t) => !t.includes("=") && !/^params:$/i.test(t));
        const target = subckts.get((args[args.length - 1] ?? "").toUpperCase());
        if (!target) {
          skipped.add(`${name} (no subcircuit ${args[args.length - 1]})`);
          break;
        }
        const nodes = args.slice(0, -1);
        if (nodes.length !== target.ports.length) {
          skipped.add(`${name} (${nodes.length} nodes for ${target.ports.length} ports)`);
          break;
        }
        expandSubckt(ckt, target, nodes.map(nd), ref(name), { ...ctx, models, subckts }, depth + 1);
        break;
      }
      default:
        skipped.add(`${name} (element type ${kind} is not supported)`);
    }
  }
  if (skipped.size) ckt.warnings.push(`${prefix} (${sub.name}): skipped ${[...skipped].slice(0, 6).join(", ")}${skipped.size > 6 ? ` and ${skipped.size - 6} more` : ""}`);
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
  const ckt: Circuit = { nodeNames, linear: [], vsrc: [], isrc: [], devices: [], controlled: [], internalNodes: new Set(), notModeled: [], warnings: [], params: { opGain: 1e5 } };
  const params = ckt.params;
  const driven = new Set<number>();
  const models = new Map(design.spiceModels.map((m) => [m.name, m]));
  const subckts = new Map((design.spiceSubckts ?? []).map((m) => [m.name.toUpperCase(), m]));
  const modelFor = (c: ComponentData, type: SpiceModelType): SpiceModel | undefined => {
    if (!c.model) return undefined;
    const m = models.get(c.model.toUpperCase());
    if (!m) ckt.warnings.push(`${c.ref}: SPICE model ${c.model} is not in the design's model library; using the built-in model`);
    else if (m.type !== type) ckt.warnings.push(`${c.ref}: model ${m.name} is ${m.type}, the part needs ${type}; using the built-in model`);
    return m && m.type === type ? m : undefined;
  };

  for (const c of design.components) {
    const part = getPart(c.partId);
    if (!part || part.kind !== "part" || c.dnp) continue;
    const id = c.partId;
    const pn = (pin: string) => node(netOf.get(termKey({ comp: c.id, pin })));
    const label = `${c.ref} ${c.value}`;
    // A subcircuit model replaces the part's built-in model.
    const sub = c.model ? subckts.get(c.model.toUpperCase()) : undefined;
    if (sub) {
      const inst = subcktInstances(part, sub, c.spicePins);
      if (typeof inst === "string") ckt.warnings.push(`${c.ref}: ${inst}; using the built-in model`);
      else {
        for (const { suffix, pins } of inst) {
          const outer = pins.map(pn);
          const before = { v: ckt.vsrc.length, c: ckt.controlled.length, l: ckt.linear.length };
          expandSubckt(ckt, sub, outer, `${c.ref}${suffix}`, { node, models, subckts }, 0);
          // Ports the model drives (a ground-referenced voltage-type source on them, directly or
          // through a small resistance, like an op-amp or regulator output) are not forced to ideal
          // rail supplies. Level shifts between two nodes (e.g. from a supply pin) do not count.
          const sourced = new Set<number>();
          for (const v of [...ckt.vsrc.slice(before.v), ...ckt.controlled.slice(before.c).filter((e) => e.kind === "E" || e.kind === "H")]) {
            if (v.n < 0 && v.p >= 0) sourced.add(v.p);
            if (v.p < 0 && v.n >= 0) sourced.add(v.n);
          }
          for (const k of outer) {
            if (k < 0) continue;
            const near = sourced.has(k) || ckt.linear.slice(before.l).some((e) => e.kind === "R" && e.value <= 1000 && ((e.a === k && sourced.has(e.b)) || (e.b === k && sourced.has(e.a))));
            if (near) driven.add(k);
          }
        }
        continue;
      }
    }
    if (id.startsWith("resistor")) {
      const r = parseValue(c.value);
      if (!r || r <= 0) ckt.warnings.push(`${c.ref}: cannot parse resistance "${c.value}"`);
      else ckt.linear.push({ kind: "R", ref: c.ref, label, a: pn("1"), b: pn("2"), value: r, ratedW: RATED_W[part.footprint?.name ?? ""] });
    } else if (id.startsWith("ferrite")) ckt.linear.push({ kind: "R", ref: c.ref, label, a: pn("1"), b: pn("2"), value: 0.05 });
    else if (id.startsWith("fuse")) ckt.linear.push({ kind: "R", ref: c.ref, label, a: pn("1"), b: pn("2"), value: 0.1 });
    else if (id.startsWith("inductor")) ckt.linear.push({ kind: "L", ref: c.ref, label, a: pn("1"), b: pn("2"), value: parseValue(c.value) ?? 1e-5 });
    else if (id.startsWith("capacitor")) ckt.linear.push({ kind: "C", ref: c.ref, label, a: pn("1"), b: pn("2"), value: parseValue(c.value) ?? 1e-7 });
    else if (id.startsWith("led") || id.startsWith("diode") || id.startsWith("schottky")) {
      const model = modelFor(c, "D");
      const { vf, n, led } = diodeParams(c);
      const N = model?.params.N ?? (model ? 1 : n);
      const nvt = N * VT;
      const is = model?.params.IS ?? (model ? 1e-14 : 0.01 / Math.exp(vf / nvt));
      const rs = model?.params.RS ?? 0;
      ckt.devices.push(diodeDevice(c.ref, label, pn("2"), pn("1"), is, nvt, rs, led)); // anode, cathode
    } else if (id.startsWith("npn") || id.startsWith("pnp")) {
      const pnp = id.startsWith("pnp");
      ckt.devices.push(bjtDevice(c.ref, label, pn("3"), pn("1"), pn("2"), modelFor(c, pnp ? "PNP" : "NPN")?.params ?? {}, pnp)); // C, B, E
    } else if (id.startsWith("nmos") || id.startsWith("pmos")) {
      const pmos = id.startsWith("pmos");
      ckt.devices.push(mosDevice(c.ref, label, pn("3"), pn("1"), pn("2"), modelFor(c, pmos ? "PMOS" : "NMOS")?.params ?? {}, pmos)); // D, G, S
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
  const size = systemSize(ckt);
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
    stampControlled(ckt, A, z, scale);
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
  const zero = new Float64Array(systemSize(ckt));
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
    if (e.internal) continue;
    const v = V(e.a) - V(e.b);
    const i = e.kind === "R" ? v / e.value : e.kind === "C" ? capI?.get(e) ?? 0 : indI?.get(e) ?? v * 1e3;
    out.push({ ref: e.ref, label: e.label, current: i, voltage: v, power: v * i });
  }
  for (const d of ckt.devices) {
    if (d.internal) continue;
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
  const supplies = ckt.vsrc.flatMap((s, j) => {
    if (s.internal) return [];
    const i = -x[n + j];
    const v = s.spec.dc;
    return [{ name: s.supply ? s.ref : s.label, voltage: v, current: i, power: v * i }];
  });
  const ground = computeNets(design).find((m) => isGroundNet(m.name))!.name;
  const nodes = [{ net: ground, voltage: 0 }, ...ckt.nodeNames.map((net, k) => ({ net, voltage: x[k] })).filter((nd) => !ckt.internalNodes.has(nd.net))].sort((a, b) => a.net.localeCompare(b.net, undefined, { numeric: true }));
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
  ckt.nodeNames.forEach((nm) => !ckt.internalNodes.has(nm) && (nodes[nm] = [0]));
  const refs = [...ckt.linear.filter((e) => !e.internal).map((e) => e.ref), ...ckt.devices.filter((d) => !d.internal).map((d) => d.ref), ...ckt.vsrc.filter((s) => !s.supply && !s.internal).map((s) => s.ref)];
  const currents: Record<string, number[]> = {};
  refs.forEach((r) => (currents[r] = [0]));
  let x: Float64Array = new Float64Array(systemSize(ckt));
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
    ckt.nodeNames.forEach((nm, k) => nodes[nm]?.push(x[k]));
    const er = elementResults(ckt, x, capI, indI);
    for (const e of er) currents[e.ref]?.push(e.current);
    ckt.vsrc.forEach((s, j) => !s.supply && !s.internal && currents[s.ref].push(-x[n + j]));
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
  const size = systemSize(ckt);
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
  stampControlled(ckt, G);
  const ppd = Math.max(1, Math.round(opts.pointsPerDecade ?? 20));
  const decades = Math.log10(opts.fstop / opts.fstart);
  if (!(decades > 0)) return fail("fstop must be greater than fstart");
  const count = Math.max(2, Math.round(decades * ppd) + 1);
  const freq: number[] = [];
  const nodes: Record<string, { mag: number[]; phase: number[] }> = {};
  ckt.nodeNames.forEach((nm) => !ckt.internalNodes.has(nm) && (nodes[nm] = { mag: [], phase: [] }));
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
      if (!nodes[nm]) return;
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

// ---------- sweeps ----------

export interface SweepResult {
  ok: boolean;
  error?: string;
  /** Swept parameter (component ref) and its values. */
  param: string;
  x: number[];
  nodes: Record<string, number[]>;
  currents: Record<string, number[]>;
  warnings: string[];
}

/** Value string for a component with its main number replaced (keeps a source's AC/transient parts). */
function sweptValue(value: string, partId: string, v: number): string {
  if (partId.startsWith("sim_")) return /^\s*DC\s+\S+/i.test(value) ? value.replace(/^\s*DC\s+\S+/i, `DC ${v}`) : `DC ${v}`;
  return String(v);
}

/** The design with one component's value replaced (for sweeps and parameter steps). */
export function withValue(design: Design, ref: string, value: string): Design {
  return { ...design, components: design.components.map((c) => (c.ref === ref ? { ...c, value } : c)) };
}

/** DC sweep: operating point as a component's value (a source voltage, a resistance…) goes from `from` to `to`. */
export function sweepDC(design: Design, opts: { ref: string; from: number; to: number; points?: number }): SweepResult {
  const c = design.components.find((x) => x.ref === opts.ref);
  const out: SweepResult = { ok: true, param: opts.ref, x: [], nodes: {}, currents: {}, warnings: [] };
  if (!c) return { ...out, ok: false, error: `No component ${opts.ref}` };
  const n = Math.max(2, Math.min(500, opts.points ?? 41));
  const seen = new Map<string, [string, number]>();
  for (let k = 0; k < n; k++) {
    const v = opts.from + ((opts.to - opts.from) * k) / (n - 1);
    const r = simulateDC(withValue(design, opts.ref, sweptValue(c.value, c.partId, v)));
    if (!r.ok) return { ...out, ok: false, error: r.error };
    out.x.push(v);
    for (const nd of r.nodes) (out.nodes[nd.net] ??= new Array(k).fill(NaN)).push(nd.voltage);
    for (const e of r.elements) (out.currents[e.ref] ??= new Array(k).fill(NaN)).push(e.current);
    for (const w of r.warnings) seen.set(w.replace(/[-\d.]+/g, "#"), [seen.get(w.replace(/[-\d.]+/g, "#"))?.[0] ?? w, (seen.get(w.replace(/[-\d.]+/g, "#"))?.[1] ?? 0) + 1]);
  }
  // The same warning at many sweep points (with different numbers) is reported once.
  out.warnings = [...seen.values()].map(([w, k]) => (k > 1 ? `${w} (at ${k} of ${n} points)` : w));
  return out;
}

/** Parameter step: run any analysis once per value of a component (e.g. R2 = 1k, 10k, 100k). */
export function stepParam<T>(design: Design, ref: string, values: string[], run: (d: Design) => T): { value: string; result: T }[] {
  if (!design.components.some((c) => c.ref === ref)) throw new Error(`No component ${ref}`);
  return values.map((value) => ({ value, result: run(withValue(design, ref, value)) }));
}
