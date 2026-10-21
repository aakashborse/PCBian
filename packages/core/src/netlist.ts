import { getPart } from "./library";
import type { ComponentData, Design, Net, Terminal } from "./types";

export class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x);
    if (p === undefined) {
      this.parent.set(x, x);
      return x;
    }
    if (p === x) return x;
    p = this.find(p);
    this.parent.set(x, p);
    return p;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
  /** Every element seen so far. */
  keys(): IterableIterator<string> {
    return this.parent.keys();
  }
}

export const termKey = (t: Terminal) => `${t.comp}:${t.pin}`;

/** Scope-aware label kinds that name nets. */
const LABEL_KINDS = new Set(["power", "netlabel", "locallabel", "hierlabel"]);

/**
 * Derive nets from wires and labels. Power symbols and global labels join by name across all sheets,
 * local labels join within their sheet, hierarchical labels join their sheet's sheet-symbol pins.
 * Every pin of every component belongs to exactly one net.
 */
export function computeNets(design: Design): Net[] {
  const uf = new UnionFind();
  const byId = new Map(design.components.map((c) => [c.id, c]));
  const allTerms: Terminal[] = [];
  const first = design.sheets[0]?.id ?? "main";
  const sheetName = new Map(design.sheets.map((s) => [s.id, s.name]));
  const sheetOfC = (c: ComponentData) => c.sheet ?? first;

  for (const c of design.components) {
    const part = getPart(c.partId);
    if (!part) continue;
    for (const p of part.symbol.pins) {
      const t = { comp: c.id, pin: p.id };
      allTerms.push(t);
      uf.find(termKey(t));
    }
    const name = c.value.trim();
    const key0 = part.symbol.pins[0] && termKey({ comp: c.id, pin: part.symbol.pins[0].id });
    if (part.kind === "power" || part.kind === "netlabel") uf.union(key0, `G:${name}`);
    else if (part.kind === "locallabel") uf.union(key0, `L:${sheetOfC(c)}:${name}`);
    else if (part.kind === "hierlabel") uf.union(key0, `H:${sheetOfC(c)}:${name}`);
    else if (part.kind === "sheet") for (const p of part.symbol.pins) uf.union(termKey({ comp: c.id, pin: p.id }), `H:${c.value}:${p.id}`);
  }
  for (const w of design.wires) {
    if (byId.has(w.a.comp) && byId.has(w.b.comp)) uf.union(termKey(w.a), termKey(w.b));
  }

  const groups = new Map<string, Terminal[]>();
  for (const t of allTerms) {
    const r = uf.find(termKey(t));
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(t);
  }

  const nets: Net[] = [];
  const usedNames = new Set<string>();
  for (const terms of groups.values()) {
    const labelled = terms.map((t) => byId.get(t.comp)!).filter((c) => LABEL_KINDS.has(getPart(c.partId)?.kind ?? ""));
    const globals = labelled.filter((c) => ["power", "netlabel"].includes(getPart(c.partId)!.kind)).map((c) => c.value.trim()).sort();
    const scoped = labelled
      .filter((c) => !["power", "netlabel"].includes(getPart(c.partId)!.kind))
      // KiCad-style hierarchical names: "/name" on the root sheet, "/Sheet/name" elsewhere.
      .map((c) => (sheetOfC(c) === first ? `/${c.value.trim()}` : `/${sheetName.get(sheetOfC(c)) ?? sheetOfC(c)}/${c.value.trim()}`))
      .sort();
    let name: string;
    let named = false;
    if (globals.length || scoped.length) {
      name = globals[0] ?? scoped[0];
      named = true;
    } else {
      const phys = terms.filter((t) => getPart(byId.get(t.comp)!.partId)?.kind === "part");
      const pick = (phys.length ? phys : terms).sort((a, b) => refOf(byId, a).localeCompare(refOf(byId, b), undefined, { numeric: true }))[0];
      name = `Net-(${refOf(byId, pick)}-${pick.pin})`;
    }
    while (usedNames.has(name)) name += "_";
    usedNames.add(name);
    nets.push({ name, terminals: terms, named });
  }
  nets.sort((a, b) => Number(b.named) - Number(a.named) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return nets;
}

function refOf(byId: Map<string, ComponentData>, t: Terminal) {
  return byId.get(t.comp)?.ref ?? t.comp;
}

/** Map "comp:pin" -> net name, considering only physical parts. */
export function netByTerminal(nets: Net[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of nets) for (const t of n.terminals) m.set(termKey(t), n.name);
  return m;
}

/** Nets that contain at least two physical (footprint-bearing) pins. */
export function physicalNets(design: Design, nets: Net[]): Net[] {
  const byId = new Map(design.components.map((c) => [c.id, c]));
  return nets
    .map((n) => ({ ...n, terminals: n.terminals.filter((t) => getPart(byId.get(t.comp)!.partId)?.footprint) }))
    .filter((n) => n.terminals.length > 0);
}
