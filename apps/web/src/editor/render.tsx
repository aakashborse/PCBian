import type { PartDef, Shape, SymbolPin } from "@pcbian/core";

export function ShapeEl({ s, stroke, width, fill = "none" }: { s: Shape; stroke: string; width: number; fill?: string }) {
  switch (s.kind) {
    case "rect":
      return <rect x={s.x} y={s.y} width={s.w} height={s.h} stroke={stroke} strokeWidth={width} fill={s.fill ? stroke : fill} />;
    case "line":
      return <polyline points={s.points.map((p) => `${p.x},${p.y}`).join(" ")} stroke={stroke} strokeWidth={width} fill="none" strokeLinejoin="round" strokeLinecap="round" />;
    case "polygon":
      return <polygon points={s.points.map((p) => `${p.x},${p.y}`).join(" ")} stroke={stroke} strokeWidth={width} fill={s.fill ? stroke : fill} strokeLinejoin="round" />;
    case "circle":
      return <circle cx={s.x} cy={s.y} r={s.r} stroke={stroke} strokeWidth={width} fill={s.fill ? stroke : "none"} />;
    case "text":
      return (
        <text x={s.x} y={s.y} fontSize={s.size ?? 8} fill={stroke} textAnchor={s.anchor ?? "start"} style={{ pointerEvents: "none" }}>
          {s.text}
        </text>
      );
  }
}

const DIR: Record<SymbolPin["side"], [number, number]> = { left: [1, 0], right: [-1, 0], top: [0, 1], bottom: [0, -1] };

export function PinEl({ pin, color, rot }: { pin: SymbolPin; color: string; rot: number }) {
  const [dx, dy] = DIR[pin.side];
  const ex = pin.x + dx * pin.length;
  const ey = pin.y + dy * pin.length;
  const horizontal = pin.side === "left" || pin.side === "right";
  // Keep text readable when the symbol is upside down.
  const flip = rot === 180;
  const t = (x: number, y: number) => (flip ? `rotate(180 ${x} ${y})` : undefined);
  const nameX = ex + dx * 4;
  const anchorName = (dx > 0) !== flip ? "start" : "end";
  return (
    <g>
      {pin.length > 0 && <line x1={pin.x} y1={pin.y} x2={ex} y2={ey} stroke={color} strokeWidth={1.2} />}
      {pin.showName && horizontal && (
        <text x={nameX} y={ey + 3} fontSize={7.5} fill="#1f2937" textAnchor={anchorName} transform={t(nameX, ey)}>
          {pin.name}
        </text>
      )}
      {pin.showNumber && horizontal && (
        <text x={(pin.x + ex) / 2} y={pin.y - 2} fontSize={6} fill="#6b7280" textAnchor="middle" transform={t((pin.x + ex) / 2, pin.y - 4)}>
          {pin.id}
        </text>
      )}
    </g>
  );
}

/** Schematic symbol drawn at the origin in local coordinates. */
export function SymbolBody({ part, color, rot = 0 }: { part: PartDef; color: string; rot?: number }) {
  return (
    <>
      {part.symbol.shapes.map((s, i) => (
        <ShapeEl key={i} s={s} stroke={color} width={1.4} fill={part.kind === "part" && s.kind === "rect" ? "#fff8e7" : "none"} />
      ))}
      {part.symbol.pins.map((p) => (
        <PinEl key={p.id} pin={p} color={color} rot={rot} />
      ))}
    </>
  );
}

/** Small thumbnail of a part's symbol for the library list. */
export function SymbolThumb({ part, size = 36 }: { part: PartDef; size?: number }) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of part.symbol.pins) {
    xs.push(p.x);
    ys.push(p.y);
  }
  for (const s of part.symbol.shapes) {
    if (s.kind === "rect") xs.push(s.x, s.x + s.w), ys.push(s.y, s.y + s.h);
    if (s.kind === "line" || s.kind === "polygon") s.points.forEach((p) => (xs.push(p.x), ys.push(p.y)));
    if (s.kind === "circle") xs.push(s.x - s.r, s.x + s.r), ys.push(s.y - s.r, s.y + s.r);
  }
  const x0 = Math.min(...xs) - 4;
  const y0 = Math.min(...ys) - 4;
  const w = Math.max(...xs) + 4 - x0;
  const h = Math.max(...ys) + 4 - y0;
  const m = Math.max(w, h);
  return (
    <svg width={size} height={size} viewBox={`${x0 + w / 2 - m / 2} ${y0 + h / 2 - m / 2} ${m} ${m}`}>
      {part.symbol.shapes.map((s, i) => (
        <ShapeEl key={i} s={s} stroke="#7a1f1f" width={Math.max(1.4, m / 40)} />
      ))}
      {part.symbol.pins.map((p) => {
        const [dx, dy] = DIR[p.side];
        return <line key={p.id} x1={p.x} y1={p.y} x2={p.x + dx * p.length} y2={p.y + dy * p.length} stroke="#7a1f1f" strokeWidth={Math.max(1.4, m / 40)} />;
      })}
    </svg>
  );
}
