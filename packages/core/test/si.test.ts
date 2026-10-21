import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addComponent, addTrace, addZone, attachNet, boardOutlineZone, getDesign, initDoc, setBoard, setNetClass, signalIntegrity, traceImpedance, updateComponent } from "../src";

/** Two 4-layer nets: A--B on top, a ground plane on in1 with a slot under part of A's route. */
function board(slot: boolean) {
  const doc = new Y.Doc();
  initDoc(doc, "si");
  setBoard(doc, { width: 60, height: 30, layers: 4 });
  const parts = ["A1", "A2", "B1", "B2"].map(() => addComponent(doc, "resistor_0603", { x: 0, y: 0 }));
  const at = [
    [5, 10],
    [55, 10],
    [5, 18],
    [55, 18],
  ];
  parts.forEach((p, i) => updateComponent(doc, p.id, { pcb: { x: at[i][0], y: at[i][1], rot: 0, side: "top" } }));
  attachNet(doc, `${parts[0].ref}.2`, "SIG_A", "global");
  attachNet(doc, `${parts[1].ref}.1`, "SIG_A", "global");
  attachNet(doc, `${parts[2].ref}.2`, "SIG_B", "global");
  attachNet(doc, `${parts[3].ref}.1`, "SIG_B", "global");
  const d0 = getDesign(doc);
  const pad = (i: number, pin: string) => {
    const c = d0.components.find((c) => c.id === parts[i].id)!;
    return { x: c.pcb.x + (pin === "1" ? -0.75 : 0.75), y: c.pcb.y };
  };
  addTrace(doc, { layer: "top", width: 0.2, points: [pad(0, "2"), { x: 10, y: 14 }, { x: 50, y: 14 }, pad(1, "1")] });
  addTrace(doc, { layer: "top", width: 0.2, points: [pad(2, "2"), { x: 10, y: 14.5 }, { x: 50, y: 14.5 }, pad(3, "1")] });
  const outline = boardOutlineZone(getDesign(doc).board);
  // GND plane on in1, optionally with a 4 mm slot across both routes at x = 28..32.
  if (!slot) addZone(doc, { layer: "in1", net: "GND", points: outline, priority: 0, removeIslands: false });
  else {
    addZone(doc, { layer: "in1", net: "GND", points: [{ x: 0.5, y: 0.5 }, { x: 28, y: 0.5 }, { x: 28, y: 29.5 }, { x: 0.5, y: 29.5 }], priority: 0, removeIslands: false });
    addZone(doc, { layer: "in1", net: "GND", points: [{ x: 32, y: 0.5 }, { x: 59.5, y: 0.5 }, { x: 59.5, y: 29.5 }, { x: 32, y: 29.5 }], priority: 0, removeIslands: false });
  }
  return doc;
}

describe("signal integrity", () => {
  it("reports impedance, delay, return-path gaps and crosstalk", () => {
    const doc = board(true);
    setNetClass(doc, { name: "50R", nets: ["SIG_A"], traceWidth: 0.2, clearance: 0.15, viaDiameter: 0.6, viaDrill: 0.3, impedance: 50 });
    const d = getDesign(doc);
    const r = signalIntegrity(d);
    const a = r.nets.find((n) => n.net === "SIG_A")!;
    expect(a.length).toBeGreaterThan(45);
    expect(a.zMin).toBeCloseTo(traceImpedance(d.board, "top", 0.2), 6);
    // Delay of a microstrip: between the speed in air and in the laminate.
    const perMm = a.delay / a.length;
    expect(perMm).toBeGreaterThan(3.336);
    expect(perMm).toBeLessThan(3.336 * Math.sqrt(4.5));
    // The 4 mm slot under the route.
    expect(a.unreferenced).toBeGreaterThan(3.5);
    expect(a.unreferenced).toBeLessThan(4.6);
    expect(r.issues.some((i) => i.code === "return-path" && i.message.startsWith("SIG_A") && i.severity === "error")).toBe(true);
    // 0.2 mm traces 0.3 mm apart for 40 mm: with a 1 ns edge (saturation length ~80 mm) about half
    // the saturated level; with a fast 0.2 ns edge, the full saturated level.
    expect(r.crosstalk).toHaveLength(1);
    expect(r.crosstalk[0].coupled).toBeGreaterThan(39);
    const slow = r.crosstalk[0].next;
    const fast = signalIntegrity(d, { riseTime: 0.2 }).crosstalk[0].next;
    expect(slow).toBeGreaterThan(0.02);
    expect(fast / slow).toBeGreaterThan(1.8);
    expect(fast).toBeLessThan(0.15);
    // The impedance check against the 50 ohm target.
    const z = a.zMin;
    expect(r.issues.some((i) => i.code === "impedance")).toBe(Math.abs(z / 50 - 1) > 0.1);
  });

  it("is quiet for a solid plane and well-spaced traces", () => {
    const doc = board(false);
    const d = getDesign(doc);
    const r = signalIntegrity({ ...d, traces: d.traces.map((t, i) => (i === 1 ? { ...t, points: t.points.map((p) => ({ x: p.x, y: p.y === 14.5 ? 24 : p.y })) } : t)) });
    expect(r.nets.every((n) => n.unreferenced < 0.01)).toBe(true);
    expect(r.crosstalk).toEqual([]);
  });
});
