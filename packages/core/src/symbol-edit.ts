// Geometry for drawing schematic symbols by hand: bounds, hit testing and moving of shapes and
// pins, and finishing a drawing into a symbol (pins on the 10-unit connection grid, reference and
// value text placed clear of the body).
import { pointSegmentDistance } from "./geometry";
import type { PartSymbol, Shape, SymbolPin, Vec } from "./types";

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Unit vector from a pin's tip toward the body. */
export const PIN_INWARD: Record<SymbolPin["side"], Vec> = { left: { x: 1, y: 0 }, right: { x: -1, y: 0 }, top: { x: 0, y: 1 }, bottom: { x: 0, y: -1 } };

/** Where a pin meets the body (its tip is the connection point). */
export const pinBodyEnd = (p: SymbolPin): Vec => ({ x: p.x + PIN_INWARD[p.side].x * p.length, y: p.y + PIN_INWARD[p.side].y * p.length });

const textWidth = (s: Extract<Shape, { kind: "text" }>) => s.text.length * (s.size ?? 8) * 0.6;

export function shapeBounds(s: Shape): Bounds {
  switch (s.kind) {
    case "rect":
      return { x0: Math.min(s.x, s.x + s.w), y0: Math.min(s.y, s.y + s.h), x1: Math.max(s.x, s.x + s.w), y1: Math.max(s.y, s.y + s.h) };
    case "circle":
      return { x0: s.x - s.r, y0: s.y - s.r, x1: s.x + s.r, y1: s.y + s.r };
    case "line":
    case "polygon":
      return { x0: Math.min(...s.points.map((p) => p.x)), y0: Math.min(...s.points.map((p) => p.y)), x1: Math.max(...s.points.map((p) => p.x)), y1: Math.max(...s.points.map((p) => p.y)) };
    case "text": {
      const w = textWidth(s);
      const x0 = s.anchor === "middle" ? s.x - w / 2 : s.anchor === "end" ? s.x - w : s.x;
      return { x0, y0: s.y - (s.size ?? 8), x1: x0 + w, y1: s.y + 2 };
    }
  }
}

const pinBounds = (p: SymbolPin): Bounds => {
  const e = pinBodyEnd(p);
  return { x0: Math.min(p.x, e.x), y0: Math.min(p.y, e.y), x1: Math.max(p.x, e.x), y1: Math.max(p.y, e.y) };
};

/** Bounds of a whole drawing (pins included); null when it is empty. */
export function symbolBounds(sym: { shapes: Shape[]; pins: SymbolPin[] }): Bounds | null {
  const all = [...sym.shapes.map(shapeBounds), ...sym.pins.map(pinBounds)];
  if (!all.length) return null;
  return { x0: Math.min(...all.map((b) => b.x0)), y0: Math.min(...all.map((b) => b.y0)), x1: Math.max(...all.map((b) => b.x1)), y1: Math.max(...all.map((b) => b.y1)) };
}

const nearPolyline = (pts: Vec[], p: Vec, tol: number) => pts.some((q, i) => i > 0 && pointSegmentDistance(p, pts[i - 1], q) <= tol);

function insidePolygon(pts: Vec[], p: Vec): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Whether a point picks a shape: near its outline, or anywhere inside when it is filled (or text). */
export function hitShape(s: Shape, p: Vec, tol = 3): boolean {
  switch (s.kind) {
    case "line":
      return nearPolyline(s.points, p, tol);
    case "polygon":
      return nearPolyline([...s.points, s.points[0]], p, tol) || (Boolean(s.fill) && insidePolygon(s.points, p));
    case "rect": {
      const b = shapeBounds(s);
      const corners = [
        { x: b.x0, y: b.y0 },
        { x: b.x1, y: b.y0 },
        { x: b.x1, y: b.y1 },
        { x: b.x0, y: b.y1 },
      ];
      return nearPolyline([...corners, corners[0]], p, tol) || (Boolean(s.fill) && p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1);
    }
    case "circle": {
      const d = Math.hypot(p.x - s.x, p.y - s.y);
      return Math.abs(d - s.r) <= tol || (Boolean(s.fill) && d <= s.r);
    }
    case "text": {
      const b = shapeBounds(s);
      return p.x >= b.x0 - tol && p.x <= b.x1 + tol && p.y >= b.y0 - tol && p.y <= b.y1 + tol;
    }
  }
}

/** Whether a point picks a pin (anywhere along it). */
export const hitPin = (pin: SymbolPin, p: Vec, tol = 3) => pointSegmentDistance(p, pin, pinBodyEnd(pin)) <= tol;

/** Topmost item under a point: pins first (they sit on top), then shapes from the last drawn. */
export function pickSymbolItem(sym: { shapes: Shape[]; pins: SymbolPin[] }, p: Vec, tol = 3): { kind: "pin"; index: number } | { kind: "shape"; index: number } | null {
  for (let i = sym.pins.length - 1; i >= 0; i--) if (hitPin(sym.pins[i], p, tol)) return { kind: "pin", index: i };
  for (let i = sym.shapes.length - 1; i >= 0; i--) if (hitShape(sym.shapes[i], p, tol)) return { kind: "shape", index: i };
  return null;
}

export function moveShape(s: Shape, d: Vec): Shape {
  switch (s.kind) {
    case "line":
    case "polygon":
      return { ...s, points: s.points.map((q) => ({ x: q.x + d.x, y: q.y + d.y })) };
    default:
      return { ...s, x: s.x + d.x, y: s.y + d.y };
  }
}

/** The next side clockwise (left -> top -> right -> bottom). */
export const nextPinSide = (s: SymbolPin["side"]): SymbolPin["side"] => ({ left: "top", top: "right", right: "bottom", bottom: "left" })[s] as SymbolPin["side"];

const grid = (v: number, g: number) => Math.round(v / g) * g;

/**
 * Turn a drawing into a symbol: pin tips snapped to the 10-unit connection grid (so wires meet
 * them), rectangles normalised to positive size, and the reference and value placed above and
 * below everything.
 */
export function finishSymbol(drawing: { shapes: Shape[]; pins: SymbolPin[]; units?: PartSymbol["units"] }): PartSymbol {
  const shapes = drawing.shapes.map((s) => {
    if (s.kind !== "rect") return s;
    const b = shapeBounds(s);
    return { ...s, x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 };
  });
  const pins = drawing.pins.map((p) => ({ ...p, x: grid(p.x, 10), y: grid(p.y, 10) }));
  const b = symbolBounds({ shapes, pins }) ?? { x0: -10, y0: -10, x1: 10, y1: 10 };
  const x = b.x0;
  return { shapes, pins, refPos: { x, y: b.y0 - 6 }, valuePos: { x, y: b.y1 + 12 }, ...(drawing.units ? { units: drawing.units } : {}) };
}

/**
 * Default spot for a pin added to a drawing: on the given side of the body, one grid step past
 * the pins already there.
 */
export function nextPinSpot(sym: { shapes: Shape[]; pins: SymbolPin[] }, side: SymbolPin["side"], length = 20): Vec {
  const body = symbolBounds({ shapes: sym.shapes, pins: [] }) ?? { x0: -20, y0: -20, x1: 20, y1: 20 };
  const same = sym.pins.filter((p) => p.side === side);
  const along = (p: Vec) => (side === "left" || side === "right" ? p.y : p.x);
  const start = side === "left" || side === "right" ? grid(body.y0, 10) + 10 : grid(body.x0, 10) + 10;
  const pos = same.length ? Math.max(...same.map(along)) + 10 : start;
  if (side === "left") return { x: grid(body.x0, 10) - length, y: pos };
  if (side === "right") return { x: grid(body.x1, 10) + length, y: pos };
  if (side === "top") return { x: pos, y: grid(body.y0, 10) - length };
  return { x: pos, y: grid(body.y1, 10) + length };
}
