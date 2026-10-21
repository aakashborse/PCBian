import { describe, expect, it } from "vitest";
import { finishSymbol, hitShape, moveShape, nextPinSide, nextPinSpot, pickSymbolItem, pinBodyEnd, symbolBounds, type Shape, type SymbolPin } from "../src";

const pin = (id: string, x: number, y: number, side: SymbolPin["side"]): SymbolPin => ({ id, name: id, x, y, side, length: 20 });

describe("symbol drawing", () => {
  const body: Shape = { kind: "polygon", points: [{ x: -10, y: -15 }, { x: 15, y: 0 }, { x: -10, y: 15 }] };
  const drawing = { shapes: [body, { kind: "circle", x: 18, y: 0, r: 3 } as Shape], pins: [pin("1", -30, -10, "left"), pin("2", 41, 1, "right")] };

  it("picks pins before shapes and outlines unless filled", () => {
    expect(pickSymbolItem(drawing, { x: -25, y: -10 })).toEqual({ kind: "pin", index: 0 });
    expect(pickSymbolItem(drawing, { x: 2, y: -7 })).toEqual({ kind: "shape", index: 0 });
    // Inside an unfilled triangle picks nothing; once filled it picks the triangle.
    expect(pickSymbolItem(drawing, { x: -2, y: 0 })).toBeNull();
    expect(hitShape({ ...body, fill: true } as Shape, { x: -2, y: 0 })).toBe(true);
    expect(hitShape({ kind: "circle", x: 0, y: 0, r: 5 }, { x: 5.5, y: 0 }, 1)).toBe(true);
    expect(hitShape({ kind: "rect", x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5 }, 1)).toBe(false);
  });

  it("moves shapes and finishes pins onto the connection grid", () => {
    expect(moveShape(body, { x: 5, y: 5 })).toMatchObject({ points: [{ x: -5, y: -10 }, { x: 20, y: 5 }, { x: -5, y: 20 }] });
    const sym = finishSymbol({ shapes: [{ kind: "rect", x: 10, y: 10, w: -20, h: -20 }], pins: drawing.pins });
    expect(sym.shapes[0]).toMatchObject({ x: -10, y: -10, w: 20, h: 20 });
    expect(sym.pins.map((p) => [p.x, p.y])).toEqual([
      [-30, -10],
      [40, 0],
    ]);
    // Reference above everything, value below.
    const b = symbolBounds(sym)!;
    expect(sym.refPos.y).toBeLessThan(b.y0);
    expect(sym.valuePos.y).toBeGreaterThan(b.y1);
  });

  it("rotates and places pins round the body", () => {
    expect(["left", "top", "right", "bottom"].map((s) => nextPinSide(s as SymbolPin["side"]))).toEqual(["top", "right", "bottom", "left"]);
    expect(pinBodyEnd(pin("1", 0, 50, "bottom"))).toEqual({ x: 0, y: 30 });
    const box = { shapes: [{ kind: "rect", x: -20, y: -20, w: 40, h: 40 } as Shape], pins: [] as SymbolPin[] };
    const a = nextPinSpot(box, "left");
    expect(a).toEqual({ x: -40, y: -10 });
    expect(nextPinSpot({ ...box, pins: [pin("1", a.x, a.y, "left")] }, "left")).toEqual({ x: -40, y: 0 });
    expect(nextPinSpot(box, "top")).toEqual({ x: -10, y: -40 });
  });
});
