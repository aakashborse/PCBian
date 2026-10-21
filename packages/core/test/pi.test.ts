import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addComponent, addTrace, addVia, addZone, attachNet, decouplingCheck, getDesign, initDoc, irDrop, padsOf, setBoard, traceCapacity, updateComponent } from "../src";

const RHO = 1.72e-5;
const T = 0.035;

/** A 0603 "source" at x=5 and "load" at x=55, both with pin 2 on +5V. */
function board() {
  const doc = new Y.Doc();
  initDoc(doc, "pi");
  setBoard(doc, { width: 60, height: 30 });
  const src = addComponent(doc, "resistor_0603", { x: 0, y: 0 });
  const load = addComponent(doc, "resistor_0603", { x: 0, y: 0 });
  updateComponent(doc, src.id, { pcb: { x: 5, y: 15, rot: 0, side: "top" } });
  updateComponent(doc, load.id, { pcb: { x: 55, y: 15, rot: 0, side: "top" } });
  attachNet(doc, `${src.ref}.2`, "+5V");
  attachNet(doc, `${load.ref}.1`, "+5V");
  const d = getDesign(doc);
  const pad = (id: string, pin: string) => padsOf(d.components.find((c) => c.id === id)!).find((p) => p.id === pin)!.world;
  return { doc, src, load, a: pad(src.id, "2"), b: pad(load.id, "1") };
}

describe("power integrity", () => {
  it("matches the analytic resistance of a trace, and adds a via", () => {
    const { doc, src, load, a, b } = board();
    addTrace(doc, { layer: "top", width: 0.5, points: [a, b] });
    const r = irDrop(getDesign(doc), "+5V", { source: src.ref, loads: [{ ref: load.ref, current: 1 }] });
    expect(r.ok).toBe(true);
    const L = b.x - a.x;
    expect(r.loads[0].drop).toBeCloseTo((RHO * L) / (0.5 * T), 3);
    expect(r.loads[0].voltage).toBeCloseTo(5 - r.loads[0].drop, 9);
    expect(r.hotTraces).toEqual([]);

    // Route half way on the bottom through two vias: adds two barrels' resistance.
    const { doc: d2, src: s2, load: l2, a: a2, b: b2 } = board();
    addTrace(d2, { layer: "top", width: 0.5, points: [a2, { x: 20, y: 15 }] });
    addVia(d2, { x: 20, y: 15 }, 0.6, 0.3);
    addTrace(d2, { layer: "bottom", width: 0.5, points: [{ x: 20, y: 15 }, { x: 40, y: 15 }] });
    addVia(d2, { x: 40, y: 15 }, 0.6, 0.3);
    addTrace(d2, { layer: "top", width: 0.5, points: [{ x: 40, y: 15 }, b2] });
    const r2 = irDrop(getDesign(d2), "+5V", { source: s2.ref, loads: [{ ref: l2.ref, current: 1 }] });
    const barrel = (RHO * 1.5) / (Math.PI * (0.3 + 0.025) * 0.025);
    expect(r2.loads[0].drop - r.loads[0].drop).toBeGreaterThan(1.5 * barrel);
    expect(r2.loads[0].drop - r.loads[0].drop).toBeLessThan(2.5 * barrel);
  });

  it("solves pours and flags overloaded traces", () => {
    const { doc, src, load, a, b } = board();
    addTrace(doc, { layer: "top", width: 0.25, points: [a, b] });
    const thin = irDrop(getDesign(doc), "+5V", { source: src.ref, loads: [{ ref: load.ref, current: 2 }] });
    // 0.25 mm of 1 oz outer copper carries about 0.9 A for a 10 °C rise.
    expect(traceCapacity(0.25, T, true)).toBeCloseTo(0.88, 1);
    expect(thin.hotTraces).toHaveLength(1);
    expect(thin.issues.some((i) => i.code === "current")).toBe(true);
    // A 10 mm wide pour strip along the route: far less drop, and at least the strip's own R.
    addZone(doc, { layer: "top", net: "+5V", points: [{ x: 4, y: 10 }, { x: 56, y: 10 }, { x: 56, y: 20 }, { x: 4, y: 20 }], priority: 0 });
    const poured = irDrop(getDesign(doc), "+5V", { source: src.ref, loads: [{ ref: load.ref, current: 2 }] });
    expect(poured.ok).toBe(true);
    const strip = ((RHO / T) * (b.x - a.x)) / 10;
    expect(poured.loads[0].drop).toBeLessThan(thin.loads[0].drop / 3);
    expect(poured.loads[0].drop).toBeGreaterThan(2 * strip * 0.9);
  });

  it("checks decoupling capacitors next to IC power pins", () => {
    const doc = new Y.Doc();
    initDoc(doc, "dec");
    setBoard(doc, { width: 60, height: 40 });
    const u = addComponent(doc, "atmega328p_tqfp32", { x: 0, y: 0 });
    updateComponent(doc, u.id, { pcb: { x: 20, y: 20, rot: 0, side: "top" } });
    for (const pin of ["4", "6", "18"]) attachNet(doc, `${u.ref}.${pin}`, "+3V3");
    for (const pin of ["3", "5", "21"]) attachNet(doc, `${u.ref}.${pin}`, "GND");
    const far = addComponent(doc, "capacitor_0603", { x: 0, y: 0 });
    updateComponent(doc, far.id, { pcb: { x: 50, y: 20, rot: 0, side: "top" } });
    attachNet(doc, `${far.ref}.1`, "+3V3");
    attachNet(doc, `${far.ref}.2`, "GND");
    let r = decouplingCheck(getDesign(doc));
    expect(r.pins.length).toBeGreaterThanOrEqual(3);
    expect(r.issues.length).toBe(r.pins.length);
    expect(r.pins.every((p) => p.cap === far.ref && p.distance! > 20)).toBe(true);
    // A capacitor right next to the part satisfies the pins near it.
    const near = addComponent(doc, "capacitor_0603", { x: 0, y: 0 });
    const vcc = padsOf(getDesign(doc).components.find((c) => c.id === u.id)!).find((p) => p.id === "4")!.world;
    updateComponent(doc, near.id, { pcb: { x: vcc.x - 2, y: vcc.y, rot: 0, side: "top" } });
    attachNet(doc, `${near.ref}.1`, "+3V3");
    attachNet(doc, `${near.ref}.2`, "GND");
    r = decouplingCheck(getDesign(doc));
    expect(r.pins.find((p) => p.pin === "4")!.cap).toBe(near.ref);
    expect(r.pins.find((p) => p.pin === "4")!.distance!).toBeLessThan(3);
  });
});
