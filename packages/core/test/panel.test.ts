import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addComponent, addTrace, getDesign, initDoc, padsOf, panelFiles, panelize, runDrc, setBoard, updateComponent } from "../src";

function board() {
  const doc = new Y.Doc();
  initDoc(doc, "pcb");
  setBoard(doc, { width: 30, height: 20 });
  const r = addComponent(doc, "resistor_0603", { x: 0, y: 0 });
  updateComponent(doc, r.id, { pcb: { x: 15, y: 10, rot: 0, side: "top" } });
  const d = getDesign(doc);
  const [a, b] = padsOf(d.components[0]).map((p) => p.world);
  addTrace(doc, { layer: "top", width: 0.25, points: [a, { x: a.x - 5, y: a.y }] });
  addTrace(doc, { layer: "top", width: 0.25, points: [b, { x: b.x + 5, y: b.y }] });
  return getDesign(doc);
}

describe("panelization", () => {
  it("lays out a tabbed panel with rails, slots, mouse bites, fiducials and tooling holes", () => {
    const d = board();
    const p = panelize(d, { cols: 3, rows: 2, gap: 2, rail: 5, rails: "tb" });
    // 3 x 30 + 2 gaps wide; 2 x 20 + 1 gap + 2 rails + 2 rail gaps high.
    expect(p.width).toBeCloseTo(94, 6);
    expect(p.height).toBeCloseTo(2 * 20 + 2 + 2 * (5 + 2), 6);
    expect(p.boards).toHaveLength(6);
    // Tabs: between neighbours (horizontal 2 rows x 2 gaps, vertical 3 columns x 1 gap) and to the rails
    // (3 boards top + 3 bottom); one tab per 20-30 mm side.
    expect(p.tabs.length).toBe(4 * 1 + 3 * 2 + 6 * 2);
    expect(p.npth.filter((h) => h.d === 0.5).length).toBe(p.tabs.length * 2 * 4);
    expect(p.npth.filter((h) => h.d > 1)).toHaveLength(4);
    expect(p.design.components.filter((c) => c.partId === "fiducial")).toHaveLength(6);
    // The routed slots are board cutouts, and every copy's copper is in the panel.
    expect(p.design.board.cutouts!.length).toBeGreaterThan(0);
    expect(p.design.traces).toHaveLength(12);
    expect(p.design.components.filter((c) => c.partId === "resistor_0603").map((c) => c.pcb.x).sort((a, b) => a - b)).toEqual([15, 15, 47, 47, 79, 79]);
    // The panel itself passes DRC (no copper in slots or over the frame edge).
    expect(runDrc(p.design).filter((i) => i.severity === "error" && i.code !== "unrouted")).toEqual([]);
    const { files } = panelFiles(d, { cols: 3, rows: 2 });
    const names = Object.keys(files);
    expect(names.some((n) => /F_Cu\.gtl$/.test(n))).toBe(true);
    expect(names.some((n) => /NPTH\.drl$/.test(n))).toBe(true);
    // Six copies of the resistor's two pads flashed on top copper (plus three fiducials).
    const top = files[names.find((n) => /F_Cu\.gtl$/.test(n))!];
    expect((top.match(/D03\*/g) ?? []).length).toBe(6 * 2 + 3);
  });

  it("makes a V-scored panel with no gaps", () => {
    const d = board();
    const p = panelize(d, { cols: 2, rows: 2, separation: "vscore", rails: "none" });
    expect(p.width).toBe(60);
    expect(p.height).toBe(40);
    expect(p.tabs).toEqual([]);
    expect(p.design.board.cutouts).toEqual([]);
    // One internal score line each way.
    expect(p.vscore).toHaveLength(2);
    const { files } = panelFiles(d, { cols: 2, rows: 2, separation: "vscore", rails: "none" });
    expect(Object.keys(files).some((n) => /VScore\.gbr$/.test(n))).toBe(true);
    expect(p.warnings.join(" ")).toMatch(/fiducials/);
  });
});
