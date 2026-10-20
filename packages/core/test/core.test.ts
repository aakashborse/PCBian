import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addComponent,
  addTrace,
  addWire,
  autoPlace,
  autoRoute,
  bomCsv,
  computeNets,
  getDesign,
  gerberFiles,
  initDoc,
  PARTS,
  ratsnest,
  runDrc,
  runErc,
  updateComponent,
} from "../src";

function ledCircuit() {
  const doc = new Y.Doc();
  initDoc(doc, "blinky");
  const j = addComponent(doc, "header_1x2", { x: 0, y: 0 });
  const r = addComponent(doc, "resistor_0603", { x: 100, y: 0 }, { value: "330" });
  const d = addComponent(doc, "led_0603", { x: 200, y: 0 });
  const vcc = addComponent(doc, "power_rail", { x: 0, y: -50 }, { value: "+5V" });
  const gnd = addComponent(doc, "power_gnd", { x: 0, y: 50 });
  addWire(doc, { comp: j.id, pin: "1" }, { comp: vcc.id, pin: "1" });
  addWire(doc, { comp: vcc.id, pin: "1" }, { comp: r.id, pin: "1" });
  addWire(doc, { comp: r.id, pin: "2" }, { comp: d.id, pin: "2" });
  addWire(doc, { comp: d.id, pin: "1" }, { comp: gnd.id, pin: "1" });
  addWire(doc, { comp: j.id, pin: "2" }, { comp: gnd.id, pin: "1" });
  return { doc, j, r, d };
}

describe("library", () => {
  it("every footprint pad has a matching symbol pin", () => {
    for (const p of PARTS) {
      if (!p.footprint) continue;
      const pins = new Set(p.symbol.pins.map((x) => x.id));
      for (const pad of p.footprint.pads) expect(pins.has(pad.id), `${p.id} pad ${pad.id}`).toBe(true);
      for (const pin of pins) expect(p.footprint.pads.some((pad) => pad.id === pin), `${p.id} pin ${pin}`).toBe(true);
    }
  });
});

describe("netlist", () => {
  it("merges power symbols and wires into named nets", () => {
    const { doc, r } = ledCircuit();
    const nets = computeNets(getDesign(doc));
    const names = nets.filter((n) => n.terminals.length > 1).map((n) => n.name);
    expect(names).toContain("+5V");
    expect(names).toContain("GND");
    expect(names).toContain("Net-(D1-2)");
    expect(runErc(getDesign(doc)).filter((i) => i.severity === "error")).toEqual([]);
    expect(nets.find((n) => n.name === "+5V")!.terminals.some((t) => t.comp === r.id)).toBe(true);
  });
});

describe("pcb", () => {
  it("auto-places, auto-routes and passes DRC", () => {
    const { doc } = ledCircuit();
    let design = getDesign(doc);
    expect(ratsnest(design).length).toBe(3);
    const { placements, fits } = autoPlace(design);
    expect(fits).toBe(true);
    for (const [id, pcb] of placements) updateComponent(doc, id, { pcb });
    design = getDesign(doc);
    const routed = autoRoute(design);
    expect(routed.failed).toEqual([]);
    for (const t of routed.traces) addTrace(doc, t);
    design = getDesign(doc);
    expect(ratsnest(design)).toEqual([]);
    expect(runDrc(design).filter((i) => i.severity === "error")).toEqual([]);
    const files = gerberFiles(design);
    expect(Object.keys(files).length).toBe(11);
    expect(files["blinky-F_Cu.gtl"]).toContain("D03*");
    expect(bomCsv(design)).toContain('"R1","1","330"');
  });

  it("detects shorts", () => {
    const { doc, r } = ledCircuit();
    updateComponent(doc, r.id, { pcb: { x: 10, y: 10, rot: 0, side: "top" } });
    addTrace(doc, { layer: "top", width: 0.25, points: [{ x: 9.2, y: 10 }, { x: 10.8, y: 10 }] });
    expect(runDrc(getDesign(doc)).some((i) => i.code === "short")).toBe(true);
  });
});

describe("edit helpers", () => {
  it("resolves pins by number, name and alternate function name", async () => {
    const { resolveTerminal, attachNet, connect, findByRef } = await import("../src");
    const doc = new Y.Doc();
    initDoc(doc, "mcu");
    const u = addComponent(doc, "atmega328p_tqfp32", { x: 0, y: 0 });
    expect(resolveTerminal(doc, "U1.17")).toEqual({ comp: u.id, pin: "17" });
    expect(resolveTerminal(doc, "u1.sck")).toEqual({ comp: u.id, pin: "17" });
    expect(resolveTerminal(doc, "U1.PB5/SCK")).toEqual({ comp: u.id, pin: "17" });
    expect(() => resolveTerminal(doc, "U1.NOPE")).toThrow(/has no pin/);
    expect(() => resolveTerminal(doc, "R9.1")).toThrow(/No component/);
    addComponent(doc, "capacitor_0603", { x: 200, y: 0 });
    connect(doc, "C1.1", "U1.4");
    attachNet(doc, "C1.2", "GND");
    attachNet(doc, "U1.3", "GND");
    const gnd = computeNets(getDesign(doc)).find((n) => n.name === "GND")!;
    expect(gnd.terminals.filter((t) => t.comp === u.id || t.comp === findByRef(doc, "C1")!.id)).toHaveLength(2);
  });
});
