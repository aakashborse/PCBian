import {
  addTrace,
  addVia,
  analyzeCopper,
  autoPlace,
  autoRoute,
  clearRouting,
  courtyardRect,
  deleteTrace,
  deleteVia,
  getPart,
  nextRotation,
  padRect,
  padsOf,
  pointSegmentDistance,
  ratsnest,
  runDrc,
  snap,
  tracesMap,
  updateComponent,
  type ComponentData,
  type CopperLayer,
  type Vec,
  type WorldPad,
} from "@pcbian/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "./context";
import { publishCursor, type PresenceState } from "./presence";
import { ShapeEl } from "./render";
import { beginPan, useViewport } from "./viewport";

const LAYER_COLOR: Record<CopperLayer, string> = { top: "#d9534f", bottom: "#4a7fe0" };
const PAD_COLOR: Record<CopperLayer | "tht", string> = { top: "#e0a83a", bottom: "#4f8fe6", tht: "#d9a53a" };
const SNAP = 0.05;

type Tool = "select" | "route" | "via";

interface Routing {
  layer: CopperLayer;
  width: number;
  points: Vec[];
  net?: string;
}

const inRect = (p: Vec, r: { x0: number; y0: number; x1: number; y1: number }) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;

/** Constrain the segment from `a` towards `b` to a multiple of 45 degrees. */
function snap45(a: Vec, b: Vec): Vec {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.abs(Math.cos(ang)) > 0.5 && Math.abs(Math.sin(ang)) > 0.5 ? Math.max(Math.abs(dx), Math.abs(dy)) * Math.SQRT2 : Math.hypot(dx, dy);
  return { x: a.x + Math.round(Math.cos(ang) * len * 1000) / 1000, y: a.y + Math.round(Math.sin(ang) * len * 1000) / 1000 };
}

export function PcbCanvas({ presence }: { presence: PresenceState[] }) {
  const ed = useEditor();
  const { design, conn, selection, select, nets, toast } = ed;
  const { doc, undo, provider } = conn;
  const vp = useViewport({ x: 120, y: 80, k: 12 }, 1, 200);
  const [tool, setTool] = useState<Tool>("select");
  const [layer, setLayer] = useState<CopperLayer>("top");
  const [width, setWidth] = useState(design.board.defaultTraceWidth);
  const [routing, setRouting] = useState<Routing | null>(null);
  const [cursor, setCursor] = useState<Vec>({ x: 0, y: 0 });
  const [show, setShow] = useState({ top: true, bottom: true, silk: true, rats: true, drc: true });
  const drag = useRef<{ id: string; start: Vec; orig: Vec } | null>(null);
  const fitted = useRef(false);

  const byId = useMemo(() => new Map(design.components.map((c) => [c.id, c])), [design.components]);
  const analysis = useMemo(() => analyzeCopper(design, nets), [design, nets]);
  const rats = useMemo(() => ratsnest(design, analysis), [design, analysis]);
  const drc = useMemo(() => (show.drc ? runDrc(design).filter((i) => i.severity === "error" && i.at) : []), [design, show.drc]);
  const padNet = useMemo(() => {
    const m = new Map<string, string | undefined>();
    for (const it of analysis.items) if (it.kind === "pad") m.set(`${it.pad.comp}:${it.pad.world.x}:${it.pad.world.y}`, it.net);
    return m;
  }, [analysis]);
  const netOfPad = (p: WorldPad) => padNet.get(`${p.comp}:${p.world.x}:${p.world.y}`);

  useEffect(() => {
    if (fitted.current) return;
    fitted.current = true;
    requestAnimationFrame(fitBoard);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => setWidth(design.board.defaultTraceWidth), [design.board.defaultTraceWidth]);

  function fitBoard() {
    const xs = [0, design.board.width];
    const ys = [0, design.board.height];
    for (const c of design.components) {
      const r = courtyardRect(c);
      if (r) xs.push(r.x0, r.x1), ys.push(r.y0, r.y1);
    }
    vp.fit({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }, 50);
  }

  useEffect(() => {
    if (ed.focus?.view !== "pcb") return;
    const r = vp.svgRef.current!.getBoundingClientRect();
    const k = Math.max(vp.viewRef.current.k, 20);
    vp.setView({ k, x: r.width / 2 - ed.focus.at.x * k, y: r.height / 2 - ed.focus.at.y * k });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ed.focus]);

  const finishRoute = (r: Routing | null) => {
    if (r && r.points.length >= 2) {
      undo.stopCapturing();
      addTrace(doc, { layer: r.layer, width: r.width, points: r.points });
    }
    setRouting(null);
  };

  const switchLayer = () => {
    const next: CopperLayer = layer === "top" ? "bottom" : "top";
    if (routing && routing.points.length >= 1) {
      const last = routing.points[routing.points.length - 1];
      doc.transact(() => {
        if (routing.points.length >= 2) addTrace(doc, { layer: routing.layer, width: routing.width, points: routing.points });
        addVia(doc, last);
      });
      setRouting({ ...routing, layer: next, points: [last] });
    }
    setLayer(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      const k = e.key.toLowerCase();
      if (e.metaKey || e.ctrlKey) return;
      if (e.key === "Escape") {
        if (routing) finishRoute(routing);
        else {
          setTool("select");
          select(null);
        }
      } else if (e.key === "Enter" && routing) finishRoute(routing);
      else if ((e.key === "Delete" || e.key === "Backspace") && selection) {
        if (selection.kind === "trace") deleteTrace(doc, selection.id);
        if (selection.kind === "via") deleteVia(doc, selection.id);
        select(null);
      } else if (k === "r" && selection?.kind === "component") {
        const c = byId.get(selection.id);
        if (c) updateComponent(doc, c.id, { pcb: { ...c.pcb, rot: nextRotation(c.pcb.rot) } });
      } else if (k === "f" && selection?.kind === "component") {
        const c = byId.get(selection.id);
        if (c) updateComponent(doc, c.id, { pcb: { ...c.pcb, side: c.pcb.side === "top" ? "bottom" : "top" } });
      } else if (k === "f") fitBoard();
      else if (k === "x") setTool("route");
      else if (k === "v") setTool("via");
      else if (k === "s") setTool("select");
      else if (k === "l") switchLayer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---------- picking ----------
  const padAt = (p: Vec): WorldPad | null => {
    let best: WorldPad | null = null;
    for (const c of design.components) for (const pad of padsOf(c)) if (inRect(p, padRect(pad)) && (!best || pad.layers.includes(layer))) best = pad;
    return best;
  };
  const pick = (p: Vec, tol: number): NonNullable<typeof selection> | null => {
    for (const v of design.vias) if (Math.hypot(p.x - v.x, p.y - v.y) <= v.diameter / 2 + tol) return { kind: "via", id: v.id };
    const ordered = [...design.traces].sort((a, b) => Number(b.layer === layer) - Number(a.layer === layer));
    for (const t of ordered) {
      if (!show[t.layer]) continue;
      for (let i = 1; i < t.points.length; i++) if (pointSegmentDistance(p, t.points[i - 1], t.points[i]) <= t.width / 2 + tol) return { kind: "trace", id: t.id };
    }
    const comps = [...design.components].filter((c) => getPart(c.partId)?.footprint).sort((a, b) => Number(b.pcb.side === layer) - Number(a.pcb.side === layer));
    for (const c of comps) if (inRect(p, courtyardRect(c)!)) return { kind: "component", id: c.id };
    return null;
  };

  const snapped = (p: Vec): Vec => ({ x: snap(p.x, SNAP), y: snap(p.y, SNAP) });

  const routeTarget = (raw: Vec, shift: boolean): Vec => {
    if (!routing) return snapped(raw);
    const last = routing.points[routing.points.length - 1];
    const pad = padAt(raw);
    if (pad) return pad.world;
    return shift ? snapped(raw) : snap45(last, snapped(raw));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 1) return beginPan(e, vp.viewRef, vp.setView);
    if (e.button !== 0) return;
    const raw = vp.toWorld(e.clientX, e.clientY);
    const tol = 4 / vp.viewRef.current.k;

    if (tool === "via") {
      undo.stopCapturing();
      addVia(doc, snapped(raw));
      return;
    }
    if (tool === "route") {
      const pad = padAt(raw);
      if (!routing) {
        if (!pad) return toast("Start a trace on a pad");
        const l = pad.layers.includes(layer) ? layer : pad.layers[0];
        if (l !== layer) setLayer(l);
        setRouting({ layer: l, width, points: [pad.world], net: netOfPad(pad) });
        return;
      }
      const p = routeTarget(raw, e.shiftKey);
      const pts = [...routing.points, p];
      if (pad && pad.layers.includes(routing.layer)) return finishRoute({ ...routing, points: pts });
      if (e.detail >= 2) return finishRoute(routing);
      setRouting({ ...routing, points: pts });
      return;
    }
    const hit = pick(raw, tol);
    select(hit);
    if (hit?.kind === "component") {
      const c = byId.get(hit.id)!;
      undo.stopCapturing();
      drag.current = { id: c.id, start: raw, orig: { x: c.pcb.x, y: c.pcb.y } };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } else if (!hit) {
      beginPan(e, vp.viewRef, vp.setView);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const w = vp.toWorld(e.clientX, e.clientY);
    setCursor(routing ? routeTarget(w, e.shiftKey) : snapped(w));
    publishCursor(provider, { view: "pcb", x: w.x, y: w.y });
    const d = drag.current;
    if (d) {
      const c = byId.get(d.id);
      const p = e.altKey ? { x: d.orig.x + w.x - d.start.x, y: d.orig.y + w.y - d.start.y } : snapped({ x: d.orig.x + w.x - d.start.x, y: d.orig.y + w.y - d.start.y });
      if (c && (p.x !== c.pcb.x || p.y !== c.pcb.y)) updateComponent(doc, d.id, { pcb: { ...c.pcb, x: p.x, y: p.y } });
    }
  };

  const doAutoPlace = () => {
    undo.stopCapturing();
    const { placements, fits } = autoPlace(design);
    doc.transact(() => {
      for (const [id, pcb] of placements) updateComponent(doc, id, { pcb });
    });
    toast(fits ? "Placed all footprints on the board" : "Not everything fits; enlarge the board in the inspector");
  };

  const doAutoRoute = () => {
    undo.stopCapturing();
    const t0 = performance.now();
    const r = autoRoute(design, { width });
    doc.transact(() => {
      for (const t of r.traces) addTrace(doc, t);
      for (const v of r.vias) addVia(doc, v);
    });
    toast(`Routed ${r.routed} connection${r.routed === 1 ? "" : "s"} with ${r.vias.length} via${r.vias.length === 1 ? "" : "s"} in ${Math.round(performance.now() - t0)}ms${r.failed.length ? ` · ${r.failed.length} failed` : ""}`);
  };

  const { view } = vp;
  const px = 1 / view.k; // one screen pixel in mm
  const selTraceNet = useMemo(() => {
    if (selection?.kind !== "trace") return null;
    return analysis.clusterOf.get(`trace:${selection.id}`) ?? null;
  }, [selection, analysis]);

  const layerOrder: CopperLayer[] = layer === "top" ? ["bottom", "top"] : ["top", "bottom"];
  const placed = design.components.filter((c) => getPart(c.partId)?.footprint);

  return (
    <>
      <svg
        ref={vp.svgRef}
        className="canvas-svg"
        style={{ cursor: tool === "select" ? "default" : "crosshair" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
        onPointerLeave={() => publishCursor(provider, null)}
        onDoubleClick={() => routing && finishRoute(routing)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (routing) finishRoute(routing);
          else setTool("select");
        }}
      >
        <defs>
          <pattern id="pcb-grid" width={view.k} height={view.k} patternUnits="userSpaceOnUse" x={view.x} y={view.y}>
            <circle cx={0.5} cy={0.5} r={view.k > 6 ? 0.7 : 0} fill="#2a313c" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#pcb-grid)" />
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          <rect x={0} y={0} width={design.board.width} height={design.board.height} fill="#0d3326" stroke="#e8d36b" strokeWidth={Math.max(0.1, px * 1.5)} rx={0.5} />

          {layerOrder.map((l) => {
            if (!show[l]) return null;
            const dim = l !== layer ? 0.45 : 0.92;
            return (
              <g key={l} opacity={dim}>
                {design.traces
                  .filter((t) => t.layer === l)
                  .map((t) => {
                    const sel = selection?.kind === "trace" && selection.id === t.id;
                    const sameNet = selTraceNet && analysis.clusterOf.get(`trace:${t.id}`) === selTraceNet;
                    return (
                      <polyline
                        key={t.id}
                        points={t.points.map((p) => `${p.x},${p.y}`).join(" ")}
                        stroke={sel ? "#ffffff" : sameNet ? "#ff9a8f" : LAYER_COLOR[l]}
                        strokeWidth={t.width}
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    );
                  })}
                {placed.flatMap((c) =>
                  padsOf(c)
                    .filter((p) => (p.drill ? l === layer : p.layers[0] === l))
                    .map((p, i) => <PadEl key={`${c.id}-${i}`} pad={p} color={p.drill ? PAD_COLOR.tht : PAD_COLOR[l]} />),
                )}
              </g>
            );
          })}

          {design.vias.map((v) => {
            const sel = selection?.kind === "via" && selection.id === v.id;
            return (
              <g key={v.id}>
                <circle cx={v.x} cy={v.y} r={v.diameter / 2} fill={sel ? "#ffffff" : "#c9b458"} />
                <circle cx={v.x} cy={v.y} r={v.drill / 2} fill="#0b0d10" />
              </g>
            );
          })}

          {placed.map((c) => (
            <FootprintOverlay key={c.id} c={c} showSilk={show.silk} selected={selection?.kind === "component" && selection.id === c.id} remote={presence.find((p) => p.sel === c.id)?.user.color} px={px} />
          ))}

          {show.rats &&
            rats.map((r, i) => <line key={i} x1={r.a.x} y1={r.a.y} x2={r.b.x} y2={r.b.y} stroke="#e5e7eb" strokeOpacity={0.75} strokeWidth={px} pointerEvents="none" />)}

          {drc.map((i, n) => (
            <g key={n} pointerEvents="none">
              <circle cx={i.at!.x} cy={i.at!.y} r={px * 9} fill="none" stroke="#ff3b3b" strokeWidth={px * 2} />
              <line x1={i.at!.x - px * 5} y1={i.at!.y - px * 5} x2={i.at!.x + px * 5} y2={i.at!.y + px * 5} stroke="#ff3b3b" strokeWidth={px * 2} />
            </g>
          ))}

          {routing && (
            <polyline
              points={[...routing.points, cursor].map((p) => `${p.x},${p.y}`).join(" ")}
              stroke={LAYER_COLOR[routing.layer]}
              strokeOpacity={0.8}
              strokeWidth={routing.width}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              pointerEvents="none"
            />
          )}

          {presence.map((p) =>
            p.cursor?.view === "pcb" ? (
              <g key={p.clientId} transform={`translate(${p.cursor.x},${p.cursor.y}) scale(${px})`} pointerEvents="none">
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
        <button className={tool === "select" ? "active" : ""} onClick={() => setTool("select")} title="Select / move (S)">
          Select
        </button>
        <button className={tool === "route" ? "active" : ""} onClick={() => setTool("route")} title="Route trace (X)">
          Route
        </button>
        <button className={tool === "via" ? "active" : ""} onClick={() => setTool("via")} title="Place via (V)">
          Via
        </button>
        <span className="sep" />
        <button onClick={switchLayer} title="Switch active layer (L); while routing this drops a via" style={{ color: LAYER_COLOR[layer] }}>
          {layer === "top" ? "Top" : "Bottom"} layer
        </button>
        <select value={width} onChange={(e) => setWidth(Number(e.target.value))} title="Trace width (mm)">
          {[0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.8, 1.0].map((w) => (
            <option key={w} value={w}>
              {w} mm
            </option>
          ))}
        </select>
        <span className="sep" />
        <button onClick={doAutoPlace} title="Pack all footprints onto the board">
          Auto-place
        </button>
        <button className="primary" onClick={doAutoRoute} title="Route all unrouted connections">
          Auto-route
        </button>
        <button
          onClick={() => {
            if (tracesMap(doc).size === 0 || confirm("Delete all traces and vias?")) {
              undo.stopCapturing();
              clearRouting(doc);
            }
          }}
        >
          Unroute
        </button>
        <span className="sep" />
        <button onClick={fitBoard} title="Zoom to fit (F)">
          Fit
        </button>
      </div>

      <div className="layers">
        <b className="small">Layers</b>
        {(
          [
            ["top", "Top copper", LAYER_COLOR.top],
            ["bottom", "Bottom copper", LAYER_COLOR.bottom],
            ["silk", "Silkscreen", "#f3f4f6"],
            ["rats", "Ratsnest", "#9ca3af"],
            ["drc", "DRC markers", "#ff3b3b"],
          ] as const
        ).map(([k, label, color]) => (
          <label key={k}>
            <input type="checkbox" checked={show[k]} onChange={(e) => setShow({ ...show, [k]: e.target.checked })} />
            <span className="swatch" style={{ background: color }} />
            {label}
          </label>
        ))}
        <span className="muted small" style={{ marginTop: 4 }}>
          {rats.length} unrouted
        </span>
      </div>

      <div className="hint">
        {tool === "route"
          ? routing
            ? "Click to add corners (45°, Shift = free) · click a pad to finish · L = via + switch layer · Enter / double-click / Esc to end"
            : "Click a pad to start a trace"
          : tool === "via"
            ? "Click to place a via · Esc to stop"
            : "Drag parts to move · R rotate · F flip side · X route · L switch layer · Del delete trace/via"}
      </div>
      <div className="coords">
        {cursor.x.toFixed(2)}, {cursor.y.toFixed(2)} mm
      </div>
    </>
  );
}

function PadEl({ pad, color }: { pad: WorldPad; color: string }) {
  const { world: c, ww, wh } = pad;
  return (
    <g>
      {pad.shape === "circle" ? (
        <circle cx={c.x} cy={c.y} r={Math.min(ww, wh) / 2} fill={color} />
      ) : (
        <rect x={c.x - ww / 2} y={c.y - wh / 2} width={ww} height={wh} rx={pad.shape === "oval" ? Math.min(ww, wh) / 2 : Math.min(ww, wh) * 0.12} fill={color} />
      )}
      {pad.drill && <circle cx={c.x} cy={c.y} r={pad.drill / 2} fill="#0b0d10" />}
    </g>
  );
}

function FootprintOverlay({ c, showSilk, selected, remote, px }: { c: ComponentData; showSilk: boolean; selected: boolean; remote?: string; px: number }) {
  const part = getPart(c.partId)!;
  const fp = part.footprint!;
  const r = courtyardRect(c)!;
  const silk = c.pcb.side === "top" ? "#f3f4f6" : "#c4b5fd";
  const mirror = c.pcb.side === "bottom" ? " scale(-1,1)" : "";
  const fontSize = Math.min(1.2, Math.max(0.5, Math.min(r.x1 - r.x0, r.y1 - r.y0) * 0.35));
  return (
    <g>
      {showSilk && (
        <g transform={`translate(${c.pcb.x},${c.pcb.y}) rotate(${c.pcb.rot})${mirror}`} opacity={c.pcb.side === "top" ? 0.9 : 0.6} pointerEvents="none">
          {fp.silk.map((s, i) => (
            <ShapeEl key={i} s={s} stroke={silk} width={0.15} />
          ))}
        </g>
      )}
      {showSilk && (
        <text x={c.pcb.x} y={c.pcb.y + fontSize * 0.35} fontSize={fontSize} fill={silk} textAnchor="middle" fontWeight={600} pointerEvents="none" style={{ paintOrder: "stroke" }} stroke="#0d3326" strokeWidth={fontSize * 0.15}>
          {c.ref}
        </text>
      )}
      {(selected || remote) && (
        <rect x={r.x0} y={r.y0} width={r.x1 - r.x0} height={r.y1 - r.y0} fill={selected ? "rgba(96,165,250,0.12)" : "none"} stroke={selected ? "#60a5fa" : remote} strokeWidth={px * 1.5} strokeDasharray={`${px * 4} ${px * 3}`} pointerEvents="none" />
      )}
    </g>
  );
}
