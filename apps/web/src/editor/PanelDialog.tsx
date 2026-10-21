import { panelize, type PanelOptions } from "@pcbian/core";
import { useMemo, useState } from "react";
import { useEditor } from "./context";

/** Panelize the board: layout options with a live preview, and the panel's fabrication zip. */
export function PanelDialog({ onClose, onExport }: { onClose: () => void; onExport: (o: PanelOptions) => Promise<void> }) {
  const { design, toast } = useEditor();
  const [o, setO] = useState<PanelOptions>({ cols: 2, rows: 2, gap: 2, rail: 5, rails: "tb", separation: "tabs", tabWidth: 3, mouseBites: true, fiducials: true, toolingHoles: true });
  const [busy, setBusy] = useState(false);
  const p = useMemo(() => panelize(design, o), [design, o]);
  const set = (patch: Partial<PanelOptions>) => setO({ ...o, ...patch });
  const num = (k: keyof PanelOptions, min: number, step = 1) => (
    <input type="number" min={min} step={step} value={o[k] as number} onChange={(e) => set({ [k]: Math.max(min, Number(e.target.value) || min) } as Partial<PanelOptions>)} style={{ width: 64 }} />
  );
  const pad = 3;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal panel-dialog" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: 0 }}>Panelize</h3>
        <div className="panel-grid">
          <div className="panel-form small">
            <label>Columns</label>
            {num("cols", 1)}
            <label>Rows</label>
            {num("rows", 1)}
            <label>Separation</label>
            <select value={o.separation} onChange={(e) => set({ separation: e.target.value as PanelOptions["separation"] })}>
              <option value="tabs">Tabs + mouse bites</option>
              <option value="vscore">V-score</option>
            </select>
            {o.separation === "tabs" && (
              <>
                <label>Gap (mm)</label>
                {num("gap", 0.5, 0.5)}
                <label>Tab width</label>
                {num("tabWidth", 1, 0.5)}
              </>
            )}
            <label>Rails</label>
            <select value={o.rails} onChange={(e) => set({ rails: e.target.value as PanelOptions["rails"] })}>
              <option value="tb">Top and bottom</option>
              <option value="lr">Left and right</option>
              <option value="all">All sides</option>
              <option value="none">None</option>
            </select>
            {o.rails !== "none" && (
              <>
                <label>Rail width</label>
                {num("rail", 3, 0.5)}
              </>
            )}
            <label>Extras</label>
            <div>
              <label className="row" style={{ gap: 4 }}>
                <input type="checkbox" checked={o.fiducials} onChange={(e) => set({ fiducials: e.target.checked })} /> fiducials
              </label>
              <label className="row" style={{ gap: 4 }}>
                <input type="checkbox" checked={o.toolingHoles} onChange={(e) => set({ toolingHoles: e.target.checked })} /> tooling holes
              </label>
            </div>
          </div>
          <svg className="panel-preview" viewBox={`${-pad} ${-pad} ${p.width + 2 * pad} ${p.height + 2 * pad}`}>
            <rect x={0} y={0} width={p.width} height={p.height} fill="#1f5e3b" />
            {(p.design.board.cutouts ?? []).map((c, i) => (
              <polygon key={i} points={c.map((q) => `${q.x},${q.y}`).join(" ")} fill="var(--panel)" />
            ))}
            {p.tabs.map((t, i) => (
              <polygon key={`t${i}`} points={t.map((q) => `${q.x},${q.y}`).join(" ")} fill="#2f7d52" />
            ))}
            {p.boards.map((b, i) => (
              <rect key={`b${i}`} x={b.x} y={b.y} width={design.board.width} height={design.board.height} fill="none" stroke="#e8d27a" strokeWidth={Math.max(p.width, p.height) / 400} />
            ))}
            {p.design.traces.map((t) => (
              <polyline key={t.id} points={t.points.map((q) => `${q.x},${q.y}`).join(" ")} fill="none" stroke="#c9a227" strokeWidth={t.width} opacity={0.8} />
            ))}
            {p.design.components
              .filter((c) => c.partId === "fiducial" && c.pcb.side === "top")
              .map((c) => (
                <circle key={c.id} cx={c.pcb.x} cy={c.pcb.y} r={1} fill="#d4a64a" />
              ))}
            {p.npth.map((h, i) => (
              <circle key={`h${i}`} cx={h.at.x} cy={h.at.y} r={h.d / 2} fill="#0b0d10" />
            ))}
            {p.vscore.map(([a, b], i) => (
              <line key={`v${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#ef4444" strokeWidth={Math.max(p.width, p.height) / 300} strokeDasharray="2 1" />
            ))}
          </svg>
        </div>
        <div className="small">
          <b>
            {p.width.toFixed(1)} × {p.height.toFixed(1)} mm
          </b>{" "}
          · {p.boards.length} boards{p.tabs.length ? ` · ${p.tabs.length} tabs` : ""}
          {p.npth.length ? ` · ${p.npth.length} non-plated holes` : ""}
          {p.vscore.length ? ` · ${p.vscore.length} score lines` : ""}
        </div>
        {p.warnings.map((w) => (
          <div key={w} className="small warn-text">
            {w}
          </div>
        ))}
        <div className="row">
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onExport(o);
              } catch (e) {
                toast((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Building…" : "Download panel (.zip)"}
          </button>
        </div>
      </div>
    </div>
  );
}
