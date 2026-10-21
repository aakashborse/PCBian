import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addComponent, addZone, getDesign, initDoc, setBoard, thermalAnalysis, updateComponent } from "../src";

function board() {
  const doc = new Y.Doc();
  initDoc(doc, "th");
  setBoard(doc, { width: 40, height: 40 });
  const r = addComponent(doc, "resistor_0805", { x: 0, y: 0 });
  updateComponent(doc, r.id, { pcb: { x: 20, y: 20, rot: 0, side: "top" } });
  return { doc, r };
}

describe("thermal", () => {
  it("conserves energy: total convection equals the injected power", () => {
    const { doc, r } = board();
    const t = thermalAnalysis(getDesign(doc), { power: { [r.ref]: 0.5 }, h: 10 });
    expect(t.ok).toBe(true);
    // Sum of h * A * dT over both faces of every cell equals the 0.5 W put in.
    const area = (t.pitch / 1000) ** 2;
    let out = 0;
    for (const v of t.temps) if (Number.isFinite(v)) out += 2 * 10 * area * (v - t.ambient);
    expect(out).toBeCloseTo(0.5, 3);
    // A 0.5 W hot spot on bare FR-4 runs hot; the average rise is P / (2 h A_board).
    const avg = 0.5 / (2 * 10 * (0.04 * 0.04));
    expect(t.max - t.ambient).toBeGreaterThan(avg * 3);
    expect(t.parts[0].ref).toBe(r.ref);
  });

  it("spreads heat through copper pours", () => {
    const { doc, r } = board();
    const bare = thermalAnalysis(getDesign(doc), { power: { [r.ref]: 0.5 } });
    addZone(doc, { layer: "top", net: "GND", points: [{ x: 1, y: 1 }, { x: 39, y: 1 }, { x: 39, y: 39 }, { x: 1, y: 39 }], priority: 0, removeIslands: false });
    addZone(doc, { layer: "bottom", net: "GND", points: [{ x: 1, y: 1 }, { x: 39, y: 1 }, { x: 39, y: 39 }, { x: 1, y: 39 }], priority: 0, removeIslands: false });
    const poured = thermalAnalysis(getDesign(doc), { power: { [r.ref]: 0.5 } });
    expect(poured.max - poured.ambient).toBeLessThan((bare.max - bare.ambient) / 2);
    // The board edge warms up more when copper carries the heat out to it.
    const corner = (t: typeof bare) => t.temps[t.nx + 1];
    expect(corner(poured)).toBeGreaterThan(corner(bare));
  });
});
