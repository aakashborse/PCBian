// Parametric footprint generators. All dimensions in millimetres.
import type { Footprint, Pad, Shape } from "./types";

const outline = (w: number, h: number): Shape => ({
  kind: "line",
  points: [
    { x: -w / 2, y: -h / 2 },
    { x: w / 2, y: -h / 2 },
    { x: w / 2, y: h / 2 },
    { x: -w / 2, y: h / 2 },
    { x: -w / 2, y: -h / 2 },
  ],
});

const pin1Dot = (x: number, y: number): Shape => ({ kind: "circle", x, y, r: 0.2, fill: true });

/** Two-terminal SMD chip package (resistors, capacitors, inductors). */
export function chip(code: "0402" | "0603" | "0805" | "1206"): Footprint {
  const dims = {
    "0402": { pitch: 1.0, pw: 0.6, ph: 0.6, bw: 1.0, bh: 0.5 },
    "0603": { pitch: 1.6, pw: 0.9, ph: 0.95, bw: 1.6, bh: 0.8 },
    "0805": { pitch: 1.9, pw: 1.0, ph: 1.3, bw: 2.0, bh: 1.25 },
    "1206": { pitch: 3.0, pw: 1.15, ph: 1.8, bw: 3.2, bh: 1.6 },
  }[code];
  return {
    name: `${code}`,
    pads: [
      { id: "1", x: -dims.pitch / 2, y: 0, w: dims.pw, h: dims.ph, shape: "rect" },
      { id: "2", x: dims.pitch / 2, y: 0, w: dims.pw, h: dims.ph, shape: "rect" },
    ],
    courtyard: { w: dims.pitch + dims.pw + 0.5, h: dims.ph + 0.5 },
    silk: [
      { kind: "line", points: [{ x: -dims.bw / 4, y: -dims.bh / 2 - 0.15 }, { x: dims.bw / 4, y: -dims.bh / 2 - 0.15 }] },
      { kind: "line", points: [{ x: -dims.bw / 4, y: dims.bh / 2 + 0.15 }, { x: dims.bw / 4, y: dims.bh / 2 + 0.15 }] },
    ],
  };
}

export function sod123(): Footprint {
  return {
    name: "SOD-123",
    pads: [
      { id: "1", x: -1.65, y: 0, w: 0.9, h: 1.2, shape: "rect" },
      { id: "2", x: 1.65, y: 0, w: 0.9, h: 1.2, shape: "rect" },
    ],
    courtyard: { w: 4.6, h: 2.0 },
    silk: [outline(2.8, 1.6), { kind: "line", points: [{ x: -0.9, y: -0.8 }, { x: -0.9, y: 0.8 }] }],
  };
}

export function sot23(): Footprint {
  return {
    name: "SOT-23",
    pads: [
      { id: "1", x: -0.95, y: 1.0, w: 0.6, h: 0.9, shape: "rect" },
      { id: "2", x: 0.95, y: 1.0, w: 0.6, h: 0.9, shape: "rect" },
      { id: "3", x: 0, y: -1.0, w: 0.6, h: 0.9, shape: "rect" },
    ],
    courtyard: { w: 3.4, h: 3.2 },
    silk: [outline(2.9, 1.3)],
  };
}

export function sot223(): Footprint {
  return {
    name: "SOT-223",
    pads: [
      { id: "1", x: -2.3, y: 3.15, w: 1.0, h: 1.8, shape: "rect" },
      { id: "2", x: 0, y: 3.15, w: 1.0, h: 1.8, shape: "rect" },
      { id: "3", x: 2.3, y: 3.15, w: 1.0, h: 1.8, shape: "rect" },
      { id: "4", x: 0, y: -3.15, w: 3.3, h: 1.8, shape: "rect" },
    ],
    courtyard: { w: 7.4, h: 8.4 },
    silk: [outline(6.6, 3.6)],
  };
}

/** Dual-row package. `pitch` along a row, `span` between row centres. Pin 1 top-left, counter-clockwise. */
function dualRow(name: string, n: number, pitch: number, span: number, pw: number, ph: number, drill?: number): Footprint {
  const per = n / 2;
  const pads: Pad[] = [];
  const top = -((per - 1) * pitch) / 2;
  for (let i = 0; i < per; i++) {
    pads.push({ id: String(i + 1), x: -span / 2, y: top + i * pitch, w: pw, h: ph, shape: drill ? (i === 0 ? "rect" : "oval") : "rect", drill });
  }
  for (let i = 0; i < per; i++) {
    pads.push({ id: String(per + i + 1), x: span / 2, y: top + (per - 1 - i) * pitch, w: pw, h: ph, shape: drill ? "oval" : "rect", drill });
  }
  const bodyH = per * pitch + 0.4;
  const bodyW = span - pw - 0.4;
  return {
    name,
    pads,
    courtyard: { w: span + pw + 0.6, h: bodyH + 0.6 },
    silk: [outline(bodyW, bodyH), pin1Dot(-bodyW / 2 + 0.6, -bodyH / 2 + 0.6)],
  };
}

export const dip = (n: number) => dualRow(`DIP-${n}`, n, 2.54, 7.62, 1.6, 1.6, 0.8);
export const soic = (n: number) => dualRow(`SOIC-${n}`, n, 1.27, 5.4, 1.55, 0.6);

/** Quad flat package with `n` pins (n divisible by 4), pin 1 at top of the left side, counter-clockwise. */
export function qfp(n: number, pitch: number, span: number): Footprint {
  const per = n / 4;
  const pads: Pad[] = [];
  const start = -((per - 1) * pitch) / 2;
  const pl = 1.5;
  const pw = pitch * 0.55;
  for (let i = 0; i < per; i++) pads.push({ id: String(i + 1), x: -span / 2, y: start + i * pitch, w: pl, h: pw, shape: "rect" });
  for (let i = 0; i < per; i++) pads.push({ id: String(per + i + 1), x: start + i * pitch, y: span / 2, w: pw, h: pl, shape: "rect" });
  for (let i = 0; i < per; i++) pads.push({ id: String(2 * per + i + 1), x: span / 2, y: -start - i * pitch, w: pl, h: pw, shape: "rect" });
  for (let i = 0; i < per; i++) pads.push({ id: String(3 * per + i + 1), x: -start - i * pitch, y: -span / 2, w: pw, h: pl, shape: "rect" });
  const body = span - pl - 0.6;
  return {
    name: `TQFP-${n}`,
    pads,
    courtyard: { w: span + pl + 0.6, h: span + pl + 0.6 },
    silk: [outline(body, body), pin1Dot(-body / 2 + 0.7, -body / 2 + 0.7)],
  };
}

export function header(n: number): Footprint {
  const pads: Pad[] = [];
  const top = -((n - 1) * 2.54) / 2;
  for (let i = 0; i < n; i++) {
    pads.push({ id: String(i + 1), x: 0, y: top + i * 2.54, w: 1.7, h: 1.7, shape: i === 0 ? "rect" : "circle", drill: 1.0 });
  }
  return {
    name: `PinHeader_1x${n}_P2.54mm`,
    pads,
    courtyard: { w: 3.0, h: n * 2.54 + 0.5 },
    silk: [outline(2.54, n * 2.54)],
  };
}

export function radialCap(diameter: number, pitch: number): Footprint {
  return {
    name: `CP_Radial_D${diameter}mm_P${pitch}mm`,
    pads: [
      { id: "1", x: -pitch / 2, y: 0, w: 1.6, h: 1.6, shape: "rect", drill: 0.8 },
      { id: "2", x: pitch / 2, y: 0, w: 1.6, h: 1.6, shape: "circle", drill: 0.8 },
    ],
    courtyard: { w: diameter + 0.5, h: diameter + 0.5 },
    silk: [
      { kind: "circle", x: 0, y: 0, r: diameter / 2 },
      { kind: "text", x: -pitch / 2 - 1.4, y: -1.2, text: "+", size: 1 },
    ],
  };
}

export function tht2(name: string, pitch: number, bodyW: number, bodyH: number, drill = 0.8): Footprint {
  return {
    name,
    pads: [
      { id: "1", x: -pitch / 2, y: 0, w: 1.6, h: 1.6, shape: "rect", drill },
      { id: "2", x: pitch / 2, y: 0, w: 1.6, h: 1.6, shape: "circle", drill },
    ],
    courtyard: { w: Math.max(pitch + 2, bodyW) + 0.5, h: Math.max(2, bodyH) + 0.5 },
    silk: [outline(bodyW, bodyH)],
  };
}

export function tactSwitch6mm(): Footprint {
  return {
    name: "SW_PUSH_6mm",
    pads: [
      { id: "1", x: -3.25, y: -2.25, w: 2, h: 2, shape: "circle", drill: 1.1 },
      { id: "2", x: 3.25, y: -2.25, w: 2, h: 2, shape: "circle", drill: 1.1 },
      { id: "1", x: -3.25, y: 2.25, w: 2, h: 2, shape: "circle", drill: 1.1 },
      { id: "2", x: 3.25, y: 2.25, w: 2, h: 2, shape: "circle", drill: 1.1 },
    ],
    courtyard: { w: 9, h: 7.5 },
    silk: [outline(6, 6), { kind: "circle", x: 0, y: 0, r: 1.75 }],
  };
}

export function usbC(): Footprint {
  const sig = ["A4", "A5", "A6", "A7", "B5", "A1"];
  const pads: Pad[] = sig.map((id, i) => ({ id, x: -1.25 * 1 + i * 0.5 - 0.0, y: -3.6, w: 0.3, h: 1.1, shape: "rect" as const }));
  pads.push({ id: "S1", x: -4.3, y: -3.1, w: 1.0, h: 1.6, shape: "oval", drill: 0.6 });
  pads.push({ id: "S1", x: 4.3, y: -3.1, w: 1.0, h: 1.6, shape: "oval", drill: 0.6 });
  return {
    name: "USB_C_Receptacle_Simplified",
    pads,
    courtyard: { w: 10, h: 8.5 },
    silk: [outline(9, 7.4)],
  };
}

export function hc49(): Footprint {
  return tht2("Crystal_HC49-U_Vertical", 4.88, 11, 4.6, 0.8);
}
