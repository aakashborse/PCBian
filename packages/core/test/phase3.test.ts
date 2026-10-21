import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addZone,
  boardOutlineZone,
  hatchHoles,
  ipc2581,
  odbFiles,
  parseXml,
  schematicSvgs,
  stepFile,
  xkids,
  xpath,
  zoneFill,
  addComment,
  addSpiceModels,
  parseSpiceModels,
  simulateAC,
  simulateDC,
  spiceNumber,
  stepParam,
  sweepDC,
  withValue,
  addComponent,
  designDiff,
  replyComment,
  restoreInto,
  setCommentResolved,
  summarizeDiff,
  addKeepout,
  addTrace,
  addVia,
  attachNet,
  autoPlace,
  autoRoute,
  connect,
  copperLayers,
  defaultStackup,
  diffImpedance,
  findByRef,
  getDesign,
  gerberFiles,
  importKicadProject,
  initDoc,
  kicadPcb,
  matchLengths,
  netLengths,
  pointSegmentDistance,
  setDiffPair,
  setLengthGroup,
  shoveTrace,
  tracesMap,
  tuneLength,
  microstripZ0,
  ratsnest,
  runDrc,
  setBoard,
  stackupOf,
  stackupThickness,
  striplineZ0,
  traceImpedance,
  updateComponent,
  viaKind,
  viaLayers,
  widthForImpedance,
} from "../src";

function newDoc() {
  const doc = new Y.Doc();
  initDoc(doc, "p3");
  return doc;
}

function boardDoc(layers = 6) {
  const doc = newDoc();
  setBoard(doc, { width: 40, height: 30, layers });
  addComponent(doc, "header_1x2", { x: 0, y: 0 });
  addComponent(doc, "resistor_0603", { x: 100, y: 0 }, { value: "330" });
  addComponent(doc, "led_0603", { x: 200, y: 0 });
  connect(doc, "R1.2", "D1.A");
  for (const p of ["J1.1", "R1.1"]) attachNet(doc, p, "+5V");
  for (const p of ["J1.2", "D1.K"]) attachNet(doc, p, "GND");
  const { placements } = autoPlace(getDesign(doc));
  for (const [id, pcb] of placements) updateComponent(doc, id, { pcb });
  return doc;
}

describe("layer stack", () => {
  it("names layers for any even count up to 32", () => {
    expect(copperLayers({ layers: 2 })).toEqual(["top", "bottom"]);
    expect(copperLayers({ layers: 6 })).toEqual(["top", "in1", "in2", "in3", "in4", "bottom"]);
    expect(copperLayers({ layers: 32 })).toHaveLength(32);
    expect(copperLayers({ layers: 32 })[30]).toBe("in30");
  });

  it("builds a stackup that adds up to the board thickness", () => {
    for (const n of [2, 4, 6, 8, 12]) {
      const s = defaultStackup(n, 1.6);
      expect(s.copperOz).toHaveLength(n);
      expect(s.dielectrics).toHaveLength(n - 1);
      expect(stackupThickness(s)).toBeCloseTo(1.6, 2);
    }
    // A stored stack with the wrong layer count is regenerated.
    expect(stackupOf({ layers: 6, thickness: 1.6, stackup: defaultStackup(4, 1.6) }).copperOz).toHaveLength(6);
  });

  it("computes impedance with IPC-2141 formulas", () => {
    // Textbook cases: 0.3mm on 0.2mm FR-4 ≈ 50-54 Ω; symmetric stripline 0.2mm in 0.5mm ≈ 48 Ω.
    expect(microstripZ0(0.3, 0.2, 0.035, 4.3)).toBeGreaterThan(48);
    expect(microstripZ0(0.3, 0.2, 0.035, 4.3)).toBeLessThan(56);
    expect(striplineZ0(0.2, 0.5, 0.017, 4.3)).toBeCloseTo(48.6, 0);
    const board = { layers: 4, thickness: 1.6 };
    const w = widthForImpedance(board, "top", 50)!;
    expect(traceImpedance(board, "top", w)).toBeCloseTo(50, 1);
    // Wider traces mean lower impedance; tighter coupling lowers the differential impedance.
    expect(traceImpedance(board, "top", 0.5)).toBeLessThan(traceImpedance(board, "top", 0.2));
    expect(diffImpedance(board, "top", 0.2, 0.1)).toBeLessThan(diffImpedance(board, "top", 0.2, 0.4));
  });
});

describe("blind, buried and micro vias", () => {
  it("classifies via spans", () => {
    const b = { layers: 6 };
    expect(viaKind(b, {})).toBe("through");
    expect(viaKind(b, { from: "top", to: "in1" })).toBe("micro");
    expect(viaKind(b, { from: "top", to: "in3" })).toBe("blind");
    expect(viaKind(b, { from: "in1", to: "in4" })).toBe("buried");
    expect(viaLayers(b, { from: "in3", to: "in1" })).toEqual(["in1", "in2", "in3"]);
  });

  it("routes with blind vias on a 6-layer board and exports them", () => {
    const doc = boardDoc(6);
    const r1 = findByRef(doc, "R1")!;
    const d1 = findByRef(doc, "D1")!;
    // Block the top layer between R1 and D1 so the router has to dive into the stack.
    const mx = (r1.pcb.x + d1.pcb.x) / 2;
    addKeepout(doc, { layers: ["top"], points: [{ x: mx - 0.4, y: 0.5 }, { x: mx + 0.4, y: 0.5 }, { x: mx + 0.4, y: 29.5 }, { x: mx - 0.4, y: 29.5 }], noTracks: true, noVias: true, noPours: false });
    const r = autoRoute(getDesign(doc), { blindVias: true });
    expect(r.failed).toEqual([]);
    for (const t of r.traces) addTrace(doc, t);
    for (const v of r.vias) addVia(doc, v, v.diameter, v.drill, v);
    const d = getDesign(doc);
    expect(ratsnest(d)).toEqual([]);
    expect(runDrc(d).filter((i) => i.severity === "error")).toEqual([]);
    const kinds = d.vias.map((v) => viaKind(d.board, v));
    expect(kinds.some((k) => k !== "through")).toBe(true);
    // The cheapest dive is the adjacent inner layer: a microvia pair top<->in1.
    expect(kinds).toContain("micro");

    const g = gerberFiles(d);
    for (const tag of ["F_Cu.gtl", "In1_Cu.g2", "In4_Cu.g5", "B_Cu.gbl"]) expect(Object.keys(g).some((k) => k.endsWith(tag))).toBe(true);
    expect(Object.keys(g).filter((k) => k.endsWith(".drl")).length).toBeGreaterThan(1);
    expect(g["p3-fab-notes.txt"]).toMatch(/Micro via Top - Inner 1: \d+/);

    // KiCad export carries the stack and via spans, and imports back the same.
    const pcb = kicadPcb(d);
    expect(pcb).toContain('"In4.Cu" signal');
    expect(pcb).toContain("(via micro");
    expect(pcb).toContain('(type "prepreg")');
    const back = newDoc();
    importKicadProject(back, { pcb });
    const b = getDesign(back);
    expect(b.board.layers).toBe(6);
    expect(b.vias.map((v) => viaKind(b.board, v)).sort()).toEqual([...kinds].sort());
  });

  it("flags vias on layers the board does not have", () => {
    const doc = boardDoc(4);
    addVia(doc, { x: 20, y: 15 }, 0.5, 0.25, { from: "top", to: "in5" });
    expect(runDrc(getDesign(doc)).some((i) => i.code === "layer" && /in5/.test(i.message))).toBe(true);
  });
});

describe("differential pairs, length tuning, shove", () => {
  function pairDoc() {
    const doc = newDoc();
    setBoard(doc, { width: 40, height: 25, layers: 2 });
    addComponent(doc, "header_1x2", { x: 0, y: 0 });
    addComponent(doc, "header_1x2", { x: 300, y: 0 });
    for (const [a, b, n] of [
      ["J1.1", "J2.1", "D_P"],
      ["J1.2", "J2.2", "D_N"],
    ]) {
      attachNet(doc, a, n);
      attachNet(doc, b, n);
    }
    updateComponent(doc, findByRef(doc, "J1")!.id, { pcb: { x: 5, y: 10, rot: 0, side: "top" } });
    updateComponent(doc, findByRef(doc, "J2")!.id, { pcb: { x: 33, y: 14, rot: 0, side: "top" } });
    setDiffPair(doc, { name: "D", positive: "D_P", negative: "D_N", width: 0.25, gap: 0.2, maxSkew: 0.5 });
    return doc;
  }

  it("routes a pair as two coupled traces at the pair gap", () => {
    const doc = pairDoc();
    const r = autoRoute(getDesign(doc));
    expect(r.failed).toEqual([]);
    expect(r.coupled).toEqual(["D"]);
    for (const t of r.traces) addTrace(doc, t);
    const d = getDesign(doc);
    expect(ratsnest(d)).toEqual([]);
    expect(runDrc(d).filter((i) => i.severity === "error")).toEqual([]);
    const [tp, tn] = d.traces;
    expect(tp.width).toBe(0.25);
    // Along the coupled run the traces sit one pitch apart (centre to centre = width + gap).
    const mid = tp.points[Math.floor(tp.points.length / 2)];
    const nearest = Math.min(...tn.points.slice(1).map((b, i) => pointSegmentDistance(mid, tn.points[i], b)));
    expect(nearest).toBeCloseTo(0.45, 1);
    const lens = netLengths(d);
    expect(Math.abs(lens.get("D_P")! - lens.get("D_N")!)).toBeLessThan(1);
  });

  it("matches pair skew and group lengths with meanders", () => {
    const doc = pairDoc();
    setDiffPair(doc, { name: "D", positive: "D_P", negative: "D_N", width: 0.25, gap: 0.2, maxSkew: 0.05 });
    const r = autoRoute(getDesign(doc), { coupled: false });
    for (const t of r.traces) addTrace(doc, t);
    let d = getDesign(doc);
    const before = netLengths(d);
    const res = tuneLength(d, "D_N", before.get("D_N")! + 6);
    expect(res.ok).toBe(true);
    for (const c of res.changes) tracesMap(doc).set(c.id, { ...tracesMap(doc).get(c.id)!, points: c.points });
    d = getDesign(doc);
    expect(netLengths(d).get("D_N")).toBeCloseTo(before.get("D_N")! + 6, 1);
    expect(runDrc(d).filter((i) => i.severity === "error")).toEqual([]);
    // Now D_P is ~6mm short: the skew check fires, and matching fixes it.
    expect(runDrc(d).some((i) => i.code === "skew")).toBe(true);
    const m = matchLengths(d, ["D_P", "D_N"]);
    for (const c of m.changes) tracesMap(doc).set(c.id, { ...tracesMap(doc).get(c.id)!, points: c.points });
    d = getDesign(doc);
    expect(runDrc(d).filter((i) => i.code === "skew" || i.severity === "error")).toEqual([]);
    setLengthGroup(doc, { name: "bus", nets: ["D_P", "D_N"], target: 80, tolerance: 0.5 });
    expect(runDrc(getDesign(doc)).filter((i) => i.code === "length")).toHaveLength(2);
  });

  it("shoves a neighbouring trace aside for a new one", () => {
    const doc = newDoc();
    setBoard(doc, { width: 40, height: 30 });
    addTrace(doc, { layer: "top", width: 0.25, points: [{ x: 5, y: 10 }, { x: 35, y: 10 }] });
    addTrace(doc, { layer: "top", width: 0.25, points: [{ x: 5, y: 10.5 }, { x: 35, y: 10.5 }] });
    // New trace 0.3mm under the first one: it clashes with trace 1, which must push trace 2 as well.
    const fresh = { layer: "top" as const, width: 0.25, points: [{ x: 12, y: 9.7 }, { x: 28, y: 9.7 }] };
    const r = shoveTrace(getDesign(doc), fresh, undefined);
    expect(r.ok).toBe(true);
    expect(r.changes.length).toBe(2);
    for (const c of r.changes) tracesMap(doc).set(c.id, { ...tracesMap(doc).get(c.id)!, points: c.points });
    addTrace(doc, fresh);
    expect(runDrc(getDesign(doc)).filter((i) => i.code === "clearance")).toEqual([]);
    // A trace that crosses another cannot be shoved.
    expect(shoveTrace(getDesign(doc), { layer: "top", width: 0.25, points: [{ x: 20, y: 5 }, { x: 20, y: 15 }] }, undefined).ok).toBe(false);
  });
});

describe("version history and comments", () => {
  it("diffs two states and restores a snapshot as ordinary edits", () => {
    const doc = boardDoc(2);
    const snap = Y.encodeStateAsUpdate(doc);
    const before = getDesign(doc);
    // Edit: change a value, add a part, route, resize the board.
    updateComponent(doc, findByRef(doc, "R1")!.id, { value: "1k" });
    addComponent(doc, "capacitor_0603", { x: 300, y: 0 });
    const r = autoRoute(getDesign(doc));
    for (const t of r.traces) addTrace(doc, t);
    setBoard(doc, { width: 45 });
    addComment(doc, { view: "pcb", pos: { x: 1, y: 1 }, author: "A", text: "check this" });
    const d = designDiff(before, getDesign(doc));
    expect(d.same).toBe(false);
    expect(d.components.added).toEqual(["C1"]);
    expect(d.components.changed.find((c) => c.ref === "R1")?.what).toContain("value 330→1k");
    expect(d.traces.added).toBe(r.traces.length);
    expect(d.board.some((b) => b.startsWith("width"))).toBe(true);
    expect(summarizeDiff(d)).toMatch(/\+1 part/);

    const old = new Y.Doc();
    Y.applyUpdate(old, snap);
    // A second client stays in sync through the restore.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    doc.on("update", (u: Uint8Array) => Y.applyUpdate(peer, u));
    restoreInto(doc, old);
    expect(designDiff(before, getDesign(doc)).same).toBe(true);
    expect(designDiff(before, getDesign(peer)).same).toBe(true);
    // Comments are discussion, not design: they survive a restore.
    expect(getDesign(doc).comments).toHaveLength(1);
  });

  it("threads replies and resolves comments", () => {
    const doc = newDoc();
    const c = addComment(doc, { view: "schematic", sheet: "main", pos: { x: 10, y: 20 }, ref: "R1", author: "Ana", text: "Is 330R right for 5V?" });
    replyComment(doc, c.id, { author: "Copilot", text: "Yes: about 9mA through a red LED." });
    setCommentResolved(doc, c.id, true);
    const got = getDesign(doc).comments[0];
    expect(got.replies.map((r) => r.author)).toEqual(["Copilot"]);
    expect(got.resolved).toBe(true);
  });
});

describe("SPICE models and sweeps", () => {
  const MODELS = `
* Vendor model file
.model 1N4148 D(IS=2.52n RS=0.568 N=1.752 CJO=4p
+ BV=100 IBV=100u)
.MODEL 2N3906 PNP(Is=1.41f Xti=3 Eg=1.11 Vaf=18.7 Bf=180.7 Ne=1.5 Ise=0 Ikf=80m)
.model AO3401 VDMOS pchan (Rd=10m Vto=-0.9 Kp=12 lambda=0.01)
.subckt FOO 1 2
.ends
`;
  it("parses model cards with suffixes and continuations", () => {
    const { models, warnings } = parseSpiceModels(MODELS);
    expect(models.map((m) => [m.name, m.type])).toEqual([
      ["1N4148", "D"],
      ["2N3906", "PNP"],
      ["AO3401", "PMOS"],
    ]);
    expect(models[0].params.IS).toBeCloseTo(2.52e-9, 15);
    expect(models[0].params.BV).toBe(100);
    expect(models[1].params.IKF).toBeCloseTo(0.08, 9);
    expect(spiceNumber("2.2MEG")).toBe(2.2e6);
    expect(spiceNumber("10m")).toBeCloseTo(0.01, 12);
    expect(warnings.some((w) => /subckt/.test(w))).toBe(true);
  });

  function circuit(build: (doc: Y.Doc) => void) {
    const doc = newDoc();
    addSpiceModels(doc, parseSpiceModels(MODELS).models);
    build(doc);
    return doc;
  }

  it("uses an imported diode model (series resistance shows at high current)", () => {
    const mk = (model?: string) =>
      circuit((doc) => {
        addComponent(doc, "sim_vsource", { x: 0, y: 0 }, { value: "DC 1.2" });
        addComponent(doc, "diode_sod123", { x: 100, y: 0 });
        updateComponent(doc, findByRef(doc, "D1")!.id, { model });
        connect(doc, "V1.1", "D1.A");
        attachNet(doc, "V1.2", "GND");
        attachNet(doc, "D1.K", "GND");
      });
    const i = (doc: Y.Doc) => simulateDC(getDesign(doc)).elements.find((e) => e.ref === "D1")!.current;
    const withModel = i(mk("1N4148"));
    // 1N4148 at 1.2V forward: limited by RS≈0.57Ω to roughly 0.5-1A, far below an ideal exponential.
    expect(withModel).toBeGreaterThan(0.2);
    expect(withModel).toBeLessThan(1.5);
    expect(i(mk("NOPE")) > 0).toBe(true);
    expect(simulateDC(getDesign(mk("NOPE"))).warnings.some((w) => /not in the design's model library/.test(w))).toBe(true);
  });

  it("simulates PNP and P-MOSFET high-side switches", () => {
    for (const [part, ref, model] of [
      ["pnp_sot23", "Q1", "2N3906"],
      ["pmos_sot23", "Q1", "AO3401"],
    ] as const) {
      const doc = circuit((d) => {
        addComponent(d, part, { x: 0, y: 0 });
        addComponent(d, "resistor_0603", { x: 100, y: 0 }, { value: "100" }); // load
        addComponent(d, "resistor_0603", { x: 200, y: 0 }, { value: "1k" }); // base/gate drive
        updateComponent(d, findByRef(d, ref)!.id, { model });
        attachNet(d, `${ref}.2`, "+5V"); // emitter/source to the supply
        connect(d, `${ref}.3`, "R1.1");
        attachNet(d, "R1.2", "GND");
        connect(d, `${ref}.1`, "R2.1");
        attachNet(d, "R2.2", "GND"); // pull base/gate low = on
      });
      const r = simulateDC(getDesign(doc));
      expect(r.ok).toBe(true);
      const load = r.elements.find((e) => e.ref === "R1")!;
      // Switched on: most of the 5V appears across the 100Ω load (≈ 40-50 mA).
      expect(load.current).toBeGreaterThan(0.035);
    }
  });

  it("sweeps a source and steps a component value", () => {
    const doc = circuit((d) => {
      addComponent(d, "sim_vsource", { x: 0, y: 0 }, { value: "DC 0 AC 1" });
      addComponent(d, "resistor_0603", { x: 100, y: 0 }, { value: "1k" });
      addComponent(d, "capacitor_0603", { x: 200, y: 0 }, { value: "100n" });
      connect(d, "V1.1", "R1.1");
      connect(d, "R1.2", "C1.1");
      attachNet(d, "R1.2", "OUT");
      attachNet(d, "V1.2", "GND");
      attachNet(d, "C1.2", "GND");
    });
    const d = getDesign(doc);
    const sw = sweepDC(d, { ref: "V1", from: 0, to: 5, points: 6 });
    expect(sw.ok).toBe(true);
    expect(sw.x).toEqual([0, 1, 2, 3, 4, 5]);
    expect(sw.nodes.OUT[5]).toBeCloseTo(5, 3);
    // The AC part of the source value survives the sweep.
    expect(withValue(d, "V1", "DC 3 AC 1").components.find((c) => c.ref === "V1")!.value).toBe("DC 3 AC 1");
    const steps = stepParam(d, "R1", ["1k", "10k"], (x) => simulateAC(x, { fstart: 10, fstop: 1e5, pointsPerDecade: 40 }));
    const f3 = steps.map(({ result }) => result.freq[result.nodes.OUT.mag.findIndex((m) => m < -3.0103)]);
    expect(f3[0]).toBeGreaterThan(1400);
    expect(f3[0]).toBeLessThan(1800);
    expect(f3[1]).toBeGreaterThan(140);
    expect(f3[1]).toBeLessThan(180);
  });
});

describe("pour styles and fabrication outputs", () => {
  it("cuts lower-priority pours around higher-priority ones and hatches", () => {
    const doc = boardDoc(2);
    const d0 = getDesign(doc);
    const big = addZone(doc, { net: "GND", layer: "top", points: boardOutlineZone(d0.board) });
    const small = addZone(doc, { net: "+5V", layer: "top", points: [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }, { x: 2, y: 8 }], priority: 1, fill: "hatch", hatchWidth: 0.3, hatchGap: 0.8 });
    const d = getDesign(doc);
    const fb = zoneFill(d, d.zones.find((z) => z.id === big.id)!);
    expect(fb.cutouts.some((c) => c.kind === "polygon" && c.points[0].x === 2)).toBe(true);
    const fs = zoneFill(d, d.zones.find((z) => z.id === small.id)!);
    expect(fs.hatch).toMatchObject({ width: 0.3, gap: 0.8 });
    expect(hatchHoles(fs).length).toBeGreaterThan(9);
    expect(runDrc(d).filter((i) => i.code === "short")).toEqual([]);
  });

  it("writes STEP, IPC-2581, ODB++ and schematic SVG", () => {
    const doc = boardDoc(4);
    const r = autoRoute(getDesign(doc));
    for (const t of r.traces) addTrace(doc, t);
    for (const v of r.vias) addVia(doc, v, v.diameter, v.drill, v);
    const d = getDesign(doc);
    const step = stepFile(d);
    expect(step.startsWith("ISO-10303-21;")).toBe(true);
    // One solid for the board and one per fitted component with a body.
    expect(step.match(/MANIFOLD_SOLID_BREP/g)!.length).toBe(1 + d.components.filter((c) => !/MOUNT/.test(c.partId) && c.partId.match(/resistor|led|header/)).length);
    const ipc = parseXml(ipc2581(d));
    const root = xpath(ipc, "IPC-2581")!;
    expect(root.attrs.revision).toBe("C");
    expect(xkids(xpath(root, "Ecad/CadData")!, "Layer").filter((l) => l.attrs.layerFunction === "SIGNAL")).toHaveLength(4);
    const odb = odbFiles(d);
    const job = Object.keys(odb)[0].split("/")[0];
    for (const f of ["matrix/matrix", "steps/pcb/profile", "steps/pcb/layers/top/features", "steps/pcb/layers/in2/features", "steps/pcb/layers/drill/features", "steps/pcb/eda/data"]) expect(odb[`${job}/${f}`]).toBeDefined();
    expect(odb[`${job}/steps/pcb/layers/top/features`]).toMatch(/^UNITS=MM/);
    const svg = schematicSvgs(d);
    expect(svg).toHaveLength(1);
    expect(svg[0].svg).toContain("<svg");
    expect(svg[0].svg).toContain(">R1<");
  });
});
