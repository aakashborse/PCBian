import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { assemblyPdf, computeNets, findByRef, getDesign, importKicadProject, initDoc, netByTerminal, padsOf, ratsnest, schematicPdf, schematicPin, termKey } from "../src";
import { buildTemplate } from "../../../apps/server/src/templates";

const LIB = `(lib_symbols
  (symbol "Device:R" (property "Reference" "R" (at 0 0 0)) (property "Value" "R" (at 0 0 0))
    (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54)))
    (symbol "R_1_1"
      (pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1"))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2"))))
  (symbol "Amp:Dual" (property "Reference" "U" (at 0 0 0)) (property "Value" "Dual" (at 0 0 0))
    (symbol "Dual_1_1" (pin output line (at 5.08 0 180) (length 2.54) (name "A" ) (number "1")))
    (symbol "Dual_2_1" (pin output line (at 5.08 0 180) (length 2.54) (name "B" ) (number "2"))))
  (symbol "power:GND" (power) (property "Reference" "#PWR" (at 0 0 0)) (property "Value" "GND" (at 0 0 0))
    (symbol "GND_1_1" (pin power_in line (at 0 0 270) (length 0) (name "GND") (number "1"))))
  (symbol "power:PWR_FLAG" (power) (property "Reference" "#FLG" (at 0 0 0)) (property "Value" "PWR_FLAG" (at 0 0 0))
    (symbol "PWR_FLAG_1_1" (pin power_out line (at 0 0 90) (length 0) (name "~") (number "1")))))`;

// R1 at (50,50) rot 0: pins (50,46.19) and (50,53.81).
// R2 at (70,50) rot 90 mirrored y: pin 1 -> rotate (0,-3.81) by 90 CCW = (-3.81,0) -> mirror y (3.81,0) -> (73.81,50).
// The vertical wire at x=60 crosses the top wire without a junction, so it must stay unconnected.
const SCH = `(kicad_sch (version 20231120) ${LIB}
  (symbol (lib_id "Device:R") (at 50 50 0) (unit 1) (property "Reference" "R1" (at 0 0 0)) (property "Value" "1k" (at 0 0 0)) (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at 0 0 0)))
  (symbol (lib_id "Device:R") (at 70 50 90) (mirror y) (unit 1) (property "Reference" "R2" (at 0 0 0)) (property "Value" "2k" (at 0 0 0)) (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at 0 0 0)))
  (symbol (lib_id "Device:R") (at 90 50 0) (unit 1) (property "Reference" "R3" (at 0 0 0)) (property "Value" "3k" (at 0 0 0)) (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at 0 0 0)))
  (symbol (lib_id "Amp:Dual") (at 120 40 0) (unit 1) (property "Reference" "U1" (at 0 0 0)) (property "Value" "Dual" (at 0 0 0)))
  (symbol (lib_id "Amp:Dual") (at 120 60 0) (unit 2) (property "Reference" "U1" (at 0 0 0)) (property "Value" "Dual" (at 0 0 0)))
  (symbol (lib_id "power:GND") (at 50 60 0) (unit 1) (property "Reference" "#PWR01" (at 0 0 0)) (property "Value" "GND" (at 0 0 0)))
  (symbol (lib_id "power:PWR_FLAG") (at 50 60 0) (unit 1) (property "Reference" "#FLG01" (at 0 0 0)) (property "Value" "PWR_FLAG" (at 0 0 0)))
  (wire (pts (xy 50 46.19) (xy 50 40) (xy 85 40)))
  (wire (pts (xy 73.81 40) (xy 73.81 50)))
  (wire (pts (xy 60 30) (xy 60 45)))
  (wire (pts (xy 50 53.81) (xy 50 60)))
  (wire (pts (xy 66.19 50) (xy 66.19 70) (xy 90 70) (xy 90 53.81)))
  (wire (pts (xy 80 40) (xy 80 46.19) (xy 90 46.19)))
  (label "MID" (at 80 40 0))
  (global_label "OUTA" (shape output) (at 125.08 40 0))
  (no_connect (at 125.08 60))
)`;

describe("KiCad schematic import", () => {
  it("resolves geometric connectivity like KiCad", () => {
    const doc = new Y.Doc();
    initDoc(doc, "imp");
    const rep = importKicadProject(doc, { schematics: [{ name: "t.kicad_sch", text: SCH }] });
    const d = getDesign(doc);
    const net = netByTerminal(computeNets(d));
    const n = (ref: string, pin: string) => net.get(termKey({ comp: findByRef(doc, ref)!.id, pin }));
    // R1.1 -> wire -> R2.1 (rotated + mirrored)
    expect(n("R1", "1")).toBe(n("R2", "1"));
    // The vertical wire at x=60 crosses the top wire without a junction: not connected.
    // R2.2 -> R3.2 via the bottom wire.
    expect(n("R2", "2")).toBe(n("R3", "2"));
    // T-junctions: wires starting at (73.81,40) and (80,40) land on the top wire -> one net, named by the label.
    expect(n("R3", "1")).toBe(n("R1", "1"));
    expect(n("R1", "1")).toBe("/MID");
    expect(n("R2", "2")).not.toBe(n("R1", "1"));
    // GND symbol gives the net its name; PWR_FLAG is ignored.
    expect(n("R1", "2")).toBe("GND");
    expect(d.components.some((c) => c.value === "PWR_FLAG")).toBe(false);
    // Multi-unit symbol merged; unit B pin marked no-connect.
    const u1 = findByRef(doc, "U1")!;
    expect(u1.noConnect).toEqual(["2"]);
    expect(n("U1", "1")).toBe("OUTA");
    // Footprints from KiCad library names.
    expect(padsOf(findByRef(doc, "R1")!).length).toBe(2);
    // PCBian's placement of the mirrored R2 reproduces KiCad's pin position.
    const k = 10 / 2.54;
    const p = schematicPin(findByRef(doc, "R2")!, "1")!;
    expect(p.x).toBeCloseTo(73.81 * k, 0);
    expect(p.y).toBeCloseTo(50 * k, 0);
    expect(rep.warnings.some((w) => /multi-unit/.test(w))).toBe(true);
  });

  it("imports each instance of a reused sub-sheet with its own references", () => {
    const sheet = (uuid: string, name: string, y: number) =>
      `(sheet (at 100 ${y}) (size 20 10) (uuid "${uuid}") (property "Sheetname" "${name}" (at 0 0 0)) (property "Sheetfile" "amp.kicad_sch" (at 0 0 0)) (pin "IN" input (at 100 ${y + 5} 180)))`;
    const root = `(kicad_sch (version 20250114) (uuid "r0") (lib_symbols)
      ${sheet("s1", "amp_left", 100)} ${sheet("s2", "amp_right", 130)}
      (wire (pts (xy 100 105) (xy 90 105))) (label "A" (at 90 105 0))
      (wire (pts (xy 100 135) (xy 90 135))) (label "B" (at 90 135 0)))`;
    const inst = (pairs: [string, string][]) => `(instances (project "p" ${pairs.map(([path, ref]) => `(path "${path}" (reference "${ref}") (unit 1))`).join(" ")}))`;
    const child = `(kicad_sch (version 20250114) (uuid "c0") ${LIB}
      (symbol (lib_id "Device:R") (at 50 50 0) (unit 1) (uuid "u1") (property "Reference" "R?" (at 0 0 0)) (property "Value" "1k" (at 0 0 0)) (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at 0 0 0))
        ${inst([["/r0/s1", "R101"], ["/r0/s2", "R201"]])})
      (symbol (lib_id "power:GND") (at 50 53.81 0) (unit 1) (property "Reference" "#PWR?" (at 0 0 0)) (property "Value" "GND" (at 0 0 0)))
      (hierarchical_label "IN" (shape input) (at 50 46.19 0)))`;
    const doc = new Y.Doc();
    initDoc(doc, "reuse");
    const rep = importKicadProject(doc, { schematics: [{ name: "root.kicad_sch", text: root }, { name: "amp.kicad_sch", text: child }] });
    const d = getDesign(doc);
    expect(rep.sheets).toBe(3);
    expect(d.sheets.map((x) => x.name)).toEqual(["Root", "amp_left", "amp_right"]);
    const net = netByTerminal(computeNets(d));
    const n = (ref: string, pin: string) => net.get(termKey({ comp: findByRef(doc, ref)!.id, pin }));
    // Same child file, separate circuits: each instance's input lands on its own root net.
    expect(n("R101", "1")).toBeDefined();
    expect(n("R101", "1")).not.toBe(n("R201", "1"));
    expect(n("R101", "2")).toBe("GND");
    expect(n("R201", "2")).toBe("GND");
    expect(findByRef(doc, "R101")!.sheet).not.toBe(findByRef(doc, "R201")!.sheet);
  });
});

const PCB = `(kicad_pcb (version 20240108) (generator "pcbnew")
  (general (thickness 1.2))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "") (net 1 "GND") (net 2 "SIG")
  (footprint "Resistor_SMD:R_0603" (layer "F.Cu") (at 120 110 90)
    (property "Reference" "R1" (at 0 0 0)) (property "Value" "1k" (at 0 0 0))
    (pad "1" smd roundrect (at -0.8 0 90) (size 0.9 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (net 2 "SIG"))
    (pad "2" smd roundrect (at 0.8 0 90) (size 0.9 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (net 1 "GND")))
  (footprint "Connector:PinHeader_1x02" (layer "B.Cu") (at 110 110 0)
    (property "Reference" "J1" (at 0 0 0)) (property "Value" "CONN" (at 0 0 0))
    (pad "1" thru_hole rect (at 0 0) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask") (net 2 "SIG"))
    (pad "2" thru_hole circle (at 0 2.54) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask") (net 1 "GND")))
  (gr_rect (start 100 100) (end 130 120) (layer "Edge.Cuts"))
  (segment (start 110 110) (end 120 110.8) (width 0.25) (layer "F.Cu") (net 2))
  (zone (net 1) (net_name "GND") (layer "B.Cu") (polygon (pts (xy 101 101) (xy 129 101) (xy 129 119) (xy 101 119))))
  (zone (net 0) (net_name "") (layers "F&B.Cu") (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour allowed) (footprints allowed)) (polygon (pts (xy 102 102) (xy 105 102) (xy 105 105) (xy 102 105))))
)`;

describe("KiCad board import", () => {
  it("imports footprints, copper, outline and pours with exact pad positions", () => {
    const doc = new Y.Doc();
    initDoc(doc, "pcb");
    const rep = importKicadProject(doc, { pcb: PCB });
    const d = getDesign(doc);
    expect(d.board.width).toBe(30);
    expect(d.board.height).toBe(20);
    expect(d.board.thickness).toBe(1.2);
    expect(rep.traces).toBe(1);
    expect(d.zones[0].net).toBe("GND");
    // KiCad rotation 90 (CCW) puts pad 1 at (120, 110 + 0.8) -> shifted by (100,100).
    const r1 = padsOf(findByRef(doc, "R1")!).find((p) => p.id === "1")!;
    expect(r1.world.x).toBeCloseTo(20, 3);
    expect(r1.world.y).toBeCloseTo(10.8, 3);
    expect(findByRef(doc, "J1")!.pcb.side).toBe("bottom");
    expect(d.keepouts).toHaveLength(1);
    expect(d.keepouts[0]).toMatchObject({ layers: ["top", "bottom"], noTracks: true, noVias: true, noPours: false });
    expect(d.keepouts[0].points[0]).toEqual({ x: 2, y: 2 });
    // The trace connects SIG; the bottom GND pour connects J1.2 and (via THT) nothing else on top -> one rat for R1.2.
    const rats = ratsnest(d);
    expect(rats.filter((r) => r.net === "SIG")).toEqual([]);
    expect(rats.filter((r) => r.net === "GND").length).toBe(1);
  });
});

describe("PDF export", () => {
  it("writes valid schematic and assembly PDFs", async () => {
    const doc = new Y.Doc();
    buildTemplate(doc, "blinker555", "Blinker");
    const d = getDesign(doc);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcbian-pdf-"));
    const sch = schematicPdf(d);
    const asm = assemblyPdf(d);
    for (const [name, bytes] of [["sch.pdf", sch], ["asm.pdf", asm]] as const) {
      const text = Buffer.from(bytes).toString("latin1");
      expect(text.startsWith("%PDF-1.4")).toBe(true);
      const xref = Number(text.match(/startxref\n(\d+)/)![1]);
      expect(text.slice(xref, xref + 4)).toBe("xref");
      fs.writeFileSync(path.join(dir, name), bytes);
    }
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("pdftotext", [path.join(dir, "sch.pdf"), "-"]).toString();
    expect(out).toContain("U1");
    expect(out).toContain("Blinker");
    const asmText = execFileSync("pdftotext", [path.join(dir, "asm.pdf"), "-"]).toString();
    expect(asmText).toContain("R3");
    expect(asmText).toMatch(/Top assembly/);
  });
});
