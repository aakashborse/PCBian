// Read/write helpers for the collaborative Yjs design document.
// Every mutation goes through these functions so the web client, the server and
// the AI copilot all edit the document the same way.
import * as Y from "yjs";
import { defaultPcbPlacement } from "./geometry";
import { getPart } from "./library";
import type { BoardSettings, ComponentData, Design, PcbPlacement, Placement, Terminal, Trace, Vec, Via, Wire } from "./types";

export const DEFAULT_BOARD: BoardSettings = { width: 50, height: 40, clearance: 0.2, defaultTraceWidth: 0.25 };

export const uid = (prefix = "") => prefix + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 9);

const meta = (doc: Y.Doc) => doc.getMap<unknown>("meta");
export const componentsMap = (doc: Y.Doc) => doc.getMap<ComponentData>("components");
export const wiresMap = (doc: Y.Doc) => doc.getMap<Wire>("wires");
export const tracesMap = (doc: Y.Doc) => doc.getMap<Trace>("traces");
export const viasMap = (doc: Y.Doc) => doc.getMap<Via>("vias");

export function initDoc(doc: Y.Doc, name: string) {
  doc.transact(() => {
    const m = meta(doc);
    if (!m.has("name")) m.set("name", name);
    if (!m.has("board")) m.set("board", DEFAULT_BOARD);
  });
}

export function getDesign(doc: Y.Doc): Design {
  const m = meta(doc);
  return {
    name: (m.get("name") as string) ?? "Untitled",
    board: { ...DEFAULT_BOARD, ...((m.get("board") as Partial<BoardSettings>) ?? {}) },
    components: [...componentsMap(doc).values()],
    wires: [...wiresMap(doc).values()],
    traces: [...tracesMap(doc).values()],
    vias: [...viasMap(doc).values()],
  };
}

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
}

export function addComponent(doc: Y.Doc, partId: string, at: Vec, opts: AddComponentOptions = {}): ComponentData {
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
