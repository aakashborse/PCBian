import {
  addComponent,
  addWire,
  deleteComponent,
  deleteWire,
  getPart,
  netByTerminal,
  nextRotation,
  rotate,
  schematicPin,
  schematicPins,
  snap,
  termKey,
  updateComponent,
  type ComponentData,
  type Rotation,
  type Terminal,
  type Vec,
  type Wire,
} from "@pcbian/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "./context";
import { publishCursor, type PresenceState } from "./presence";
import { SymbolBody } from "./render";
import { beginPan, useViewport } from "./viewport";

const GRID = 10;
const COLORS = { body: "#7a1f1f", wire: "#0b7a3e", wireHi: "#16a34a", sel: "#2563eb", text: "#1f2937", power: "#b91c1c" };

interface Wiring {
  from: Terminal;
  points: Vec[];
}

/** Orthogonal route between two points: horizontal first, then vertical. */
const elbow = (a: Vec, b: Vec): Vec[] => (a.x === b.x || a.y === b.y ? [] : [{ x: b.x, y: a.y }]);

export function wirePath(byId: Map<string, ComponentData>, w: Wire): Vec[] | null {
  const ca = byId.get(w.a.comp);
  const cb = byId.get(w.b.comp);
  if (!ca || !cb) return null;
  const a = schematicPin(ca, w.a.pin);
  const b = schematicPin(cb, w.b.pin);
  if (!a || !b) return null;
  const pts = [a, ...w.points, b];
  const out: Vec[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) out.push(...elbow(pts[i - 1], pts[i]), pts[i]);
  return out;
}

function symbolBounds(c: ComponentData) {
  const part = getPart(c.partId)!;
  const xs: number[] = [];
  const ys: number[] = [];
  const add = (p: Vec) => {
    const r = rotate(p, c.sch.rot);
    xs.push(r.x);
    ys.push(r.y);
  };
  part.symbol.pins.forEach(add);
  for (const s of part.symbol.shapes) {
    if (s.kind === "rect") [{ x: s.x, y: s.y }, { x: s.x + s.w, y: s.y + s.h }].forEach(add);
    if (s.kind === "line" || s.kind === "polygon") s.points.forEach(add);
    if (s.kind === "circle") [{ x: s.x - s.r, y: s.y - s.r }, { x: s.x + s.r, y: s.y + s.r }].forEach(add);
  }
  if (part.kind === "netlabel") add({ x: 12 + c.value.length * 6, y: 0 });
  return { x0: Math.min(...xs) - 3, y0: Math.min(...ys) - 3, x1: Math.max(...xs) + 3, y1: Math.max(...ys) + 3 };
}

export function SchematicCanvas({ presence }: { presence: PresenceState[] }) {
  const ed = useEditor();
  const { design, conn, selection, select, placing, setPlacing, nets } = ed;
  const { doc, undo, provider } = conn;
  const vp = useViewport({ x: 300, y: 250, k: 1.6 }, 0.2, 8);
  const [cursor, setCursor] = useState<Vec>({ x: 0, y: 0 });
  const [wiring, setWiring] = useState<Wiring | null>(null);
  const drag = useRef<{ id: string; start: Vec; orig: Vec; moved: boolean } | null>(null);
  const fitted = useRef(false);

  const byId = useMemo(() => new Map(design.components.map((c) => [c.id, c])), [design.components]);
  const netOf = useMemo(() => netByTerminal(nets), [nets]);
  const wireCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const w of design.wires) for (const t of [w.a, w.b]) m.set(termKey(t), (m.get(termKey(t)) ?? 0) + 1);
    return m;
  }, [design.wires]);

  // Net highlighted by the current selection (a wire, or nothing).
  const hiNet = useMemo(() => {
    if (selection?.kind !== "wire") return null;
    const w = design.wires.find((x) => x.id === selection.id);
    return w ? netOf.get(termKey(w.a)) ?? null : null;
  }, [selection, design.wires, netOf]);

  // Fit the existing drawing once when the editor opens.
  useEffect(() => {
    if (fitted.current) return;
    fitted.current = true;
    requestAnimationFrame(fitAll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function fitAll() {
    if (!design.components.length) return vp.setView({ x: 300, y: 250, k: 1.6 });
    const bs = design.components.map((c) => {
      const b = symbolBounds(c);
      return { x0: b.x0 + c.sch.x, y0: b.y0 + c.sch.y, x1: b.x1 + c.sch.x, y1: b.y1 + c.sch.y };
    });
    const x0 = Math.min(...bs.map((b) => b.x0));
    const y0 = Math.min(...bs.map((b) => b.y0));
    const x1 = Math.max(...bs.map((b) => b.x1));
    const y1 = Math.max(...bs.map((b) => b.y1));
    // Never zoom in further than 3x, so small drawings keep room around them.
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const r = vp.svgRef.current!.getBoundingClientRect();
    const hw = Math.max((x1 - x0) / 2, (r.width - 120) / 6);
    const hh = Math.max((y1 - y0) / 2, (r.height - 120) / 6);
    vp.fit({ x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh }, 60);
  }

  useEffect(() => {
    if (ed.focus?.view !== "schematic") return;
    const r = vp.svgRef.current!.getBoundingClientRect();
    const k = Math.max(vp.viewRef.current.k, 2);
    vp.setView({ k, x: r.width / 2 - ed.focus.at.x * k, y: r.height / 2 - ed.focus.at.y * k });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ed.focus]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      if (e.key === "Escape") {
        setWiring(null);
        setPlacing(null);
        select(null);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selection) {
        if (selection.kind === "component") deleteComponent(doc, selection.id);
        if (selection.kind === "wire") deleteWire(doc, selection.id);
        select(null);
      } else if (e.key.toLowerCase() === "r" && !e.metaKey && !e.ctrlKey && selection?.kind === "component") {
        const c = byId.get(selection.id);
        if (c) updateComponent(doc, c.id, { sch: { ...c.sch, rot: nextRotation(c.sch.rot) } });
      } else if (e.key.toLowerCase() === "d" && (e.metaKey || e.ctrlKey) && selection?.kind === "component") {
        e.preventDefault();
        const c = byId.get(selection.id);
        if (c) select({ kind: "component", id: addComponent(doc, c.partId, { x: c.sch.x + 40, y: c.sch.y + 40 }, { value: c.value, rot: c.sch.rot }).id });
      } else if (e.key.toLowerCase() === "f" && !e.metaKey && !e.ctrlKey) {
        fitAll();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const toGrid = (p: Vec): Vec => ({ x: snap(p.x, GRID), y: snap(p.y, GRID) });

  const onPointerMove = (e: React.PointerEvent) => {
    const w = vp.toWorld(e.clientX, e.clientY);
    setCursor(w);
    publishCursor(provider, { view: "schematic", x: w.x, y: w.y });
    const d = drag.current;
    if (d) {
      const p = toGrid({ x: d.orig.x + w.x - d.start.x, y: d.orig.y + w.y - d.start.y });
      const c = byId.get(d.id);
      if (c && (p.x !== c.sch.x || p.y !== c.sch.y)) {
        d.moved = true;
        updateComponent(doc, d.id, { sch: { ...c.sch, x: p.x, y: p.y } });
      }
    }
  };

  const onBackgroundDown = (e: React.PointerEvent) => {
    if (e.button === 1 || (e.button === 0 && !placing && !wiring)) {
      if (e.button === 0) select(null);
      return beginPan(e, vp.viewRef, vp.setView);
    }
    if (e.button !== 0) return;
    const p = toGrid(vp.toWorld(e.clientX, e.clientY));
    if (placing) {
      const c = addComponent(doc, placing, p);
      select({ kind: "component", id: c.id });
      if (!e.shiftKey) setPlacing(null);
    } else if (wiring) {
      const last = wiring.points.length ? wiring.points[wiring.points.length - 1] : pinPos(wiring.from);
      setWiring({ ...wiring, points: [...wiring.points, ...elbow(last, p), p] });
    }
  };

  const pinPos = (t: Terminal) => schematicPin(byId.get(t.comp)!, t.pin)!;

  const onPinDown = (e: React.PointerEvent, t: Terminal) => {
    if (e.button !== 0 || placing) return;
    e.stopPropagation();
    if (!wiring) {
      setWiring({ from: t, points: [] });
      return;
    }
    if (wiring.from.comp !== t.comp || wiring.from.pin !== t.pin) {
      undo.stopCapturing();
      const w = addWire(doc, wiring.from, t, simplify([pinPos(wiring.from), ...wiring.points, pinPos(t)]).slice(1, -1));
      if (w) select({ kind: "wire", id: w.id });
    }
    setWiring(null);
  };

  const onComponentDown = (e: React.PointerEvent, c: ComponentData) => {
    if (e.button !== 0 || placing || wiring) return;
    e.stopPropagation();
    select({ kind: "component", id: c.id });
    undo.stopCapturing();
    drag.current = { id: c.id, start: vp.toWorld(e.clientX, e.clientY), orig: { x: c.sch.x, y: c.sch.y }, moved: false };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const { view } = vp;
  const ghostPart = placing ? getPart(placing) : null;
  const gp = toGrid(cursor);
  const remoteSel = new Map(presence.filter((p) => p.sel).map((p) => [p.sel!, p.user.color]));

  return (
    <>
      <svg
        ref={vp.svgRef}
        className="canvas-svg"
        style={{ background: "var(--sch-bg)", cursor: placing || wiring ? "crosshair" : "default" }}
        onPointerDown={onBackgroundDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
        onPointerLeave={() => publishCursor(provider, null)}
        onContextMenu={(e) => {
          e.preventDefault();
          setWiring(null);
          setPlacing(null);
        }}
      >
        <defs>
          <pattern id="sch-grid" width={GRID * view.k} height={GRID * view.k} patternUnits="userSpaceOnUse" x={view.x} y={view.y}>
            <circle cx={0.5} cy={0.5} r={view.k > 0.8 ? 0.9 : 0} fill="#cfc9b8" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#sch-grid)" />
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {design.wires.map((w) => {
            const pts = wirePath(byId, w);
            if (!pts) return null;
            const sel = selection?.kind === "wire" && selection.id === w.id;
            const hi = hiNet !== null && netOf.get(termKey(w.a)) === hiNet;
            const pstr = pts.map((p) => `${p.x},${p.y}`).join(" ");
            return (
              <g
                key={w.id}
                onPointerDown={(e) => {
                  if (e.button !== 0 || placing || wiring) return;
                  e.stopPropagation();
                  select({ kind: "wire", id: w.id });
                }}
                style={{ cursor: "pointer" }}
              >
                <polyline points={pstr} stroke="transparent" strokeWidth={8} fill="none" />
                <polyline points={pstr} stroke={sel ? COLORS.sel : hi ? COLORS.wireHi : COLORS.wire} strokeWidth={sel || hi ? 2.2 : 1.4} fill="none" strokeLinejoin="round" />
              </g>
            );
          })}

          {design.components.map((c) => {
            const part = getPart(c.partId);
            if (!part) return null;
            const sel = selection?.kind === "component" && selection.id === c.id;
            const b = symbolBounds(c);
            const color = part.kind === "part" ? COLORS.body : COLORS.power;
            const refP = rotate(part.symbol.refPos, c.sch.rot);
            const valP = rotate(part.symbol.valuePos, c.sch.rot);
            const vertical = c.sch.rot === 90 || c.sch.rot === 270;
            const remote = remoteSel.get(c.id);
            return (
              <g key={c.id} transform={`translate(${c.sch.x},${c.sch.y})`} onPointerDown={(e) => onComponentDown(e, c)} style={{ cursor: "move" }}>
                <rect x={b.x0} y={b.y0} width={b.x1 - b.x0} height={b.y1 - b.y0} fill={sel ? "rgba(37,99,235,0.08)" : "transparent"} stroke={sel ? COLORS.sel : remote ?? "none"} strokeDasharray={remote && !sel ? "4 3" : undefined} strokeWidth={1} rx={3} />
                <g transform={`rotate(${c.sch.rot})`}>
                  <SymbolBody part={part} color={color} rot={c.sch.rot} />
                </g>
                {part.kind === "part" && (
                  <>
                    <text x={vertical ? b.x1 + 3 : refP.x} y={vertical ? -3 : refP.y} fontSize={9} fontWeight={600} fill={COLORS.text} textAnchor={vertical ? "start" : part.symbol.pins.length > 3 ? "start" : "middle"}>
                      {c.ref}
                    </text>
                    <text x={vertical ? b.x1 + 3 : valP.x} y={vertical ? 9 : valP.y} fontSize={8} fill="#4b5563" textAnchor={vertical ? "start" : part.symbol.pins.length > 3 ? "start" : "middle"}>
                      {c.value}
                    </text>
                  </>
                )}
                {part.kind !== "part" && (
                  <text x={valP.x} y={valP.y} fontSize={8.5} fontWeight={600} fill={COLORS.power} textAnchor={part.kind === "netlabel" ? "start" : "middle"}>
                    {c.value}
                  </text>
                )}
                {schematicPins({ ...c, sch: { x: 0, y: 0, rot: c.sch.rot as Rotation } }).map((p) => {
                  const t = { comp: c.id, pin: p.id };
                  const n = wireCount.get(termKey(t)) ?? 0;
                  const active = wiring && wiring.from.comp === c.id && wiring.from.pin === p.id;
                  return (
                    <g key={p.id} onPointerDown={(e) => onPinDown(e, t)} style={{ cursor: "crosshair" }}>
                      <circle cx={p.world.x} cy={p.world.y} r={4} fill="transparent" />
                      {n >= 2 && <circle cx={p.world.x} cy={p.world.y} r={2.2} fill={COLORS.wire} />}
                      {part.kind === "part" && n === 0 && <rect x={p.world.x - 1.5} y={p.world.y - 1.5} width={3} height={3} fill="none" stroke="#9ca3af" strokeWidth={0.6} />}
                      {active && <circle cx={p.world.x} cy={p.world.y} r={3.5} fill="none" stroke={COLORS.sel} strokeWidth={1.2} />}
                    </g>
                  );
                })}
              </g>
            );
          })}

          {wiring && (
            <polyline
              points={[pinPos(wiring.from), ...wiring.points, ...elbow(wiring.points.at(-1) ?? pinPos(wiring.from), gp), gp].map((p) => `${p.x},${p.y}`).join(" ")}
              stroke={COLORS.sel}
              strokeWidth={1.4}
              strokeDasharray="4 3"
              fill="none"
              pointerEvents="none"
            />
          )}

          {ghostPart && (
            <g transform={`translate(${gp.x},${gp.y})`} opacity={0.55} pointerEvents="none">
              <SymbolBody part={ghostPart} color={COLORS.sel} />
            </g>
          )}

          {presence.map((p) =>
            p.cursor?.view === "schematic" ? (
              <g key={p.clientId} transform={`translate(${p.cursor.x},${p.cursor.y}) scale(${1 / view.k})`} pointerEvents="none">
                <path d="M0 0 L0 16 L4.5 12 L8 19 L10.5 18 L7 11 L13 11 Z" fill={p.user.color} stroke="white" strokeWidth={1} />
                <rect x={12} y={16} rx={4} height={18} width={p.user.name.length * 7 + 12} fill={p.user.color} />
                <text x={18} y={29} fontSize={11.5} fill="#0b0d10" fontWeight={600}>
                  {p.user.name}
                </text>
              </g>
            ) : null,
          )}
        </g>
      </svg>
      <div className="toolbar">
        <button className={!wiring && !placing ? "active" : ""} onClick={() => (setWiring(null), setPlacing(null))} title="Select / move (Esc)">
          Select
        </button>
        <button onClick={() => setPlacing("power_gnd")} className={placing === "power_gnd" ? "active" : ""} title="Place ground symbol">
          GND
        </button>
        <button onClick={() => setPlacing("power_rail")} className={placing === "power_rail" ? "active" : ""} title="Place power rail symbol">
          Power
        </button>
        <button onClick={() => setPlacing("net_label")} className={placing === "net_label" ? "active" : ""} title="Place net label">
          Label
        </button>
        <span className="sep" />
        <button disabled={selection?.kind !== "component"} onClick={() => {
          const c = selection && byId.get(selection.id);
          if (c) updateComponent(doc, c.id, { sch: { ...c.sch, rot: nextRotation(c.sch.rot) } });
        }} title="Rotate (R)">
          Rotate
        </button>
        <button disabled={!selection} onClick={() => {
          if (selection?.kind === "component") deleteComponent(doc, selection.id);
          if (selection?.kind === "wire") deleteWire(doc, selection.id);
          select(null);
        }} title="Delete (Del)">
          Delete
        </button>
        <span className="sep" />
        <button onClick={fitAll} title="Zoom to fit (F)">
          Fit
        </button>
      </div>
      <div className="hint">
        {placing
          ? "Click to place · Shift+click to keep placing · Esc to stop"
          : wiring
            ? "Click empty space to add a corner · click a pin to finish · Esc / right-click to cancel"
            : "Click a pin to start a wire · drag parts to move · R rotate · Del delete · scroll to zoom · drag background to pan"}
      </div>
      <div className="coords">
        {gp.x}, {gp.y}
      </div>
    </>
  );
}

/** Drop redundant collinear points so stored wires stay compact. */
function simplify(pts: Vec[]): Vec[] {
  const out: Vec[] = [];
  for (const p of pts) {
    const n = out.length;
    if (n && out[n - 1].x === p.x && out[n - 1].y === p.y) continue;
    if (n >= 2 && ((out[n - 2].x === out[n - 1].x && out[n - 1].x === p.x) || (out[n - 2].y === out[n - 1].y && out[n - 1].y === p.y))) {
      out[n - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}
