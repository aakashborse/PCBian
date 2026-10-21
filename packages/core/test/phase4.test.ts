import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addComponent,
  addZone,
  fracture,
  addKeepout,
  addTrace,
  altiumQuery,
  parseRules,
  setDesignRules,
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

describe("custom design rules", () => {
  it("parses rules, units and conditions, and reports mistakes", () => {
    const { rules, errors } = parseRules(`
      # comment
      (version 1)
      (rule "HV" (condition "A.NetClass == 'HV' && B.NetClass != 'HV'") (constraint clearance (min 60mil)))
      (rule "Bad" (condition "A.Colour == 'red'") (constraint clearance (min 1mm)))
      (rule "Typo" (constraint width (min 1mm)))`);
    expect(rules.map((r) => r.name)).toEqual(["HV"]);
    expect(rules[0].constraints[0].min).toBeCloseTo(1.524, 6);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/Colour/);
  });

  it("overrides clearance and edge clearance, with areas and the last rule winning", () => {
    const doc = newDoc();
    // Two traces of different nets 0.3mm apart; the first runs 0.1mm from the top edge.
    addTrace(doc, { layer: "top", width: 0.2, points: [{ x: 5, y: 0.2 }, { x: 20, y: 0.2 }], net: "A" });
    addTrace(doc, { layer: "top", width: 0.2, points: [{ x: 5, y: 0.7 }, { x: 20, y: 0.7 }], net: "B" });
    const codes = () => runDrc(getDesign(doc)).filter((i) => i.severity === "error").map((i) => i.code).sort();
    expect(codes()).toEqual(["edge_clearance"]);
    addKeepout(doc, { name: "Edge strip", layers: ["top"], points: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 2 }, { x: 0, y: 2 }], noTracks: false, noVias: false, noPours: false });
    setDesignRules(doc, `(rule "Wide" (constraint clearance (min 0.5mm)))
(rule "Strip" (condition "A.intersectsArea('Edge strip')") (constraint edge_clearance (min 0mm)))
(rule "Pair A-B" (condition "A.NetName == 'A' && B.NetName == 'B'") (constraint clearance (min 0.25mm)))
(rule "No vias in strip" (condition "A.insideArea('Edge strip')") (constraint disallow via))`);
    expect(codes()).toEqual([]);
    setDesignRules(doc, `(rule "Pair A-B" (condition "A.NetName == 'A' && B.NetName == 'B'") (constraint clearance (min 0.25mm)))
(rule "Wide" (constraint clearance (min 0.5mm)))
(rule "Strip" (condition "A.intersectsArea('Edge*')") (constraint edge_clearance (min 0mm)))`);
    // "Wide" now comes last and wins; area names are not patterns, so the edge exemption is gone
    // (and the unknown area is reported).
    expect(codes()).toEqual(["clearance", "edge_clearance"]);
    expect(runDrc(getDesign(doc)).some((i) => i.code === "rule_syntax" && /Edge\*/.test(i.message))).toBe(true);
  });

  it("translates Altium rule scopes", () => {
    expect(altiumQuery("InNetClass('PWR') and not IsVia", "A", new Map([["PWR", ["VCC", "3V3"]]]))).toBe("(A.NetName == 'VCC' || A.NetName == '3V3') && ! A.Type == 'via'");
    expect(altiumQuery("TouchesRoom('R1') or OnTopSilkscreen", "B")).toBe("B.intersectsArea('R1') || false");
    expect(() => altiumQuery("IsDiffPair", "A")).toThrow();
  });
});

describe("exact pour geometry", () => {
  it("fractures islands with holes into one contour of the right area", () => {
    const outer = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const hole = (x: number, y: number) => [
      { x, y },
      { x: x + 2, y },
      { x: x + 2, y: y + 2 },
      { x, y: y + 2 },
    ];
    const c = fracture([outer, hole(2, 2), hole(6, 6), hole(6, 2)]);
    const a = Math.abs(c.reduce((s, p, i) => s + p.x * c[(i + 1) % c.length].y - c[(i + 1) % c.length].x * p.y, 0) / 2);
    expect(a).toBeCloseTo(100 - 3 * 4, 6);
  });

  it("reports pours of different nets that touch", () => {
    const doc = newDoc();
    const sq = (x: number) => [
      { x, y: 5 },
      { x: x + 10, y: 5 },
      { x: x + 10, y: 15 },
      { x, y: 15 },
    ];
    addZone(doc, { net: "A", layer: "top", points: sq(5), removeIslands: false });
    addZone(doc, { net: "B", layer: "top", points: sq(10), removeIslands: false });
    expect(runDrc(getDesign(doc)).some((i) => i.code === "short" && /Pours of A and B/.test(i.message))).toBe(true);
  });
});
