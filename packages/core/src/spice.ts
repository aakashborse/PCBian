// SPICE .model import: diode, BJT and MOSFET model cards from vendor model files.
import type { SpiceModel, SpiceModelType } from "./types";

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
  warnings: string[];
}

/** Parse every `.model` card in a SPICE text (continuation lines start with "+", comments with "*" or ";"). */
export function parseSpiceModels(text: string): SpiceParseResult {
  const warnings: string[] = [];
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, "").trimEnd();
    if (!line.trim() || line.trim().startsWith("*")) continue;
    if (line.trim().startsWith("+") && lines.length) lines[lines.length - 1] += " " + line.trim().slice(1);
    else lines.push(line.trim());
  }
  const models: SpiceModel[] = [];
  let subckts = 0;
  for (const line of lines) {
    if (/^\.subckt\b/i.test(line)) subckts++;
    const m = line.match(/^\.model\s+(\S+)\s+([A-Za-z]+)\s*\(?(.*?)\)?\s*$/i);
    if (!m) continue;
    const type = TYPES[m[2].toUpperCase()];
    if (!type) {
      warnings.push(`${m[1]}: model type ${m[2]} is not supported (D, NPN, PNP, NMOS, PMOS)`);
      continue;
    }
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
    models.push({ name: m[1].toUpperCase(), type: t, params });
  }
  if (subckts) warnings.push(`${subckts} .subckt definition(s) skipped: only primitive .model cards are imported`);
  if (!models.length && !warnings.length) warnings.push("No .model cards found");
  return { models, warnings };
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
