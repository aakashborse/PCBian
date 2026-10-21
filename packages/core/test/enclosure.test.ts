import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addComponent, enclosure, enclosureStep, getDesign, initDoc, setBoard, updateComponent } from "../src";

const occt = createRequire(import.meta.url)("occt-import-js") as () => Promise<{ ReadStepFile: (d: Uint8Array, p: null) => { success: boolean; meshes: { name: string; attributes: { position: { array: number[] } } }[] } }>;

function board() {
  const doc = new Y.Doc();
  initDoc(doc, "box");
  setBoard(doc, { width: 50, height: 30 });
  const place = (part: string, x: number, y: number, rot = 0) => {
    const c = addComponent(doc, part, { x: 0, y: 0 });
    updateComponent(doc, c.id, { pcb: { x, y, rot, side: "top" } });
    return c;
  };
  for (const [x, y] of [
    [4, 4],
    [46, 4],
    [4, 26],
    [46, 26],
  ])
    place("mounting_hole_m3", x, y);
  const usb = place("usb_c_power", 25, 3);
  place("resistor_0603", 25, 15);
  return { doc, usb };
}

describe("enclosure", () => {
  it("builds walls, floor, standoffs, lid and a connector opening", () => {
    const { doc, usb } = board();
    const d = getDesign(doc);
    const e = enclosure(d, { wall: 2, clearance: 0.5, standoff: 4, headroom: 2 });
    expect(e.standoffs).toHaveLength(4);
    // Outside: board + clearance + walls; height: floor + standoff + board + tallest + headroom + lid.
    expect(e.outer.x1 - e.outer.x0).toBeCloseTo(50 + 2 * 0.5 + 2 * 2, 6);
    expect(e.outer.y1 - e.outer.y0).toBeCloseTo(30 + 2 * 0.5 + 2 * 2, 6);
    expect(e.outer.z1 - e.outer.z0).toBeCloseTo(2 + 4 + d.board.thickness + e.tallest + 2 + 2, 6);
    // The USB connector sits on the board's top edge (y = 3 from the top, i.e. the STEP "back").
    const cut = e.cutouts.find((c) => c.ref === usb.ref)!;
    expect(cut).toBeTruthy();
    expect(cut.side).toBe("back");
    expect(cut.z0).toBeGreaterThanOrEqual(d.board.thickness - 0.5 - 1e-9);
    // The back wall is split around the opening.
    expect(e.base.filter((s) => s.name === "Wall back").length).toBeGreaterThan(1);
    expect(e.warnings).toEqual([]);
  });

  it("exports a STEP that OCCT reads, with the board inside", async () => {
    const { doc } = board();
    const d = getDesign(doc);
    const e = enclosure(d);
    const m = await occt();
    const r = m.ReadStepFile(new TextEncoder().encode(enclosureStep(d)), null);
    expect(r.success).toBe(true);
    const all = r.meshes.flatMap((x) => x.attributes.position.array);
    const zs = all.filter((_, i) => i % 3 === 2);
    expect(Math.min(...zs)).toBeCloseTo(e.outer.z0, 3);
    expect(Math.max(...zs)).toBeCloseTo(e.outer.z1, 3);
    // Base pieces + lid + board + 6 part bodies (mounting holes have no body).
    expect(r.meshes.length).toBe(e.base.length + e.lid.length + 1 + 2);
    const alone = m.ReadStepFile(new TextEncoder().encode(enclosureStep(d, {}, false)), null);
    expect(alone.meshes.length).toBe(e.base.length + e.lid.length);
  });
});
