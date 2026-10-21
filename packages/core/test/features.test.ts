import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addComponent,
  addCustomPart,
  addSheet,
  addTrace,
  addVia,
  addZone,
  annotate,
  attachNet,
  autoPlace,
  autoRoute,
  boardOutlineZone,
  buildPart,
  connect,
  deleteSheet,
  getDesign,
  gerberFiles,
  importKicadPart,
  initDoc,
  kicadNetlist,
  kicadPcb,
  parseSExpr,
  parseValue,
  railVoltage,
  ratsnest,
  runDrc,
  runErc,
  setBoard,
  setNetClass,
  simulateDC,
  toggleNoConnect,
  updateComponent,
  findByRef,
} from "../src";

function board(layers: 2 | 4 = 2) {
  const doc = new Y.Doc();
  initDoc(doc, "test");
  setBoard(doc, { layers, width: 40, height: 30 });
  addComponent(doc, "header_1x2", { x: 0, y: 0 });
  addComponent(doc, "resistor_0603", { x: 100, y: 0 }, { value: "330" });
  addComponent(doc, "led_0603", { x: 200, y: 0 }, { value: "Red" });
  addComponent(doc, "capacitor_0603", { x: 300, y: 0 });
  connect(doc, "R1.2", "D1.A");
  for (const p of ["J1.1", "R1.1", "C1.1"]) attachNet(doc, p, "+5V");
  for (const p of ["J1.2", "D1.K", "C1.2"]) attachNet(doc, p, "GND");
  const { placements } = autoPlace(getDesign(doc));
  for (const [id, pcb] of placements) updateComponent(doc, id, { pcb });
  return doc;
}

const route = (doc: Y.Doc, opts = {}) => {
  const r = autoRoute(getDesign(doc), opts);
  for (const t of r.traces) addTrace(doc, t);
  for (const v of r.vias) addVia(doc, v, v.diameter, v.drill, v);
  return r;
};

describe("copper pours", () => {
  it("a GND pour connects every GND pad and stays DRC clean", () => {
    const doc = board();
    const before = ratsnest(getDesign(doc)).filter((r) => r.net === "GND").length;
    expect(before).toBeGreaterThan(0);
    addZone(doc, { net: "GND", layer: "bottom", points: boardOutlineZone(getDesign(doc).board) });
    // THT header pad J1.2 is on the bottom layer; SMD GND pads still need a route or via to reach it.
    addZone(doc, { net: "GND", layer: "top", points: boardOutlineZone(getDesign(doc).board) });
    const d = getDesign(doc);
    expect(ratsnest(d).filter((r) => r.net === "GND")).toEqual([]);
    const r = route(doc);
    expect(r.failed).toEqual([]);
    expect(runDrc(getDesign(doc)).filter((i) => i.severity === "error")).toEqual([]);
    const files = gerberFiles(getDesign(doc));
    expect(files["test-F_Cu.gtl"]).toContain("G36*");
    // Pours are plain dark regions: nothing in the image is ever cleared.
    expect(files["test-F_Cu.gtl"]).not.toContain("%LPC*%");
  });
});

describe("multilayer + net classes", () => {
  it("routes a 4-layer board and honours net-class widths", () => {
    const doc = board(4);
    setNetClass(doc, { name: "Power", traceWidth: 0.5, clearance: 0.25, viaDiameter: 0.8, viaDrill: 0.4, nets: ["+5V"] });
    const r = route(doc);
    expect(r.failed).toEqual([]);
    const d = getDesign(doc);
    expect(ratsnest(d)).toEqual([]);
    expect(runDrc(d).filter((i) => i.severity === "error").map((i) => i.message)).toEqual([]);
    expect(Object.keys(gerberFiles(d)).some((f) => f.includes("In1_Cu"))).toBe(true);
    const widths = new Set(d.traces.map((t) => t.width));
    expect(widths.has(0.5)).toBe(true);
  });

  it("flags inner-layer copper on a 2-layer board", () => {
    const doc = board(2);
    addTrace(doc, { layer: "in1", width: 0.25, points: [{ x: 5, y: 5 }, { x: 10, y: 5 }] });
    expect(runDrc(getDesign(doc)).some((i) => i.code === "layer")).toBe(true);
  });
});

describe("simulation", () => {
  it("parses values and rails", () => {
    expect(parseValue("4k7")).toBeCloseTo(4700);
    expect(parseValue("100nF")).toBeCloseTo(1e-7);
    expect(parseValue("330R")).toBe(330);
    expect(parseValue("500mA")).toBeCloseTo(0.5);
    expect(railVoltage("+3V3")).toBeCloseTo(3.3);
    expect(railVoltage("5V")).toBe(5);
    expect(railVoltage("VBUS")).toBe(5);
    expect(railVoltage("-12V")).toBe(-12);
  });

  it("solves an LED + resistor circuit", () => {
    const doc = board();
    const sim = simulateDC(getDesign(doc));
    expect(sim.ok).toBe(true);
    const led = sim.elements.find((e) => e.ref === "D1")!;
    expect(led.current * 1000).toBeGreaterThan(8);
    expect(led.current * 1000).toBeLessThan(10.5);
    expect(led.voltage).toBeGreaterThan(1.7);
    expect(sim.supplies[0].current).toBeCloseTo(led.current, 6);
  });

  it("warns about LED overcurrent", () => {
    const doc = board();
    updateComponent(doc, findByRef(doc, "R1")!.id, { value: "10" });
    const sim = simulateDC(getDesign(doc));
    expect(sim.warnings.join(" ")).toMatch(/exceeds the typical 20mA/);
  });
});

describe("KiCad interop", () => {
  it("exports a parseable board and netlist", () => {
    const doc = board(4);
    addZone(doc, { net: "GND", layer: "in1", points: boardOutlineZone(getDesign(doc).board) });
    route(doc);
    const pcb = kicadPcb(getDesign(doc));
    const tree = parseSExpr(pcb) as unknown[];
    expect(tree[0]).toBe("kicad_pcb");
    expect(pcb).toContain('(layer "In1.Cu")');
    expect(pcb).toContain("(segment");
    expect(pcb).toContain('(net_name "GND")');
    const net = kicadNetlist(getDesign(doc));
    expect((parseSExpr(net) as unknown[])[0]).toBe("export");
    expect(net).toContain('(node (ref "R1") (pin "2"))');
  });

  it("imports a KiCad symbol + footprint as a usable part", () => {
    const sym = `(kicad_symbol_lib (version 20231120) (generator kicad_symbol_editor)
      (symbol "MCP1700" (pin_names (offset 1.016)) (in_bom yes) (on_board yes)
        (property "Reference" "U" (at 0 5 0)) (property "Value" "MCP1700" (at 0 -5 0))
        (property "Description" "250mA LDO regulator" (at 0 0 0))
        (symbol "MCP1700_0_1" (rectangle (start -5.08 2.54) (end 5.08 -2.54) (stroke (width 0.254)) (fill (type background))))
        (symbol "MCP1700_1_1"
          (pin power_in line (at -7.62 0 0) (length 2.54) (name "VIN" (effects (font (size 1.27 1.27)))) (number "3" (effects (font (size 1.27 1.27)))))
          (pin power_out line (at 7.62 0 180) (length 2.54) (name "VOUT" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
          (pin power_in line (at 0 -5.08 90) (length 2.54) (name "GND" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
        )))`;
    const mod = `(footprint "SOT-23" (version 20240108) (layer "F.Cu")
      (pad "1" smd roundrect (at -0.95 1.1) (size 0.6 1.0) (layers "F.Cu" "F.Paste" "F.Mask"))
      (pad "2" smd roundrect (at 0.95 1.1) (size 0.6 1.0) (layers "F.Cu" "F.Paste" "F.Mask"))
      (pad "3" smd roundrect (at 0 -1.1) (size 0.6 1.0) (layers "F.Cu" "F.Paste" "F.Mask"))
      (fp_line (start -1.5 -0.7) (end 1.5 -0.7) (stroke (width 0.12) (type solid)) (layer "F.SilkS"))
      (fp_rect (start -1.7 -1.75) (end 1.7 1.75) (stroke (width 0.05) (type solid)) (fill none) (layer "F.CrtYd")))`;
    const part = importKicadPart(sym, mod);
    expect(part.symbol.pins.map((p) => p.id).sort()).toEqual(["1", "2", "3"]);
    expect(part.symbol.pins.find((p) => p.name === "VIN")!.side).toBe("left");
    expect(part.footprint!.courtyard.w).toBeCloseTo(3.4);
    const doc = new Y.Doc();
    initDoc(doc, "imp");
    addCustomPart(doc, part);
    addComponent(doc, part.id, { x: 0, y: 0 });
    expect(findByRef(doc, "U1")).toBeTruthy();
  });
});

describe("schematic features", () => {
  it("builds custom parts and validates pin/pad coverage", () => {
    const part = buildPart({ name: "ATtiny85", refPrefix: "U", pins: [["1", "PB5"], ["2", "PB3"], ["3", "PB4"], ["4", "GND"], ["5", "PB0"], ["6", "PB1"], ["7", "PB2"], ["8", "VCC"]].map(([number, name]) => ({ number, name })), package: { type: "soic", pins: 8 } });
    expect(part.footprint!.pads).toHaveLength(8);
    expect(() => buildPart({ name: "bad", refPrefix: "U", pins: [{ number: "1", name: "A" }], package: { type: "soic", pins: 8 } })).toThrow(/has no pin/);
  });

  it("annotates, handles no-connects and sheets", () => {
    const doc = new Y.Doc();
    initDoc(doc, "s");
    const s2 = addSheet(doc, "Power");
    addComponent(doc, "resistor_0603", { x: 0, y: 100 }, { ref: "R7" });
    addComponent(doc, "resistor_0603", { x: 0, y: 0 }, { ref: "R3" });
    const r = addComponent(doc, "resistor_0603", { x: 0, y: 0 }, { ref: "R9", sheet: s2.id });
    const renames = annotate(doc);
    expect(renames.get("R3")).toBe("R1");
    expect(renames.get("R7")).toBe("R2");
    expect(renames.get("R9")).toBe("R3");
    const erc1 = runErc(getDesign(doc)).filter((i) => i.code === "unconnected_pin").length;
    toggleNoConnect(doc, r.id, "1");
    expect(runErc(getDesign(doc)).filter((i) => i.code === "unconnected_pin").length).toBe(erc1 - 1);
    deleteSheet(doc, s2.id);
    expect(getDesign(doc).components).toHaveLength(2);
    expect(() => deleteSheet(doc, "main")).toThrow(/at least one sheet/);
  });
});
