// Repeated channels: a template sheet drawn once and repeated as channel sheets. Each channel holds
// copies of the template's parts, wires, labels and graphics; syncChannels keeps them in step with
// the template (only a copy's PCB placement is its own). Copies have deterministic ids, so two
// clients syncing at once write the same keys instead of duplicating parts.
import * as Y from "yjs";
import { analyzeCopper } from "./copper";
import { componentsMap, getDesign, getSheets, schGraphicsMap, setSheets, sheetPartId, tracesMap, uid, viasMap, wiresMap, addComponent } from "./doc";
import { getPart } from "./library";
import { computeNets, netByTerminal } from "./netlist";
import type { ComponentData, Design, Sheet } from "./types";

const copyId = (srcId: string, sheet: string) => `${srcId}~${sheet}`;
const isCopyOn = (id: string, sheet: string) => id.endsWith(`~${sheet}`);

/** Designator of a part's copy on a channel: R1 -> R1_CH2 (or R1_CH1 -> R1_CH2 when the template carries one). */
export function channelRef(ref: string, template: Sheet, channel: Sheet): string {
  const tag = channel.channel ?? channel.name;
  if (template.channel && ref.endsWith(`_${template.channel}`)) return `${ref.slice(0, -template.channel.length - 1)}_${tag}`;
  return `${ref}_${tag}`;
}

/** Channel sheets of a template, in sheet order. */
export function channelsOf(design: Pick<Design, "sheets">, templateId: string): Sheet[] {
  return design.sheets.filter((s) => s.repeatOf === templateId);
}

/**
 * Repeat a sheet as `count` more channels (CH2, CH3, ...). When the template has a sheet symbol,
 * each channel gets one too, stacked below it, so the channels can be wired into the parent.
 */
export function addChannels(doc: Y.Doc, templateId: string, count: number): Sheet[] {
  const sheets = getSheets(doc);
  const tpl = sheets.find((s) => s.id === templateId);
  if (!tpl) throw new Error(`No sheet ${templateId}`);
  if (tpl.repeatOf) throw new Error(`"${tpl.name}" is itself a channel; repeat its template instead`);
  if (templateId === sheets[0].id) throw new Error("The root sheet cannot be repeated; move the channel onto its own sheet");
  if (count < 1 || count > 64) throw new Error("Channel count must be 1-64");
  const existing = channelsOf({ sheets }, templateId);
  const taken = new Set([tpl.channel, ...existing.map((s) => s.channel)]);
  const added: Sheet[] = [];
  for (let n = 2; added.length < count; n++) {
    const tag = `CH${n}`;
    if (taken.has(tag)) continue;
    added.push({ id: uid("s"), name: `${tpl.name} ${tag}`, repeatOf: templateId, channel: tag });
  }
  doc.transact(() => {
    setSheets(doc, [...sheets, ...added]);
    syncChannels(doc);
    // Sheet symbols for the new channels, below the template's own (or the last channel's).
    getDesign(doc); // registers the channels' sheet-symbol parts
    const symbols = [...componentsMap(doc).values()].filter((c) => c.partId.startsWith("sheet:"));
    const tplSym = symbols.find((c) => c.partId === sheetPartId(templateId));
    if (!tplSym) return;
    const h = (getPart(tplSym.partId)?.symbol.pins.length ?? 2) * 5 + 40;
    let last = [tplSym, ...existing.map((s) => symbols.find((c) => c.partId === sheetPartId(s.id))).filter((c): c is ComponentData => !!c)].sort((a, b) => b.sch.y - a.sch.y)[0];
    for (const s of added) {
      last = addComponent(doc, sheetPartId(s.id), { x: last.sch.x, y: last.sch.y + h }, { sheet: tplSym.sheet });
    }
  });
  return added;
}

/** Turn a channel back into an ordinary sheet whose parts can be edited on their own. */
export function detachChannel(doc: Y.Doc, sheetId: string) {
  doc.transact(() => {
    setSheets(doc, getSheets(doc).map((s) => (s.id === sheetId ? { id: s.id, name: s.name } : s)));
    for (const c of [...componentsMap(doc).values()]) if (c.src && isCopyOn(c.id, sheetId)) componentsMap(doc).set(c.id, { ...c, src: undefined });
    for (const w of [...wiresMap(doc).values()]) if (w.src && isCopyOn(w.id, sheetId)) wiresMap(doc).set(w.id, { ...w, src: undefined });
    for (const g of [...schGraphicsMap(doc).values()]) if (g.src && isCopyOn(g.id, sheetId)) schGraphicsMap(doc).set(g.id, { ...g, src: undefined });
  });
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Bring every channel sheet in line with its template. Writes only what differs, so it is cheap to
 * call after any edit. Returns the number of objects written or removed.
 */
export function syncChannels(doc: Y.Doc): number {
  const sheets = getSheets(doc);
  const channels = sheets.filter((s) => s.repeatOf && sheets.some((t) => t.id === s.repeatOf));
  const first = sheets[0].id;
  const comps = componentsMap(doc);
  const wires = wiresMap(doc);
  const graphics = schGraphicsMap(doc);
  let writes = 0;
  // Copies left behind by a channel that is gone (e.g. undone) go too.
  const live = new Set(channels.map((s) => s.id));
  const orphan = (o: { id: string; src?: string }) => !!o.src && o.id.includes("~") && !live.has(o.id.slice(o.id.lastIndexOf("~") + 1));
  const sweep = <T extends { id: string; src?: string }>(map: Y.Map<T>) => {
    for (const o of [...map.values()]) if (orphan(o)) (map.delete(o.id), writes++);
  };
  if (!channels.length && ![...comps.values()].some(orphan)) return 0;
  const put = <T extends { id: string }>(map: Y.Map<T>, v: T) => {
    if (same(map.get(v.id), v)) return;
    map.set(v.id, v);
    writes++;
  };
  doc.transact(() => {
    sweep(comps);
    sweep(wires);
    sweep(graphics);
    for (const ch of channels) {
      const tpl = sheets.find((s) => s.id === ch.repeatOf)!;
      const tplComps = [...comps.values()].filter((c) => !c.src && (c.sheet ?? first) === tpl.id);
      const ids = new Set(tplComps.map((c) => c.id));
      const keep = new Set<string>();
      for (const c of tplComps) {
        const id = copyId(c.id, ch.id);
        keep.add(id);
        const old = comps.get(id);
        const { unit: _u, ...base } = c;
        const copy: ComponentData = {
          ...base,
          id,
          src: c.id,
          ref: getPart(c.partId)?.kind === "part" ? channelRef(c.ref, tpl, ch) : c.ref,
          sheet: ch.id,
          ...(c.units ? { units: c.units.map((u) => ({ ...u, sheet: ch.id })) } : {}),
          // The layout is per channel: a new copy starts on top of the template part.
          pcb: old?.pcb ?? c.pcb,
        };
        put(comps, copy);
      }
      for (const c of [...comps.values()]) if (c.src && isCopyOn(c.id, ch.id) && !keep.has(c.id)) (comps.delete(c.id), writes++);

      const keepW = new Set<string>();
      for (const w of wires.values()) {
        if (w.src || !ids.has(w.a.comp) || !ids.has(w.b.comp)) continue;
        const id = copyId(w.id, ch.id);
        keepW.add(id);
        put(wires, { ...w, id, src: w.id, a: { ...w.a, comp: copyId(w.a.comp, ch.id) }, b: { ...w.b, comp: copyId(w.b.comp, ch.id) } });
      }
      for (const w of [...wires.values()]) if (w.src && isCopyOn(w.id, ch.id) && !keepW.has(w.id)) (wires.delete(w.id), writes++);

      const keepG = new Set<string>();
      for (const g of graphics.values()) {
        if (g.src || g.sheet !== tpl.id) continue;
        const id = copyId(g.id, ch.id);
        keepG.add(id);
        put(graphics, { ...g, id, src: g.id, sheet: ch.id });
      }
      for (const g of [...graphics.values()]) if (g.src && isCopyOn(g.id, ch.id) && !keepG.has(g.id)) (graphics.delete(g.id), writes++);
    }
  });
  return writes;
}

export interface ReplicateResult {
  channels: number;
  parts: number;
  traces: number;
  vias: number;
}

/**
 * Copy the template channel's PCB layout to its channels: every copied part takes the template
 * part's rotation, side and relative position, anchored where the channel's anchor part sits now
 * (the first part, by designator, that was moved away from its template part), or `spacing` apart; the copper of nets local to the channel is copied
 * along. Earlier replicated copper is replaced. Move one part of a channel to choose where it goes.
 */
export function replicateLayout(doc: Y.Doc, templateId: string, opts: { spacing?: { x: number; y: number } } = {}): ReplicateResult {
  syncChannels(doc);
  const design = getDesign(doc);
  const tpl = design.sheets.find((s) => s.id === templateId);
  if (!tpl) throw new Error(`No sheet ${templateId}`);
  const chans = channelsOf(design, templateId);
  if (!chans.length) throw new Error(`"${tpl.name}" has no channels`);
  const first = design.sheets[0].id;
  const tplParts = design.components
    .filter((c) => !c.src && (c.sheet ?? first) === templateId && getPart(c.partId)?.footprint)
    .sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  if (!tplParts.length) throw new Error(`"${tpl.name}" has no parts with footprints`);
  const byId = new Map(design.components.map((c) => [c.id, c]));

  // Copper of nets whose pads are all on the template sheet, judged without the channel copies
  // (which may still sit on top of the template parts).
  const own = { ...design, components: design.components.filter((c) => !c.src), traces: design.traces.filter((t) => !t.src), vias: design.vias.filter((v) => !v.src) };
  const analysis = analyzeCopper(own);
  const netOf = netByTerminal(computeNets(design));
  const tplIds = new Set(tplParts.map((c) => c.id));
  const localNets = new Set<string>();
  for (const n of analysis.nets) {
    const phys = n.terminals.filter((t) => getPart(byId.get(t.comp)?.partId ?? "")?.footprint);
    if (phys.length && phys.every((t) => tplIds.has(t.comp))) localNets.add(n.name);
  }
  const local = (it: (typeof analysis.items)[number]) => localNets.has(analysis.netOfItem(it) ?? "");
  const traces = analysis.items.flatMap((it) => (it.kind === "trace" && !it.trace.src && local(it) ? [it.trace] : []));
  const vias = analysis.items.flatMap((it) => (it.kind === "via" && !it.via.src && local(it) ? [it.via] : []));
  // A template net's name in a channel: the net of the channel copy of one of its pins.
  const tplNetPin = new Map<string, { comp: string; pin: string }>();
  for (const n of analysis.nets) if (localNets.has(n.name)) tplNetPin.set(n.name, n.terminals.find((t) => tplIds.has(t.comp))!);

  const res: ReplicateResult = { channels: chans.length, parts: 0, traces: 0, vias: 0 };
  const step = opts.spacing;
  doc.transact(() => {
    chans.forEach((ch, i) => {
      // The anchor is the first part (by designator) whose copy was moved off the template part.
      const offsetOf = (c: ComponentData) => {
        const copy = componentsMap(doc).get(copyId(c.id, ch.id));
        return copy ? { x: copy.pcb.x - c.pcb.x, y: copy.pcb.y - c.pcb.y } : { x: 0, y: 0 };
      };
      const moved = tplParts.map(offsetOf).find((o) => o.x || o.y) ?? { x: 0, y: 0 };
      const dx = step ? step.x * (i + 1) : moved.x;
      const dy = step ? step.y * (i + 1) : moved.y;
      for (const c of tplParts) {
        const id = copyId(c.id, ch.id);
        const cur = componentsMap(doc).get(id);
        if (!cur) continue;
        componentsMap(doc).set(id, { ...cur, pcb: { ...c.pcb, x: c.pcb.x + dx, y: c.pcb.y + dy } });
        res.parts++;
      }
      for (const t of [...tracesMap(doc).values()]) if (t.src && isCopyOn(t.id, ch.id)) tracesMap(doc).delete(t.id);
      for (const v of [...viasMap(doc).values()]) if (v.src && isCopyOn(v.id, ch.id)) viasMap(doc).delete(v.id);
      if (!dx && !dy) return;
      const chanNet = (tplNet: string | undefined) => {
        const t = tplNet ? tplNetPin.get(tplNet) : undefined;
        return t ? netOf.get(`${copyId(t.comp, ch.id)}:${t.pin}`) : undefined;
      };
      for (const t of traces) {
        const id = copyId(t.id, ch.id);
        const net = t.net ? chanNet(t.net) : undefined;
        tracesMap(doc).set(id, { ...t, id, src: t.id, points: t.points.map((p) => ({ x: p.x + dx, y: p.y + dy })), ...(net ? { net } : { net: undefined }) });
        res.traces++;
      }
      for (const v of vias) {
        const id = copyId(v.id, ch.id);
        const net = v.net ? chanNet(v.net) : undefined;
        viasMap(doc).set(id, { ...v, id, src: v.id, x: v.x + dx, y: v.y + dy, ...(net ? { net } : { net: undefined }) });
        res.vias++;
      }
    });
  });
  return res;
}
