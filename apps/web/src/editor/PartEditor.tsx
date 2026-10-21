import { addCustomPart, componentsMap, finishSymbol, getPart, icSymbol, packageFootprint, partsMap, type ComponentData, type Footprint, type Pad, type PackageSpec, type PartDef, type PinType, type Shape, type Vec } from "@pcbian/core";
import { useMemo, useRef, useState } from "react";
import { useEditor } from "./context";
import { ShapeEl, SymbolBody } from "./render";
import { SymbolDraw, type Drawing } from "./SymbolDraw";

const PIN_TYPES: PinType[] = ["passive", "input", "output", "bidirectional", "tristate", "power_in", "power_out", "open_collector", "unspecified", "nc"];

interface PinRow {
  number: string;
  name: string;
  side: "left" | "right";
  type: PinType;
}

const PACKAGES: { label: string; spec: (n: number) => PackageSpec }[] = [
  { label: "SOIC", spec: (n) => ({ type: "soic", pins: n }) },
  { label: "DIP", spec: (n) => ({ type: "dip", pins: n }) },
  { label: "TQFP 0.5mm", spec: (n) => ({ type: "qfp", pins: n, pitch: 0.5 }) },
  { label: "TQFP 0.8mm", spec: (n) => ({ type: "qfp", pins: n, pitch: 0.8 }) },
  { label: "Pin header", spec: (n) => ({ type: "header", pins: n }) },
  { label: "SOT-23", spec: () => ({ type: "sot23" }) },
  { label: "SOT-223", spec: () => ({ type: "sot223" }) },
  { label: "0603", spec: () => ({ type: "chip", size: "0603" }) },
  { label: "0805", spec: () => ({ type: "chip", size: "0805" }) },
];

const snap = (v: number) => Math.round(v * 20) / 20;

/** Courtyard from pad extents plus 0.25mm, centred on the origin. */
function autoCourtyard(pads: Pad[]) {
  if (!pads.length) return { w: 1, h: 1 };
  const ex = Math.max(...pads.map((p) => Math.abs(p.x) + p.w / 2));
  const ey = Math.max(...pads.map((p) => Math.abs(p.y) + p.h / 2));
  return { w: Math.round((ex + 0.25) * 2 * 100) / 100, h: Math.round((ey + 0.25) * 2 * 100) / 100 };
}

export function PartEditor({ comp, onClose }: { comp: ComponentData; onClose: () => void }) {
  const { conn, design, toast } = useEditor();
  const doc = conn.doc;
  const original = getPart(comp.partId)!;
  const isCustom = partsMap(doc).has(original.id);
  const [tab, setTab] = useState<"symbol" | "footprint">("symbol");
  const [name, setName] = useState(original.name);
  const [prefix, setPrefix] = useState(original.refPrefix);
  const [description, setDescription] = useState(original.description);
  const [pins, setPins] = useState<PinRow[]>(() =>
    original.symbol.pins.map((p, i) => ({ number: p.id, name: p.name, side: p.side === "right" ? "right" : p.side === "left" ? "left" : i < original.symbol.pins.length / 2 ? "left" : "right", type: p.type ?? "passive" })),
  );
  const [pads, setPads] = useState<Pad[]>(() => original.footprint?.pads.map((p) => ({ ...p })) ?? []);
  const [silk, setSilk] = useState<Shape[]>(() => original.footprint?.silk ?? []);
  const [fpName, setFpName] = useState(original.footprint?.name ?? "Custom");
  const [selPad, setSelPad] = useState<number | null>(null);
  const [applyAll, setApplyAll] = useState(true);
  const users = design.components.filter((c) => c.partId === original.id);

  const sameIds = pins.length === original.symbol.pins.length && pins.every((p) => original.symbol.pins.some((o) => o.id === p.number));
  /** How the symbol is drawn: an automatic box, the part's original drawing, or by hand. */
  const [mode, setMode] = useState<"box" | "original" | "draw">(original.symbol.shapes.every((s) => s.kind !== "rect") || pins.length <= 3 || isCustom ? "original" : "box");
  const [drawing, setDrawing] = useState<Drawing | null>(null);
  const boxSymbol = () => {
    const sym = icSymbol(
      pins.filter((p) => p.side === "left").map((p) => [p.number, p.name]),
      pins.filter((p) => p.side === "right").map((p) => [p.number, p.name]),
      pins.length > 3 ? name.slice(0, 14) : "",
    );
    for (const p of sym.pins) p.type = pins.find((r) => r.number === p.id)?.type ?? "passive";
    return sym;
  };
  const symbol = useMemo(() => {
    if (mode === "draw" && drawing) {
      // The pin table owns numbers, names and types; the drawing owns where each pin sits.
      const drawn = drawing.pins.flatMap((d) => ((r) => (r ? [{ ...d, name: r.name, type: r.type }] : []))(pins.find((p) => p.number === d.id)));
      return finishSymbol({ shapes: drawing.shapes, pins: drawn, units: original.symbol.units });
    }
    if (mode === "original" && sameIds) {
      return { ...original.symbol, pins: original.symbol.pins.map((o) => ({ ...o, ...((r) => (r ? { name: r.name, type: r.type, showName: o.showName } : {}))(pins.find((p) => p.number === o.id)) })) };
    }
    return boxSymbol();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins, mode, drawing, sameIds, name, original.symbol]);
  const startDrawing = () => {
    // Start from whatever is shown now, so a box or the original can be reshaped.
    setDrawing({ shapes: symbol.shapes.map((x) => ({ ...x })), pins: symbol.pins.map((x) => ({ ...x })) });
    setMode("draw");
  };

  const pinIds = new Set(pins.map((p) => p.number));
  const padIds = new Set(pads.map((p) => p.id));
  const problems = [
    ...[...padIds].filter((id) => !pinIds.has(id)).map((id) => `Pad ${id} has no matching pin`),
    ...(pads.length ? [...pinIds].filter((id) => !padIds.has(id)).map((id) => `Pin ${id} has no pad`) : []),
    ...(new Set(pins.map((p) => p.number)).size !== pins.length ? ["Pin numbers must be unique"] : []),
    ...(mode === "draw" && drawing ? pins.filter((p) => !drawing.pins.some((d) => d.id === p.number)).map((p) => `Pin ${p.number} is not placed on the drawing`) : []),
  ];

  const save = () => {
    const blocking = problems.find((p) => /no matching pin|unique|not placed/.test(p));
    if (blocking) return toast(blocking);
    const footprint: Footprint | null = pads.length ? { name: fpName, pads, courtyard: autoCourtyard(pads), silk } : null;
    const part: PartDef = {
      ...original,
      id: isCustom ? original.id : `custom_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name,
      refPrefix: prefix || "U",
      description,
      category: isCustom ? original.category : "Custom",
      symbol,
      footprint,
    };
    doc.transact(() => {
      addCustomPart(doc, part);
      if (!isCustom) {
        const targets = applyAll ? users : [comp];
        for (const c of targets) componentsMap(doc).set(c.id, { ...componentsMap(doc).get(c.id)!, partId: part.id });
      }
    });
    toast(isCustom ? `Updated ${name} (${users.length} instance${users.length === 1 ? "" : "s"})` : `Saved ${name} as a project part`);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal part-editor" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h3 style={{ margin: 0 }}>Part editor</h3>
          <span className="muted small">{isCustom ? "project part — changes apply to every instance" : "built-in part — saved as an editable project copy"}</span>
          <span className="spacer" />
          <div className="tabs">
            <button className={tab === "symbol" ? "on" : ""} onClick={() => setTab("symbol")}>
              Symbol
            </button>
            <button className={tab === "footprint" ? "on" : ""} onClick={() => setTab("footprint")}>
              Footprint
            </button>
          </div>
        </div>
        <div className="row">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name / MPN" style={{ flex: 2 }} />
          <input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="Ref" style={{ width: 60 }} />
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" style={{ flex: 3 }} />
        </div>
        {tab === "symbol" ? (
          <div className="pe-grid">
            <div className="pe-table">
              <table className="pin-table">
                <thead>
                  <tr className="muted small">
                    <td>#</td>
                    <td>Name</td>
                    <td>Side</td>
                    <td>Type</td>
                    <td />
                  </tr>
                </thead>
                <tbody>
                  {pins.map((p, i) => {
                    const upd = (patch: Partial<PinRow>) => {
                      setPins(pins.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                      // A renumbered pin keeps its place on a hand drawing.
                      if (patch.number !== undefined && drawing) setDrawing({ ...drawing, pins: drawing.pins.map((d) => (d.id === p.number ? { ...d, id: patch.number! } : d)) });
                    };
                    return (
                      <tr key={i}>
                        <td>
                          <input value={p.number} onChange={(e) => upd({ number: e.target.value })} style={{ width: 42 }} />
                        </td>
                        <td>
                          <input value={p.name} onChange={(e) => upd({ name: e.target.value })} style={{ width: 110 }} />
                        </td>
                        <td>
                          <select value={p.side} onChange={(e) => upd({ side: e.target.value as "left" | "right" })}>
                            <option value="left">L</option>
                            <option value="right">R</option>
                          </select>
                        </td>
                        <td>
                          <select value={p.type} onChange={(e) => upd({ type: e.target.value as PinType })}>
                            {PIN_TYPES.map((t) => (
                              <option key={t} value={t}>
                                {t.replace("_", " ")}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <button
                            className="ghost small danger"
                            onClick={() => {
                              setPins(pins.filter((_, j) => j !== i));
                              if (drawing) setDrawing({ ...drawing, pins: drawing.pins.filter((d) => d.id !== p.number) });
                            }}
                            title="Remove pin"
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="row" style={{ marginTop: 6 }}>
                <button className="small" onClick={() => setPins([...pins, { number: String(pins.length + 1), name: `P${pins.length + 1}`, side: pins.length % 2 ? "right" : "left", type: "passive" }])}>
                  + Pin
                </button>
              </div>
              <div className="row" style={{ marginTop: 8, gap: 4 }}>
                <span className="small muted">Drawing</span>
                <div className="tabs">
                  <button className={mode === "box" ? "on" : ""} onClick={() => setMode("box")} title="A box with the pins down its sides (the Side column)">
                    Box
                  </button>
                  <button className={mode === "original" ? "on" : ""} disabled={!sameIds} onClick={() => setMode("original")} title="The part's own drawing (only while pin numbers are unchanged)">
                    Original
                  </button>
                  <button className={mode === "draw" ? "on" : ""} onClick={() => (drawing ? setMode("draw") : startDrawing())} title="Draw the body and place pins by hand">
                    Draw
                  </button>
                </div>
                {mode === "draw" && (
                  <button className="small ghost" onClick={startDrawing} title="Throw away the hand drawing and start again from the box">
                    Restart
                  </button>
                )}
              </div>
            </div>
            {mode === "draw" && drawing ? <SymbolDraw drawing={drawing} onChange={setDrawing} pinTable={pins.map((p) => ({ number: p.number, name: p.name, type: p.type }))} /> : <SymbolPreview part={{ ...original, name, symbol }} />}
          </div>
        ) : (
          <FootprintEditor pads={pads} setPads={setPads} silk={silk} setSilk={setSilk} sel={selPad} setSel={setSelPad} pinCount={pins.length} fpName={fpName} setFpName={setFpName} />
        )}
        {problems.length > 0 && (
          <div className="small" style={{ color: "var(--warn)" }}>
            {problems.slice(0, 4).join(" · ")}
            {problems.length > 4 ? ` · +${problems.length - 4} more` : ""}
          </div>
        )}
        <div className="row">
          {!isCustom && users.length > 1 && (
            <label className="small row" style={{ gap: 4 }}>
              <input type="checkbox" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} />
              Use for all {users.length} components with this part
            </label>
          )}
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}>
            Save part
          </button>
        </div>
      </div>
    </div>
  );
}

function SymbolPreview({ part }: { part: PartDef }) {
  const pts = [...part.symbol.pins.map((p) => ({ x: p.x, y: p.y })), ...part.symbol.shapes.flatMap((s) => (s.kind === "rect" ? [{ x: s.x, y: s.y }, { x: s.x + s.w, y: s.y + s.h }] : s.kind === "line" || s.kind === "polygon" ? s.points : []))];
  const x0 = Math.min(...pts.map((p) => p.x), -20) - 40;
  const y0 = Math.min(...pts.map((p) => p.y), -20) - 20;
  const x1 = Math.max(...pts.map((p) => p.x), 20) + 40;
  const y1 = Math.max(...pts.map((p) => p.y), 20) + 20;
  return (
    <svg className="pe-preview" viewBox={`${x0} ${y0} ${x1 - x0} ${y1 - y0}`} style={{ background: "var(--sch-bg)" }}>
      <SymbolBody part={part} color="#7a1f1f" />
    </svg>
  );
}

function FootprintEditor({
  pads,
  setPads,
  silk,
  setSilk,
  sel,
  setSel,
  pinCount,
  fpName,
  setFpName,
}: {
  pads: Pad[];
  setPads: (p: Pad[]) => void;
  silk: Shape[];
  setSilk: (s: Shape[]) => void;
  sel: number | null;
  setSel: (i: number | null) => void;
  pinCount: number;
  fpName: string;
  setFpName: (n: string) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ i: number; start: Vec; orig: Vec } | null>(null);
  const court = autoCourtyard(pads);
  const span = Math.max(court.w, court.h, 4) * 0.75 + 1;
  const toMm = (e: React.PointerEvent): Vec => {
    const r = svg.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 2 * span - span, y: ((e.clientY - r.top) / r.height) * 2 * span - span };
  };
  const p = sel !== null ? pads[sel] : null;
  const upd = (patch: Partial<Pad>) => sel !== null && setPads(pads.map((x, i) => (i === sel ? { ...x, ...patch } : x)));
  const nextId = () => String(Math.max(0, ...pads.map((x) => Number(x.id) || 0)) + 1);
  const grid: number[] = [];
  for (let v = -Math.floor(span); v <= span; v++) grid.push(v);
  return (
    <div className="pe-grid">
      <div>
        <svg
          ref={svg}
          className="pe-preview pe-canvas"
          viewBox={`${-span} ${-span} ${span * 2} ${span * 2}`}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const m = toMm(e);
            setPads(pads.map((x, i) => (i === d.i ? { ...x, x: snap(d.orig.x + m.x - d.start.x), y: snap(d.orig.y + m.y - d.start.y) } : x)));
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerDown={() => setSel(null)}
        >
          {grid.map((v) => (
            <g key={v}>
              <line x1={v} x2={v} y1={-span} y2={span} stroke={v === 0 ? "#3a4352" : "#1d222b"} strokeWidth={0.02} />
              <line y1={v} y2={v} x1={-span} x2={span} stroke={v === 0 ? "#3a4352" : "#1d222b"} strokeWidth={0.02} />
            </g>
          ))}
          <rect x={-court.w / 2} y={-court.h / 2} width={court.w} height={court.h} fill="none" stroke="#f472b6" strokeWidth={0.04} strokeDasharray="0.15 0.1" />
          {silk.map((s, i) => (
            <ShapeEl key={i} s={s} stroke="#f3f4f6" width={0.12} />
          ))}
          {pads.map((pd, i) => (
            <g
              key={i}
              onPointerDown={(e) => {
                e.stopPropagation();
                setSel(i);
                drag.current = { i, start: toMm(e), orig: { x: pd.x, y: pd.y } };
                (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(e.pointerId);
              }}
              style={{ cursor: "move" }}
            >
              {pd.shape === "circle" ? (
                <circle cx={pd.x} cy={pd.y} r={Math.min(pd.w, pd.h) / 2} fill={i === sel ? "#fbbf24" : "#d9a53a"} />
              ) : (
                <rect x={pd.x - pd.w / 2} y={pd.y - pd.h / 2} width={pd.w} height={pd.h} rx={pd.shape === "oval" ? Math.min(pd.w, pd.h) / 2 : 0.05} fill={i === sel ? "#fbbf24" : "#d9a53a"} />
              )}
              {pd.drill && <circle cx={pd.x} cy={pd.y} r={pd.drill / 2} fill="#0b0d10" />}
              <text x={pd.x} y={pd.y + Math.min(pd.w, pd.h) * 0.18} fontSize={Math.min(pd.w, pd.h) * 0.5} textAnchor="middle" fill="#0b0d10" style={{ pointerEvents: "none" }}>
                {pd.id}
              </text>
            </g>
          ))}
        </svg>
        <div className="muted small">Drag pads (0.05mm snap). Pink: courtyard (auto). Origin at the crosshair.</div>
      </div>
      <div className="pe-table">
        <div className="field">
          <label>Footprint</label>
          <input value={fpName} onChange={(e) => setFpName(e.target.value)} />
        </div>
        <div className="row" style={{ flexWrap: "wrap", marginBottom: 8 }}>
          <button className="small" onClick={() => (setPads([...pads, { id: nextId(), x: 0, y: 0, w: 1, h: 1.2, shape: "rect" }]), setSel(pads.length))}>
            + SMD pad
          </button>
          <button className="small" onClick={() => (setPads([...pads, { id: nextId(), x: 0, y: 0, w: 1.7, h: 1.7, shape: "circle", drill: 1 }]), setSel(pads.length))}>
            + THT pad
          </button>
          <select
            value=""
            onChange={(e) => {
              const pk = PACKAGES[Number(e.target.value)];
              if (!pk) return;
              const fp = packageFootprint(pk.spec(pinCount));
              setPads(fp.pads);
              setSilk(fp.silk);
              setFpName(fp.name);
              setSel(null);
            }}
          >
            <option value="">Generate from package…</option>
            {PACKAGES.map((pk, i) => (
              <option key={pk.label} value={i}>
                {pk.label} ({pinCount} pins)
              </option>
            ))}
          </select>
          <button className="small" onClick={() => setSilk([{ kind: "line", points: [{ x: -court.w / 2 + 0.2, y: -court.h / 2 + 0.2 }, { x: court.w / 2 - 0.2, y: -court.h / 2 + 0.2 }, { x: court.w / 2 - 0.2, y: court.h / 2 - 0.2 }, { x: -court.w / 2 + 0.2, y: court.h / 2 - 0.2 }, { x: -court.w / 2 + 0.2, y: -court.h / 2 + 0.2 }] }])}>
            Auto silkscreen
          </button>
        </div>
        {p ? (
          <>
            <h4>Pad {p.id}</h4>
            <div className="pe-fields">
              <label>Number</label>
              <input value={p.id} onChange={(e) => upd({ id: e.target.value })} />
              {(["x", "y", "w", "h"] as const).map((k) => (
                <FieldNum key={k} label={k.toUpperCase() + (k === "w" || k === "h" ? " (size)" : "")} value={p[k]} onChange={(v) => upd({ [k]: v })} />
              ))}
              <label>Shape</label>
              <select value={p.shape} onChange={(e) => upd({ shape: e.target.value as Pad["shape"] })}>
                <option value="rect">Rectangle</option>
                <option value="oval">Oval</option>
                <option value="circle">Circle</option>
              </select>
              <label>Drill</label>
              <input type="number" step={0.05} value={p.drill ?? ""} placeholder="SMD" onChange={(e) => upd({ drill: e.target.value ? Number(e.target.value) : undefined })} />
            </div>
            <button className="small danger" onClick={() => (setPads(pads.filter((_, i) => i !== sel)), setSel(null))}>
              Delete pad
            </button>
          </>
        ) : (
          <p className="muted small">
            {pads.length} pads. Select a pad to edit it. Pad numbers must match symbol pin numbers.
          </p>
        )}
      </div>
    </div>
  );
}

function FieldNum({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <>
      <label>{label}</label>
      <input type="number" step={0.05} value={value} onChange={(e) => Number.isFinite(Number(e.target.value)) && onChange(Number(e.target.value))} />
    </>
  );
}
