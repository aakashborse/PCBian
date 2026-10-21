import { copperLayers, defaultStackup, diffImpedance, gapForDiffImpedance, layerLabel, OZ_MM, setBoard, stackupOf, stackupThickness, traceImpedance, widthForImpedance, type CopperLayer, type Stackup } from "@pcbian/core";
import { useState } from "react";
import { useEditor } from "./context";

/** Layer stackup table (copper weights, dielectrics) and a controlled-impedance calculator. */
export function StackupCard() {
  const { design, conn } = useEditor();
  const b = design.board;
  const st = stackupOf(b);
  const layers = copperLayers(b);
  const save = (next: Stackup) => setBoard(conn.doc, { stackup: next, thickness: Math.round(stackupThickness(next) * 100) / 100 });
  const num = (v: string, min: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? n : null;
  };
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <h4 style={{ margin: 0 }}>Stackup</h4>
        <span className="spacer" />
        <button className="small" onClick={() => save(defaultStackup(layers.length, b.thickness))} title="Regenerate a standard stack for this layer count">
          Reset
        </button>
      </div>
      <table className="pin-table stackup">
        <tbody>
          {layers.map((l, i) => (
            <StackRows key={l} l={l} i={i} st={st} save={save} num={num} />
          ))}
        </tbody>
      </table>
      <div className="small muted" style={{ marginTop: 6 }}>
        Total {stackupThickness(st).toFixed(3)} mm incl. mask · board thickness follows the stack
      </div>
      <ImpedanceCalc />
    </div>
  );
}

function StackRows({ l, i, st, save, num }: { l: CopperLayer; i: number; st: Stackup; save: (s: Stackup) => void; num: (v: string, min: number) => number | null }) {
  const d = st.dielectrics[i];
  return (
    <>
      <tr className="cu">
        <td>
          L{i + 1} {layerLabel(l)}
        </td>
        <td colSpan={2}>
          <input
            type="number"
            step={0.5}
            min={0.25}
            defaultValue={st.copperOz[i]}
            key={`cu${i}-${st.copperOz[i]}`}
            onBlur={(e) => {
              const v = num(e.target.value, 0.25);
              if (v !== null && v !== st.copperOz[i]) save({ ...st, copperOz: st.copperOz.map((x, k) => (k === i ? v : x)) });
            }}
            style={{ width: 52 }}
          />{" "}
          oz <span className="muted">({(st.copperOz[i] * OZ_MM * 1000).toFixed(0)} µm)</span>
        </td>
      </tr>
      {d && (
        <tr className="diel">
          <td>
            <select value={d.kind} onChange={(e) => save({ ...st, dielectrics: st.dielectrics.map((x, k) => (k === i ? { ...x, kind: e.target.value as "core" | "prepreg" } : x)) })}>
              <option value="core">core</option>
              <option value="prepreg">prepreg</option>
            </select>
          </td>
          <td>
            <input
              type="number"
              step={0.01}
              min={0.03}
              defaultValue={d.thickness}
              key={`t${i}-${d.thickness}`}
              title="Thickness (mm)"
              onBlur={(e) => {
                const v = num(e.target.value, 0.03);
                if (v !== null && v !== d.thickness) save({ ...st, dielectrics: st.dielectrics.map((x, k) => (k === i ? { ...x, thickness: v } : x)) });
              }}
              style={{ width: 60 }}
            />{" "}
            mm
          </td>
          <td>
            εr{" "}
            <input
              type="number"
              step={0.1}
              min={1}
              defaultValue={d.er}
              key={`e${i}-${d.er}`}
              onBlur={(e) => {
                const v = num(e.target.value, 1);
                if (v !== null && v !== d.er) save({ ...st, dielectrics: st.dielectrics.map((x, k) => (k === i ? { ...x, er: v } : x)) });
              }}
              style={{ width: 46 }}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function ImpedanceCalc() {
  const { design } = useEditor();
  const b = design.board;
  const layers = copperLayers(b);
  const [layer, setLayer] = useState<CopperLayer>("top");
  const [width, setWidth] = useState(b.defaultTraceWidth);
  const [gap, setGap] = useState(0.15);
  const [target, setTarget] = useState(50);
  const [targetDiff, setTargetDiff] = useState(90);
  const l = layers.includes(layer) ? layer : "top";
  const z0 = traceImpedance(b, l, width);
  const zd = diffImpedance(b, l, width, gap);
  const wFor = widthForImpedance(b, l, target);
  const gFor = gapForDiffImpedance(b, l, width, targetDiff);
  return (
    <div style={{ borderTop: "1px solid var(--border)", marginTop: 10, paddingTop: 8 }}>
      <h4 style={{ margin: "0 0 6px" }}>Impedance</h4>
      <div className="field">
        <label>Layer</label>
        <select value={l} onChange={(e) => setLayer(e.target.value as CopperLayer)}>
          {layers.map((x) => (
            <option key={x} value={x}>
              {layerLabel(x)} ({x === "top" || x === "bottom" ? "microstrip" : "stripline"})
            </option>
          ))}
        </select>
      </div>
      <div className="imp-grid small">
        <label>Width</label>
        <input type="number" step={0.01} min={0.02} value={width} onChange={(e) => setWidth(Math.max(0.02, Number(e.target.value) || 0.02))} />
        <b>{z0.toFixed(1)} Ω</b>
        <label>Gap</label>
        <input type="number" step={0.01} min={0.02} value={gap} onChange={(e) => setGap(Math.max(0.02, Number(e.target.value) || 0.02))} />
        <b>{zd.toFixed(1)} Ω diff</b>
        <label>Target Z₀</label>
        <input type="number" step={1} min={10} value={target} onChange={(e) => setTarget(Number(e.target.value) || 50)} />
        <span>{wFor ? <button className="ghost small" onClick={() => setWidth(wFor)}>w = {wFor.toFixed(3)} mm</button> : "out of range"}</span>
        <label>Target Zdiff</label>
        <input type="number" step={1} min={20} value={targetDiff} onChange={(e) => setTargetDiff(Number(e.target.value) || 90)} />
        <span>{gFor ? <button className="ghost small" onClick={() => setGap(gFor)}>gap = {gFor.toFixed(3)} mm</button> : "not reachable at this width"}</span>
      </div>
      <p className="muted small" style={{ margin: "6px 0 0" }}>
        IPC-2141 closed-form estimates (±10%); confirm final widths with your fabricator.
      </p>
    </div>
  );
}
