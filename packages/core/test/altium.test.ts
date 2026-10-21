import * as CFB from "cfb";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { computeNets, findByRef, getDesign, importAltiumPcb, importAltiumProject, initDoc, netByTerminal, padsOf, ratsnest, termKey } from "../src";

// Minimal writer for the Altium record formats the importer reads.
const MIL = 10000; // internal units per mil
const mm = (v: number) => Math.round((v / 0.0254) * MIL);
class W {
  parts: number[] = [];
  u8(v: number) {
    this.parts.push(v & 255);
    return this;
  }
  u16(v: number) {
    return this.u8(v).u8(v >> 8);
  }
  u32(v: number) {
    return this.u16(v & 0xffff).u16(v >>> 16);
  }
  i32(v: number) {
    return this.u32(v >>> 0);
  }
  f64(v: number) {
    const b = new Uint8Array(new Float64Array([v]).buffer);
    b.forEach((x) => this.u8(x));
    return this;
  }
  bytes(b: number[]) {
    b.forEach((x) => this.u8(x));
    return this;
  }
  props(o: Record<string, string>) {
    const s = "|" + Object.entries(o).map(([k, v]) => `${k}=${v}`).join("|") + "\0";
    return this.u32(s.length).bytes([...s].map((c) => c.charCodeAt(0)));
  }
  sub(build: (w: W) => void) {
    const inner = new W();
    build(inner);
    return this.u32(inner.parts.length).bytes(inner.parts);
  }
}
const pos = (w: W, x: number, y: number) => w.i32(mm(x)).i32(mm(y));

function pcbDoc(): Uint8Array {
  const cfb = CFB.utils.cfb_new();
  const add = (name: string, w: W) => CFB.utils.cfb_add(cfb, `/${name}/Data`, Uint8Array.from(w.parts));
  // 30 x 20 mm board with its origin at (10, 10) mm (Altium y is up).
  add("Board6", new W().props({ VX0: "393.7mil", VY0: "393.7mil", VX1: "1574.8mil", VY1: "393.7mil", VX2: "1574.8mil", VY2: "1181.1mil", VX3: "393.7mil", VY3: "1181.1mil" }));
  add("Nets6", new W().props({ NAME: "SIG" }).props({ NAME: "GND" }));
  add(
    "Components6",
    new W().props({ LAYER: "TOP", X: "590.55mil", Y: "787.4mil", ROTATION: "0.000", PATTERN: "R0603", SOURCEDESIGNATOR: "R1", SOURCELIBREFERENCE: "1k" }).props({ LAYER: "BOTTOM", X: "1181.1mil", Y: "787.4mil", ROTATION: "90.000", PATTERN: "R0603", SOURCEDESIGNATOR: "R2", SOURCELIBREFERENCE: "2k" }),
  );
  const pads = new W();
  const pad = (name: string, comp: number, net: number, x: number, y: number, layer: number, dir: number) => {
    pads.u8(2);
    pads.sub((w) => w.u8(name.length).bytes([...name].map((c) => c.charCodeAt(0))));
    for (let k = 0; k < 3; k++) pads.sub(() => undefined);
    pads.sub((w) => {
      w.u8(layer).u8(0).u8(0).u16(net).u16(0xffff).u16(comp).u32(0);
      pos(w, x, y);
      w.i32(mm(0.8)).i32(mm(0.9)).i32(mm(0.8)).i32(mm(0.9)).i32(mm(0.8)).i32(mm(0.9)).i32(0);
      w.u8(2).u8(2).u8(2).f64(dir).u8(0).u8(0).u8(0);
      while (w.parts.length < 110) w.u8(0);
    });
    pads.sub(() => undefined);
  };
  pad("1", 0, 1, 14.25, 20, 1, 0);
  pad("2", 0, 0, 15.75, 20, 1, 0);
  // R2 is on the bottom, rotated 90°: its pads sit above and below its centre.
  pad("1", 1, 0, 30, 20.75, 32, 90);
  pad("2", 1, 1, 30, 19.25, 32, 90);
  add("Pads6", pads);
  const tracks = new W();
  const track = (x1: number, y1: number, x2: number, y2: number, layer: number) => {
    tracks.u8(4).sub((w) => {
      w.u8(layer).u8(0).u8(0).u16(0).u16(0xffff).u16(0xffff).u32(0);
      pos(w, x1, y1);
      pos(w, x2, y2);
      w.i32(mm(0.25)).u16(0).u8(0);
    });
  };
  track(15.75, 20, 22, 20, 1);
  track(22, 20, 30, 20.75, 32);
  add("Tracks6", tracks);
  const vias = new W().u8(3).sub((w) => {
    w.u8(0).u8(0).u8(0).u16(0).u16(0xffff).u16(0xffff).u32(0);
    pos(w, 22, 20);
    w.i32(mm(0.6)).i32(mm(0.3)).u8(1).u8(32);
  });
  add("Vias6", vias);
  return Uint8Array.from(CFB.write(cfb, { type: "array" }) as ArrayLike<number>);
}

describe("Altium PcbDoc import", () => {
  it("reads components, pads, tracks, vias and the outline", () => {
    const doc = new Y.Doc();
    initDoc(doc, "alt");
    const rep = importAltiumPcb(doc, pcbDoc());
    const d = getDesign(doc);
    expect(rep.components).toBe(2);
    expect(d.board.width).toBeCloseTo(30, 2);
    expect(d.board.height).toBeCloseTo(20, 2);
    const r2 = findByRef(doc, "R2")!;
    expect(r2.pcb.side).toBe("bottom");
    // Board coordinates shift so the outline starts at 0,0 and y points down.
    const p = (ref: string, id: string) => padsOf(findByRef(doc, ref)!).find((x) => x.id === id)!.world;
    expect(p("R1", "2").x).toBeCloseTo(5.75, 3);
    expect(p("R1", "2").y).toBeCloseTo(10, 3);
    expect(p("R2", "1").y).toBeCloseTo(9.25, 3);
    expect(p("R2", "1").x).toBeCloseTo(20, 3);
    // The pads' nets come through as labels: SIG joins R1.1 and R2.2, GND joins R1.2 and R2.1.
    const net = netByTerminal(computeNets(d));
    const n = (ref: string, pin: string) => net.get(termKey({ comp: findByRef(doc, ref)!.id, pin }));
    expect(n("R1", "1")).toBe(n("R2", "2"));
    expect(n("R1", "2")).toBe(n("R2", "1"));
    expect(n("R1", "1")).not.toBe(n("R1", "2"));
    expect(d.traces).toHaveLength(2);
    expect(d.vias).toHaveLength(1);
    // GND is routed through the via; SIG is left unrouted.
    expect(ratsnest(d).map((r) => r.net)).toEqual([n("R1", "1")]);
  });
});

describe("Altium schematic import", () => {
  // Two resistors: R1.2 and R2.1 joined by a wire with a net label, R1.1 on a GND power port,
  // and R2.2 joined to the same GND name by a port on a second sheet's power port.
  const schdoc = (records: Record<string, string>[]) => {
    const w = new W();
    w.props({ HEADER: "Protel for Windows - Schematic Capture Binary File Version 5.0" });
    for (const r of records) w.props(r);
    const cfb = CFB.utils.cfb_new();
    CFB.utils.cfb_add(cfb, "FileHeader", new Uint8Array(w.parts));
    return new Uint8Array(CFB.write(cfb, { type: "array" }) as number[]);
  };
  const resistor = (ref: string, x: number, y: number, index: number) => [
    { RECORD: "1", LIBREFERENCE: "Res", "LOCATION.X": String(x), "LOCATION.Y": String(y), CURRENTPARTID: "1", PARTCOUNT: "2" },
    { RECORD: "34", OWNERINDEX: String(index), TEXT: ref, NAME: "Designator" },
    // Pin 1 points left from x-10, pin 2 right from x+10 (pins are 10 long): tips at x-20 and x+20.
    { RECORD: "2", OWNERINDEX: String(index), OWNERPARTID: "1", DESIGNATOR: "1", NAME: "1", "LOCATION.X": String(x - 10), "LOCATION.Y": String(y), PINLENGTH: "10", PINCONGLOMERATE: "2", ELECTRICAL: "4" },
    { RECORD: "2", OWNERINDEX: String(index), OWNERPARTID: "1", DESIGNATOR: "2", NAME: "2", "LOCATION.X": String(x + 10), "LOCATION.Y": String(y), PINLENGTH: "10", PINCONGLOMERATE: "0", ELECTRICAL: "4" },
    { RECORD: "41", OWNERINDEX: String(index), NAME: "Comment", TEXT: "10k" },
    { RECORD: "14", OWNERINDEX: String(index), OWNERPARTID: "1", "LOCATION.X": String(x - 10), "LOCATION.Y": String(y - 4), "CORNER.X": String(x + 10), "CORNER.Y": String(y + 4) },
  ];

  it("recovers parts, values and nets from wires, labels, power ports and ports", () => {
    const sheet1 = schdoc([
      ...resistor("R1", 100, 500, 0),
      ...resistor("R2", 200, 500, 6),
      { RECORD: "27", LOCATIONCOUNT: "2", X1: "120", Y1: "500", X2: "180", Y2: "500" },
      { RECORD: "25", TEXT: "MID", "LOCATION.X": "150", "LOCATION.Y": "500" },
      { RECORD: "27", LOCATIONCOUNT: "2", X1: "80", Y1: "500", X2: "80", Y2: "450" },
      { RECORD: "17", TEXT: "GND", "LOCATION.X": "80", "LOCATION.Y": "450" },
      // A port touching R2.2's tip.
      { RECORD: "18", NAME: "RET", "LOCATION.X": "220", "LOCATION.Y": "500", WIDTH: "30", STYLE: "0" },
    ]);
    const sheet2 = schdoc([{ RECORD: "18", NAME: "RET", "LOCATION.X": "100", "LOCATION.Y": "100", WIDTH: "30" }, { RECORD: "17", TEXT: "GND", "LOCATION.X": "130", "LOCATION.Y": "100" }]);
    const doc = new Y.Doc();
    initDoc(doc, "sch");
    const report = importAltiumProject(doc, { schematics: [{ name: "a.SchDoc", data: sheet1 }, { name: "b.SchDoc", data: sheet2 }] });
    const d = getDesign(doc);
    expect(d.sheets).toHaveLength(2);
    expect(findByRef(doc, "R1")!.value).toBe("10k");
    const nets = computeNets(d);
    const of = netByTerminal(nets);
    const r1 = findByRef(doc, "R1")!;
    const r2 = findByRef(doc, "R2")!;
    const net = (c: { id: string }, pin: string) => of.get(termKey({ comp: c.id, pin }));
    expect(net(r1, "2")).toMatch(/^\/?MID$/); // local labels carry the sheet path
    expect(net(r2, "1")).toBe(net(r1, "2"));
    // R2.2 reaches GND through the RET port and sheet 2's power port.
    expect(net(r1, "1")).toBe("GND");
    expect(net(r2, "2")).toBe("GND");
    expect(report.warnings.join(" ")).toMatch(/no footprint/);
  });
});
