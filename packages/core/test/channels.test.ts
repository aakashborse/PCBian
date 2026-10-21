import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addChannels,
  addComponent,
  addSheet,
  addTrace,
  addWire,
  annotate,
  attachNet,
  autoRoute,
  computeNets,
  deleteComponent,
  detachChannel,
  getDesign,
  initDoc,
  ratsnest,
  replicateLayout,
  runDrc,
  sheetPartId,
  syncChannels,
  updateComponent,
} from "../src";

function channelDesign() {
  const doc = new Y.Doc();
  initDoc(doc, "chan");
  const ch = addSheet(doc, "Channel");
  const r = addComponent(doc, "resistor_0603", { x: 100, y: 0 }, { sheet: ch.id, value: "4k7" });
  const d = addComponent(doc, "led_0603", { x: 200, y: 0 }, { sheet: ch.id });
  addWire(doc, { comp: r.id, pin: "2" }, { comp: d.id, pin: "2" });
  attachNet(doc, `${r.ref}.1`, "IN", "hierarchical");
  attachNet(doc, `${d.ref}.1`, "GND", "power");
  getDesign(doc);
  const sym = addComponent(doc, sheetPartId(ch.id), { x: 0, y: 0 });
  return { doc, ch, r, d, sym };
}

describe("repeated channels", () => {
  it("copies the template, keeps channels separate and follows template edits", () => {
    const { doc, ch, r, d, sym } = channelDesign();
    const added = addChannels(doc, ch.id, 2);
    expect(added.map((s) => s.channel)).toEqual(["CH2", "CH3"]);
    let design = getDesign(doc);
    const refs = design.components.filter((c) => c.partId === "resistor_0603").map((c) => c.ref).sort();
    expect(refs).toEqual(["R1", "R1_CH2", "R1_CH3"]);
    // One sheet symbol per channel; wiring each to its own root net keeps the channels apart.
    const syms = design.components.filter((c) => c.partId.startsWith("sheet:"));
    expect(syms).toHaveLength(3);
    syms.forEach((s, i) => attachNet(doc, `${s.ref}.IN`, `IN${i + 1}`, "global"));
    design = getDesign(doc);
    const nets = computeNets(design);
    const pinNet = (comp: string, pin: string) => nets.find((n) => n.terminals.some((t) => t.comp === comp && t.pin === pin))!.name;
    const copies = (id: string) => design.components.filter((c) => c.src === id).map((c) => c.id);
    expect(new Set([r.id, ...copies(r.id)].map((id) => pinNet(id, "1")))).toEqual(new Set(["IN1", "IN2", "IN3"]));
    expect(new Set([d.id, ...copies(d.id)].map((id) => pinNet(id, "1")))).toEqual(new Set(["GND"]));
    expect(new Set([r.id, ...copies(r.id)].map((id) => pinNet(id, "2"))).size).toBe(3);
    expect(sym.id).toBeTruthy();

    // Template edits reach every channel; a second sync writes nothing.
    updateComponent(doc, r.id, { value: "10k", sch: { x: 120, y: 10, rot: 90 } });
    expect(syncChannels(doc)).toBe(2);
    expect(syncChannels(doc)).toBe(0);
    design = getDesign(doc);
    for (const c of design.components.filter((x) => x.src === r.id)) expect([c.value, c.sch.rot]).toEqual(["10k", 90]);
    // Annotating renames the template; the copies follow on the next sync.
    updateComponent(doc, r.id, { ref: "R7" });
    annotate(doc);
    syncChannels(doc);
    expect(getDesign(doc).components.filter((c) => c.partId === "resistor_0603").map((c) => c.ref).sort()).toEqual(["R1", "R1_CH2", "R1_CH3"]);
    // Removing a template part removes its copies (and their wires).
    deleteComponent(doc, d.id);
    syncChannels(doc);
    design = getDesign(doc);
    expect(design.components.filter((c) => c.partId === "led_0603")).toHaveLength(0);
    // Only the copies of R1's wire to its port label are left.
    const portWire = design.wires.find((w) => !w.src && (w.a.comp === r.id || w.b.comp === r.id))!;
    expect(design.wires.filter((w) => w.src).map((w) => w.src)).toEqual([portWire.id, portWire.id]);
    // A detached channel becomes an ordinary sheet that sync leaves alone.
    detachChannel(doc, added[0].id);
    updateComponent(doc, r.id, { value: "1k" });
    syncChannels(doc);
    design = getDesign(doc);
    expect(design.components.filter((c) => c.sheet === added[0].id && c.partId === "resistor_0603")[0].value).toBe("10k");
    expect(design.components.filter((c) => c.sheet === added[1].id && c.partId === "resistor_0603")[0].value).toBe("1k");
  });

  it("replicates the template layout and routing onto each channel", () => {
    const { doc, ch, r, d } = channelDesign();
    updateComponent(doc, r.id, { pcb: { x: 8, y: 8, rot: 0, side: "top" } });
    updateComponent(doc, d.id, { pcb: { x: 14, y: 8, rot: 0, side: "top" } });
    let design = getDesign(doc);
    // Route the template's local net (R1.2 - D1.2) only, then repeat the channel.
    const local = autoRoute(design, { nets: [computeNets(design).find((n) => n.terminals.some((t) => t.comp === r.id && t.pin === "2"))!.name] });
    expect(local.failed).toEqual([]);
    for (const t of local.traces) addTrace(doc, t);
    const [c2, c3] = addChannels(doc, ch.id, 2);
    // Place channel 2 by moving its anchor part; channel 3 by a fixed step.
    updateComponent(doc, `${r.id}~${c2.id}`, { pcb: { x: 8, y: 20 } });
    let res = replicateLayout(doc, ch.id);
    expect(res.parts).toBe(4);
    design = getDesign(doc);
    const at = (id: string) => design.components.find((c) => c.id === id)!.pcb;
    expect([at(`${d.id}~${c2.id}`).x, at(`${d.id}~${c2.id}`).y]).toEqual([14, 20]);
    expect(at(`${d.id}~${c3.id}`).x).toBe(14);
    res = replicateLayout(doc, ch.id, { spacing: { x: 0, y: 12 } });
    expect(res.traces).toBe(local.traces.length * 2);
    design = getDesign(doc);
    expect([at(`${r.id}~${c3.id}`).y, at(`${d.id}~${c3.id}`).y]).toEqual([32, 32]);
    // Every channel's local net is now routed, and the copies are clean.
    const unrouted = ratsnest(design).filter((l) => /Net-\(R1/.test(l.net));
    expect(unrouted).toEqual([]);
    expect(runDrc(design).filter((i) => i.severity === "error" && i.code !== "unrouted")).toEqual([]);
    // Replicating again replaces, rather than stacks, the copied copper.
    replicateLayout(doc, ch.id, { spacing: { x: 0, y: 12 } });
    expect(getDesign(doc).traces).toHaveLength(local.traces.length * 3);
  });
});
