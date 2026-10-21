import {
  deleteComponent,
  deleteTrace,
  deleteVia,
  getPart,
  netByTerminal,
  nextRotation,
  normAngle,
  setBoard,
  termKey,
  tracesMap,
  updateComponent,
  busMembers,
  copperLayers,
  modelTypesForPart,
  layerLabel,
  traceImpedance,
  viaKind,
  viaLayers,
  viasMap,
  widthForImpedance,
  deleteKeepout,
  deleteNetClass,
  deletePcbGraphic,
  deleteSchGraphic,
  deleteVariant,
  keepoutsMap,
  schGraphicsMap,
  setActiveVariant,
  setTitleBlock,
  setVariant,
  type Keepout,
  deleteZone,
  setNetClass,
  zonesMap,
  type BoardSettings,
  type CopperLayer,
  type NetClass,
} from "@pcbian/core";
import { useEffect, useState } from "react";
import { useEditor } from "./context";
import { PartEditor } from "./PartEditor";
import { StackupCard } from "./Stackup";
import { DiffPairsCard, LengthGroupsCard, TraceLengthTuner } from "./Routing";

export function NumField({ label, value, onChange, step = 0.05, min = 0 }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number }) {
  const shown = String(Math.round(value * 1000) / 1000);
  const [v, setV] = useState(shown);
  useEffect(() => setV(shown), [shown]);
  return (
    <div className="field">
      <label>{label}</label>
      <input
        type="number"
        step={step}
        min={min}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= min) onChange(n);
          else setV(shown);
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
    </div>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <div className="field">
      <label>{label}</label>
      <input value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v.trim() && v !== value && onChange(v.trim())} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
    </div>
  );
}

export function Inspector() {
  const { design, selection, select, conn, nets, mode } = useEditor();
  const doc = conn.doc;
  const [editing, setEditing] = useState<string | null>(null);
  const variant = design.variants.find((v) => v.name === design.activeVariant);

  if (selection?.kind === "component") {
    const c = design.components.find((x) => x.id === selection.id);
    const part = c && getPart(c.partId);
    if (!c || !part) return <Empty />;
    const netOf = netByTerminal(nets);
    const netSize = new Map(nets.map((n) => [n.name, n.terminals.length]));
    return (
      <div className="panel-body">
        <div className="card">
          <h4>{part.name}</h4>
          <p className="muted small" style={{ margin: "0 0 8px" }}>
            {part.description}
          </p>
          <div className="kv">
            <span>Footprint</span>
            <span>{part.footprint?.name ?? "none"}</span>
            {part.mpn && (
              <>
                <span>MPN</span>
                <span>{part.mpn}</span>
              </>
            )}
          </div>
        </div>
        {part.kind === "part" && <TextField label="Reference" value={c.ref} onChange={(ref) => updateComponent(doc, c.id, { ref })} />}
        {variant && part.kind === "part" ? (
          <>
            <TextField label={`Value (${variant.name})`} value={c.value} onChange={(value) => setVariant(doc, { ...variant, values: { ...variant.values, [c.ref]: value } })} />
            <div className="field">
              <label>Fitted</label>
              <label className="small row" style={{ gap: 6 }}>
                <input
                  type="checkbox"
                  checked={!variant.dnp.includes(c.ref)}
                  onChange={(e) => setVariant(doc, { ...variant, dnp: e.target.checked ? variant.dnp.filter((r) => r !== c.ref) : [...variant.dnp, c.ref] })}
                />
                in variant {variant.name}
              </label>
            </div>
          </>
        ) : (
          <>
            <TextField label={part.kind === "part" ? "Value" : "Net name"} value={c.value} onChange={(value) => updateComponent(doc, c.id, { value })} />
            {part.kind === "part" && (
              <div className="field">
                <label>Fitted</label>
                <label className="small row" style={{ gap: 6 }}>
                  <input type="checkbox" checked={!c.dnp} onChange={(e) => updateComponent(doc, c.id, { dnp: !e.target.checked })} />
                  {c.dnp ? "Do not populate" : "Populate"}
                </label>
              </div>
            )}
          </>
        )}
        {design.sheets.length > 1 && (
          <div className="field">
            <label>Sheet</label>
            <select value={c.sheet ?? design.sheets[0].id} onChange={(e) => updateComponent(doc, c.id, { sheet: e.target.value })}>
              {design.sheets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {modelTypesForPart(c.partId).length > 0 && (
          <div className="field">
            <label>SPICE model</label>
            <select value={c.model ?? ""} onChange={(e) => updateComponent(doc, c.id, { model: e.target.value || undefined })}>
              <option value="">Built-in</option>
              {design.spiceModels
                .filter((m) => modelTypesForPart(c.partId).includes(m.type))
                .map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                  </option>
                ))}
            </select>
          </div>
        )}
        {mode === "schematic" ? (
          <div className="field">
            <label>Rotation</label>
            <button onClick={() => updateComponent(doc, c.id, { sch: { ...c.sch, rot: nextRotation(c.sch.rot) } })}>{c.sch.rot}° ↻</button>
            <label>Mirror</label>
            <label className="small row" style={{ gap: 6 }}>
              <input type="checkbox" checked={Boolean(c.sch.mirror)} onChange={(e) => updateComponent(doc, c.id, { sch: { ...c.sch, mirror: e.target.checked } })} /> left-right
            </label>
          </div>
        ) : (
          part.footprint && (
            <>
              <NumField label="X (mm)" value={c.pcb.x} onChange={(x) => updateComponent(doc, c.id, { pcb: { ...c.pcb, x } })} min={-1000} />
              <NumField label="Y (mm)" value={c.pcb.y} onChange={(y) => updateComponent(doc, c.id, { pcb: { ...c.pcb, y } })} min={-1000} />
              <div className="field">
                <label>Rotation</label>
                <button onClick={() => updateComponent(doc, c.id, { pcb: { ...c.pcb, rot: normAngle(c.pcb.rot + 90) } })}>{c.pcb.rot}° ↻</button>
              </div>
              <NumField label="Angle (°)" value={c.pcb.rot} onChange={(rot) => updateComponent(doc, c.id, { pcb: { ...c.pcb, rot: normAngle(rot) } })} min={-360} />
              <div className="field">
                <label>Side</label>
                <select value={c.pcb.side} onChange={(e) => updateComponent(doc, c.id, { pcb: { ...c.pcb, side: e.target.value as "top" | "bottom" } })}>
                  <option value="top">Top</option>
                  <option value="bottom">Bottom</option>
                </select>
              </div>
            </>
          )
        )}
        {part.kind === "part" && (
          <table className="pin-table">
            <tbody>
              {part.symbol.pins.map((p) => (
                <tr key={p.id}>
                  <td className="muted">{p.id}</td>
                  <td>{p.name}</td>
                  <td className="muted" style={{ fontSize: 10 }}>{(p.type ?? "passive").replace("_", " ")}</td>
                  <td className="muted" style={{ textAlign: "right" }}>
                    {(() => {
                      const n = netOf.get(termKey({ comp: c.id, pin: p.id }));
                      return n && (netSize.get(n) ?? 0) > 1 ? n : "—";
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          {part.kind === "part" && <button onClick={() => setEditing(c.id)}>Edit part…</button>}
          <button
            className="danger"
            onClick={() => {
              deleteComponent(doc, c.id);
              select(null);
            }}
          >
            Delete {c.ref}
          </button>
        </div>
        {editing === c.id && <PartEditor comp={c} onClose={() => setEditing(null)} />}
      </div>
    );
  }

  if (selection?.kind === "keepout") {
    const k = design.keepouts.find((x) => x.id === selection.id);
    if (!k) return <Empty />;
    const save = (patch: Partial<Keepout>) => keepoutsMap(doc).set(k.id, { ...k, ...patch });
    return (
      <div className="panel-body">
        <h4>{k.name ? "Rule area" : "Keepout"}</h4>
        <div className="field">
          <label>Name (custom design rules refer to it)</label>
          <input value={k.name ?? ""} placeholder="e.g. HV zone" onChange={(e) => save({ name: e.target.value || undefined })} />
        </div>
        <div className="field">
          <label>Layers</label>
          <div className="row" style={{ flexWrap: "wrap" }}>
            {copperLayers(design.board).map((l) => (
              <label key={l} className="small row" style={{ gap: 3 }}>
                <input type="checkbox" checked={k.layers.includes(l)} onChange={(e) => save({ layers: e.target.checked ? [...k.layers, l] : k.layers.filter((x) => x !== l) })} />
                {l}
              </label>
            ))}
          </div>
        </div>
        {(
          [
            ["noTracks", "No tracks"],
            ["noVias", "No vias"],
            ["noPours", "No pours"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="small row" style={{ gap: 6, marginBottom: 6 }}>
            <input type="checkbox" checked={k[key]} onChange={(e) => save({ [key]: e.target.checked })} />
            {label}
          </label>
        ))}
        <button className="danger" onClick={() => (deleteKeepout(doc, k.id), select(null))}>
          Delete keepout
        </button>
      </div>
    );
  }

  if (selection?.kind === "dimension") {
    const g = design.pcbGraphics.find((x) => x.id === selection.id);
    if (!g) return <Empty />;
    return (
      <div className="panel-body">
        <h4>Dimension</h4>
        <p className="small">{Math.hypot(g.points[1].x - g.points[0].x, g.points[1].y - g.points[0].y).toFixed(3)} mm (shown on the assembly drawing)</p>
        <button className="danger" onClick={() => (deletePcbGraphic(doc, g.id), select(null))}>
          Delete dimension
        </button>
      </div>
    );
  }

  if (selection?.kind === "graphic") {
    const g = design.schGraphics.find((x) => x.id === selection.id);
    if (!g) return <Empty />;
    return (
      <div className="panel-body">
        <h4>{g.kind === "bus" ? "Bus" : g.kind === "text" ? "Note" : "Graphic"}</h4>
        {(g.kind === "bus" || g.kind === "text") && <TextField label={g.kind === "bus" ? "Bus name" : "Text"} value={g.text ?? ""} onChange={(text) => schGraphicsMap(doc).set(g.id, { ...g, text })} />}
        {g.kind === "bus" && <p className="muted small">Members: {busMembers(g.text ?? "").join(", ")}. Connect them with labels of the same names.</p>}
        {g.kind === "text" && <NumField label="Size" value={g.size ?? 10} onChange={(size) => schGraphicsMap(doc).set(g.id, { ...g, size })} step={1} min={4} />}
        <button className="danger" onClick={() => (deleteSchGraphic(doc, g.id), select(null))}>
          Delete
        </button>
      </div>
    );
  }

  if (selection?.kind === "wire") {
    const w = design.wires.find((x) => x.id === selection.id);
    if (!w) return <Empty />;
    const net = netByTerminal(nets).get(termKey(w.a));
    return (
      <div className="panel-body">
        <h4>Wire</h4>
        <div className="kv" style={{ marginBottom: 12 }}>
          <span>Net</span>
          <span>{net}</span>
        </div>
        <button className="danger" onClick={() => (conn.doc.getMap("wires").delete(w.id), select(null))}>
          Delete wire
        </button>
      </div>
    );
  }

  if (selection?.kind === "trace") {
    const t = design.traces.find((x) => x.id === selection.id);
    if (!t) return <Empty />;
    const len = t.points.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - t.points[i].x, p.y - t.points[i].y), 0);
    return (
      <div className="panel-body">
        <h4>Trace</h4>
        <div className="kv" style={{ marginBottom: 12 }}>
          <span>Layer</span>
          <span>{t.layer}</span>
          <span>Length</span>
          <span>{len.toFixed(2)} mm</span>
        </div>
        <TraceLengthTuner traceId={t.id} />
        <NumField label="Width (mm)" value={t.width} onChange={(width) => tracesMap(doc).set(t.id, { ...t, width })} min={0.05} />
        <div className="field">
          <label>Layer</label>
          <select value={t.layer} onChange={(e) => tracesMap(doc).set(t.id, { ...t, layer: e.target.value as CopperLayer })}>
            {copperLayers(design.board).map((l) => (
              <option key={l} value={l}>
                {layerLabel(l)}
              </option>
            ))}
          </select>
        </div>
        <div className="kv small" style={{ marginBottom: 12 }}>
          <span>Impedance</span>
          <span>{copperLayers(design.board).includes(t.layer) ? `${traceImpedance(design.board, t.layer, t.width).toFixed(1)} Ω` : "—"}</span>
        </div>
        <button className="danger" onClick={() => (deleteTrace(doc, t.id), select(null))}>
          Delete trace
        </button>
      </div>
    );
  }

  if (selection?.kind === "zone") {
    const z = design.zones.find((x) => x.id === selection.id);
    if (!z) return <Empty />;
    const names = nets.filter((n) => n.terminals.length > 1).map((n) => n.name);
    return (
      <div className="panel-body">
        <h4>Copper pour</h4>
        <div className="field">
          <label>Net</label>
          <select value={z.net} onChange={(e) => zonesMap(doc).set(z.id, { ...z, net: e.target.value })}>
            {(names.includes(z.net) ? names : [z.net, ...names]).map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Layer</label>
          <select value={z.layer} onChange={(e) => zonesMap(doc).set(z.id, { ...z, layer: e.target.value as CopperLayer })}>
            {copperLayers(design.board).map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Pad connection</label>
          <select value={z.padConnection ?? "thermal"} onChange={(e) => zonesMap(doc).set(z.id, { ...z, padConnection: e.target.value as "thermal" | "solid" })}>
            <option value="thermal">Thermal relief</option>
            <option value="solid">Solid</option>
          </select>
        </div>
        {(z.padConnection ?? "thermal") === "thermal" && (
          <>
            <NumField label="Thermal gap" value={z.thermalGap ?? 0.5} onChange={(thermalGap) => zonesMap(doc).set(z.id, { ...z, thermalGap })} min={0.1} />
            <NumField label="Spoke width" value={z.spokeWidth ?? 0.3} onChange={(spokeWidth) => zonesMap(doc).set(z.id, { ...z, spokeWidth })} min={0.1} />
          </>
        )}
        <label className="small row" style={{ gap: 6, marginBottom: 8 }}>
          <input type="checkbox" checked={z.removeIslands ?? true} onChange={(e) => zonesMap(doc).set(z.id, { ...z, removeIslands: e.target.checked })} />
          Remove isolated islands
        </label>
        <div className="field">
          <label>Fill</label>
          <select value={z.fill ?? "solid"} onChange={(e) => zonesMap(doc).set(z.id, { ...z, fill: e.target.value as "solid" | "hatch" })}>
            <option value="solid">Solid</option>
            <option value="hatch">Hatched</option>
          </select>
        </div>
        {z.fill === "hatch" && (
          <>
            <NumField label="Hatch width" value={z.hatchWidth ?? 0.25} onChange={(hatchWidth) => zonesMap(doc).set(z.id, { ...z, hatchWidth })} min={0.1} />
            <NumField label="Hatch gap" value={z.hatchGap ?? 1} onChange={(hatchGap) => zonesMap(doc).set(z.id, { ...z, hatchGap })} min={0.2} />
          </>
        )}
        <NumField label="Priority" value={z.priority ?? 0} step={1} onChange={(priority) => zonesMap(doc).set(z.id, { ...z, priority: Math.round(priority) })} />
        <p className="muted small">Same-net pads inside the outline connect through the pour; other nets get clearance automatically. {z.points.length} outline points.</p>
        <button className="danger" onClick={() => (deleteZone(doc, z.id), select(null))}>
          Delete pour
        </button>
      </div>
    );
  }

  if (selection?.kind === "via") {
    const v = design.vias.find((x) => x.id === selection.id);
    if (!v) return <Empty />;
    const all = copperLayers(design.board);
    const span = viaLayers(design.board, v);
    const setSpan = (from: CopperLayer, to: CopperLayer) => {
      const [a, b] = [all.indexOf(from), all.indexOf(to)].sort((x, y) => x - y);
      const through = a === 0 && b === all.length - 1;
      const { from: _f, to: _t, ...rest } = v;
      viasMap(doc).set(v.id, through ? rest : { ...rest, from: all[a], to: all[b] });
    };
    return (
      <div className="panel-body">
        <h4>Via</h4>
        <div className="kv" style={{ marginBottom: 10 }}>
          <span>Type</span>
          <span>{viaKind(design.board, v)}</span>
        </div>
        <div className="field">
          <label>From</label>
          <select value={span[0]} onChange={(e) => setSpan(e.target.value as CopperLayer, span[span.length - 1])}>
            {all.map((l) => (
              <option key={l} value={l}>
                {layerLabel(l)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>To</label>
          <select value={span[span.length - 1]} onChange={(e) => setSpan(span[0], e.target.value as CopperLayer)}>
            {all.map((l) => (
              <option key={l} value={l}>
                {layerLabel(l)}
              </option>
            ))}
          </select>
        </div>
        <NumField label="Diameter" value={v.diameter} onChange={(diameter) => viasMap(doc).set(v.id, { ...v, diameter })} min={0.15} />
        <NumField label="Drill" value={v.drill} onChange={(drill) => viasMap(doc).set(v.id, { ...v, drill: Math.min(drill, v.diameter - 0.05) })} min={0.05} />
        <button className="danger" onClick={() => (deleteVia(doc, selection.id), select(null))}>
          Delete via
        </button>
      </div>
    );
  }

  return <Empty />;
}

function Empty() {
  const { design, conn } = useEditor();
  const b = design.board;
  const set = (patch: Partial<BoardSettings>) => setBoard(conn.doc, patch);
  const parts = design.components.filter((c) => getPart(c.partId)?.kind === "part");
  return (
    <div className="panel-body">
      <h4>Board</h4>
      <NumField label="Width (mm)" value={b.width} onChange={(width) => set({ width })} step={1} min={5} />
      <NumField label="Height (mm)" value={b.height} onChange={(height) => set({ height })} step={1} min={5} />
      <div className="field">
        <label>Copper layers</label>
        <select value={b.layers} onChange={(e) => set({ layers: Number(e.target.value), stackup: undefined })}>
          {Array.from({ length: 16 }, (_, i) => 2 * (i + 1)).map((n) => (
            <option key={n} value={n}>
              {n === 2 ? "2 (top, bottom)" : n === 4 ? "4 (top, in1, in2, bottom)" : `${n} layers`}
            </option>
          ))}
        </select>
      </div>
      <NumField label="Thickness" value={b.thickness} onChange={(thickness) => set({ thickness, stackup: undefined })} step={0.1} min={0.2} />
      <NumField label="Clearance" value={b.clearance} onChange={(clearance) => set({ clearance })} min={0.05} />
      {!b.outline && <NumField label="Corner radius" value={b.cornerRadius ?? 0} onChange={(cornerRadius) => set({ cornerRadius })} step={0.5} min={0} />}
      {b.outline && <p className="muted small">Custom outline ({b.outline.length} points). Use PCB toolbar → Outline… to redraw or reset it.</p>}
      {(b.cutouts?.length ?? 0) > 0 && (
        <div className="field">
          <label>Cutouts</label>
          <button className="small" onClick={() => set({ cutouts: [] })}>
            Remove {b.cutouts!.length}
          </button>
        </div>
      )}
      <label className="small row" style={{ gap: 6, marginBottom: 8 }}>
        <input type="checkbox" checked={Boolean(b.teardrops)} onChange={(e) => set({ teardrops: e.target.checked })} />
        Teardrops at pads and vias
      </label>
      <NumField label="Trace width" value={b.defaultTraceWidth} onChange={(defaultTraceWidth) => set({ defaultTraceWidth })} min={0.05} />
      <StackupCard />
      <NetClasses />
      <DiffPairsCard />
      <LengthGroupsCard />
      <Variants />
      <TitleBlockCard />
      <div className="card" style={{ marginTop: 12 }}>
        <div className="kv">
          <span>Components</span>
          <span>{parts.length}</span>
          <span>Wires</span>
          <span>{design.wires.length}</span>
          <span>Traces</span>
          <span>{design.traces.length}</span>
          <span>Vias</span>
          <span>{design.vias.length}</span>
          <span>Pours</span>
          <span>{design.zones.length}</span>
          <span>Sheets</span>
          <span>{design.sheets.length}</span>
        </div>
      </div>
      <p className="muted small">Select a part, wire or trace to edit it. Pick parts from the library on the left, or ask the copilot to design a circuit.</p>
    </div>
  );
}

function NetClasses() {
  const { design, conn, nets } = useEditor();
  const [adding, setAdding] = useState(false);
  const names = nets.filter((n) => n.terminals.length > 1).map((n) => n.name);
  const save = (nc: NetClass) => setNetClass(conn.doc, nc);
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <h4 style={{ margin: 0 }}>Net classes</h4>
        <span className="spacer" />
        <button className="small" onClick={() => setAdding(true)}>
          + Class
        </button>
      </div>
      {design.netClasses.length === 0 && !adding && <p className="muted small" style={{ margin: 0 }}>All nets use the board defaults. Add a class for wider power traces or extra clearance.</p>}
      {design.netClasses.map((nc) => (
        <div key={nc.name} style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 8 }}>
          <div className="row">
            <b className="small">{nc.name}</b>
            <span className="spacer" />
            <button className="ghost small danger" onClick={() => deleteNetClass(conn.doc, nc.name)}>
              Remove
            </button>
          </div>
          <NumField label="Trace (mm)" value={nc.traceWidth} onChange={(traceWidth) => save({ ...nc, traceWidth })} min={0.05} />
          <NumField label="Clearance" value={nc.clearance} onChange={(clearance) => save({ ...nc, clearance })} min={0.05} />
          <NumField
            label="Impedance Ω"
            value={nc.impedance ?? 0}
            step={1}
            onChange={(z) => {
              // Solving the width from the stackup keeps the class on target for the outer layers.
              const w = z > 0 ? widthForImpedance(design.board, "top", z) : null;
              save({ ...nc, impedance: z > 0 ? z : undefined, ...(w ? { traceWidth: Math.round(w * 1000) / 1000 } : {}) });
            }}
          />
          <NumField label="Via Ø / drill" value={nc.viaDiameter} onChange={(viaDiameter) => save({ ...nc, viaDiameter, viaDrill: Math.min(nc.viaDrill, viaDiameter - 0.2) })} min={0.3} />
          <div className="field">
            <label>Nets</label>
            <select
              multiple
              value={nc.nets}
              style={{ height: 70 }}
              onChange={(e) => save({ ...nc, nets: [...e.target.selectedOptions].map((o) => o.value) })}
            >
              {[...new Set([...names, ...nc.nets])].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
        </div>
      ))}
      {adding && (
        <form
          className="row"
          style={{ marginTop: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
            if (name) save({ name, traceWidth: 0.5, clearance: 0.25, viaDiameter: 0.8, viaDrill: 0.4, nets: [] });
            setAdding(false);
          }}
        >
          <input name="name" placeholder="e.g. Power" autoFocus style={{ flex: 1 }} />
          <button className="primary small">Add</button>
        </form>
      )}
    </div>
  );
}

function Variants() {
  const { design, conn } = useEditor();
  const doc = conn.doc;
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <h4 style={{ margin: 0 }}>Variants</h4>
        <span className="spacer" />
        <button
          className="small"
          onClick={() => {
            const name = prompt("Variant name (e.g. Lite, Pro)");
            if (name?.trim()) setVariant(doc, { name: name.trim(), dnp: [], values: {} });
          }}
        >
          + Variant
        </button>
      </div>
      {design.variants.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>Assembly variants change which parts are fitted and their values. BOM, 3D, simulation and exports follow the active variant.</p>
      ) : (
        <>
          <div className="field">
            <label>Active</label>
            <select value={design.activeVariant} onChange={(e) => setActiveVariant(doc, e.target.value)}>
              <option value="">(base design)</option>
              {design.variants.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name}
                </option>
              ))}
            </select>
          </div>
          {design.variants.map((v) => (
            <div key={v.name} className="row small" style={{ borderTop: "1px solid var(--border)", paddingTop: 6, marginTop: 6 }}>
              <b>{v.name}</b>
              <span className="muted">
                {v.dnp.length} not fitted · {Object.keys(v.values).length} value changes
              </span>
              <span className="spacer" />
              <button className="ghost small danger" onClick={() => deleteVariant(doc, v.name)}>
                Remove
              </button>
            </div>
          ))}
          <p className="muted small" style={{ marginBottom: 0 }}>Select a part while a variant is active to change its value or fitted state in that variant.</p>
        </>
      )}
    </div>
  );
}

function TitleBlockCard() {
  const { design, conn } = useEditor();
  const tb = design.titleBlock;
  const set = (k: keyof typeof tb) => (v: string) => setTitleBlock(conn.doc, { [k]: v });
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h4>Title block</h4>
      <TextField label="Title" value={tb.title || design.name} onChange={set("title")} />
      <TextField label="Revision" value={tb.revision} onChange={set("revision")} />
      <TextField label="Date" value={tb.date || new Date().toISOString().slice(0, 10)} onChange={set("date")} />
      <TextField label="Company" value={tb.company} onChange={set("company")} />
      <TextField label="Author" value={tb.author} onChange={set("author")} />
    </div>
  );
}
