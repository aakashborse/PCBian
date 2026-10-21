// Custom design rules: a small KiCad-style rule language checked by the DRC.
//
//   (rule "HV spacing"
//     (condition "A.NetClass == 'HV' && B.NetClass != 'HV'")
//     (constraint clearance (min 1.5mm)))
//   (rule "Stack marker" (condition "A.intersectsArea('Room_LS')") (constraint edge_clearance (min 0mm)))
//
// Later rules override earlier ones; items no rule matches fall back to the board and net-class
// settings. Conditions compare item properties (Type, NetName, NetClass, Layer, Reference,
// Footprint, Pad, PadType = smd | thru) with == / != (wildcards * and ?), combine them with && || ! (or and/or/not),
// and test named rule areas with A.insideArea('name') / A.intersectsArea('name').
import { parseSExpr, type SExpr } from "./kicad";
import { pointInPolygon, polygonPolygonDistance, polylineTouchesPolygon, segmentPolygonDistance } from "./geometry";
import type { Design, Vec } from "./types";

export type ConstraintKind = "clearance" | "edge_clearance" | "track_width" | "via_diameter" | "hole_size" | "disallow";
export const CONSTRAINT_KINDS: ConstraintKind[] = ["clearance", "edge_clearance", "track_width", "via_diameter", "hole_size", "disallow"];

export interface Constraint {
  kind: ConstraintKind;
  min?: number;
  max?: number;
  /** For disallow: the item types it forbids (track, via, pad). */
  types?: string[];
}

export interface DesignRule {
  name: string;
  condition?: string;
  constraints: Constraint[];
  /** Compiled condition (absent = always applies). */
  test?: Expr;
}

/** The copper object a rule is evaluated against, with its geometry for area tests. */
export interface RuleItem {
  type: "track" | "via" | "pad";
  net?: string;
  netClass?: string;
  layer?: string;
  ref?: string;
  footprint?: string;
  pad?: string;
  /** For pads: surface-mount or plated through-hole. */
  padType?: "smd" | "thru";
  shape: { kind: "line"; points: Vec[]; width: number } | { kind: "circle"; c: Vec; r: number } | { kind: "poly"; points: Vec[] };
}

// ---------- parsing ----------

/** Length with an optional unit (mm, mil, in, um); bare numbers are millimetres. */
export function parseLength(s: string): number {
  const m = s.trim().match(/^(-?[\d.]+(?:e-?\d+)?)\s*(mm|mil|mils|in|um)?$/i);
  if (!m) throw new Error(`Bad length "${s}"`);
  const v = Number(m[1]);
  const u = (m[2] ?? "mm").toLowerCase();
  return u === "mil" || u === "mils" ? v * 0.0254 : u === "in" ? v * 25.4 : u === "um" ? v / 1000 : v;
}

const isList = (e: SExpr): e is SExpr[] => Array.isArray(e);

export function parseRules(text: string): { rules: DesignRule[]; errors: string[] } {
  const rules: DesignRule[] = [];
  const errors: string[] = [];
  if (!text.trim()) return { rules, errors };
  let root: SExpr;
  try {
    root = parseSExpr(`(rules ${text.replace(/^\s*#.*$/gm, "")})`);
  } catch (e) {
    return { rules, errors: [`Syntax: ${(e as Error).message}`] };
  }
  for (const r of (root as SExpr[]).slice(1)) {
    if (!isList(r) || r[0] === "version") continue;
    if (r[0] !== "rule") {
      errors.push(`Unknown top-level form "${String(r[0])}"`);
      continue;
    }
    const name = String(r[1] ?? `rule ${rules.length + 1}`);
    const rule: DesignRule = { name, constraints: [] };
    try {
      for (const part of r.slice(2)) {
        if (!isList(part)) continue;
        if (part[0] === "condition") {
          rule.condition = String(part[1] ?? "");
          rule.test = parseExpr(rule.condition);
        } else if (part[0] === "constraint") {
          const kind = String(part[1]) as ConstraintKind;
          if (!CONSTRAINT_KINDS.includes(kind)) throw new Error(`unknown constraint "${kind}"`);
          const c: Constraint = { kind };
          for (const opt of part.slice(2)) {
            if (isList(opt) && (opt[0] === "min" || opt[0] === "max" || opt[0] === "opt")) {
              const v = parseLength(String(opt[1]));
              if (opt[0] === "max") c.max = v;
              else c.min = v;
            } else if (kind === "disallow" && typeof opt === "string") (c.types ??= []).push(opt);
          }
          rule.constraints.push(c);
        } else if (part[0] !== "layer" && part[0] !== "severity") throw new Error(`unknown clause "${String(part[0])}"`);
      }
      if (!rule.constraints.length) throw new Error("no constraint");
      rules.push(rule);
    } catch (e) {
      errors.push(`Rule "${name}": ${(e as Error).message}`);
    }
  }
  return { rules, errors };
}

// ---------- condition expressions ----------

type Expr =
  | { k: "lit"; v: string | number | boolean }
  | { k: "prop"; obj: "A" | "B"; name: string }
  | { k: "call"; obj: "A" | "B"; name: string; args: string[] }
  | { k: "not"; e: Expr }
  | { k: "bin"; op: "&&" | "||" | "==" | "!=" | "<" | ">" | "<=" | ">="; a: Expr; b: Expr };

function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /\s*(&&|\|\||==|!=|<=|>=|[!()<>,]|'[^']*'|"[^"]*"|[A-Za-z_][\w.]*|-?[\d.]+\s*(?:mm|mil|in|um)?)/y;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while (re.lastIndex < s.length) {
    if (/^\s*$/.test(s.slice(re.lastIndex))) break;
    const at = re.lastIndex;
    m = re.exec(s);
    if (!m) throw new Error(`unexpected "${s.slice(at).trim().slice(0, 12)}" in condition`);
    out.push(m[1]);
  }
  return out;
}

export function parseExpr(src: string): Expr {
  const t = tokenize(src);
  let i = 0;
  const peek = () => t[i];
  const eat = (x?: string) => {
    const v = t[i++];
    if (x !== undefined && v !== x) throw new Error(`expected "${x}" in condition`);
    if (v === undefined) throw new Error("condition ends early");
    return v;
  };
  const isOr = (x?: string) => x === "||" || x?.toLowerCase() === "or";
  const isAnd = (x?: string) => x === "&&" || x?.toLowerCase() === "and";
  const or = (): Expr => {
    let a = and();
    while (isOr(peek())) {
      eat();
      a = { k: "bin", op: "||", a, b: and() };
    }
    return a;
  };
  const and = (): Expr => {
    let a = unary();
    while (isAnd(peek())) {
      eat();
      a = { k: "bin", op: "&&", a, b: unary() };
    }
    return a;
  };
  const unary = (): Expr => {
    if (peek() === "!" || peek()?.toLowerCase() === "not") {
      eat();
      return { k: "not", e: unary() };
    }
    const a = value();
    const op = peek();
    if (op === "==" || op === "!=" || op === "<" || op === ">" || op === "<=" || op === ">=") {
      eat();
      return { k: "bin", op, a, b: value() };
    }
    return a;
  };
  const value = (): Expr => {
    const x = eat();
    if (x === "(") {
      const e = or();
      eat(")");
      return e;
    }
    if (/^['"]/.test(x)) return { k: "lit", v: x.slice(1, -1) };
    if (/^-?[\d.]/.test(x)) return { k: "lit", v: parseLength(x) };
    if (/^true$/i.test(x)) return { k: "lit", v: true };
    if (/^false$/i.test(x)) return { k: "lit", v: false };
    const m = x.match(/^([AB])\.(\w+)$/);
    if (!m) throw new Error(`unknown name "${x}" (use A.<property> or B.<property>)`);
    const obj = m[1] as "A" | "B";
    if (peek() === "(") {
      eat("(");
      const args: string[] = [];
      while (peek() !== ")") {
        const a = eat();
        if (a !== ",") args.push(a.replace(/^['"]|['"]$/g, ""));
      }
      eat(")");
      if (!["insideArea", "intersectsArea"].includes(m[2])) throw new Error(`unknown function ${m[2]}()`);
      return { k: "call", obj, name: m[2], args };
    }
    if (!PROPS.includes(m[2])) throw new Error(`unknown property ${m[2]} (try ${PROPS.join(", ")})`);
    return { k: "prop", obj, name: m[2] };
  };
  const e = or();
  if (i < t.length) throw new Error(`unexpected "${t[i]}" in condition`);
  return e;
}

const PROPS = ["Type", "PadType", "NetName", "NetClass", "Layer", "Reference", "Footprint", "Pad"];

const glob = (pattern: string, s: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i").test(s);

interface EvalCtx {
  A: RuleItem;
  B?: RuleItem;
  areas: Map<string, Vec[]>;
}

function prop(it: RuleItem | undefined, name: string): string {
  if (!it) return "";
  switch (name) {
    case "Type":
      return it.type;
    case "PadType":
      return it.padType ?? "";
    case "NetName":
      return it.net ?? "";
    case "NetClass":
      return it.netClass ?? "Default";
    case "Layer":
      return it.layer ?? "";
    case "Reference":
      return it.ref ?? "";
    case "Footprint":
      return it.footprint ?? "";
    default:
      return it.pad ?? "";
  }
}

function inArea(it: RuleItem, area: Vec[], whole: boolean): boolean {
  const s = it.shape;
  if (s.kind === "circle") return whole ? pointInPolygon(s.c, area) : segmentPolygonDistance(s.c, s.c, area) <= s.r;
  if (s.kind === "line") return whole ? s.points.every((p) => pointInPolygon(p, area)) : polylineTouchesPolygon(s.points, area);
  return whole ? s.points.every((p) => pointInPolygon(p, area)) : polygonPolygonDistance(s.points, area) === 0;
}

function evaluate(e: Expr, ctx: EvalCtx): string | number | boolean {
  switch (e.k) {
    case "lit":
      return e.v;
    case "prop":
      return prop(e.obj === "A" ? ctx.A : ctx.B, e.name);
    case "call": {
      const it = e.obj === "A" ? ctx.A : ctx.B;
      const area = ctx.areas.get(e.args[0] ?? "");
      return Boolean(it && area && inArea(it, area, e.name === "insideArea"));
    }
    case "not":
      return !truthy(evaluate(e.e, ctx));
    case "bin": {
      if (e.op === "&&") return truthy(evaluate(e.a, ctx)) && truthy(evaluate(e.b, ctx));
      if (e.op === "||") return truthy(evaluate(e.a, ctx)) || truthy(evaluate(e.b, ctx));
      const a = evaluate(e.a, ctx);
      const b = evaluate(e.b, ctx);
      if (e.op === "==" || e.op === "!=") {
        const eq = typeof a === "string" && typeof b === "string" ? glob(b, a) || glob(a, b) : a === b;
        return e.op === "==" ? eq : !eq;
      }
      const x = Number(a);
      const y = Number(b);
      return e.op === "<" ? x < y : e.op === ">" ? x > y : e.op === "<=" ? x <= y : x >= y;
    }
  }
}
const truthy = (v: string | number | boolean) => (typeof v === "string" ? v !== "" : Boolean(v));

// ---------- evaluation ----------

export interface RuleSet {
  rules: DesignRule[];
  errors: string[];
  areas: Map<string, Vec[]>;
}

/** Rules and named rule areas of a design. */
export function compileRules(design: Pick<Design, "rules" | "keepouts">): RuleSet {
  const { rules, errors } = parseRules(design.rules ?? "");
  const areas = new Map<string, Vec[]>();
  for (const k of design.keepouts) if (k.name) areas.set(k.name, k.points);
  for (const r of rules) {
    const missing = (r.condition?.match(/Area\(\s*['"]([^'"]*)['"]/g) ?? []).map((m) => m.replace(/^.*\(\s*['"]/, "").replace(/['"]$/, "")).filter((n) => !areas.has(n));
    if (missing.length) errors.push(`Rule "${r.name}": no rule area named ${missing.map((n) => `'${n}'`).join(", ")}`);
  }
  return { rules, errors, areas };
}

/**
 * The constraint of a kind that applies to an item (or, for clearance, a pair: the condition may
 * match with the items either way round). The last matching rule wins.
 */
export function ruleConstraint(rs: RuleSet, kind: ConstraintKind, a: RuleItem, b?: RuleItem): (Constraint & { rule: string }) | undefined {
  for (let i = rs.rules.length - 1; i >= 0; i--) {
    const r = rs.rules[i];
    const c = r.constraints.find((x) => x.kind === kind);
    if (!c) continue;
    const ok = (A: RuleItem, B?: RuleItem) => !r.test || truthy(evaluate(r.test, { A, B, areas: rs.areas }));
    if (ok(a, b) || (b && ok(b, a))) return { ...c, rule: r.name };
  }
  return undefined;
}
