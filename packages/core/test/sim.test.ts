import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { addComponent, attachNet, connect, getDesign, initDoc, parseSource, simulateAC, simulateDC, simulateTransient, sourceAt } from "../src";
import { buildTemplate } from "../../../apps/server/src/templates";

const doc0 = () => {
  const d = new Y.Doc();
  initDoc(d, "sim");
  return d;
};

describe("sources", () => {
  it("parses PULSE / SIN / AC specs", () => {
    const p = parseSource("PULSE(0 5 0 1u 1u 0.5m 1m)");
    expect(sourceAt(p, 0.25e-3)).toBe(5);
    expect(sourceAt(p, 0.75e-3)).toBe(0);
    const s = parseSource("SIN(0 1 1k) AC 1");
    expect(s.ac).toBe(1);
    expect(sourceAt(s, 0.25e-3)).toBeCloseTo(1, 5);
    expect(parseSource("DC 3.3").dc).toBeCloseTo(3.3);
  });
});

describe("transient", () => {
  it("simulates the 555 blinker at the textbook frequency", () => {
    const doc = new Y.Doc();
    buildTemplate(doc, "blinker555", "blink");
    const r = simulateTransient(getDesign(doc), { tstop: 3, points: 3000 });
    expect(r.ok).toBe(true);
    // Find the output net (U1 pin 3 drives R3).
    const outNet = Object.keys(r.nodes).find((n) => n.includes("U1-3") || n.includes("R3-1"))!;
    const v = r.nodes[outNet];
    const rises: number[] = [];
    for (let i = 1; i < v.length; i++) if (v[i - 1] < 1.5 && v[i] >= 1.5) rises.push(r.time[i]);
    expect(rises.length).toBeGreaterThanOrEqual(3);
    const period = (rises[rises.length - 1] - rises[1]) / (rises.length - 2);
    const expected = 0.693 * (1000 + 2 * 47000) * 10e-6;
    expect(Math.abs(period - expected) / expected).toBeLessThan(0.1);
    // The LED actually blinks.
    expect(Math.max(...r.currents["D1"])).toBeGreaterThan(0.003);
  });

  it("charges an RC network from a pulse source", () => {
    const doc = doc0();
    addComponent(doc, "sim_vsource", { x: 0, y: 0 }, { value: "PULSE(0 5 0 1u 1u 10m 20m)" });
    addComponent(doc, "resistor_0603", { x: 100, y: 0 }, { value: "1k" });
    addComponent(doc, "capacitor_0603", { x: 200, y: 0 }, { value: "1u" });
    connect(doc, "V1.1", "R1.1");
    connect(doc, "R1.2", "C1.1");
    attachNet(doc, "V1.2", "GND");
    attachNet(doc, "C1.2", "GND");
    attachNet(doc, "C1.1", "OUT");
    const r = simulateTransient(getDesign(doc), { tstop: 5e-3, points: 1000 });
    const out = r.nodes["OUT"];
    const at = (t: number) => out[Math.round(t / 5e-6)];
    expect(at(1e-3)).toBeGreaterThan(5 * (1 - Math.exp(-1)) - 0.15); // one tau
    expect(at(1e-3)).toBeLessThan(5 * (1 - Math.exp(-1)) + 0.15);
    expect(at(5e-3)).toBeGreaterThan(4.9);
  });
});

describe("AC", () => {
  it("finds the -3dB point of an RC low-pass", () => {
    const doc = doc0();
    addComponent(doc, "sim_vsource", { x: 0, y: 0 }, { value: "DC 0 AC 1" });
    addComponent(doc, "resistor_0603", { x: 100, y: 0 }, { value: "1k" });
    addComponent(doc, "capacitor_0603", { x: 200, y: 0 }, { value: "100n" });
    connect(doc, "V1.1", "R1.1");
    connect(doc, "R1.2", "C1.1");
    attachNet(doc, "V1.2", "GND");
    attachNet(doc, "C1.2", "GND");
    attachNet(doc, "C1.1", "OUT");
    const r = simulateAC(getDesign(doc), { fstart: 10, fstop: 1e6, pointsPerDecade: 50 });
    expect(r.ok).toBe(true);
    const idx = r.nodes["OUT"].mag.findIndex((m) => m < -3.0103);
    const fc = r.freq[idx];
    expect(fc).toBeGreaterThan(1400);
    expect(fc).toBeLessThan(1800);
    expect(r.nodes["OUT"].phase[idx]).toBeLessThan(-40);
  });
});

describe("transistors and op-amps", () => {
  it("switches an LED with an NPN and a MOSFET", () => {
    for (const [part, drive] of [["npn_sot23", "Q1.B"], ["nmos_sot23", "Q1.G"]] as const) {
      const doc = doc0();
      addComponent(doc, part, { x: 0, y: 0 });
      addComponent(doc, "resistor_0603", { x: 100, y: 0 }, { value: "330" });
      addComponent(doc, "led_0603", { x: 200, y: 0 });
      addComponent(doc, "resistor_0603", { x: 100, y: 100 }, { value: "4.7k" });
      attachNet(doc, "R1.1", "+5V");
      connect(doc, "R1.2", "D1.A");
      connect(doc, "D1.K", part === "npn_sot23" ? "Q1.C" : "Q1.D");
      attachNet(doc, part === "npn_sot23" ? "Q1.E" : "Q1.S", "GND");
      attachNet(doc, "R2.1", "+3V3");
      connect(doc, "R2.2", drive);
      const r = simulateDC(getDesign(doc));
      expect(r.ok).toBe(true);
      const led = r.elements.find((e) => e.ref === "D1")!;
      expect(led.current * 1000).toBeGreaterThan(7);
    }
  });

  it("buffers with an op-amp follower", () => {
    const doc = doc0();
    addComponent(doc, "lm358_soic8", { x: 0, y: 0 });
    addComponent(doc, "resistor_0603", { x: 100, y: 0 }, { value: "10k" });
    addComponent(doc, "resistor_0603", { x: 100, y: 100 }, { value: "10k" });
    attachNet(doc, "U1.V+", "+5V");
    attachNet(doc, "U1.V-", "GND");
    attachNet(doc, "R1.1", "+5V");
    attachNet(doc, "R2.2", "GND");
    connect(doc, "R1.2", "R2.1");
    connect(doc, "R2.1", "U1.+INA");
    connect(doc, "U1.OUTA", "U1.-INA");
    attachNet(doc, "U1.OUTA", "BUF");
    const r = simulateDC(getDesign(doc));
    expect(r.ok).toBe(true);
    expect(r.nodes.find((n) => n.net === "BUF")!.voltage).toBeCloseTo(2.5, 2);
  });
});
