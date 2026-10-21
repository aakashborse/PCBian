// Version history support: comparing two design states and restoring a snapshot into a live
// (collaborative) document as ordinary edits, so the restore syncs to everyone and can be undone.
import * as Y from "yjs";
import { DESIGN_MAPS, getDesign } from "./doc";
import { computeNets } from "./netlist";
import type { Design } from "./types";

export interface DesignDiff {
  components: { added: string[]; removed: string[]; changed: { ref: string; what: string[] }[] };
  nets: { added: string[]; removed: string[] };
  wires: { added: number; removed: number };
  traces: { added: number; removed: number; changed: number };
  vias: { added: number; removed: number };
  zones: { added: number; removed: number };
  sheets: { added: string[]; removed: string[] };
  board: string[];
  rules: string[];
  /** Nothing at all differs. */
  same: boolean;
}

const json = (v: unknown) => JSON.stringify(v);

function byId<T extends { id: string }>(a: T[], b: T[]) {
  const A = new Map(a.map((x) => [x.id, x]));
  const B = new Map(b.map((x) => [x.id, x]));
  return {
    added: [...B.keys()].filter((k) => !A.has(k)).map((k) => B.get(k)!),
    removed: [...A.keys()].filter((k) => !B.has(k)).map((k) => A.get(k)!),
    common: [...A.keys()].filter((k) => B.has(k)).map((k) => [A.get(k)!, B.get(k)!] as [T, T]),
  };
}

/** What changed going from design `a` (older) to design `b` (newer). */
export function designDiff(a: Design, b: Design): DesignDiff {
  const comps = byId(a.components, b.components);
  const changed: { ref: string; what: string[] }[] = [];
  for (const [x, y] of comps.common) {
    const what: string[] = [];
    if (x.ref !== y.ref) what.push(`ref ${x.ref}→${y.ref}`);
    if (x.value !== y.value) what.push(`value ${x.value}→${y.value}`);
    if (x.partId !== y.partId) what.push("part");
    if (x.sch.x !== y.sch.x || x.sch.y !== y.sch.y || x.sch.rot !== y.sch.rot || Boolean(x.sch.mirror) !== Boolean(y.sch.mirror)) what.push("schematic position");
    if (x.pcb.x !== y.pcb.x || x.pcb.y !== y.pcb.y || x.pcb.rot !== y.pcb.rot) what.push("PCB position");
    if (x.pcb.side !== y.pcb.side) what.push(`side ${x.pcb.side}→${y.pcb.side}`);
    if (Boolean(x.dnp) !== Boolean(y.dnp)) what.push(y.dnp ? "not fitted" : "fitted");
    if ((x.sheet ?? "") !== (y.sheet ?? "")) what.push("sheet");
    if (what.length) changed.push({ ref: y.ref, what });
  }
  const netsA = new Set(computeNets(a).map((n) => n.name));
  const netsB = new Set(computeNets(b).map((n) => n.name));
  const wires = byId(a.wires, b.wires);
  const traces = byId(a.traces, b.traces);
  const vias = byId(a.vias, b.vias);
  const zones = byId(a.zones, b.zones);
  const sheets = byId(a.sheets, b.sheets);
  const board = (Object.keys({ ...a.board, ...b.board }) as (keyof Design["board"])[]).filter((k) => json(a.board[k]) !== json(b.board[k])).map((k) => `${k}: ${fmt(a.board[k])} → ${fmt(b.board[k])}`);
  const rules: string[] = [];
  if (json(a.netClasses) !== json(b.netClasses)) rules.push("net classes");
  if (json(a.diffPairs) !== json(b.diffPairs)) rules.push("differential pairs");
  if (json(a.lengthGroups) !== json(b.lengthGroups)) rules.push("length groups");
  if (json(a.keepouts) !== json(b.keepouts)) rules.push("keepouts");
  if (json(a.variants) !== json(b.variants) || a.activeVariant !== b.activeVariant) rules.push("variants");
  if (json(a.titleBlock) !== json(b.titleBlock)) rules.push("title block");
  if (json(a.schGraphics) !== json(b.schGraphics) || json(a.pcbGraphics) !== json(b.pcbGraphics)) rules.push("notes / dimensions");
  const d: DesignDiff = {
    components: { added: comps.added.map((c) => c.ref), removed: comps.removed.map((c) => c.ref), changed },
    nets: { added: [...netsB].filter((n) => !netsA.has(n)), removed: [...netsA].filter((n) => !netsB.has(n)) },
    wires: { added: wires.added.length, removed: wires.removed.length },
    traces: { added: traces.added.length, removed: traces.removed.length, changed: traces.common.filter(([x, y]) => json(x) !== json(y)).length },
    vias: { added: vias.added.length, removed: vias.removed.length },
    zones: { added: zones.added.length, removed: zones.removed.length },
    sheets: { added: sheets.added.map((s) => s.name), removed: sheets.removed.map((s) => s.name) },
    board,
    rules,
    same: false,
  };
  d.same =
    !d.components.added.length && !d.components.removed.length && !changed.length && !d.nets.added.length && !d.nets.removed.length &&
    !wires.added.length && !wires.removed.length && !d.traces.added && !d.traces.removed && !d.traces.changed && !d.vias.added && !d.vias.removed &&
    !d.zones.added && !d.zones.removed && !d.sheets.added.length && !d.sheets.removed.length && !board.length && !rules.length && a.name === b.name;
  return d;
}

const fmt = (v: unknown) => (v === undefined ? "default" : typeof v === "object" ? "custom" : String(v));

/** Short human summary of a diff, e.g. "+2 parts, 14 traces added, board width". */
export function summarizeDiff(d: DesignDiff): string {
  if (d.same) return "No changes";
  const out: string[] = [];
  const n = (k: number, word: string) => (k ? `${k} ${word}${k === 1 ? "" : "s"}` : "");
  if (d.components.added.length) out.push(`+${d.components.added.length} part${d.components.added.length > 1 ? "s" : ""}`);
  if (d.components.removed.length) out.push(`−${d.components.removed.length} part${d.components.removed.length > 1 ? "s" : ""}`);
  if (d.components.changed.length) out.push(`${d.components.changed.length} part${d.components.changed.length > 1 ? "s" : ""} edited`);
  if (d.wires.added || d.wires.removed) out.push(`wires +${d.wires.added}/−${d.wires.removed}`);
  if (d.traces.added || d.traces.removed || d.traces.changed) out.push(`traces +${d.traces.added}/−${d.traces.removed}${d.traces.changed ? `/~${d.traces.changed}` : ""}`);
  out.push(n(d.vias.added, "via added"), n(d.vias.removed, "via removed"), n(d.zones.added, "pour added"), n(d.zones.removed, "pour removed"));
  if (d.sheets.added.length) out.push(`sheets +${d.sheets.added.join(", ")}`);
  if (d.board.length) out.push(`board ${d.board.map((b) => b.split(":")[0]).join(", ")}`);
  if (d.rules.length) out.push(d.rules.join(", "));
  return out.filter(Boolean).join(" · ");
}

/** Make the live document's design maps equal to the snapshot's (comments and chat are kept). */
export function restoreInto(live: Y.Doc, snapshot: Y.Doc, origin: unknown = "restore") {
  live.transact(() => {
    for (const name of DESIGN_MAPS) {
      const dst = live.getMap<unknown>(name);
      const src = snapshot.getMap<unknown>(name);
      for (const k of [...dst.keys()]) if (!src.has(k)) dst.delete(k);
      for (const [k, v] of src) if (json(dst.get(k)) !== json(v)) dst.set(k, v);
    }
  }, origin);
}

/** Design snapshot of a stored Yjs update. */
export function designFromUpdate(update: Uint8Array): Design {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return getDesign(doc);
}
