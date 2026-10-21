import { moveShape, nextPinSide, nextPinSpot, pickSymbolItem, shapeBounds, symbolBounds, type PinType, type Shape, type SymbolPin, type Vec } from "@pcbian/core";
import { useEffect, useRef, useState } from "react";
import { PinEl, ShapeEl } from "./render";

export interface Drawing {
  shapes: Shape[];
  pins: SymbolPin[];
}

/** A pin from the part's pin table (number, name and type come from there). */
export interface PinInfo {
  number: string;
  name: string;
  type: PinType;
}

type Tool = "select" | "line" | "polygon" | "rect" | "circle" | "text" | "pin";
type Sel = { kind: "shape" | "pin"; index: number } | null;

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: "select", label: "Select", hint: "Click to select, drag to move · R rotates a pin · Del deletes" },
  { id: "line", label: "Line", hint: "Click to add corners · double-click or Enter to finish" },
  { id: "polygon", label: "Polygon", hint: "Click to add corners · double-click or Enter to close" },
  { id: "rect", label: "Rectangle", hint: "Drag from corner to corner" },
  { id: "circle", label: "Circle", hint: "Drag from the centre out" },
  { id: "text", label: "Text", hint: "Click where the text goes" },
  { id: "pin", label: "Pin", hint: "Click to place the chosen pin (its tip is the connection point) · R rotates" },
];

const COLOR = "#7a1f1f";
const SEL = "#2563eb";
const snap = (v: number, g: number) => Math.round(v / g) * g;
const snapV = (p: Vec, g: number): Vec => ({ x: snap(p.x, g), y: snap(p.y, g) });

/**
 * Free-hand symbol editor: draw body graphics and place the part's pins on a grid. Graphics snap
 * to 5 units, pin tips to the 10-unit connection grid.
 */
export function SymbolDraw({ drawing, onChange, pinTable }: { drawing: Drawing; onChange: (d: Drawing) => void; pinTable: PinInfo[] }) {
  const svg = useRef<SVGSVGElement>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [sel, setSel] = useState<Sel>(null);
  const [draft, setDraft] = useState<Vec[] | null>(null);
  const [drag, setDrag] = useState<{ start: Vec; orig: Drawing; moved: boolean } | null>(null);
  const [cursor, setCursor] = useState<Vec>({ x: 0, y: 0 });
  const [fill, setFill] = useState(false);
  const [pinSide, setPinSide] = useState<SymbolPin["side"]>("left");
  const [pinLength, setPinLength] = useState(20);
  const placed = new Set(drawing.pins.map((p) => p.id));
  const unplaced = pinTable.filter((p) => !placed.has(p.number));
  const [nextPin, setNextPin] = useState<string>("");
  const pinToPlace = unplaced.find((p) => p.number === nextPin) ?? unplaced[0];
  const history = useRef<Drawing[]>([]);
  const [view, setView] = useState(() => {
    const b = symbolBounds(drawing) ?? { x0: -40, y0: -40, x1: 40, y1: 40 };
    const w = Math.max(160, b.x1 - b.x0 + 80);
    const h = Math.max(120, b.y1 - b.y0 + 80);
    return { x: (b.x0 + b.x1) / 2 - w / 2, y: (b.y0 + b.y1) / 2 - h / 2, w, h };
  });

  const commit = (d: Drawing) => {
    history.current.push(drawing);
    if (history.current.length > 100) history.current.shift();
    onChange(d);
  };
  const undoLast = () => {
    const prev = history.current.pop();
    if (prev) {
      onChange(prev);
      setSel(null);
    }
  };

  const toWorld = (e: { clientX: number; clientY: number }): Vec => {
    const m = svg.current!.getScreenCTM()!.inverse();
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m);
    return { x: p.x, y: p.y };
  };
  const tol = view.w / 120;

  const finishDraft = (pts = draft) => {
    const clean = (pts ?? []).filter((p, i, a) => i === 0 || p.x !== a[i - 1].x || p.y !== a[i - 1].y);
    if (tool === "line" && clean.length >= 2) commit({ ...drawing, shapes: [...drawing.shapes, { kind: "line", points: clean }] });
    if (tool === "polygon" && clean.length >= 3) commit({ ...drawing, shapes: [...drawing.shapes, { kind: "polygon", points: clean, fill }] });
    setDraft(null);
  };

  const rotatePin = (i: number) => {
    const p = drawing.pins[i];
    // Turn about the body end, so the pin swings round the point where it joins the body.
    const inward = { left: [1, 0], right: [-1, 0], top: [0, 1], bottom: [0, -1] } as const;
    const side = nextPinSide(p.side);
    const body = { x: p.x + inward[p.side][0] * p.length, y: p.y + inward[p.side][1] * p.length };
    const tip = snapV({ x: body.x - inward[side][0] * p.length, y: body.y - inward[side][1] * p.length }, 10);
    commit({ ...drawing, pins: drawing.pins.map((q, j) => (j === i ? { ...q, side, x: tip.x, y: tip.y } : q)) });
  };

  const deleteSel = () => {
    if (!sel) return;
    if (sel.kind === "shape") commit({ ...drawing, shapes: drawing.shapes.filter((_, j) => j !== sel.index) });
    else commit({ ...drawing, pins: drawing.pins.filter((_, j) => j !== sel.index) });
    setSel(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      const k = e.key.toLowerCase();
      if (["escape", "enter", "delete", "backspace", "r"].includes(k) || (k === "z" && (e.metaKey || e.ctrlKey))) e.stopPropagation();
      if (k === "escape") {
        setDraft(null);
        setTool("select");
      } else if (k === "enter" && draft) finishDraft();
      else if ((k === "delete" || k === "backspace") && sel) {
        e.preventDefault();
        deleteSel();
      } else if (k === "r" && !e.metaKey && !e.ctrlKey) {
        if (tool === "pin") setPinSide(nextPinSide(pinSide));
        else if (sel?.kind === "pin") rotatePin(sel.index);
      } else if (k === "z" && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        undoLast();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const w = toWorld(e);
    const g5 = snapV(w, 5);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    switch (tool) {
      case "select": {
        const hit = pickSymbolItem(drawing, w, tol);
        setSel(hit);
        if (hit) setDrag({ start: w, orig: drawing, moved: false });
        return;
      }
      case "line":
      case "polygon":
        if (e.detail >= 2 && draft) return finishDraft();
        setDraft([...(draft ?? [g5]), g5].slice(draft ? 0 : 1));
        return;
      case "rect":
      case "circle":
        setDraft([g5, g5]);
        return;
      case "text": {
        const text = prompt("Text");
        if (text?.trim()) commit({ ...drawing, shapes: [...drawing.shapes, { kind: "text", x: g5.x, y: g5.y, text: text.trim(), size: 8 }] });
        return;
      }
      case "pin": {
        if (!pinToPlace) return;
        const tip = snapV(w, 10);
        const pin: SymbolPin = { id: pinToPlace.number, name: pinToPlace.name, type: pinToPlace.type, x: tip.x, y: tip.y, side: pinSide, length: pinLength, showName: true, showNumber: true };
        commit({ ...drawing, pins: [...drawing.pins, pin] });
        setNextPin("");
        if (unplaced.length <= 1) setTool("select");
        return;
      }
    }
  };

  const onMove = (e: React.PointerEvent) => {
    const w = toWorld(e);
    setCursor(w);
    if (drag && sel) {
      const g = sel.kind === "pin" ? 10 : 5;
      const d = { x: snap(w.x - drag.start.x, g), y: snap(w.y - drag.start.y, g) };
      if (!d.x && !d.y && !drag.moved) return;
      const o = drag.orig;
      const next =
        sel.kind === "shape"
          ? { ...o, shapes: o.shapes.map((s, j) => (j === sel.index ? moveShape(s, d) : s)) }
          : { ...o, pins: o.pins.map((p, j) => (j === sel.index ? { ...p, x: p.x + d.x, y: p.y + d.y } : p)) };
      if (!drag.moved) history.current.push(o);
      setDrag({ ...drag, moved: true });
      onChange(next);
    } else if (draft && (tool === "rect" || tool === "circle") && e.buttons & 1) {
      setDraft([draft[0], snapV(w, 5)]);
    }
  };

  const onUp = () => {
    setDrag(null);
    if (draft && (tool === "rect" || tool === "circle")) {
      const [a, b] = draft;
      if (tool === "rect" && a.x !== b.x && a.y !== b.y) commit({ ...drawing, shapes: [...drawing.shapes, { kind: "rect", x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y), fill }] });
      const r = Math.hypot(b.x - a.x, b.y - a.y);
      if (tool === "circle" && r > 0) commit({ ...drawing, shapes: [...drawing.shapes, { kind: "circle", x: a.x, y: a.y, r: Math.round(r * 10) / 10, fill }] });
      setDraft(null);
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const w = toWorld(e);
    const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    setView((v) => {
      const nw = Math.min(2000, Math.max(40, v.w * k));
      const s = nw / v.w;
      return { x: w.x - (w.x - v.x) * s, y: w.y - (w.y - v.y) * s, w: nw, h: v.h * s };
    });
  };
  const fit = () => {
    const b = symbolBounds(drawing);
    if (!b) return;
    const w = Math.max(80, b.x1 - b.x0 + 60);
    const h = Math.max(60, b.y1 - b.y0 + 60);
    const ratio = view.h / view.w;
    const W = Math.max(w, h / ratio);
    setView({ x: (b.x0 + b.x1) / 2 - W / 2, y: (b.y0 + b.y1) / 2 - (W * ratio) / 2, w: W, h: W * ratio });
  };

  const selShape = sel?.kind === "shape" ? drawing.shapes[sel.index] : undefined;
  const selPin = sel?.kind === "pin" ? drawing.pins[sel.index] : undefined;
  const setShape = (s: Shape) => sel && commit({ ...drawing, shapes: drawing.shapes.map((x, j) => (j === sel.index ? s : x)) });
  const setPin = (p: SymbolPin) => sel && commit({ ...drawing, pins: drawing.pins.map((x, j) => (j === sel.index ? p : x)) });
  const c5 = snapV(cursor, 5);
  const preview: Shape | null = !draft
    ? null
    : tool === "line"
      ? { kind: "line", points: [...draft, c5] }
      : tool === "polygon"
        ? { kind: "polygon", points: [...draft, c5], fill }
        : tool === "rect"
          ? { kind: "rect", x: Math.min(draft[0].x, draft[1].x), y: Math.min(draft[0].y, draft[1].y), w: Math.abs(draft[1].x - draft[0].x), h: Math.abs(draft[1].y - draft[0].y), fill }
          : tool === "circle"
            ? { kind: "circle", x: draft[0].x, y: draft[0].y, r: Math.hypot(draft[1].x - draft[0].x, draft[1].y - draft[0].y), fill }
            : null;
  const ghostPin: SymbolPin | null = tool === "pin" && pinToPlace ? { id: pinToPlace.number, name: pinToPlace.name, x: snap(cursor.x, 10), y: snap(cursor.y, 10), side: pinSide, length: pinLength, showName: true, showNumber: true } : null;
  const selBox = selShape ? shapeBounds(selShape) : null;

  return (
    <div className="sym-draw">
      <div className="row sym-tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={`small${tool === t.id ? " on" : ""}`}
            disabled={t.id === "pin" && !unplaced.length}
            onClick={() => {
              setTool(t.id);
              setDraft(null);
            }}
            title={t.hint}
          >
            {t.label}
          </button>
        ))}
        <span className="spacer" />
        <button className="small" onClick={undoLast} disabled={!history.current.length} title="Undo (Ctrl+Z)">
          Undo
        </button>
        <button className="small" onClick={fit}>
          Fit
        </button>
      </div>
      <div className="row sym-opts small">
        {(tool === "rect" || tool === "circle" || tool === "polygon") && (
          <label className="row" style={{ gap: 4 }}>
            <input type="checkbox" checked={fill} onChange={(e) => setFill(e.target.checked)} /> filled
          </label>
        )}
        {tool === "pin" && pinToPlace && (
          <>
            <select value={pinToPlace.number} onChange={(e) => setNextPin(e.target.value)}>
              {unplaced.map((p) => (
                <option key={p.number} value={p.number}>
                  {p.number} {p.name}
                </option>
              ))}
            </select>
            <select value={pinSide} onChange={(e) => setPinSide(e.target.value as SymbolPin["side"])} title="Side of the body the pin sticks out of (R)">
              <option value="left">left</option>
              <option value="right">right</option>
              <option value="top">top</option>
              <option value="bottom">bottom</option>
            </select>
            <select value={pinLength} onChange={(e) => setPinLength(Number(e.target.value))}>
              {[10, 20, 30].map((n) => (
                <option key={n} value={n}>
                  length {n}
                </option>
              ))}
            </select>
            <button
              className="small"
              title="Place every unplaced pin on its side of the body"
              onClick={() => {
                let d = drawing;
                for (const p of unplaced) {
                  const at = nextPinSpot(d, pinSide, pinLength);
                  d = { ...d, pins: [...d.pins, { id: p.number, name: p.name, type: p.type, ...at, side: pinSide, length: pinLength, showName: true, showNumber: true }] };
                }
                commit(d);
                setTool("select");
              }}
            >
              Place all {unplaced.length}
            </button>
          </>
        )}
        {tool === "select" && selShape && (
          <>
            <b>{selShape.kind}</b>
            {(selShape.kind === "rect" || selShape.kind === "circle" || selShape.kind === "polygon") && (
              <label className="row" style={{ gap: 4 }}>
                <input type="checkbox" checked={Boolean(selShape.fill)} onChange={(e) => setShape({ ...selShape, fill: e.target.checked })} /> filled
              </label>
            )}
            {selShape.kind === "text" && (
              <>
                <input key={`${sel!.index}:${selShape.text}`} defaultValue={selShape.text} onBlur={(e) => e.target.value.trim() && e.target.value !== selShape.text && setShape({ ...selShape, text: e.target.value })} style={{ width: 120 }} />
                <select value={selShape.size ?? 8} onChange={(e) => setShape({ ...selShape, size: Number(e.target.value) })}>
                  {[6, 8, 10, 12, 16].map((n) => (
                    <option key={n} value={n}>
                      size {n}
                    </option>
                  ))}
                </select>
                <select value={selShape.anchor ?? "start"} onChange={(e) => setShape({ ...selShape, anchor: e.target.value as "start" | "middle" | "end" })}>
                  <option value="start">left</option>
                  <option value="middle">centre</option>
                  <option value="end">right</option>
                </select>
              </>
            )}
          </>
        )}
        {tool === "select" && selPin && (
          <>
            <b>
              pin {selPin.id} {selPin.name}
            </b>
            <button className="small" onClick={() => rotatePin(sel!.index)} title="R">
              Rotate
            </button>
            <select value={selPin.length} onChange={(e) => setPin({ ...selPin, length: Number(e.target.value) })}>
              {[10, 20, 30].map((n) => (
                <option key={n} value={n}>
                  length {n}
                </option>
              ))}
            </select>
            <label className="row" style={{ gap: 4 }}>
              <input type="checkbox" checked={selPin.showName !== false} onChange={(e) => setPin({ ...selPin, showName: e.target.checked })} /> name
            </label>
            <label className="row" style={{ gap: 4 }}>
              <input type="checkbox" checked={selPin.showNumber !== false} onChange={(e) => setPin({ ...selPin, showNumber: e.target.checked })} /> number
            </label>
          </>
        )}
        {(selShape || selPin) && tool === "select" && (
          <button className="small danger" onClick={deleteSel}>
            Delete
          </button>
        )}
        {unplaced.length > 0 && tool !== "pin" && <span className="muted">{unplaced.length} pin(s) not placed yet: use the Pin tool</span>}
      </div>
      <svg
        ref={svg}
        className="pe-preview sym-canvas"
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ background: "var(--sch-bg)", cursor: tool === "select" ? "default" : "crosshair" }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onWheel={onWheel}
      >
        <defs>
          <pattern id="symgrid" width={10} height={10} patternUnits="userSpaceOnUse">
            <circle cx={0} cy={0} r={0.6} fill="#c9c2b2" />
          </pattern>
        </defs>
        <rect x={view.x - view.w} y={view.y - view.h} width={view.w * 3} height={view.h * 3} fill="url(#symgrid)" />
        <path d={`M -4 0 H 4 M 0 -4 V 4`} stroke="#c9c2b2" strokeWidth={0.6} />
        {drawing.shapes.map((s, i) => (
          <ShapeEl key={i} s={s} stroke={sel?.kind === "shape" && sel.index === i ? SEL : COLOR} width={1.4} fill={s.kind === "rect" ? "#fff8e7" : "none"} />
        ))}
        {drawing.pins.map((p, i) => (
          <g key={`${p.id}:${i}`}>
            <PinEl pin={p} color={sel?.kind === "pin" && sel.index === i ? SEL : COLOR} rot={0} />
            <circle cx={p.x} cy={p.y} r={1.5} fill="none" stroke={sel?.kind === "pin" && sel.index === i ? SEL : "#9ca3af"} strokeWidth={0.6} />
          </g>
        ))}
        {selBox && <rect x={selBox.x0 - 2} y={selBox.y0 - 2} width={selBox.x1 - selBox.x0 + 4} height={selBox.y1 - selBox.y0 + 4} fill="none" stroke={SEL} strokeDasharray="3 2" strokeWidth={0.6} />}
        {preview && <ShapeEl s={preview} stroke={SEL} width={1} />}
        {ghostPin && (
          <g opacity={0.6}>
            <PinEl pin={ghostPin} color={SEL} rot={0} />
          </g>
        )}
      </svg>
      <div className="muted small">
        {TOOLS.find((t) => t.id === tool)!.hint} · scroll to zoom · {snap(cursor.x, 5)}, {snap(cursor.y, 5)}
      </div>
    </div>
  );
}
