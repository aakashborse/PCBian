import {
  addTrace,
  addComment,
  shoveTrace,
  getDesign,
  shoveVia,
  viasMap,
  type ShoveResult,
  type Design,
  layerLabel,
  viaKind,
  viaLayers,
  addVia,
  addZone,
  boardOutlineZone,
  copperLayers,
  deleteZone,
  netRules,
  pointInPolygon,
  zoneFill,
  boardOutline,
  boardTeardrops,
  addKeepout,
  deleteKeepout,
  addPcbGraphic,
  deletePcbGraphic,
  setBoard,
  setBoardOutline,
  analyzeCopper,
  autoPlace,
  autoRoute,
  clearRouting,
  courtyardRect,
  deleteTrace,
  deleteVia,
  getPart,
  normAngle,
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
import { askCopilotAbout, CommentPins } from "./Review";
import { useUser } from "../lib/user";
import { beginPan, dedupe, useViewport } from "./viewport";

// Outer layers keep the familiar red/blue; inner layers take distinct hues in order.
const INNER_COLORS = ["#d98b2b", "#2fb39a", "#b46fd8", "#c9b02e", "#e06c9f", "#5fae4a", "#4cb7d6", "#d6764c"];
export const layerColor = (l: CopperLayer) => (l === "top" ? "#d9534f" : l === "bottom" ? "#4a7fe0" : INNER_COLORS[(Number(l.slice(2)) - 1) % INNER_COLORS.length]);
const padColor = (l: CopperLayer) => (l === "top" ? "#e0a83a" : l === "bottom" ? "#4f8fe6" : layerColor(l));
const THT_COLOR = "#d9a53a";
const SNAP = 0.05;

type Tool = "select" | "route" | "via" | "zone" | "keepout" | "outline" | "cutout" | "measure" | "comment";
const POLY_TOOLS: Tool[] = ["zone", "keepout", "outline", "cutout"];

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
  const { design, conn, selection, select, nets, toast, projectId } = ed;
  const user = useUser();
  const { doc, undo, provider } = conn;
  const vp = useViewport({ x: 120, y: 80, k: 12 }, 1, 200);
  const [tool, setTool] = useState<Tool>("select");
  const [layer, setLayer] = useState<CopperLayer>("top");
  const [width, setWidth] = useState(design.board.defaultTraceWidth);
  const [routing, setRouting] = useState<Routing | null>(null);
  const [cursor, setCursor] = useState<Vec>({ x: 0, y: 0 });
  const [show, setShow] = useState({ zones: true, silk: true, rats: true, drc: true });
  const [hidden, setHidden] = useState<CopperLayer[]>([]);
  const [viaMode, setViaMode] = useState<"through" | "span">("through");
  const [shove, setShove] = useState(false);
  const [viaSpan, setViaSpan] = useState<[CopperLayer, CopperLayer]>(["top", "in1"]);
  const visible = (l: CopperLayer) => !hidden.includes(l);
  const [zoneDraft, setZoneDraft] = useState<Vec[] | null>(null);
  const [measure, setMeasure] = useState<Vec | null>(null);
  const layers = copperLayers(design.board);
  const namedNets = useMemo(() => nets.filter((n) => n.terminals.length > 1).map((n) => n.name), [nets]);
  const [zoneNet, setZoneNet] = useState<string>("GND");
  useEffect(() => {
    if (!layers.includes(layer)) setLayer("top");
  }, [layers, layer]);
  const drag = useRef<{ kind: "component" | "via"; id: string; start: Vec; orig: Vec; moved?: boolean; before?: Design } | null>(null);
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

  /** Apply what a shove moved: traces bent aside, vias moved (their traces already follow). */
  const applyShove = (r: ShoveResult) => {
    for (const c of r.changes) {
      const old = tracesMap(doc).get(c.id);
      if (old) tracesMap(doc).set(c.id, { ...old, points: c.points });
    }
    for (const m of r.viaMoves) {
      const old = viasMap(doc).get(m.id);
      if (old) viasMap(doc).set(m.id, { ...old, x: m.x, y: m.y });
    }
  };

  /** Add a routed trace, shoving other nets' traces and vias aside first when shove mode is on. */
  const commitTrace = (t: { layer: CopperLayer; width: number; points: Vec[] }, net: string | undefined) => {
    if (shove) {
      const r = shoveTrace(design, t, net);
      if (r.ok) applyShove(r);
      else toast(`Could not shove: ${r.reason}. The trace was added; DRC will flag the clash.`);
    }
    addTrace(doc, t);
  };

  /** Add a via, shoving other nets' copper aside first when shove mode is on. */
  const commitVia = (at: Vec, diameter: number, drill: number, span: { from?: CopperLayer; to?: CopperLayer } | undefined, net: string | undefined) => {
    if (shove) {
      const r = shoveVia(getDesign(doc), { x: at.x, y: at.y, diameter, drill, ...span }, net);
      if (r.ok) applyShove(r);
      else toast(`Could not shove: ${r.reason}. The via was added; DRC will flag the clash.`);
    }
    addVia(doc, at, diameter, drill, span);
  };

  const finishRoute = (r: Routing | null) => {
    if (r && r.points.length >= 2) {
      undo.stopCapturing();
      doc.transact(() => commitTrace({ layer: r.layer, width: r.width, points: r.points }, r.net));
    }
    setRouting(null);
  };

  // A tool switch abandons any half-drawn polygon or measurement.
  useEffect(() => {
    setZoneDraft(null);
    setMeasure(null);
  }, [tool]);

  const finishZone = (pts: Vec[] | null) => {
    if (pts && pts.length >= 3) {
      undo.stopCapturing();
      if (tool === "zone") {
        addZone(doc, { net: zoneNet, layer, points: pts });
        toast(`Copper pour for ${zoneNet} added on ${layerLabel(layer)}`);
      } else if (tool === "keepout") {
        addKeepout(doc, { points: pts, layers: [...layers], noTracks: true, noVias: true, noPours: true });
        toast("Keepout added on all layers (edit it in the inspector)");
      } else if (tool === "outline") {
        setBoardOutline(doc, pts);
        toast("Board outline replaced; the board was re-origined to the outline's corner");
      } else if (tool === "cutout") {
        setBoard(doc, { cutouts: [...(design.board.cutouts ?? []), pts] });
        toast("Cutout added");
      }
    }
    setZoneDraft(null);
  };

  const pourBoard = () => {
    if (!zoneNet) return toast("Choose a net for the pour");
    undo.stopCapturing();
    addZone(doc, { net: zoneNet, layer, points: boardOutlineZone(design.board) });
    toast(`${zoneNet} pour added on ${layerLabel(layer)}`);
  };

  const switchLayer = (to?: CopperLayer) => {
    const next: CopperLayer = to ?? layers[(layers.indexOf(layer) + 1) % layers.length];
    if (next === layer) return;
    if (routing && routing.points.length >= 1) {
      const last = routing.points[routing.points.length - 1];
      const rules = netRules(design, routing.net);
      // In blind/buried mode the via only spans the two layers being joined.
      const span = viaMode === "span" ? { from: routing.layer, to: next } : undefined;
      doc.transact(() => {
        if (routing.points.length >= 2) commitTrace({ layer: routing.layer, width: routing.width, points: routing.points }, routing.net);
        // Without a net the via could not tell its own trace from others', so it is not shoved.
        if (routing.net) commitVia(last, rules.viaDiameter, rules.viaDrill, span, routing.net);
        else addVia(doc, last, rules.viaDiameter, rules.viaDrill, span);
      });
      setRouting({ ...routing, layer: next, points: [last] });
    }
    setLayer(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Shortcuts belong to the canvas, not to a dialog open over it.
      if ((e.target as HTMLElement).closest("input, textarea, select") || document.querySelector(".modal-backdrop")) return;
      const k = e.key.toLowerCase();
      if (e.metaKey || e.ctrlKey) return;
      if (e.key === "Escape") {
        if (measure) setMeasure(null);
        else if (zoneDraft) finishZone(zoneDraft);
        else if (routing) finishRoute(routing);
        else {
          setTool("select");
          select(null);
        }
      } else if (e.key === "Enter" && zoneDraft) finishZone(zoneDraft);
      else if (e.key === "Enter" && routing) finishRoute(routing);
      else if ((e.key === "Delete" || e.key === "Backspace") && selection) {
        if (selection.kind === "trace") deleteTrace(doc, selection.id);
        if (selection.kind === "via") deleteVia(doc, selection.id);
        if (selection.kind === "zone") deleteZone(doc, selection.id);
        if (selection.kind === "keepout") deleteKeepout(doc, selection.id);
        if (selection.kind === "dimension") deletePcbGraphic(doc, selection.id);
        select(null);
      } else if (k === "r" && selection?.kind === "component") {
        const c = byId.get(selection.id);
        if (c) updateComponent(doc, c.id, { pcb: { ...c.pcb, rot: normAngle(c.pcb.rot + (e.shiftKey ? 45 : 90)) } });
      } else if (k === "f" && selection?.kind === "component") {
        const c = byId.get(selection.id);
        if (c) updateComponent(doc, c.id, { pcb: { ...c.pcb, side: c.pcb.side === "top" ? "bottom" : "top" } });
      } else if (k === "f") fitBoard();
      else if (k === "x") setTool("route");
      else if (k === "v") setTool("via");
      else if (k === "s") setTool("select");
      else if (k === "p") setTool("zone");
      else if (k === "k") setTool("keepout");
      else if (k === "m") setTool("measure");
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
      if (!visible(t.layer)) continue;
      for (let i = 1; i < t.points.length; i++) if (pointSegmentDistance(p, t.points[i - 1], t.points[i]) <= t.width / 2 + tol) return { kind: "trace", id: t.id };
    }
    const comps = [...design.components].filter((c) => getPart(c.partId)?.footprint).sort((a, b) => Number(b.pcb.side === layer) - Number(a.pcb.side === layer));
    for (const c of comps) if (inRect(p, courtyardRect(c)!)) return { kind: "component", id: c.id };
    for (const g of design.pcbGraphics) if (g.kind === "dimension" && g.points.length >= 2 && pointSegmentDistance(p, g.points[0], g.points[1]) <= tol * 2) return { kind: "dimension", id: g.id };
    for (const k of design.keepouts) if (pointInPolygon(p, k.points)) return { kind: "keepout", id: k.id };
    if (show.zones) {
      const zs = [...design.zones].sort((a, b) => Number(b.layer === layer) - Number(a.layer === layer));
      for (const z of zs) if (visible(z.layer) && pointInPolygon(p, z.points)) return { kind: "zone", id: z.id };
    }
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
      if (viaMode === "span") {
        const [a, b] = [layers.indexOf(viaSpan[0]), layers.indexOf(viaSpan[1])];
        // A microvia joins an outer layer to its neighbour: laser drilled, small.
        const micro = Math.abs(a - b) === 1 && (Math.min(a, b) === 0 || Math.max(a, b) === layers.length - 1);
        doc.transact(() => commitVia(snapped(raw), micro ? 0.25 : 0.5, micro ? 0.1 : 0.25, { from: viaSpan[0], to: viaSpan[1] }, undefined));
      } else doc.transact(() => commitVia(snapped(raw), 0.6, 0.3, undefined, undefined));
      return;
    }
    if (tool === "comment") {
      const text = prompt("Comment (mention @copilot to ask the AI)");
      if (text?.trim()) {
        const hit = pick(raw, px * 4);
        const ref = hit?.kind === "component" ? design.components.find((c) => c.id === hit.id)?.ref : undefined;
        const c = addComment(doc, { view: "pcb", pos: snapped(raw), ref, author: user.name, color: user.color, text: text.trim() });
        select({ kind: "comment", id: c.id });
        if (/@copilot\b/i.test(text)) askCopilotAbout(projectId, c, text.trim(), user.name).then(() => toast("Copilot is on it"), (err) => toast((err as Error).message));
      }
      setTool("select");
      return;
    }
    if (tool === "measure") {
      const p = snapped(raw);
      if (!measure) setMeasure(p);
      else {
        undo.stopCapturing();
        addPcbGraphic(doc, { kind: "dimension", points: [measure, p] });
        setMeasure(null);
      }
      return;
    }
    if (POLY_TOOLS.includes(tool)) {
      const p = snapped(raw);
      if (e.detail >= 2 && zoneDraft) return finishZone(dedupe(zoneDraft));
      setZoneDraft([...(zoneDraft ?? []), p]);
      return;
    }
    if (tool === "route") {
      const pad = padAt(raw);
      if (!routing) {
        if (!pad) return toast("Start a trace on a pad");
        const l = pad.layers.includes(layer) ? layer : pad.layers[0];
        if (l !== layer) setLayer(l);
        const net = netOfPad(pad);
        const rules = netRules(design, net);
        setRouting({ layer: l, width: rules.className === "Default" ? width : rules.traceWidth, points: [pad.world], net });
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
      drag.current = { kind: "component", id: c.id, start: raw, orig: { x: c.pcb.x, y: c.pcb.y } };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } else if (hit?.kind === "via") {
      const v = design.vias.find((x) => x.id === hit.id)!;
      undo.stopCapturing();
      // Shoving is worked out on drop against the board as it was before the drag: copper the
      // via passes over on the way would otherwise count as connected to it.
      drag.current = { kind: "via", id: v.id, start: raw, orig: { x: v.x, y: v.y }, before: design };
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
    if (d?.kind === "via") {
      // The via's own traces follow it; with shove on, others make room when it is dropped.
      const v = viasMap(doc).get(d.id);
      const p = snapped({ x: d.orig.x + w.x - d.start.x, y: d.orig.y + w.y - d.start.y });
      if (v && (p.x !== v.x || p.y !== v.y)) {
        d.moved = true;
        doc.transact(() => {
          for (const t of tracesMap(doc).values()) {
            const n = t.points.length - 1;
            const hit = (q: Vec) => Math.hypot(q.x - v.x, q.y - v.y) < 1e-3;
            if (!viaLayers(design.board, v).includes(t.layer) || !(hit(t.points[0]) || hit(t.points[n]))) continue;
            tracesMap(doc).set(t.id, { ...t, points: t.points.map((q, i) => ((i === 0 || i === n) && hit(q) ? p : q)) });
          }
          viasMap(doc).set(d.id, { ...v, x: p.x, y: p.y });
        });
      }
    } else if (d) {
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
      for (const v of r.vias) addVia(doc, v, v.diameter, v.drill, v);
    });
    toast(`Routed ${r.routed} connection${r.routed === 1 ? "" : "s"} with ${r.vias.length} via${r.vias.length === 1 ? "" : "s"} in ${Math.round(performance.now() - t0)}ms${r.failed.length ? ` · ${r.failed.length} failed` : ""}`);
  };

  const { view } = vp;
  const px = 1 / view.k; // one screen pixel in mm
  const selTraceNet = useMemo(() => {
    if (selection?.kind !== "trace") return null;
    return analysis.clusterOf.get(`trace:${selection.id}`) ?? null;
  }, [selection, analysis]);

  const layerOrder: CopperLayer[] = [...[...layers].reverse().filter((l) => l !== layer), layer];
  const fills = useMemo(() => new Map(design.zones.map((z) => [z.id, zoneFill(design, z, analysis)])), [design, analysis]);
  const drops = useMemo(() => boardTeardrops(design, analysis), [design, analysis]);
  const outline = boardOutline(design.board);
  const boardPath = [outline, ...(design.board.cutouts ?? [])].map((poly) => `M${poly.map((p) => `${p.x},${p.y}`).join("L")}Z`).join("");
  const placed = design.components.filter((c) => getPart(c.partId)?.footprint);

  return (
    <>
      <svg
        ref={vp.svgRef}
        className="canvas-svg"
        style={{ cursor: tool === "select" ? "default" : "crosshair" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (d?.kind === "via" && d.moved && shove && d.before) {
            const v = viasMap(doc).get(d.id);
            if (!v) return;
            const a = analyzeCopper(d.before);
            const item = a.items.find((it) => it.kind === "via" && it.via.id === v.id);
            const r = shoveVia(d.before, v, item && a.netOfItem(item));
            if (r.ok) doc.transact(() => applyShove(r));
            else toast(`Could not shove: ${r.reason}`);
          }
        }}
        onPointerLeave={() => publishCursor(provider, null)}
        onDoubleClick={() => {
          // Chromium reports detail=0 on pointerdown, so double-click closing happens here.
          if (routing) finishRoute(routing);
          else if (zoneDraft && POLY_TOOLS.includes(tool)) finishZone(dedupe(zoneDraft));
        }}
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
          <path d={boardPath} fill="#0d3326" fillRule="evenodd" stroke="#e8d36b" strokeWidth={Math.max(0.1, px * 1.5)} />

          {layerOrder.map((l) => {
            if (!visible(l)) return null;
            const dim = l !== layer ? 0.45 : 0.92;
            return (
              <g key={l} opacity={dim}>
                {show.zones &&
                  design.zones
                    .filter((z) => z.layer === l)
                    .map((z) => {
                      const sel = selection?.kind === "zone" && selection.id === z.id;
                      const pts = z.points.map((p) => `${p.x},${p.y}`).join(" ");
                      return (
                        <g key={z.id}>
                          {/* The computed fill: islands with holes, drawn even-odd. */}
                          <path d={(fills.get(z.id)?.polygons ?? []).flatMap((isl) => isl.map((ring) => `M${ring.map((p) => `${p.x},${p.y}`).join("L")}Z`)).join("")} fill={layerColor(l)} fillRule="evenodd" opacity={0.42} />
                          <polygon points={pts} fill="none" stroke={sel ? "#ffffff" : layerColor(l)} strokeWidth={px * (sel ? 2 : 1)} strokeDasharray={`${px * 6} ${px * 4}`} />
                        </g>
                      );
                    })}
                {drops
                  .filter((t) => t.layer === l)
                  .map((t, i) => (
                    <polygon key={`td${i}`} points={t.points.map((p) => `${p.x},${p.y}`).join(" ")} fill={layerColor(l)} />
                  ))}
                {design.traces
                  .filter((t) => t.layer === l)
                  .map((t) => {
                    const sel = selection?.kind === "trace" && selection.id === t.id;
                    const sameNet = selTraceNet && analysis.clusterOf.get(`trace:${t.id}`) === selTraceNet;
                    return (
                      <polyline
                        key={t.id}
                        points={t.points.map((p) => `${p.x},${p.y}`).join(" ")}
                        stroke={sel ? "#ffffff" : sameNet ? "#ff9a8f" : layerColor(l)}
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
                    .map((p, i) => <PadEl key={`${c.id}-${i}`} pad={p} color={p.drill ? THT_COLOR : padColor(l)} />),
                )}
              </g>
            );
          })}

          {design.vias.map((v) => {
            const sel = selection?.kind === "via" && selection.id === v.id;
            const kind = viaKind(design.board, v);
            const span = viaLayers(design.board, v);
            return (
              <g key={v.id}>
                <circle cx={v.x} cy={v.y} r={v.diameter / 2} fill={sel ? "#ffffff" : kind === "through" ? "#c9b458" : layerColor(span[0])} />
                {/* Blind/buried/micro vias: the inner ring shows the far layer of the span. */}
                {kind !== "through" && !sel && <circle cx={v.x} cy={v.y} r={(v.diameter + v.drill) / 4} fill={layerColor(span[span.length - 1])} />}
                <circle cx={v.x} cy={v.y} r={v.drill / 2} fill="#0b0d10" />
              </g>
            );
          })}

          {placed.map((c) => (
            <FootprintOverlay key={c.id} c={c} showSilk={show.silk} selected={selection?.kind === "component" && selection.id === c.id} remote={presence.find((p) => p.sel === c.id)?.user.color} px={px} />
          ))}

          <defs>
            <pattern id="ko-hatch" width={1} height={1} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1={0} y1={0} x2={0} y2={1} stroke="#ef4444" strokeWidth={0.12} />
            </pattern>
          </defs>
          {design.keepouts.map((k) => {
            const sel = selection?.kind === "keepout" && selection.id === k.id;
            return (
              <polygon key={k.id} points={k.points.map((p) => `${p.x},${p.y}`).join(" ")} fill="url(#ko-hatch)" fillOpacity={0.7} stroke={sel ? "#ffffff" : "#ef4444"} strokeWidth={px * (sel ? 2 : 1.2)} strokeDasharray={`${px * 5} ${px * 3}`} />
            );
          })}
          {design.pcbGraphics.map((g) =>
            g.kind === "dimension" && g.points.length >= 2 ? (
              <Dimension key={g.id} a={g.points[0]} b={g.points[1]} px={px} selected={selection?.kind === "dimension" && selection.id === g.id} />
            ) : null,
          )}
          {measure && <Dimension a={measure} b={cursor} px={px} selected={false} live />}
          {show.rats &&
            rats.map((r, i) => <line key={i} x1={r.a.x} y1={r.a.y} x2={r.b.x} y2={r.b.y} stroke="#e5e7eb" strokeOpacity={0.75} strokeWidth={px} pointerEvents="none" />)}

          {drc.map((i, n) => (
            <g key={n} pointerEvents="none">
              <circle cx={i.at!.x} cy={i.at!.y} r={px * 9} fill="none" stroke="#ff3b3b" strokeWidth={px * 2} />
              <line x1={i.at!.x - px * 5} y1={i.at!.y - px * 5} x2={i.at!.x + px * 5} y2={i.at!.y + px * 5} stroke="#ff3b3b" strokeWidth={px * 2} />
            </g>
          ))}

          {zoneDraft && POLY_TOOLS.includes(tool) && (
            <polygon
              points={[...zoneDraft, cursor].map((p) => `${p.x},${p.y}`).join(" ")}
              fill={layerColor(layer)}
              fillOpacity={0.2}
              stroke={layerColor(layer)}
              strokeWidth={px * 1.5}
              strokeDasharray={`${px * 5} ${px * 4}`}
              pointerEvents="none"
            />
          )}
          {routing && (
            <polyline
              points={[...routing.points, cursor].map((p) => `${p.x},${p.y}`).join(" ")}
              stroke={layerColor(routing.layer)}
              strokeOpacity={0.8}
              strokeWidth={routing.width}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              pointerEvents="none"
            />
          )}

          <CommentPins view="pcb" r={px * 11} />
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
        <button className={tool === "zone" ? "active" : ""} onClick={() => setTool("zone")} title="Draw a copper pour outline (P)">
          Pour
        </button>
        <button className={tool === "keepout" ? "active" : ""} onClick={() => setTool("keepout")} title="Draw a keepout area (K)">
          Keepout
        </button>
        <button className={tool === "comment" ? "active" : ""} onClick={() => setTool("comment")} title="Pin a review comment">
          Comment
        </button>
        <button className={tool === "measure" ? "active" : ""} onClick={() => setTool("measure")} title="Measure / add a dimension (M)">
          Measure
        </button>
        <select
          value={tool === "outline" || tool === "cutout" ? tool : ""}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "rect") {
              undo.stopCapturing();
              setBoardOutline(doc, null);
              setBoard(doc, { cutouts: [] });
              toast("Board outline reset to a rectangle");
            } else if (v) setTool(v as Tool);
          }}
          title="Board outline tools"
        >
          <option value="">Outline…</option>
          <option value="outline">Draw board outline</option>
          <option value="cutout">Draw cutout / slot</option>
          <option value="rect">Reset to rectangle</option>
        </select>
        <span className="sep" />
        <select value={layer} onChange={(e) => switchLayer(e.target.value as CopperLayer)} title="Active layer (L cycles; while routing this drops a via)" style={{ color: layerColor(layer) }}>
          {layers.map((l) => (
            <option key={l} value={l}>
              {layerLabel(l)}
            </option>
          ))}
        </select>
        {(tool === "route" || tool === "via" || tool === "select") && (
          <label className="small row" style={{ gap: 4 }} title="Push other nets' traces and vias aside when a new trace or via needs the room, or when you drag a via (pads never move)">
            <input type="checkbox" checked={shove} onChange={(e) => setShove(e.target.checked)} />
            Shove
          </label>
        )}
        {layers.length > 2 && (tool === "via" || tool === "route") && (
          <select value={viaMode} onChange={(e) => setViaMode(e.target.value as "through" | "span")} title="Via type for the via tool and for layer changes while routing">
            <option value="through">Through vias</option>
            <option value="span">Blind / buried vias</option>
          </select>
        )}
        {layers.length > 2 && tool === "via" && viaMode === "span" && (
          <>
            {[0, 1].map((k) => (
              <select key={k} value={viaSpan[k]} onChange={(e) => setViaSpan(k === 0 ? [e.target.value as CopperLayer, viaSpan[1]] : [viaSpan[0], e.target.value as CopperLayer])} title={k === 0 ? "Via starts on" : "Via ends on"}>
                {layers.map((l) => (
                  <option key={l} value={l}>
                    {k === 0 ? "from " : "to "}
                    {layerLabel(l)}
                  </option>
                ))}
              </select>
            ))}
          </>
        )}
        <select value={width} onChange={(e) => setWidth(Number(e.target.value))} title="Trace width (mm)">
          {[0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.8, 1.0].map((w) => (
            <option key={w} value={w}>
              {w} mm
            </option>
          ))}
        </select>
        {tool === "zone" && (
          <>
            <select value={zoneNet} onChange={(e) => setZoneNet(e.target.value)} title="Net for the copper pour">
              {(namedNets.includes(zoneNet) ? namedNets : [zoneNet, ...namedNets]).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <button onClick={pourBoard} title="Pour this net over the whole board on the active layer">
              Fill board
            </button>
          </>
        )}
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
            ...layers.map((l) => [l, `${layerLabel(l)} copper`, layerColor(l)] as const),
            ["zones", "Copper pours", "#7c8796"],
            ["silk", "Silkscreen", "#f3f4f6"],
            ["rats", "Ratsnest", "#9ca3af"],
            ["drc", "DRC markers", "#ff3b3b"],
          ] as const
        ).map(([k, label, color]) => (
          <label key={k}>
            <input
              type="checkbox"
              checked={k in show ? show[k as keyof typeof show] : visible(k as CopperLayer)}
              onChange={(e) =>
                k in show ? setShow({ ...show, [k]: e.target.checked }) : setHidden(e.target.checked ? hidden.filter((x) => x !== k) : [...hidden, k as CopperLayer])
              }
            />
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
          : tool === "measure"
            ? measure
              ? "Click the second point to add a dimension · Esc to cancel"
              : "Click two points to measure and add a dimension"
            : POLY_TOOLS.includes(tool) && tool !== "zone"
              ? zoneDraft
                ? "Click to add corners · double-click / Enter to close · Esc to finish"
                : tool === "keepout"
                  ? "Click corners of the keepout area"
                  : tool === "outline"
                    ? "Click corners of the new board outline"
                    : "Click corners of the cutout"
          : tool === "via"
            ? "Click to place a via · Esc to stop"
            : tool === "zone"
              ? zoneDraft
                ? "Click to add outline corners · double-click / Enter to close the pour · Esc to finish"
                : "Click corners of the pour outline, or use Fill board"
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
        <rect x={c.x - ww / 2} y={c.y - wh / 2} width={ww} height={wh} rx={pad.shape === "oval" ? Math.min(ww, wh) / 2 : Math.min(ww, wh) * 0.12} fill={color} transform={pad.angle ? `rotate(${pad.angle} ${c.x} ${c.y})` : undefined} />
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

function Dimension({ a, b, px, selected, live }: { a: Vec; b: Vec; px: number; selected: boolean; live?: boolean }) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const ux = len ? (b.y - a.y) / len : 0;
  const uy = len ? -(b.x - a.x) / len : 0;
  const t = 4 * px;
  const color = selected ? "#ffffff" : "#60a5fa";
  return (
    <g pointerEvents="none">
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={px * 1.2} strokeDasharray={live ? `${px * 4} ${px * 3}` : undefined} />
      <line x1={a.x - ux * t} y1={a.y - uy * t} x2={a.x + ux * t} y2={a.y + uy * t} stroke={color} strokeWidth={px * 1.2} />
      <line x1={b.x - ux * t} y1={b.y - uy * t} x2={b.x + ux * t} y2={b.y + uy * t} stroke={color} strokeWidth={px * 1.2} />
      <text x={(a.x + b.x) / 2 + ux * t * 2.5} y={(a.y + b.y) / 2 + uy * t * 2.5} fontSize={px * 11} fill={color} textAnchor="middle" fontWeight={600}>
        {len.toFixed(2)} mm
      </text>
    </g>
  );
}
