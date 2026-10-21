import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { computeNets, findByRef, getDesign, importEagleProject, initDoc, netByTerminal, padsOf, parseXml, ratsnest, runDrc, termKey, viaKind, xkids, xpath } from "../src";

const LIB = `<libraries><library name="lib">
<packages><package name="R0603">
  <smd name="1" x="-0.75" y="0" dx="0.8" dy="0.9" layer="1"/>
  <smd name="2" x="0.75" y="0" dx="0.8" dy="0.9" layer="1"/>
  <wire x1="-0.2" y1="0.5" x2="0.2" y2="0.5" width="0.1" layer="21"/>
</package></packages>
<symbols><symbol name="R">
  <wire x1="-2.54" y1="-0.889" x2="2.54" y2="-0.889" width="0.254" layer="94"/>
  <pin name="1" x="-5.08" y="0" length="short" direction="pas"/>
  <pin name="2" x="5.08" y="0" length="short" direction="pas" rot="R180"/>
</symbol></symbols>
<devicesets><deviceset name="R" prefix="R"><gates><gate name="G$1" symbol="R" x="0" y="0"/></gates>
  <devices><device name="" package="R0603"><connects><connect gate="G$1" pin="1" pad="1"/><connect gate="G$1" pin="2" pad="2"/></connects></device></devices>
</deviceset></devicesets>
</library></libraries>`;

const BRD = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE eagle SYSTEM "eagle.dtd">
<eagle version="9.6.2"><drawing><board>
<plain>
  <wire x1="0" y1="0" x2="20" y2="0" width="0" layer="20"/><wire x1="20" y1="0" x2="20" y2="10" width="0" layer="20"/>
  <wire x1="20" y1="10" x2="0" y2="10" width="0" layer="20"/><wire x1="0" y1="10" x2="0" y2="0" width="0" layer="20"/>
  <hole x="17" y="7" drill="3.2"/>
</plain>
${LIB}
<elements>
  <element name="R1" library="lib" package="R0603" value="1k" x="5" y="5"/>
  <element name="R2" library="lib" package="R0603" value="2k" x="10" y="5" rot="R90"/>
</elements>
<signals>
  <signal name="SIG"><contactref element="R1" pad="2"/><contactref element="R2" pad="1"/>
    <wire x1="5.75" y1="5" x2="8" y2="5" width="0.25" layer="1"/>
    <wire x1="8" y1="5" x2="8" y2="4.25" width="0.25" layer="16" curve="-90"/>
    <wire x1="8" y1="4.25" x2="10" y2="4.25" width="0.25" layer="1"/>
    <via x="8" y="5" extent="1-16" drill="0.3"/><via x="8" y="4.25" extent="1-16" drill="0.3"/>
  </signal>
  <signal name="GND"><contactref element="R1" pad="1"/><contactref element="R2" pad="2"/>
    <polygon width="0.2" layer="1" pour="hatch" spacing="1" rank="2"><vertex x="1" y="1"/><vertex x="19" y="1"/><vertex x="19" y="9"/><vertex x="1" y="9"/></polygon>
  </signal>
</signals>
</board></drawing></eagle>`;

const SCH = `<?xml version="1.0" encoding="utf-8"?>
<eagle version="9.6.2"><drawing><schematic>
${LIB}
<parts><part name="R1" library="lib" deviceset="R" device="" value="1k"/><part name="R2" library="lib" deviceset="R" device="" value="2k"/></parts>
<sheets><sheet>
  <instances><instance part="R1" gate="G$1" x="50.8" y="50.8"/><instance part="R2" gate="G$1" x="76.2" y="50.8"/></instances>
  <nets>
    <net name="SIG"><segment><pinref part="R1" gate="G$1" pin="2"/><pinref part="R2" gate="G$1" pin="1"/></segment></net>
    <net name="N$1"><segment><pinref part="R1" gate="G$1" pin="1"/><pinref part="R2" gate="G$1" pin="2"/></segment></net>
  </nets>
</sheet></sheets>
</schematic></drawing></eagle>`;

describe("EAGLE import", () => {
  it("parses XML with entities and doctype", () => {
    const x = parseXml(`<?xml version="1.0"?><!DOCTYPE a [ <!ENTITY x "y"> ]><a q="1 &amp; 2"><b>t&lt;</b><!-- c --><c/></a>`);
    expect(xpath(x, "a")!.attrs.q).toBe("1 & 2");
    expect(xpath(x, "a/b")!.text).toBe("t<");
    expect(xkids(xpath(x, "a"), "c")).toHaveLength(1);
  });

  it("imports a board: exact pad positions, rotated parts, arcs, vias, pours, outline, holes", () => {
    const doc = new Y.Doc();
    initDoc(doc, "e");
    const rep = importEagleProject(doc, { board: BRD });
    const d = getDesign(doc);
    expect(d.board.width).toBe(20);
    expect(d.board.height).toBe(10);
    expect(d.board.cutouts).toHaveLength(1);
    // Eagle y-up -> PCBian y-down: (x, 10 - y).
    const p = (ref: string, id: string) => padsOf(findByRef(doc, ref)!).find((x) => x.id === id)!;
    expect(p("R1", "2").world).toEqual({ x: 5.75, y: 5 });
    expect(p("R2", "1").world.x).toBeCloseTo(10, 6);
    expect(p("R2", "1").world.y).toBeCloseTo(5.75, 6);
    // R90 turns the 0.8 x 0.9 pad: 0.9 wide, 0.8 tall on the board.
    expect(p("R2", "1").ww).toBeCloseTo(0.9, 6);
    expect(rep.traces).toBe(3);
    expect(d.vias.every((v) => viaKind(d.board, v) === "through")).toBe(true);
    // The arc on the bottom layer is expanded into segments.
    expect(d.traces.find((t) => t.layer === "bottom")!.points.length).toBeGreaterThan(4);
    expect(d.zones[0]).toMatchObject({ net: "GND", layer: "top", fill: "hatch", hatchGap: 1 });
    // SIG is routed through the vias; GND joins through the pour.
    expect(ratsnest(d)).toEqual([]);
    expect(runDrc(d).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("imports a schematic with its board and keeps Eagle's nets", () => {
    const doc = new Y.Doc();
    initDoc(doc, "e");
    const rep = importEagleProject(doc, { board: BRD, schematic: SCH });
    const d = getDesign(doc);
    const net = netByTerminal(computeNets(d));
    const n = (ref: string, pin: string) => net.get(termKey({ comp: findByRef(doc, ref)!.id, pin }));
    expect(n("R1", "2")).toBe(n("R2", "1"));
    expect(n("R1", "2")).toBe("/SIG");
    expect(n("R1", "1")).toBe(n("R2", "2"));
    expect(n("R1", "1")).not.toBe(n("R1", "2"));
    expect(findByRef(doc, "R2")!.pcb.rot).toBe(270);
    expect(rep.warnings).toEqual([]);
    expect(ratsnest(d)).toEqual([]);
  });
});
