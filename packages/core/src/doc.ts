// Read/write helpers for the collaborative Yjs design document.
// Every mutation goes through these functions so the web client, the server and
// the AI copilot all edit the document the same way.
import * as Y from "yjs";
import { defaultPcbPlacement } from "./geometry";
import { getPart, registerParts } from "./library";
import { ALL_COPPER, type BoardSettings, type PartDef, type ComponentData, type CopperLayer, type Design, type NetClass, type PcbPlacement, type Placement, type Sheet, type Terminal, type Trace, type Vec, type Via, type Wire, type Zone } from "./types";

export const DEFAULT_BOARD: BoardSettings = { width: 50, height: 40, layers: 2, thickness: 1.6, clearance: 0.2, defaultTraceWidth: 0.25 };
export const DEFAULT_SHEET: Sheet = { id: "main", name: "Sheet 1" };

/** Copper layers that exist on a board with the given settings, front to back. */
export const copperLayers = (board: Pick<BoardSettings, "layers">): CopperLayer[] => (board.layers === 4 ? ALL_COPPER : ["top", "bottom"]);

export const uid = (prefix = "") => prefix + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 9);

const meta = (doc: Y.Doc) => doc.getMap<unknown>("meta");
export const componentsMap = (doc: Y.Doc) => doc.getMap<ComponentData>("components");
export const wiresMap = (doc: Y.Doc) => doc.getMap<Wire>("wires");
export const tracesMap = (doc: Y.Doc) => doc.getMap<Trace>("traces");
export const viasMap = (doc: Y.Doc) => doc.getMap<Via>("vias");
export const zonesMap = (doc: Y.Doc) => doc.getMap<Zone>("zones");
export const partsMap = (doc: Y.Doc) => doc.getMap<PartDef>("parts");

/** Project-local parts; also registers them so getPart() can resolve them. */
export function customParts(doc: Y.Doc): PartDef[] {
  const parts = [...partsMap(doc).values()];
  registerParts(parts);
  return parts;
}

export function addCustomPart(doc: Y.Doc, part: PartDef): PartDef {
  partsMap(doc).set(part.id, part);
  registerParts([part]);
  return part;
}

export function initDoc(doc: Y.Doc, name: string) {
  doc.transact(() => {
    const m = meta(doc);
    if (!m.has("name")) m.set("name", name);
    if (!m.has("board")) m.set("board", DEFAULT_BOARD);
  });
}

export function getDesign(doc: Y.Doc): Design {
  customParts(doc);
  const m = meta(doc);
  return {
    name: (m.get("name") as string) ?? "Untitled",
    board: { ...DEFAULT_BOARD, ...((m.get("board") as Partial<BoardSettings>) ?? {}) },
    components: [...componentsMap(doc).values()],
    wires: [...wiresMap(doc).values()],
    traces: [...tracesMap(doc).values()],
    vias: [...viasMap(doc).values()],
    zones: [...zonesMap(doc).values()],
    sheets: ((m.get("sheets") as Sheet[] | undefined) ?? []).length ? (m.get("sheets") as Sheet[]) : [DEFAULT_SHEET],
    netClasses: (m.get("netClasses") as NetClass[] | undefined) ?? [],
  };
}

/** Sheet a component lives on (components without one belong to the first sheet). */
export const sheetOf = (design: Pick<Design, "sheets">, c: ComponentData) => c.sheet ?? design.sheets[0].id;

export function setName(doc: Y.Doc, name: string) {
  meta(doc).set("name", name);
}

export function setBoard(doc: Y.Doc, patch: Partial<BoardSettings>) {
  const m = meta(doc);
  m.set("board", { ...DEFAULT_BOARD, ...((m.get("board") as Partial<BoardSettings>) ?? {}), ...patch });
}

export function nextRef(doc: Y.Doc, prefix: string): string {
  let max = 0;
  for (const c of componentsMap(doc).values()) {
    const m = c.ref.match(/^([A-Za-z#]+)(\d+)$/);
    if (m && m[1] === prefix) max = Math.max(max, Number(m[2]));
  }
  return `${prefix}${max + 1}`;
}

export interface AddComponentOptions {
  value?: string;
  ref?: string;
  rot?: Placement["rot"];
  pcb?: Partial<PcbPlacement>;
  sheet?: string;
}

export function addComponent(doc: Y.Doc, partId: string, at: Vec, opts: AddComponentOptions = {}): ComponentData {
  if (!getPart(partId)) customParts(doc);
  const part = getPart(partId);
  if (!part) throw new Error(`Unknown part "${partId}"`);
  const map = componentsMap(doc);
  const comp: ComponentData = {
    id: uid("c"),
    partId,
    ref: opts.ref ?? nextRef(doc, part.refPrefix),
    value: opts.value ?? part.defaultValue,
    sch: { x: at.x, y: at.y, rot: opts.rot ?? 0 },
    pcb: { ...defaultPcbPlacement([...map.values()].filter((c) => getPart(c.partId)?.footprint).length), ...opts.pcb },
    ...(opts.sheet && { sheet: opts.sheet }),
  };
  map.set(comp.id, comp);
  return comp;
}

export function updateComponent(doc: Y.Doc, id: string, patch: Partial<Omit<ComponentData, "id" | "partId">>) {
  const map = componentsMap(doc);
  const c = map.get(id);
  if (!c) return;
  map.set(id, { ...c, ...patch, sch: { ...c.sch, ...patch.sch }, pcb: { ...c.pcb, ...patch.pcb } });
}

export function deleteComponent(doc: Y.Doc, id: string) {
  doc.transact(() => {
    componentsMap(doc).delete(id);
    const wires = wiresMap(doc);
    for (const w of [...wires.values()]) if (w.a.comp === id || w.b.comp === id) wires.delete(w.id);
  });
}

export function addWire(doc: Y.Doc, a: Terminal, b: Terminal, points: Vec[] = []): Wire | null {
  if (a.comp === b.comp && a.pin === b.pin) return null;
  const wires = wiresMap(doc);
  for (const w of wires.values()) {
    const same = (w.a.comp === a.comp && w.a.pin === a.pin && w.b.comp === b.comp && w.b.pin === b.pin) || (w.a.comp === b.comp && w.a.pin === b.pin && w.b.comp === a.comp && w.b.pin === a.pin);
    if (same) return w;
  }
  const wire: Wire = { id: uid("w"), a, b, points };
  wires.set(wire.id, wire);
  return wire;
}

export const deleteWire = (doc: Y.Doc, id: string) => wiresMap(doc).delete(id);

export function addTrace(doc: Y.Doc, t: Omit<Trace, "id">): Trace {
  const trace = { ...t, id: uid("t") };
  tracesMap(doc).set(trace.id, trace);
  return trace;
}

export const deleteTrace = (doc: Y.Doc, id: string) => tracesMap(doc).delete(id);

export function addVia(doc: Y.Doc, at: Vec, diameter = 0.6, drill = 0.3): Via {
  const via = { id: uid("v"), x: at.x, y: at.y, diameter, drill };
  viasMap(doc).set(via.id, via);
  return via;
}

export const deleteVia = (doc: Y.Doc, id: string) => viasMap(doc).delete(id);

export function clearRouting(doc: Y.Doc) {
  doc.transact(() => {
    tracesMap(doc).clear();
    viasMap(doc).clear();
  });
}

// ---------- zones (copper pours) ----------

export function addZone(doc: Y.Doc, z: Omit<Zone, "id">): Zone {
  const zone = { ...z, id: uid("z") };
  zonesMap(doc).set(zone.id, zone);
  return zone;
}

export const deleteZone = (doc: Y.Doc, id: string) => zonesMap(doc).delete(id);

/** Rectangle covering the whole board, inset from the edge. */
export function boardOutlineZone(board: BoardSettings, inset = 0.5): Vec[] {
  return [
    { x: inset, y: inset },
    { x: board.width - inset, y: inset },
    { x: board.width - inset, y: board.height - inset },
    { x: inset, y: board.height - inset },
  ];
}

// ---------- sheets ----------

function getSheets(doc: Y.Doc): Sheet[] {
  const s = meta(doc).get("sheets") as Sheet[] | undefined;
  return s?.length ? s : [DEFAULT_SHEET];
}

export function addSheet(doc: Y.Doc, name: string): Sheet {
  const sheet = { id: uid("s"), name };
  meta(doc).set("sheets", [...getSheets(doc), sheet]);
  return sheet;
}

export function renameSheet(doc: Y.Doc, id: string, name: string) {
  meta(doc).set("sheets", getSheets(doc).map((s) => (s.id === id ? { ...s, name } : s)));
}

/** Delete a sheet and everything on it. The last remaining sheet cannot be deleted. */
export function deleteSheet(doc: Y.Doc, id: string) {
  const sheets = getSheets(doc);
  if (sheets.length <= 1) throw new Error("A project needs at least one sheet");
  doc.transact(() => {
    const first = sheets[0].id;
    for (const c of [...componentsMap(doc).values()]) if ((c.sheet ?? first) === id) deleteComponent(doc, c.id);
    const rest = sheets.filter((s) => s.id !== id);
    meta(doc).set("sheets", rest);
    // Components without an explicit sheet belong to the first one; pin them if the first sheet changed.
    if (id === first) for (const c of [...componentsMap(doc).values()]) if (!c.sheet) componentsMap(doc).set(c.id, { ...c, sheet: rest[0].id });
  });
}

// ---------- net classes ----------

export function setNetClass(doc: Y.Doc, nc: NetClass) {
  const list = ((meta(doc).get("netClasses") as NetClass[] | undefined) ?? []).filter((c) => c.name !== nc.name);
  // A net belongs to at most one class.
  const cleaned = list.map((c) => ({ ...c, nets: c.nets.filter((n) => !nc.nets.includes(n)) }));
  meta(doc).set("netClasses", [...cleaned, nc]);
}

export function deleteNetClass(doc: Y.Doc, name: string) {
  meta(doc).set("netClasses", ((meta(doc).get("netClasses") as NetClass[] | undefined) ?? []).filter((c) => c.name !== name));
}

export interface NetRules {
  className: string;
  traceWidth: number;
  clearance: number;
  viaDiameter: number;
  viaDrill: number;
}

export function netRules(design: Pick<Design, "board" | "netClasses">, net: string | undefined): NetRules {
  const nc = net ? design.netClasses.find((c) => c.nets.includes(net)) : undefined;
  if (nc) return { className: nc.name, traceWidth: nc.traceWidth, clearance: nc.clearance, viaDiameter: nc.viaDiameter, viaDrill: nc.viaDrill };
  return { className: "Default", traceWidth: design.board.defaultTraceWidth, clearance: design.board.clearance, viaDiameter: 0.6, viaDrill: 0.3 };
}

// ---------- schematic helpers ----------

export function toggleNoConnect(doc: Y.Doc, compId: string, pin: string): boolean {
  const map = componentsMap(doc);
  const c = map.get(compId);
  if (!c) return false;
  const set = new Set(c.noConnect ?? []);
  const on = !set.has(pin);
  if (on) set.add(pin);
  else set.delete(pin);
  map.set(compId, { ...c, noConnect: [...set] });
  return on;
}

/** Renumber reference designators per prefix, ordered by sheet then top-to-bottom, left-to-right. */
export function annotate(doc: Y.Doc): Map<string, string> {
  const sheets = getSheets(doc);
  const order = new Map(sheets.map((s, i) => [s.id, i]));
  const comps = [...componentsMap(doc).values()];
  const groups = new Map<string, ComponentData[]>();
  for (const c of comps) {
    if (getPart(c.partId)?.kind !== "part") continue;
    const m = c.ref.match(/^([A-Za-z#]+)/);
    const prefix = m ? m[1] : "X";
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix)!.push(c);
  }
  const renames = new Map<string, string>();
  doc.transact(() => {
    for (const [prefix, list] of groups) {
      list.sort((a, b) => (order.get(a.sheet ?? sheets[0].id) ?? 0) - (order.get(b.sheet ?? sheets[0].id) ?? 0) || a.sch.y - b.sch.y || a.sch.x - b.sch.x);
      list.forEach((c, i) => {
        const ref = `${prefix}${i + 1}`;
        if (ref !== c.ref) {
          renames.set(c.ref, ref);
          componentsMap(doc).set(c.id, { ...c, ref });
        }
      });
    }
  });
  return renames;
}

// ---------- shared copilot chat log ----------

export type ChatRole = "user" | "assistant";
export type ChatStatus = "streaming" | "done" | "error";

export interface ChatEntryView {
  id: string;
  role: ChatRole;
  author: string;
  text: string;
  tools: string[];
  status: ChatStatus;
  ts: number;
}

export const chatArray = (doc: Y.Doc) => doc.getArray<Y.Map<unknown>>("chat");

export function appendChat(doc: Y.Doc, role: ChatRole, author: string, text: string, status: ChatStatus = "done"): Y.Map<unknown> {
  const entry = new Y.Map<unknown>();
  doc.transact(() => {
    entry.set("id", uid("m"));
    entry.set("role", role);
    entry.set("author", author);
    const yt = new Y.Text();
    yt.insert(0, text);
    entry.set("text", yt);
    entry.set("tools", new Y.Array<string>());
    entry.set("status", status);
    entry.set("ts", Date.now());
    chatArray(doc).push([entry]);
  });
  return entry;
}

export function chatView(entry: Y.Map<unknown>): ChatEntryView {
  return {
    id: entry.get("id") as string,
    role: entry.get("role") as ChatRole,
    author: entry.get("author") as string,
    text: (entry.get("text") as Y.Text).toString(),
    tools: (entry.get("tools") as Y.Array<string>).toArray(),
    status: entry.get("status") as ChatStatus,
    ts: entry.get("ts") as number,
  };
}
