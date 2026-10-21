// Read/write helpers for the collaborative Yjs design document.
// Every mutation goes through these functions so the web client, the server and
// the AI copilot all edit the document the same way.
import * as Y from "yjs";
import { defaultPcbPlacement } from "./geometry";
import { getPart, icSymbol, registerParts } from "./library";
import { type BoardSettings, type Keepout, type PartDef, type PcbGraphic, type SchGraphic, type TitleBlock, type Variant, type CommentReply, type ComponentData, type CopperLayer, type DesignComment, type Design, type DiffPair, type LengthGroup, type NetClass, type PcbPlacement, type Placement, type Sheet, type SpiceModel, type Terminal, type Trace, type Vec, type Via, type Wire, type Zone } from "./types";

export const DEFAULT_BOARD: BoardSettings = { width: 50, height: 40, layers: 2, thickness: 1.6, clearance: 0.2, defaultTraceWidth: 0.25 };
export const DEFAULT_SHEET: Sheet = { id: "main", name: "Sheet 1" };



export const uid = (prefix = "") => prefix + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 9);

const meta = (doc: Y.Doc) => doc.getMap<unknown>("meta");
export const componentsMap = (doc: Y.Doc) => doc.getMap<ComponentData>("components");
export const wiresMap = (doc: Y.Doc) => doc.getMap<Wire>("wires");
export const tracesMap = (doc: Y.Doc) => doc.getMap<Trace>("traces");
export const viasMap = (doc: Y.Doc) => doc.getMap<Via>("vias");
export const zonesMap = (doc: Y.Doc) => doc.getMap<Zone>("zones");
export const partsMap = (doc: Y.Doc) => doc.getMap<PartDef>("parts");
export const keepoutsMap = (doc: Y.Doc) => doc.getMap<Keepout>("keepouts");
export const schGraphicsMap = (doc: Y.Doc) => doc.getMap<SchGraphic>("schGraphics");
export const pcbGraphicsMap = (doc: Y.Doc) => doc.getMap<PcbGraphic>("pcbGraphics");
export const commentsMap = (doc: Y.Doc) => doc.getMap<DesignComment>("comments");

/** Shared maps that make up the design itself (what version history snapshots and restores). */
export const DESIGN_MAPS = ["components", "wires", "traces", "vias", "zones", "parts", "keepouts", "schGraphics", "pcbGraphics", "meta"] as const;

export const DEFAULT_TITLE: TitleBlock = { title: "", revision: "A", date: "", company: "", author: "" };

/** Part id of the sheet symbol that instantiates a sheet. */
export const sheetPartId = (sheetId: string) => `sheet:${sheetId}`;

/**
 * Sheet symbols are derived parts: one per sheet, with a pin for every hierarchical
 * label on that sheet. They are regenerated (and registered) on every read.
 */
function registerSheetParts(sheets: Sheet[], comps: ComponentData[]) {
  const first = sheets[0]?.id;
  const parts: PartDef[] = sheets.map((sh) => {
    const names = [...new Set(comps.filter((c) => (c.sheet ?? first) === sh.id && getPart(c.partId)?.kind === "hierlabel").map((c) => c.value.trim()))].sort();
    const half = Math.ceil(names.length / 2);
    const sym = icSymbol(
      names.slice(0, half).map((n) => [n, n]),
      names.slice(half).map((n) => [n, n]),
      sh.name,
    );
    for (const p of sym.pins) {
      p.showNumber = false;
      p.type = "bidirectional";
    }
    return { id: sheetPartId(sh.id), name: `Sheet: ${sh.name}`, category: "Sheets", description: `Sheet symbol for "${sh.name}"`, kind: "sheet", refPrefix: "#S", defaultValue: sh.id, keywords: [], symbol: sym, footprint: null };
  });
  registerParts(parts);
}

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
  const sheets = ((m.get("sheets") as Sheet[] | undefined) ?? []).length ? (m.get("sheets") as Sheet[]) : [DEFAULT_SHEET];
  const raw = [...componentsMap(doc).values()];
  registerSheetParts(sheets, raw);
  const variants = (m.get("variants") as Variant[] | undefined) ?? [];
  const activeVariant = (m.get("activeVariant") as string | undefined) ?? "";
  const v = variants.find((x) => x.name === activeVariant);
  return {
    name: (m.get("name") as string) ?? "Untitled",
    board: { ...DEFAULT_BOARD, ...((m.get("board") as Partial<BoardSettings>) ?? {}) },
    // The active variant overlays fitted state and values (the stored component keeps the base data).
    components: v ? raw.map((c) => ({ ...c, dnp: c.dnp || v.dnp.includes(c.ref), value: v.values[c.ref] ?? c.value })) : raw,
    wires: [...wiresMap(doc).values()],
    traces: [...tracesMap(doc).values()],
    vias: [...viasMap(doc).values()],
    zones: [...zonesMap(doc).values()],
    sheets,
    netClasses: (m.get("netClasses") as NetClass[] | undefined) ?? [],
    keepouts: [...keepoutsMap(doc).values()],
    schGraphics: [...schGraphicsMap(doc).values()],
    pcbGraphics: [...pcbGraphicsMap(doc).values()],
    titleBlock: { ...DEFAULT_TITLE, ...((m.get("titleBlock") as Partial<TitleBlock>) ?? {}) },
    diffPairs: (m.get("diffPairs") as DiffPair[] | undefined) ?? [],
    lengthGroups: (m.get("lengthGroups") as LengthGroup[] | undefined) ?? [],
    comments: [...commentsMap(doc).values()].sort((a, b) => a.createdAt - b.createdAt),
    spiceModels: (m.get("spiceModels") as SpiceModel[] | undefined) ?? [],
    variants,
    activeVariant: v ? activeVariant : "",
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

/** Add a via; `span` makes it blind/buried/micro (omit, or top-bottom, for a through via). */
export function addVia(doc: Y.Doc, at: Vec, diameter = 0.6, drill = 0.3, span?: { from?: CopperLayer; to?: CopperLayer }): Via {
  const through = !span || ((!span.from || span.from === "top") && (!span.to || span.to === "bottom"));
  const via: Via = { id: uid("v"), x: at.x, y: at.y, diameter, drill, ...(through ? {} : { from: span!.from ?? "top", to: span!.to ?? "bottom" }) };
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
  // Shaped boards: pour the outline itself; the fill keeps its own clearance from the edge.
  if ((board.outline && board.outline.length >= 3) || (board.cornerRadius ?? 0) > 0) return boardOutline(board);
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

// ---------- SPICE models ----------

/** Add or replace SPICE models by name. */
export function addSpiceModels(doc: Y.Doc, models: SpiceModel[]) {
  const names = new Set(models.map((m) => m.name));
  meta(doc).set("spiceModels", [...((meta(doc).get("spiceModels") as SpiceModel[] | undefined) ?? []).filter((m) => !names.has(m.name)), ...models]);
}
export const deleteSpiceModel = (doc: Y.Doc, name: string) => meta(doc).set("spiceModels", ((meta(doc).get("spiceModels") as SpiceModel[] | undefined) ?? []).filter((m) => m.name !== name));

// ---------- comments ----------

export function addComment(doc: Y.Doc, c: Omit<DesignComment, "id" | "createdAt" | "replies">): DesignComment {
  const comment: DesignComment = { ...c, id: uid("c"), createdAt: Date.now(), replies: [] };
  commentsMap(doc).set(comment.id, comment);
  return comment;
}

export function replyComment(doc: Y.Doc, id: string, reply: Omit<CommentReply, "id" | "at">): CommentReply {
  const c = commentsMap(doc).get(id);
  if (!c) throw new Error(`No comment ${id}`);
  const r: CommentReply = { ...reply, id: uid("r"), at: Date.now() };
  commentsMap(doc).set(id, { ...c, replies: [...c.replies, r] });
  return r;
}

export function setCommentResolved(doc: Y.Doc, id: string, resolved: boolean) {
  const c = commentsMap(doc).get(id);
  if (c) commentsMap(doc).set(id, { ...c, resolved });
}

export const deleteComment = (doc: Y.Doc, id: string) => commentsMap(doc).delete(id);

// ---------- differential pairs and length groups ----------

export function setDiffPair(doc: Y.Doc, dp: DiffPair) {
  const list = ((meta(doc).get("diffPairs") as DiffPair[] | undefined) ?? []).filter((p) => p.name !== dp.name && p.positive !== dp.positive && p.negative !== dp.negative);
  meta(doc).set("diffPairs", [...list, dp]);
}
export const deleteDiffPair = (doc: Y.Doc, name: string) => meta(doc).set("diffPairs", ((meta(doc).get("diffPairs") as DiffPair[] | undefined) ?? []).filter((p) => p.name !== name));

export function setLengthGroup(doc: Y.Doc, g: LengthGroup) {
  meta(doc).set("lengthGroups", [...((meta(doc).get("lengthGroups") as LengthGroup[] | undefined) ?? []).filter((x) => x.name !== g.name), g]);
}
export const deleteLengthGroup = (doc: Y.Doc, name: string) => meta(doc).set("lengthGroups", ((meta(doc).get("lengthGroups") as LengthGroup[] | undefined) ?? []).filter((x) => x.name !== name));

/** Find the pair a net belongs to and its partner net. */
export function pairOf(design: Pick<Design, "diffPairs">, net: string | undefined): { pair: DiffPair; partner: string; positive: boolean } | undefined {
  if (!net) return undefined;
  for (const pair of design.diffPairs ?? []) {
    if (pair.positive === net) return { pair, partner: pair.negative, positive: true };
    if (pair.negative === net) return { pair, partner: pair.positive, positive: false };
  }
  return undefined;
}

/**
 * Pairs suggested from net names: USB_D+/USB_D-, CLK_P/CLK_N, TX+/TX-…
 * Returns [positive, negative, base name] triples for nets not already paired.
 */
export function suggestDiffPairs(netNames: string[], existing: DiffPair[] = []): [string, string, string][] {
  const taken = new Set(existing.flatMap((p) => [p.positive, p.negative]));
  const set = new Set(netNames);
  const out: [string, string, string][] = [];
  for (const n of netNames) {
    if (taken.has(n)) continue;
    const m = n.match(/^(.*?)(_P|_N|P|N|\+|-)$/i);
    if (!m || !/^(_P|P|\+)$/i.test(m[2])) continue;
    const neg = m[1] + (m[2] === "+" ? "-" : m[2].replace(/p/, "n").replace(/P/, "N"));
    if (set.has(neg) && !taken.has(neg)) out.push([n, neg, m[1].replace(/^\//, "").replace(/[_/]$/, "") || n]);
  }
  return out;
}

export interface NetRules {
  className: string;
  traceWidth: number;
  clearance: number;
  viaDiameter: number;
  viaDrill: number;
}

export function netRules(design: Pick<Design, "board" | "netClasses"> & Partial<Pick<Design, "diffPairs">>, net: string | undefined): NetRules {
  const nc = net ? design.netClasses.find((c) => c.nets.includes(net)) : undefined;
  const dp = pairOf({ diffPairs: design.diffPairs ?? [] }, net);
  if (dp) {
    const base = nc ? { clearance: nc.clearance, viaDiameter: nc.viaDiameter, viaDrill: nc.viaDrill } : { clearance: design.board.clearance, viaDiameter: 0.6, viaDrill: 0.3 };
    return { className: `Pair ${dp.pair.name}`, traceWidth: dp.pair.width, ...base };
  }
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

// ---------- schematic graphics, title block ----------

export function addSchGraphic(doc: Y.Doc, g: Omit<SchGraphic, "id">): SchGraphic {
  const gr = { ...g, id: uid("g") };
  schGraphicsMap(doc).set(gr.id, gr);
  return gr;
}
export const deleteSchGraphic = (doc: Y.Doc, id: string) => schGraphicsMap(doc).delete(id);

export function setTitleBlock(doc: Y.Doc, patch: Partial<TitleBlock>) {
  meta(doc).set("titleBlock", { ...DEFAULT_TITLE, ...((meta(doc).get("titleBlock") as Partial<TitleBlock>) ?? {}), ...patch });
}

/** Expand a bus name: "D[0..7]" -> D0..D7, "{SDA SCL}" -> SDA, SCL, "A[3..0]" counts down. */
export function busMembers(name: string): string[] {
  const t = name.trim();
  const group = t.match(/^\{(.+)\}$/);
  if (group) return group[1].split(/[\s,]+/).filter(Boolean);
  const r = t.match(/^(.*)\[(\d+)\.\.(\d+)\]$/);
  if (!r) return [t];
  const a = Number(r[2]);
  const b = Number(r[3]);
  const out: string[] = [];
  for (let i = a; a <= b ? i <= b : i >= b; i += a <= b ? 1 : -1) out.push(`${r[1]}${i}`);
  return out;
}

// ---------- board outline, keepouts, PCB graphics ----------

/** Board outline polygon: custom outline, or the width x height rectangle with optional rounded corners. */
export function boardOutline(board: BoardSettings): Vec[] {
  if (board.outline && board.outline.length >= 3) return board.outline;
  const { width: W, height: H } = board;
  const r = Math.min(board.cornerRadius ?? 0, W / 2, H / 2);
  if (r <= 0) return [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
  const pts: Vec[] = [];
  const corner = (cx: number, cy: number, a0: number) => {
    for (let i = 0; i <= 8; i++) {
      const a = a0 + (Math.PI / 2) * (i / 8);
      pts.push({ x: Math.round((cx + r * Math.cos(a)) * 1e4) / 1e4, y: Math.round((cy + r * Math.sin(a)) * 1e4) / 1e4 });
    }
  };
  corner(W - r, r, -Math.PI / 2);
  corner(W - r, H - r, 0);
  corner(r, H - r, Math.PI / 2);
  corner(r, r, Math.PI);
  return pts;
}

/** Set a custom board outline; width/height become its bounding box (outline shifted to start at 0,0). */
export function setBoardOutline(doc: Y.Doc, outline: Vec[] | null) {
  if (!outline) return setBoard(doc, { outline: undefined });
  const x0 = Math.min(...outline.map((p) => p.x));
  const y0 = Math.min(...outline.map((p) => p.y));
  const pts = outline.map((p) => ({ x: p.x - x0, y: p.y - y0 }));
  setBoard(doc, { outline: pts, width: Math.max(...pts.map((p) => p.x)), height: Math.max(...pts.map((p) => p.y)) });
}

export function addKeepout(doc: Y.Doc, k: Omit<Keepout, "id">): Keepout {
  const ko = { ...k, id: uid("k") };
  keepoutsMap(doc).set(ko.id, ko);
  return ko;
}
export const deleteKeepout = (doc: Y.Doc, id: string) => keepoutsMap(doc).delete(id);

export function addPcbGraphic(doc: Y.Doc, g: Omit<PcbGraphic, "id">): PcbGraphic {
  const gr = { ...g, id: uid("d") };
  pcbGraphicsMap(doc).set(gr.id, gr);
  return gr;
}
export const deletePcbGraphic = (doc: Y.Doc, id: string) => pcbGraphicsMap(doc).delete(id);

// ---------- variants ----------

export function setVariant(doc: Y.Doc, v: Variant) {
  const list = ((meta(doc).get("variants") as Variant[] | undefined) ?? []).filter((x) => x.name !== v.name);
  meta(doc).set("variants", [...list, v]);
}

export function deleteVariant(doc: Y.Doc, name: string) {
  meta(doc).set("variants", ((meta(doc).get("variants") as Variant[] | undefined) ?? []).filter((x) => x.name !== name));
  if (meta(doc).get("activeVariant") === name) meta(doc).set("activeVariant", "");
}

export const setActiveVariant = (doc: Y.Doc, name: string) => meta(doc).set("activeVariant", name);
