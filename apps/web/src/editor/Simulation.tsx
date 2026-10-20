import { simulateDC } from "@pcbian/core";
import { useMemo, useState } from "react";
import { useEditor } from "./context";

const fmtA = (i: number) => (Math.abs(i) >= 1 ? `${i.toFixed(3)} A` : Math.abs(i) >= 1e-3 ? `${(i * 1e3).toFixed(2)} mA` : `${(i * 1e6).toFixed(1)} µA`);
const fmtW = (p: number) => (Math.abs(p) >= 1 ? `${p.toFixed(3)} W` : `${(p * 1e3).toFixed(1)} mW`);

export function Simulation() {
  const { design } = useEditor();
  const [live, setLive] = useState(true);
  const [snapshot, setSnapshot] = useState(design);
  const target = live ? design : snapshot;
  const r = useMemo(() => simulateDC(target), [target]);

  return (
    <div className="panel-body">
      <div className="row" style={{ marginBottom: 10 }}>
        <h4 style={{ margin: 0 }}>DC operating point</h4>
        <span className="spacer" />
        <label className="small row" style={{ gap: 4 }}>
          <input type="checkbox" checked={live} onChange={(e) => (setLive(e.target.checked), setSnapshot(design))} /> Live
        </label>
        {!live && <button className="small" onClick={() => setSnapshot(design)}>Re-run</button>}
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        Supplies come from rail names (+5V, +3V3, VBUS…) referenced to GND. Resistors, LEDs, diodes, fuses, inductors and AMS1117 regulators are modelled; capacitors are open at DC.
      </p>
      {!r.ok ? (
        <div className="card small">{r.error}</div>
      ) : (
        <>
          {r.warnings.length > 0 && (
            <div className="card small" style={{ borderColor: "#5b4a12" }}>
              {r.warnings.map((w, i) => (
                <div key={i} style={{ color: "var(--warn)", marginBottom: 3 }}>
                  ⚠ {w}
                </div>
              ))}
            </div>
          )}
          <h4>Supplies</h4>
          <table className="pin-table" style={{ marginBottom: 12 }}>
            <tbody>
              {r.supplies.map((s) => (
                <tr key={s.name}>
                  <td>{s.name}</td>
                  <td className="muted">{s.voltage.toFixed(2)} V</td>
                  <td style={{ textAlign: "right" }}>{fmtA(s.current)}</td>
                  <td className="muted" style={{ textAlign: "right" }}>{fmtW(s.power)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4>Components</h4>
          <table className="pin-table" style={{ marginBottom: 12 }}>
            <tbody>
              {r.elements.map((e) => (
                <tr key={e.ref}>
                  <td>{e.label}</td>
                  <td className="muted">{e.voltage.toFixed(3)} V</td>
                  <td style={{ textAlign: "right" }}>{fmtA(e.current)}</td>
                  <td className="muted" style={{ textAlign: "right" }}>{fmtW(e.power)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4>Node voltages</h4>
          <table className="pin-table">
            <tbody>
              {r.nodes.map((n) => (
                <tr key={n.net}>
                  <td>{n.net}</td>
                  <td style={{ textAlign: "right" }}>{n.voltage.toFixed(3)} V</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
