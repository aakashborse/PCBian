import { enclosure, setEnclosure, type EnclosureOptions } from "@pcbian/core";
import { useMemo, useState } from "react";
import { useEditor } from "./context";

const FIELDS: [keyof EnclosureOptions, string, string][] = [
  ["wall", "Wall / floor / lid", "mm"],
  ["clearance", "Board clearance", "mm"],
  ["standoff", "Standoff height", "mm"],
  ["headroom", "Headroom", "mm"],
  ["edgeReach", "Opening reach", "mm"],
  ["openingMargin", "Opening margin", "mm"],
];
const DEFAULTS: Required<EnclosureOptions> = { wall: 2, clearance: 0.5, standoff: 4, headroom: 2, edgeReach: 1.5, openingMargin: 0.5 };

/** Design an enclosure around the board: settings saved with the design, STEP download. */
export function EnclosureDialog({ onClose, onExport }: { onClose: () => void; onExport: (o: EnclosureOptions, withBoard: boolean) => Promise<void> }) {
  const { design, conn, toast } = useEditor();
  const [o, setO] = useState<Required<EnclosureOptions>>({ ...DEFAULTS, ...design.enclosure });
  const [withBoard, setWithBoard] = useState(true);
  const [busy, setBusy] = useState(false);
  const e = useMemo(() => enclosure(design, o), [design, o]);
  const size = (a: number, b: number) => (b - a).toFixed(1);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(ev) => ev.stopPropagation()} style={{ width: "min(560px, calc(100vw - 32px))" }}>
        <h3 style={{ margin: 0 }}>Enclosure</h3>
        <p className="muted small" style={{ margin: 0 }}>
          A base and lid around the board: standoffs under the mounting holes, room over the tallest part, and openings in the walls for parts at the board edge.
        </p>
        <div className="panel-form small" style={{ gridTemplateColumns: "140px 90px" }}>
          {FIELDS.map(([k, label, unit]) => (
            <label key={k} style={{ display: "contents" }}>
              <span>
                {label} <span className="muted">({unit})</span>
              </span>
              <input type="number" min={0} step={0.5} value={o[k]} onChange={(ev) => setO({ ...o, [k]: Math.max(0, Number(ev.target.value) || 0) })} />
            </label>
          ))}
        </div>
        <div className="card small" style={{ margin: 0 }}>
          <b>
            {size(e.outer.x0, e.outer.x1)} × {size(e.outer.y0, e.outer.y1)} × {size(e.outer.z0, e.outer.z1)} mm
          </b>{" "}
          outside · tallest part {e.tallest.toFixed(1)} mm · {e.standoffs.length} standoffs
          {e.cutouts.length > 0 && (
            <div className="muted">
              Openings: {e.cutouts.map((c) => `${c.ref} (${c.side}, ${(c.a1 - c.a0).toFixed(1)} × ${(c.z1 - c.z0).toFixed(1)} mm)`).join(", ")}
            </div>
          )}
          {e.warnings.map((w) => (
            <div key={w} className="warn-text">
              {w}
            </div>
          ))}
        </div>
        <div className="row small" style={{ gap: 12 }}>
          <label className="row" style={{ gap: 4 }}>
            <input type="checkbox" checked={withBoard} onChange={(ev) => setWithBoard(ev.target.checked)} /> include the board in the STEP
          </label>
          <label className="row" style={{ gap: 4 }}>
            <input type="checkbox" checked={!!design.enclosure?.show} onChange={(ev) => setEnclosure(conn.doc, { ...o, show: ev.target.checked })} /> show in 3D view
          </label>
        </div>
        <div className="row">
          <button
            className="ghost small"
            onClick={() => {
              setEnclosure(conn.doc, { ...o, show: design.enclosure?.show });
              toast("Enclosure settings saved with the design");
            }}
          >
            Save settings
          </button>
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setEnclosure(conn.doc, { ...o, show: design.enclosure?.show });
                await onExport(o, withBoard);
              } catch (err) {
                toast((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Building…" : "Download STEP"}
          </button>
        </div>
      </div>
    </div>
  );
}
