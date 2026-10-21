import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addComponent,
  analyzeCopper,
  copperGap,
  findByRef,
  getDesign,
  gerberFiles,
  importKicadProject,
  initDoc,
  kicadPcb,
  padRect,
  padsOf,
  runDrc,
  setBoard,
  updateComponent,
} from "../src";

function newDoc() {
  const doc = new Y.Doc();
  initDoc(doc, "p4");
  setBoard(doc, { width: 30, height: 30 });
  return doc;
}

describe("any-angle rotation", () => {
  it("rotates pads exactly and measures clearance on the real shapes", () => {
    const doc = newDoc();
    const s = Math.SQRT1_2;
    // Two 0805s at 45°, side by side across their short axis: pads (1.0 x 1.3) are 0.3 mm apart,
    // although their axis-aligned bounding boxes overlap.
    const r1 = addComponent(doc, "resistor_0805", { x: 0, y: 0 });
    const r2 = addComponent(doc, "resistor_0805", { x: 0, y: 0 });
    updateComponent(doc, r1.id, { pcb: { x: 10, y: 10, rot: 45, side: "top" } });
    updateComponent(doc, r2.id, { pcb: { x: 10 - 1.6 * s, y: 10 + 1.6 * s, rot: 45, side: "top" } });
    const d = getDesign(doc);
    const [a1, a2] = padsOf(d.components.find((c) => c.id === r1.id)!);
    expect(a1.angle).toBe(45);
    expect(a1.world.x).toBeCloseTo(10 - 0.95 * s, 6);
    expect(a2.world.y).toBeCloseTo(10 + 0.95 * s, 6);
    const items = analyzeCopper(d).items.filter((it) => it.kind === "pad");
    const p1 = items.find((it) => it.kind === "pad" && it.pad.comp === r1.id && it.pad.id === "1")!;
    const p2 = items.find((it) => it.kind === "pad" && it.pad.comp === r2.id && it.pad.id === "1")!;
    expect(copperGap(p1, p2)).toBeCloseTo(0.3, 6);
    const b1 = padRect(a1);
    const b2 = padRect(padsOf(d.components.find((c) => c.id === r2.id)!)[0]);
    expect(b1.x0 < b2.x1 && b2.x0 < b1.x1 && b1.y0 < b2.y1 && b2.y0 < b1.y1).toBe(true);
    expect(runDrc(d).filter((i) => i.code === "clearance")).toHaveLength(0);
  });

  it("writes angled pads as regions and round-trips the angle through KiCad", () => {
    const doc = newDoc();
    const r = addComponent(doc, "resistor_0805", { x: 0, y: 0 });
    updateComponent(doc, r.id, { pcb: { x: 15, y: 15, rot: 30, side: "top" } });
    const files = gerberFiles(getDesign(doc));
    const top = Object.entries(files).find(([n]) => n.endsWith(".gtl"))![1];
    expect(top.match(/G36\*/g)?.length).toBe(2);

    const back = new Y.Doc();
    importKicadProject(back, { pcb: kicadPcb(getDesign(doc)) });
    const c = findByRef(back, "R1")!;
    expect(c.pcb.rot).toBeCloseTo(30, 6);
    const before = padsOf(getDesign(doc).components[0]);
    const after = padsOf(getDesign(back).components.find((x) => x.ref === "R1")!);
    after.forEach((p, i) => {
      expect(p.world.x).toBeCloseTo(before[i].world.x, 3);
      expect(p.world.y).toBeCloseTo(before[i].world.y, 3);
      expect(p.angle).toBeCloseTo(before[i].angle, 3);
    });
  });
});
