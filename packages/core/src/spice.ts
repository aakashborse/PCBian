// SPICE model import: diode, BJT and MOSFET .model cards and .subckt macromodels (op-amps,
// regulators, references...) from vendor model files.
import { allPins } from "./library";
import type { PartDef, SpiceModel, SpiceModelType, SpiceSubckt } from "./types";

const TYPES: Record<string, SpiceModelType> = { D: "D", NPN: "NPN", PNP: "PNP", NMOS: "NMOS", PMOS: "PMOS", VDMOS: "NMOS" };

/** SPICE number: 1.5k, 2.2MEG, 10u, 4.7p, 1e-14, 3mA (trailing units ignored; M = milli). */
export function spiceNumber(raw: string): number | null {
  const m = raw.trim().match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(meg|mil|[tgkmunpf])?/i);
  if (!m) return null;
  const v = Number(m[1]);
  const s = (m[2] ?? "").toLowerCase();
  const mult = s === "meg" ? 1e6 : s === "mil" ? 25.4e-6 : ({ t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 } as Record<string, number>)[s] ?? 1;
  return Number.isFinite(v) ? v * mult : null;
}

export interface SpiceParseResult {
  models: SpiceModel[];
  subckts: SpiceSubckt[];
  warnings: string[];
}

/** SPICE text as logical lines: continuations joined, comments and blank lines dropped. */
export function spiceLines(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, "").replace(/\s\$\s.*$/, "").trimEnd();
    if (!line.trim() || line.trim().startsWith("*")) continue;
    if (line.trim().startsWith("+") && lines.length) lines[lines.length - 1] += " " + line.trim().slice(1);
    else lines.push(line.trim());
  }
  return lines;
}

/** One .model card, or a reason it was skipped. */
export function parseModelCard(line: string): SpiceModel | string | null {
  const m = line.match(/^\.model\s+(\S+)\s+([A-Za-z]+)\s*\(?(.*?)\)?\s*$/i);
  if (!m) return null;
  const type = TYPES[m[2].toUpperCase()];
  if (!type) return `${m[1]}: model type ${m[2]} is not supported (D, NPN, PNP, NMOS, PMOS)`;
  const params: Record<string, number> = {};
  // Parameters look like NAME=VALUE, possibly with spaces around "=".
  for (const p of m[3].replace(/\s*=\s*/g, "=").split(/[\s,()]+/)) {
    const kv = p.match(/^([A-Za-z_][\w]*)=(.+)$/);
    if (!kv) continue;
    const v = spiceNumber(kv[2]);
    if (v !== null) params[kv[1].toUpperCase()] = v;
  }
  // VDMOS power-MOSFET cards carry a pchan flag.
  const t = m[2].toUpperCase() === "VDMOS" && /\bpchan\b/i.test(m[3]) ? "PMOS" : type;
  return { name: m[1].toUpperCase(), type: t, params };
}

/**
 * Parse a SPICE model file: top-level `.model` cards and `.subckt` ... `.ends` blocks (whose own
 * .model cards stay local to them).
 */
export function parseSpiceModels(text: string): SpiceParseResult {
  const warnings: string[] = [];
  const models: SpiceModel[] = [];
  const subckts: SpiceSubckt[] = [];
  let open: SpiceSubckt | null = null;
  let depth = 0;
  for (const line of spiceLines(text)) {
    const sub = line.match(/^\.subckt\s+(\S+)\s*(.*)$/i);
    if (sub) {
      if (open) {
        // Nested definitions stay in the body; the expander handles them.
        depth++;
        open.lines.push(line);
        continue;
      }
      // Ports end where parameters (NAME=VALUE or PARAMS:) begin.
      const ports: string[] = [];
      for (const tok of sub[2].split(/\s+/).filter(Boolean)) {
        if (/^params:$/i.test(tok) || tok.includes("=")) break;
        ports.push(tok);
      }
      open = { name: sub[1].toUpperCase(), ports, lines: [] };
      continue;
    }
    if (/^\.ends\b/i.test(line)) {
      if (depth > 0) {
        depth--;
        open?.lines.push(line);
        continue;
      }
      if (open) subckts.push(open);
      open = null;
      continue;
    }
    if (open) {
      open.lines.push(line);
      continue;
    }
    const card = parseModelCard(line);
    if (typeof card === "string") warnings.push(card);
    else if (card) models.push(card);
  }
  if (open) warnings.push(`${open.name}: .subckt without .ends; ignored`);
  if (!models.length && !subckts.length && !warnings.length) warnings.push("No .model or .subckt definitions found");
  return { models, subckts, warnings };
}

/**
 * How a part's pins connect to a subcircuit's ports, one entry per instance: `spicePins` when
 * given ("3 2 8 4 1"), the standard op-amp order (IN+ IN- V+ V- OUT) for each half of a dual
 * op-amp, or the part's pins in number order when the counts match.
 */
export function subcktInstances(part: PartDef, sub: SpiceSubckt, spicePins?: string): { suffix: string; pins: string[] }[] | string {
  const pins = allPins(part).map((p) => p.id);
  if (spicePins?.trim()) {
    const map = spicePins.trim().split(/[\s,]+/);
    if (map.length !== sub.ports.length) return `${sub.name} has ${sub.ports.length} ports but ${map.length} pins were mapped`;
    const bad = map.find((p) => !pins.includes(p));
    return bad ? `pin ${bad} is not on ${part.name}` : [{ suffix: "", pins: map }];
  }
  if (/^lm358/i.test(part.id) && sub.ports.length === 5)
    return [
      { suffix: "A", pins: ["3", "2", "8", "4", "1"] },
      { suffix: "B", pins: ["5", "6", "8", "4", "7"] },
    ];
  if (pins.length === sub.ports.length) return [{ suffix: "", pins: [...pins].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) }];
  return `${sub.name} has ${sub.ports.length} ports (${sub.ports.join(" ")}) and ${part.name} has ${pins.length} pins: set the pin mapping`;
}

/** Which model types a library part can use. */
export function modelTypesForPart(partId: string): SpiceModelType[] {
  if (/^(led|diode|schottky)/.test(partId)) return ["D"];
  if (partId.startsWith("npn")) return ["NPN"];
  if (partId.startsWith("pnp")) return ["PNP"];
  if (partId.startsWith("nmos")) return ["NMOS"];
  if (partId.startsWith("pmos")) return ["PMOS"];
  return [];
}
