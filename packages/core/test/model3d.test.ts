import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addComponent, addCustomPart, getDesign, getPart, initDoc, modelPlacement, parseStep, renumber, stepFile, stepRoot, updateComponent, type Model3D, type PartDef } from "../src";

// OCCT (the STEP kernel the 3D view uses) reads the files back.
const occt = createRequire(import.meta.url)("occt-import-js") as () => Promise<{ ReadStepFile: (d: Uint8Array, p: null) => { success: boolean; meshes: { name: string; attributes: { position: { array: number[] } } }[] } }>;

/** A 2 x 1 x 0.5 mm block STEP model, centred on its origin in x and y (made by exporting a bare board). */
function blockModel(): string {
  const doc = new Y.Doc();
  initDoc(doc, "block");
  const d = getDesign(doc);
  const text = stepFile({ ...d, board: { ...d.board, width: 2, height: 1, thickness: 0.5 } });
  return text;
}

const bbox = (pts: number[]) => {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pts.length; i += 3) for (let k = 0; k < 3; k++) (b[k] = Math.min(b[k], pts[i + k])), (b[k + 3] = Math.max(b[k + 3], pts[i + k]));
  return b.map((v) => Math.round(v * 1000) / 1000);
};

describe("STEP models per footprint", () => {
  it("parses entities around comments and strings with separators", () => {
    const d = parseStep("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n/* a; comment */\n#1=PRODUCT('a;b','it''s;',\n'',(#2));\n#2=PRODUCT_CONTEXT('',#3,'m');\nENDSEC;\nEND-ISO-10303-21;");
    expect([...d.entities.keys()]).toEqual([1, 2]);
    expect(d.entities.get(1)).toBe("PRODUCT('a;b','it''s;', '',(#2))");
    expect(renumber(d.entities.get(1)!, 10)).toBe("PRODUCT('a;b','it''s;', '',(#12))");
    expect(renumber("X('#5',#5)", 1)).toBe("X('#5',#6)");
    const root = stepRoot(parseStep(blockModel()));
    expect(root.name).toBe("block");
  });

  it("places part models in the exported assembly where the footprint sits", async () => {
    const doc = new Y.Doc();
    initDoc(doc, "asm");
    const base = getPart("resistor_0603")!;
    const model: Model3D = { file: "blk", name: "block.step", offset: { x: -1, y: -0.5, z: 0 } };
    const part: PartDef = { ...base, id: "res_model", footprint: { ...base.footprint!, model } };
    addCustomPart(doc, part);
    const top = addComponent(doc, "res_model", { x: 0, y: 0 });
    const bottom = addComponent(doc, "res_model", { x: 50, y: 0 });
    const plain = addComponent(doc, "resistor_0603", { x: 100, y: 0 });
    updateComponent(doc, top.id, { pcb: { x: 10, y: 10, rot: 90, side: "top" } });
    updateComponent(doc, bottom.id, { pcb: { x: 30, y: 20, rot: 0, side: "bottom" } });
    updateComponent(doc, plain.id, { pcb: { x: 20, y: 5, rot: 0, side: "top" } });
    const design = getDesign(doc);
    const H = design.board.height;
    const T = design.board.thickness;

    // The 3D view's frame: x = board x, y = up from the top surface, z = board y.
    const v = modelPlacement(getDesign(doc).components.find((c) => c.id === top.id)!, model, design.board, "view");
    expect(v.t.map((n) => Math.round(n * 1000) / 1000)).toEqual([9.5, 0, 9]);

    const text = stepFile(design, { blk: blockModel() });
    const m = await occt();
    const r = m.ReadStepFile(new TextEncoder().encode(text), null);
    expect(r.success).toBe(true);
    // Board, the plain part's box, and two instances of the block.
    const boxes = r.meshes.map((x) => bbox(x.attributes.position.array));
    const has = (b: number[]) => boxes.some((x) => x.every((v, i) => Math.abs(v - b[i]) < 1e-3));
    // Top part turned 90°: its 2 mm length runs along board y.
    expect(has([9.5, H - 11, T, 10.5, H - 9, T + 0.5])).toBe(true);
    // Bottom part hangs below the board.
    expect(has([29, H - 20.5, -0.5, 31, H - 19.5, 0])).toBe(true);
    expect(r.meshes.length).toBe(4);
    // Without the model text the parts fall back to boxes.
    expect(stepFile(design)).not.toMatch(/NEXT_ASSEMBLY_USAGE_OCCURRENCE/);
  });
});
