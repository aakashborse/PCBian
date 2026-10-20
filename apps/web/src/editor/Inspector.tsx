import {
  deleteComponent,
  deleteTrace,
  deleteVia,
  getPart,
  netByTerminal,
  nextRotation,
  setBoard,
  termKey,
  tracesMap,
  updateComponent,
  copperLayers,
  deleteNetClass,
  deleteZone,
  setNetClass,
  zonesMap,
  type BoardSettings,
  type CopperLayer,
  type NetClass,
} from "@pcbian/core";
import { useEffect, useState } from "react";
import { useEditor } from "./context";

function NumField({ label, value, onChange, step = 0.05, min = 0 }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number }) {
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
        <TextField label={part.kind === "part" ? "Value" : "Net name"} value={c.value} onChange={(value) => updateComponent(doc, c.id, { value })} />
        <div className="field">
          <label>Fitted</label>
          <label className="small row" style={{ gap: 6 }}>
            <input type="checkbox" checked={!c.dnp} onChange={(e) => updateComponent(doc, c.id, { dnp: !e.target.checked })} />
            {c.dnp ? "Do not populate" : "Populate"}
          </label>
        </div>
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
        {mode === "schematic" ? (
          <div className="field">
            <label>Rotation</label>
            <button onClick={() => updateComponent(doc, c.id, { sch: { ...c.sch, rot: nextRotation(c.sch.rot) } })}>{c.sch.rot}° ↻</button>
          </div>
        ) : (
          part.footprint && (
            <>
              <NumField label="X (mm)" value={c.pcb.x} onChange={(x) => updateComponent(doc, c.id, { pcb: { ...c.pcb, x } })} min={-1000} />
              <NumField label="Y (mm)" value={c.pcb.y} onChange={(y) => updateComponent(doc, c.id, { pcb: { ...c.pcb, y } })} min={-1000} />
              <div className="field">
                <label>Rotation</label>
                <button onClick={() => updateComponent(doc, c.id, { pcb: { ...c.pcb, rot: nextRotation(c.pcb.rot) } })}>{c.pcb.rot}° ↻</button>
              </div>
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
        <button
          className="danger"
          style={{ marginTop: 12 }}
          onClick={() => {
            deleteComponent(doc, c.id);
            select(null);
          }}
        >
          Delete {c.ref}
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
        <NumField label="Width (mm)" value={t.width} onChange={(width) => tracesMap(doc).set(t.id, { ...t, width })} min={0.05} />
        <div className="field">
          <label>Layer</label>
          <select value={t.layer} onChange={(e) => tracesMap(doc).set(t.id, { ...t, layer: e.target.value as "top" | "bottom" })}>
            <option value="top">Top</option>
            <option value="bottom">Bottom</option>
          </select>
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
        <p className="muted small">Same-net pads inside the outline connect through the pour; other nets get clearance automatically. {z.points.length} outline points.</p>
        <button className="danger" onClick={() => (deleteZone(doc, z.id), select(null))}>
          Delete pour
        </button>
      </div>
    );
  }

  if (selection?.kind === "via") {
    return (
      <div className="panel-body">
        <h4>Via</h4>
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
        <select value={b.layers} onChange={(e) => set({ layers: Number(e.target.value) as 2 | 4 })}>
          <option value={2}>2 (top, bottom)</option>
          <option value={4}>4 (top, in1, in2, bottom)</option>
        </select>
      </div>
      <NumField label="Thickness" value={b.thickness} onChange={(thickness) => set({ thickness })} step={0.1} min={0.2} />
      <NumField label="Clearance" value={b.clearance} onChange={(clearance) => set({ clearance })} min={0.05} />
      <NumField label="Trace width" value={b.defaultTraceWidth} onChange={(defaultTraceWidth) => set({ defaultTraceWidth })} min={0.05} />
      <NetClasses />
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
