import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addComponent, addSpiceModels, attachNet, getDesign, initDoc, parseSpiceModels, simulateAC, simulateDC, simulateTransient, updateComponent } from "../src";

const OPAMP = `
* Simple op-amp macromodel: input resistance, gain stage with a pole, output resistance
.SUBCKT OPA1 INP INN VCC VEE OUT
RIN INP INN 10MEG
G1 0 N1 INP INN 1m
R1 N1 0 100MEG       ; DC gain 1e5
C1 N1 0 159.15p      ; dominant pole at 10 Hz -> GBW 1 MHz
EOUT N2 0 N1 0 1
ROUT N2 OUT 50
.ENDS OPA1
`;

/** Sources of every kind inside one subcircuit, with a nested subcircuit and a local diode model. */
const MIX = `
.subckt mix a b c d e
Vs a mid 0
Rl mid 0 1k
F1 0 b Vs 2
Rb b 0 1k
H1 c 0 Vs 500
G1 0 d a 0 1m
Rd d 0 1k
X1 a e clamp
.ends
.subckt clamp in out
.model DLOC D(IS=1e-14 N=1)
R1 in out 1k
D1 out 0 DLOC
.ends
`;

/** The classic Boyle macromodel of the uA741 (PSpice evaluation library): POLY sources, clamps. */
const UA741 = `
.subckt uA741    1 2 3 4 5
  c1   11 12 8.661E-12
  c2    6  7 30.00E-12
  dc    5 53 dx
  de   54  5 dx
  dlp  90 91 dx
  dln  92 90 dx
  dp    4  3 dx
  egnd 99  0 poly(2) (3,0) (4,0) 0 .5 .5
  fb    7 99 poly(5) vb vc ve vlp vln 0 10.61E6 -10E6 10E6 10E6 -10E6
  ga    6  0 11 12 188.5E-6
  gcm   0  6 10 99 5.961E-9
  iee  10  4 dc 15.16E-6
  hlim 90  0 vlim 1K
  q1   11  2 13 qx
  q2   12  1 14 qx
  r2    6  9 100.0E3
  rc1   3 11 5.305E3
  rc2   3 12 5.305E3
  re1  13 10 1.836E3
  re2  14 10 1.836E3
  ree  10 99 13.19E6
  ro1   8  5 50
  ro2   7 99 100
  rp    3  4 18.16E3
  vb    9  0 dc 0
  vc    3 53 dc 1
  ve   54  4 dc 1
  vlim  7  8 dc 0
  vlp  91  0 dc 40
  vln   0 92 dc 40
.model dx D(Is=800.0E-18 Rs=1)
.model qx NPN(Is=800.0E-18 Bf=93.75)
.ends
`;

const num = (r: ReturnType<typeof simulateDC>, net: string) => r.nodes.find((n) => n.net === net)!.voltage;

describe("SPICE subcircuits", () => {
  it("parses .subckt blocks with ports, local models and nested definitions", () => {
    const r = parseSpiceModels(OPAMP + MIX + ".model Q2N3904 NPN(IS=6.7f BF=416)\n");
    expect(r.subckts.map((s) => [s.name, s.ports.length])).toEqual([
      ["OPA1", 5],
      ["MIX", 5],
      ["CLAMP", 2],
    ]);
    expect(r.models.map((m) => m.name)).toEqual(["Q2N3904"]);
    expect(r.warnings).toEqual([]);
  });

  it("simulates an op-amp macromodel on each half of a dual op-amp", () => {
    const doc = new Y.Doc();
    initDoc(doc, "opa");
    addSpiceModels(doc, [], parseSpiceModels(OPAMP).subckts);
    const u = addComponent(doc, "lm358_soic8", { x: 0, y: 0 });
    updateComponent(doc, u.id, { model: "OPA1" });
    const v = addComponent(doc, "sim_vsource", { x: 0, y: 0 }, { value: "DC 0.1 AC 1" });
    const r1 = addComponent(doc, "resistor_0603", { x: 0, y: 0 }, { value: "1k" });
    const r2 = addComponent(doc, "resistor_0603", { x: 0, y: 0 }, { value: "10k" });
    attachNet(doc, `${v.ref}.1`, "IN", "global");
    attachNet(doc, `${v.ref}.2`, "GND");
    attachNet(doc, `${u.ref}.3`, "IN", "global");
    attachNet(doc, `${u.ref}.2`, "FB", "global");
    attachNet(doc, `${u.ref}.1`, "OUT", "global");
    attachNet(doc, `${u.ref}.8`, "+5V");
    attachNet(doc, `${u.ref}.4`, "GND");
    attachNet(doc, `${r1.ref}.1`, "FB", "global");
    attachNet(doc, `${r1.ref}.2`, "GND");
    attachNet(doc, `${r2.ref}.1`, "OUT", "global");
    attachNet(doc, `${r2.ref}.2`, "FB", "global");
    // Unit B as a follower of 2.5 V from a divider.
    attachNet(doc, `${u.ref}.5`, "HALF", "global");
    attachNet(doc, `${u.ref}.6`, "OUTB", "global");
    attachNet(doc, `${u.ref}.7`, "OUTB", "global");
    const ra = addComponent(doc, "resistor_0603", { x: 0, y: 0 }, { value: "10k" });
    const rb = addComponent(doc, "resistor_0603", { x: 0, y: 0 }, { value: "10k" });
    attachNet(doc, `${ra.ref}.1`, "+5V");
    attachNet(doc, `${ra.ref}.2`, "HALF", "global");
    attachNet(doc, `${rb.ref}.1`, "HALF", "global");
    attachNet(doc, `${rb.ref}.2`, "GND");
    const d = simulateDC(getDesign(doc));
    expect(d.ok).toBe(true);
    // Non-inverting gain 11 with 1e5 open-loop gain.
    expect(num(d, "OUT")).toBeCloseTo(1.1, 3);
    expect(num(d, "OUTB")).toBeCloseTo(2.5, 3);
    // Internal nodes and elements stay out of the results.
    expect(d.nodes.some((n) => n.net.includes("."))).toBe(false);
    expect(d.elements.some((e) => e.ref.includes("."))).toBe(false);
    // AC: closed-loop gain 11 (20.8 dB) well below the 1 MHz GBW, rolling off near GBW / 11.
    const ac = simulateAC(getDesign(doc), { fstart: 10, fstop: 1e6, pointsPerDecade: 10 });
    expect(ac.ok).toBe(true);
    const out = ac.nodes.OUT.mag;
    expect(out[0]).toBeCloseTo(20 * Math.log10(11), 1);
    const at = (f: number) => out[ac.freq.findIndex((x) => x >= f)];
    expect(at(1e6)).toBeLessThan(at(1e3) - 15);
  });

  it("runs a vendor Boyle macromodel (uA741) with POLY sources", () => {
    const doc = new Y.Doc();
    initDoc(doc, "741");
    const parsed = parseSpiceModels(UA741);
    expect(parsed.warnings).toEqual([]);
    addSpiceModels(doc, parsed.models, parsed.subckts);
    const u = addComponent(doc, "lm358_soic8", { x: 0, y: 0 });
    // One 741 on unit A's pins (IN+ IN- V+ V- OUT).
    updateComponent(doc, u.id, { model: "UA741", spicePins: "3 2 8 4 1" });
    const v = addComponent(doc, "sim_vsource", { x: 0, y: 0 }, { value: "DC 0.1 AC 1" });
    const r1 = addComponent(doc, "resistor_0603", { x: 0, y: 0 }, { value: "1k" });
    const r2 = addComponent(doc, "resistor_0603", { x: 0, y: 0 }, { value: "10k" });
    const a = (s: string, n: string, scope: "global" | "auto" = "global") => attachNet(doc, s, n, scope);
    a(`${v.ref}.1`, "IN");
    a(`${v.ref}.2`, "GND", "auto");
    a(`${u.ref}.3`, "IN");
    a(`${u.ref}.2`, "FB");
    a(`${u.ref}.1`, "OUT");
    a(`${u.ref}.8`, "+15V", "auto");
    a(`${u.ref}.4`, "-15V", "auto");
    a(`${r1.ref}.1`, "FB");
    a(`${r1.ref}.2`, "GND", "auto");
    a(`${r2.ref}.1`, "OUT");
    a(`${r2.ref}.2`, "FB");
    const d = simulateDC(getDesign(doc));
    expect(d.ok).toBe(true);
    expect(d.warnings.join(" ")).not.toMatch(/skipped/);
    expect(num(d, "OUT")).toBeCloseTo(1.1, 2);
    // Supply current of a 741 is about 1.7 mA.
    const plus = d.supplies.find((s) => s.name === "+15V")!;
    expect(Math.abs(plus.current)).toBeGreaterThan(1e-3);
    expect(Math.abs(plus.current)).toBeLessThan(3e-3);
    // Gain-bandwidth about 1 MHz: gain 11 holds at 1 kHz and has rolled off by 1 MHz.
    const ac = simulateAC(getDesign(doc), { fstart: 100, fstop: 1e6, pointsPerDecade: 10 });
    expect(ac.ok).toBe(true);
    const at = (f: number) => ac.nodes.OUT.mag[ac.freq.findIndex((x) => x >= f * 0.999)];
    expect(at(1e3)).toBeCloseTo(20 * Math.log10(11), 0);
    expect(at(1e6)).toBeLessThan(5);
    // Slew rate about 0.5 V/us on a 0.5 V step (5.5 V at the output).
    updateComponent(doc, v.id, { value: "PULSE(0 0.5 1u 10n 10n 50u 100u)" });
    const t = simulateTransient(getDesign(doc), { tstop: 30e-6, points: 3000 });
    expect(t.ok).toBe(true);
    const out = t.nodes.OUT;
    const t1 = t.time[out.findIndex((x) => x > 1)];
    const t4 = t.time[out.findIndex((x) => x > 4)];
    expect(3 / (t4 - t1) / 1e6).toBeCloseTo(0.5, 1);
    expect(out[out.length - 1]).toBeCloseTo(5.5, 1);
  });

  it("follows SPICE conventions for E, F, G and H sources, nested subcircuits and local models", () => {
    const doc = new Y.Doc();
    initDoc(doc, "mix");
    addSpiceModels(doc, [], parseSpiceModels(MIX).subckts);
    const h = addComponent(doc, "header_1x6", { x: 0, y: 0 });
    updateComponent(doc, h.id, { model: "MIX", spicePins: "1 2 3 4 5" });
    const v = addComponent(doc, "sim_vsource", { x: 0, y: 0 }, { value: "DC 1" });
    attachNet(doc, `${v.ref}.1`, "A", "global");
    attachNet(doc, `${v.ref}.2`, "GND");
    attachNet(doc, `${h.ref}.6`, "GND");
    ["A", "B", "C", "D", "E"].forEach((n, i) => attachNet(doc, `${h.ref}.${i + 1}`, n, "global"));
    const r = simulateDC(getDesign(doc));
    expect(r.ok).toBe(true);
    // I(Vs) = 1 mA through Rl. F: 2 x that into b; H: 500 ohm x 1 mA; G: 1 mS x V(a) into d.
    expect(num(r, "B")).toBeCloseTo(2, 4);
    expect(num(r, "C")).toBeCloseTo(0.5, 4);
    expect(num(r, "D")).toBeCloseTo(1, 4);
    // The nested clamp's diode (a local model) is barely on at 1 V through 1k.
    expect(num(r, "E")).toBeGreaterThan(0.3);
    expect(num(r, "E")).toBeLessThan(0.7);
    expect(r.warnings.join(" ")).not.toMatch(/skipped/);
  });
});
