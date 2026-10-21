import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addComponent,
  addKeepout,
  addSheet,
  addTrace,
  addVia,
  addZone,
  analyzeCopper,
  attachNet,
  autoPlace,
  autoRoute,
  boardOutline,
  boardOutlineZone,
  boardTeardrops,
  busMembers,
  computeNets,
  connect,
  findByRef,
  getDesign,
  gerberFiles,
  initDoc,
  ratsnest,
  runDrc,
  runErc,
  schematicPin,
  setBoard,
  sheetPartId,
  updateComponent,
  zoneFill,
} from "../src";

const newDoc = () => {
  const doc = new Y.Doc();
  initDoc(doc, "p2");
  return doc;
};

describe("labels and hierarchy", () => {
  it("local labels only join on their own sheet; global labels join everywhere", () => {
    const doc = newDoc();
    const s2 = addSheet(doc, "Second");
    addComponent(doc, "resistor_0603", { x: 0, y: 0 });
    addComponent(doc, "resistor_0603", { x: 0, y: 100 });
    addComponent(doc, "resistor_0603", { x: 0, y: 0 }, { sheet: s2.id });
    attachNet(doc, "R1.1", "SIG", "local");
    attachNet(doc, "R2.1", "SIG", "local");
    attachNet(doc, "R3.1", "SIG", "local");
    let nets = computeNets(getDesign(doc)).filter((n) => n.named);
    expect(nets.map((n) => n.name).sort()).toEqual(["/SIG", "/Second/SIG"]);
    attachNet(doc, "R1.2", "BUS_A");
    attachNet(doc, "R3.2", "BUS_A");
    nets = computeNets(getDesign(doc));
    const g = nets.find((n) => n.name === "BUS_A")!;
    expect(g.terminals.filter((t) => getDesign(doc).components.find((c) => c.id === t.comp)!.partId.startsWith("resistor"))).toHaveLength(2);
  });

  it("hierarchical labels connect through the sheet symbol", () => {
    const doc = newDoc();
    const child = addSheet(doc, "Filter");
    addComponent(doc, "resistor_0603", { x: 0, y: 0 }, { sheet: child.id });
    attachNet(doc, "R1.1", "IN", "hierarchical");
    attachNet(doc, "R1.2", "OUT", "hierarchical");
    getDesign(doc); // registers the derived sheet symbol part
    const sym = addComponent(doc, sheetPartId(child.id), { x: 300, y: 0 }, { value: child.id });
    addComponent(doc, "header_1x2", { x: 0, y: 0 });
    connect(doc, "J1.1", `${sym.ref}.IN`);
    const nets = computeNets(getDesign(doc));
    const inNet = nets.find((n) => n.terminals.some((t) => t.comp === findByRef(doc, "J1")!.id && t.pin === "1"))!;
    expect(inNet.terminals.some((t) => t.comp === findByRef(doc, "R1")!.id && t.pin === "1")).toBe(true);
    // A sheet that contains its own symbol is recursive.
    addComponent(doc, sheetPartId(child.id), { x: 500, y: 0 }, { value: child.id, sheet: child.id });
    expect(runErc(getDesign(doc)).some((i) => i.code === "sheet_recursion")).toBe(true);
  });

  it("expands bus names", () => {
    expect(busMembers("D[0..3]")).toEqual(["D0", "D1", "D2", "D3"]);
    expect(busMembers("A[2..0]")).toEqual(["A2", "A1", "A0"]);
    expect(busMembers("{SDA SCL}")).toEqual(["SDA", "SCL"]);
  });

  it("mirrors symbols", () => {
    const doc = newDoc();
    const r = addComponent(doc, "resistor_0603", { x: 100, y: 0 });
    expect(schematicPin(findByRef(doc, "R1")!, "1")).toEqual({ x: 70, y: 0 });
    updateComponent(doc, r.id, { sch: { x: 100, y: 0, rot: 0, mirror: true } });
    expect(schematicPin(findByRef(doc, "R1")!, "1")).toEqual({ x: 130, y: 0 });
  });
});

describe("pin-type ERC", () => {
  it("flags shorted outputs and undriven power", () => {
    const doc = newDoc();
    addComponent(doc, "lm358_soic8", { x: 0, y: 0 });
    addComponent(doc, "ne555_dip8", { x: 300, y: 0 });
    connect(doc, "U1.OUTA", "U2.OUT");
    addComponent(doc, "header_1x2", { x: 0, y: 200 });
    connect(doc, "J1.1", "U1.V+");
    const erc = runErc(getDesign(doc));
    expect(erc.some((i) => i.code === "pin_conflict" && /drive each other/.test(i.message))).toBe(true);
    expect(erc.some((i) => i.code === "undriven_power")).toBe(true);
  });
});

function boardDoc() {
  const doc = newDoc();
  setBoard(doc, { width: 40, height: 30 });
  addComponent(doc, "header_1x2", { x: 0, y: 0 });
  addComponent(doc, "resistor_0603", { x: 100, y: 0 }, { value: "330" });
  addComponent(doc, "led_0603", { x: 200, y: 0 });
  connect(doc, "R1.2", "D1.A");
  for (const p of ["J1.1", "R1.1"]) attachNet(doc, p, "+5V");
  for (const p of ["J1.2", "D1.K"]) attachNet(doc, p, "GND");
  const { placements } = autoPlace(getDesign(doc));
  for (const [id, pcb] of placements) updateComponent(doc, id, { pcb });
  return doc;
}

describe("board outlines and keepouts", () => {
  it("builds rounded outlines and keeps routing inside them", () => {
    const doc = boardDoc();
    setBoard(doc, { cornerRadius: 3 });
    const poly = boardOutline(getDesign(doc).board);
    expect(poly.length).toBeGreaterThan(30);
    const r = autoRoute(getDesign(doc));
    expect(r.failed).toEqual([]);
    for (const t of r.traces) addTrace(doc, t);
    expect(runDrc(getDesign(doc)).filter((i) => i.severity === "error").map((i) => i.message)).toEqual([]);
    expect(gerberFiles(getDesign(doc))["p2-Edge_Cuts.gm1"].split("D01").length).toBeGreaterThan(30);
  });

  it("routes around keepouts and reports violations", () => {
    const doc = boardDoc();
    const d = getDesign(doc);
    const r1 = findByRef(doc, "R1")!;
    const d1 = findByRef(doc, "D1")!;
    // Block the straight line between R1 and D1 on both layers.
    const mx = (r1.pcb.x + d1.pcb.x) / 2;
    addKeepout(doc, { layers: ["top", "bottom"], points: [{ x: mx - 0.5, y: 0.5 }, { x: mx + 0.5, y: 0.5 }, { x: mx + 0.5, y: d.board.height - 6 }, { x: mx - 0.5, y: d.board.height - 6 }], noTracks: true, noVias: true, noPours: true });
    const r = autoRoute(getDesign(doc));
    expect(r.failed).toEqual([]);
    for (const t of r.traces) addTrace(doc, t);
    for (const v of r.vias) addVia(doc, v, v.diameter, v.drill, v);
    expect(runDrc(getDesign(doc)).filter((i) => i.code === "keepout")).toEqual([]);
    addTrace(doc, { layer: "top", width: 0.25, points: [{ x: mx - 2, y: 5 }, { x: mx + 2, y: 5 }] });
    expect(runDrc(getDesign(doc)).some((i) => i.code === "keepout")).toBe(true);
  });
});

describe("pour fills", () => {
  it("adds thermal spokes and removes isolated islands", () => {
    const doc = boardDoc();
    const d0 = getDesign(doc);
    const z = addZone(doc, { net: "GND", layer: "top", points: boardOutlineZone(d0.board) });
    // A ring of +5V copper isolates a pocket of the GND pour (+5V is a different net).
    const ring = [{ x: 3, y: 22 }, { x: 9, y: 22 }, { x: 9, y: 28 }, { x: 3, y: 28 }, { x: 3, y: 22 }];
    addTrace(doc, { layer: "top", width: 0.4, points: ring });
    const d = getDesign(doc);
    const fill = zoneFill(d, d.zones.find((x) => x.id === z.id)!);
    expect(fill.spokes.length).toBeGreaterThan(0);
    expect(fill.removed.length).toBeGreaterThan(0);
    expect(fill.islands.length).toBeGreaterThan(0);
    const a = analyzeCopper(d);
    expect(ratsnest(d, a).filter((r) => r.net === "GND")).toEqual([]);
  });

  it("generates teardrops when enabled", () => {
    const doc = boardDoc();
    const r = autoRoute(getDesign(doc));
    for (const t of r.traces) addTrace(doc, t);
    expect(boardTeardrops(getDesign(doc))).toEqual([]);
    setBoard(doc, { teardrops: true });
    expect(boardTeardrops(getDesign(doc)).length).toBeGreaterThan(0);
  });
});

describe("variants", () => {
  it("overlays fitted state and values on the active variant", async () => {
    const { setVariant, setActiveVariant, bomCsv } = await import("../src");
    const doc = boardDoc();
    setVariant(doc, { name: "Lite", dnp: ["D1"], values: { R1: "1k" } });
    expect(bomCsv(getDesign(doc))).toContain('"D1"');
    setActiveVariant(doc, "Lite");
    const d = getDesign(doc);
    expect(d.activeVariant).toBe("Lite");
    expect(bomCsv(d)).not.toContain('"D1"');
    expect(bomCsv(d)).toContain('"R1","1","1k"');
    // The stored component keeps its base value.
    expect(findByRef(doc, "R1")!.value).toBe("330");
  });
});
