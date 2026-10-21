import { describe, expect, it } from "vitest";
import { defaultStackup, fieldSolveImpedance, solveCrossSection, type CrossSection } from "../src";

/** Complete elliptic integral of the first kind (AGM). */
const K = (k: number) => {
  let a = 1;
  let b = Math.sqrt(1 - k * k);
  for (let i = 0; i < 30; i++) [a, b] = [(a + b) / 2, Math.sqrt(a * b)];
  return Math.PI / (2 * a);
};

/** Exact zero-thickness centred stripline (Cohn). */
const striplineExact = (w: number, b: number, er: number) => {
  const k = 1 / Math.cosh((Math.PI * w) / (2 * b));
  return ((30 * Math.PI) / Math.sqrt(er)) * (K(k) / K(Math.sqrt(1 - k * k)));
};

/** Hammerstad-Jensen thin microstrip (about 0.2% accurate). */
const microstripHJ = (w: number, h: number, er: number) => {
  const u = w / h;
  const a = 1 + Math.log((u ** 4 + (u / 52) ** 2) / (u ** 4 + 0.432)) / 49 + Math.log(1 + (u / 18.1) ** 3) / 18.7;
  const b = 0.564 * ((er - 0.9) / (er + 3)) ** 0.053;
  const eeff = (er + 1) / 2 + ((er - 1) / 2) * (1 + 10 / u) ** (-a * b);
  const f = 6 + (2 * Math.PI - 6) * Math.exp(-((30.666 / u) ** 0.7528));
  const z01 = 60 * Math.log(f / u + Math.sqrt(1 + 4 / u ** 2));
  return { z0: z01 / Math.sqrt(eeff), eeff };
};

const stripline = (w: number, b: number, t: number, er: number, gap?: number): CrossSection => {
  const yc = b / 2 - t / 2;
  const lines = gap === undefined ? [{ net: "a" as const, x0: -w / 2, x1: w / 2 }] : [{ net: "a" as const, x0: -gap / 2 - w, x1: -gap / 2 }, { net: "b" as const, x0: gap / 2, x1: gap / 2 + w }];
  return {
    dielectrics: [{ y0: 0, y1: b, er }],
    conductors: [{ net: "ground", y0: -0.02, y1: 0 }, { net: "ground", y0: b, y1: b + 0.02 }, ...lines.map((l) => ({ ...l, y0: yc, y1: yc + t }))],
    bounds: { x0: -6 * b, x1: 6 * b, y0: -0.02, y1: b + 0.02 },
    minStep: Math.min(w, t, b) / 6,
  };
};

describe("field solver", { timeout: 60000 }, () => {
  it("matches the exact stripline impedance", () => {
    for (const [w, b] of [
      [0.2, 0.4],
      [0.1, 0.5],
    ]) {
      const exact = striplineExact(w, b, 4.2);
      const r = solveCrossSection(stripline(w, b, 0.001, 4.2));
      // The 1 um strip thickness accounts for most of the remaining difference.
      expect(Math.abs(r.z0 / exact - 1)).toBeLessThan(0.02);
      expect(r.eeff).toBeCloseTo(4.2, 3);
    }
  });

  it("matches Hammerstad-Jensen for a thin microstrip", () => {
    for (const [w, h] of [
      [0.3, 0.2],
      [0.15, 0.1],
      [1, 0.2],
    ]) {
      const ref = microstripHJ(w, h, 4.3);
      const t = 0.001;
      const cs: CrossSection = {
        dielectrics: [{ y0: 0, y1: h, er: 4.3 }],
        conductors: [{ net: "ground", y0: -0.03, y1: 0 }, { net: "a", x0: -w / 2, x1: w / 2, y0: h, y1: h + t }],
        bounds: { x0: -15 * h - w, x1: 15 * h + w, y0: -0.03, y1: 15 * h },
        minStep: Math.min(w, h, 4 * t) / 8,
      };
      const r = solveCrossSection(cs);
      expect(Math.abs(r.z0 / ref.z0 - 1)).toBeLessThan(0.015);
      expect(Math.abs(r.eeff / ref.eeff - 1)).toBeLessThan(0.01);
    }
  });

  it("solves coupled pairs and real stackup layers", () => {
    const tight = solveCrossSection(stripline(0.15, 0.4, 0.018, 4, 0.1));
    const loose = solveCrossSection(stripline(0.15, 0.4, 0.018, 4, 2));
    const single = solveCrossSection(stripline(0.15, 0.4, 0.018, 4));
    // Coupling pulls odd-mode impedance down and even-mode up; far apart, both tend to Z0.
    expect(tight.zodd!).toBeLessThan(single.z0 * 0.95);
    expect(tight.zeven!).toBeGreaterThan(single.z0 * 1.02);
    expect(Math.abs(loose.zodd! / single.z0 - 1)).toBeLessThan(0.01);
    expect(tight.zdiff).toBeCloseTo(2 * tight.zodd!, 9);

    const board = { layers: 4, thickness: 1.6, stackup: defaultStackup(4, 1.6) };
    const top = fieldSolveImpedance(board, "top", 0.3);
    const inner = fieldSolveImpedance(board, "in1", 0.15);
    // Microstrip: effective permittivity between air and the laminate's; stripline: the laminate's.
    expect(top.eeff).toBeGreaterThan(2.5);
    expect(top.eeff).toBeLessThan(board.stackup.dielectrics[0].er);
    expect(top.z0).toBeGreaterThan(30);
    expect(top.z0).toBeLessThan(80);
    expect(inner.z0).toBeGreaterThan(25);
    const pair = fieldSolveImpedance(board, "top", 0.2, 0.15);
    expect(pair.zdiff!).toBeGreaterThan(60);
    expect(pair.zdiff!).toBeLessThan(160);
  });
});
