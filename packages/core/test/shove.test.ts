import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addComponent, addTrace, addVia, getDesign, initDoc, runDrc, setBoard, shoveTrace, shoveVia, tracesMap, updateComponent, viasMap, type ShoveResult } from "../src";

function board() {
  const doc = new Y.Doc();
  initDoc(doc, "shove");
  setBoard(doc, { width: 40, height: 30 });
  return doc;
}
const apply = (doc: Y.Doc, r: ShoveResult) => {
  for (const c of r.changes) tracesMap(doc).set(c.id, { ...tracesMap(doc).get(c.id)!, points: c.points });
  for (const m of r.viaMoves) viasMap(doc).set(m.id, { ...viasMap(doc).get(m.id)!, x: m.x, y: m.y });
};
const clearance = (doc: Y.Doc) => runDrc(getDesign(doc)).filter((i) => i.code === "clearance" || i.code === "short");

describe("push and shove for vias and pads", () => {
  it("moves a via out of a new trace's way, and its trace follows", () => {
    const doc = board();
    const v = addVia(doc, { x: 20, y: 10.6 }, 0.6, 0.3);
    const stub = addTrace(doc, { layer: "top", width: 0.25, points: [{ x: 20, y: 10.6 }, { x: 20, y: 16 }] });
    const fresh = { layer: "top" as const, width: 0.25, points: [{ x: 5, y: 10 }, { x: 35, y: 10 }] };
    const r = shoveTrace(getDesign(doc), fresh, "A");
    expect(r.ok).toBe(true);
    expect(r.viaMoves).toHaveLength(1);
    const moved = r.viaMoves[0];
    expect(moved.id).toBe(v.id);
    // Pushed straight away from the trace (+y), just far enough.
    expect(moved.x).toBeCloseTo(20, 3);
    expect(moved.y).toBeGreaterThan(10.6);
    expect(moved.y).toBeLessThan(11.2);
    const follow = r.changes.find((c) => c.id === stub.id)!;
    expect(follow.points[0]).toEqual({ x: moved.x, y: moved.y });
    apply(doc, r);
    addTrace(doc, fresh);
    expect(clearance(doc)).toEqual([]);
  });

  it("places a new via by bumping a trace around it, and drags a via with its traces", () => {
    const doc = board();
    addTrace(doc, { layer: "top", width: 0.25, points: [{ x: 5, y: 10 }, { x: 35, y: 10 }] });
    const r = shoveVia(getDesign(doc), { x: 20, y: 10.4, diameter: 0.6, drill: 0.3 }, "B");
    expect(r.ok).toBe(true);
    expect(r.changes).toHaveLength(1);
    apply(doc, r);
    addVia(doc, { x: 20, y: 10.4 }, 0.6, 0.3);
    expect(clearance(doc)).toEqual([]);

    // Drag an existing via (with a trace on it) toward a neighbour: the neighbour gets pushed.
    const doc2 = board();
    const victim = addTrace(doc2, { layer: "top", width: 0.25, points: [{ x: 5, y: 12 }, { x: 35, y: 12 }] });
    const v = addVia(doc2, { x: 20, y: 8 }, 0.6, 0.3);
    const own = addTrace(doc2, { layer: "top", width: 0.25, points: [{ x: 10, y: 8 }, { x: 20, y: 8 }] });
    const d = shoveVia(getDesign(doc2), { id: v.id, x: 20, y: 11.5, diameter: 0.6, drill: 0.3 }, "C");
    expect(d.ok).toBe(true);
    expect(d.changes.find((c) => c.id === own.id)!.points.at(-1)).toEqual({ x: 20, y: 11.5 });
    expect(d.changes.some((c) => c.id === victim.id)).toBe(true);
    apply(doc2, d);
    viasMap(doc2).set(v.id, { ...viasMap(doc2).get(v.id)!, x: 20, y: 11.5 });
    expect(clearance(doc2)).toEqual([]);

    // Dropped right on top of a trace: the trace still counts as someone else's and is pushed.
    const doc3 = board();
    const under = addTrace(doc3, { layer: "top", width: 0.25, points: [{ x: 5, y: 12 }, { x: 35, y: 12 }] });
    const v3 = addVia(doc3, { x: 20, y: 8 }, 0.6, 0.3);
    const o = shoveVia(getDesign(doc3), { id: v3.id, x: 20, y: 11.9, diameter: 0.6, drill: 0.3 }, undefined);
    expect(o.ok).toBe(true);
    apply(doc3, o);
    viasMap(doc3).set(v3.id, { ...viasMap(doc3).get(v3.id)!, x: 20, y: 11.9 });
    expect(o.changes.some((c) => c.id === under.id)).toBe(true);
    expect(clearance(doc3)).toEqual([]);
  });

  it("never moves pads", () => {
    const doc = board();
    const r1 = addComponent(doc, "resistor_0603", { x: 0, y: 0 });
    updateComponent(doc, r1.id, { pcb: { x: 20, y: 10.5, rot: 0, side: "top" } });
    const blocked = shoveTrace(getDesign(doc), { layer: "top", width: 0.25, points: [{ x: 5, y: 10 }, { x: 35, y: 10 }] }, "D");
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toMatch(/pad/);
    // A via squeezed between a new trace and a pad has nowhere to go but sideways.
    const doc2 = board();
    const r2 = addComponent(doc2, "resistor_0603", { x: 0, y: 0 });
    updateComponent(doc2, r2.id, { pcb: { x: 20, y: 11.6, rot: 0, side: "top" } });
    addVia(doc2, { x: 20, y: 10.55 }, 0.5, 0.25);
    const r = shoveTrace(getDesign(doc2), { layer: "top", width: 0.25, points: [{ x: 5, y: 10 }, { x: 35, y: 10 }] }, "E");
    if (r.ok) {
      apply(doc2, r);
      addTrace(doc2, { layer: "top", width: 0.25, points: [{ x: 5, y: 10 }, { x: 35, y: 10 }] });
      expect(clearance(doc2)).toEqual([]);
    } else expect(r.reason).toMatch(/via|pad/);
  });
});
