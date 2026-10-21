import { decouplingCheck, irDrop, isGroundNet, railVoltage, signalIntegrity, thermalAnalysis, type DecouplingResult, type IrDropResult, type SiReport, type ThermalResult } from "@pcbian/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "./context";

type Mode = "si" | "pi" | "thermal";

/** Signal integrity, power integrity and thermal analysis of the routed board. */
export function Analysis() {
  const [mode, setMode] = useState<Mode>("si");
  return (
    <div className="panel-body analysis">
      <div className="tabs" style={{ marginBottom: 10, width: "fit-content" }}>
        {(
          [
            ["si", "Signal"],
            ["pi", "Power"],
            ["thermal", "Thermal"],
          ] as const
        ).map(([m, label]) => (
          <button key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
            {label}
          </button>
        ))}
      </div>
      {mode === "si" ? <SiView /> : mode === "pi" ? <PiView /> : <ThermalView />}
    </div>
  );
}

/** Run a blocking computation after the busy state has painted. */
function useRunner() {
  const { toast } = useEditor();
  const [busy, setBusy] = useState(false);
  const run = (f: () => void) => {
    setBusy(true);
    setTimeout(() => {
      try {
        f();
      } catch (e) {
        toast((e as Error).message);
      } finally {
        setBusy(false);
      }
    }, 20);
  };
  return { busy, run };
}

function Issues({ issues }: { issues: { severity: string; message: string }[] }) {
  if (!issues.length) return <p className="muted small">No issues found.</p>;
  return (
    <>
      {issues.map((i, k) => (
        <div key={k} className="issue">
          <span className={`sev ${i.severity}`}>{i.severity === "error" ? "error" : "warn"}</span>
          <span>{i.message}</span>
        </div>
      ))}
    </>
  );
}

function SiView() {
  const { design } = useEditor();
  const { busy, run } = useRunner();
  const [rise, setRise] = useState(1);
  const [field, setField] = useState(false);
  const [r, setR] = useState<SiReport | null>(null);
  return (
    <>
      <p className="muted small" style={{ marginTop: 0 }}>
        Per routed net: impedance along the route against its net-class or diff-pair target, delay, vias, and stretches with no reference plane under them. Parallel runs of different nets are checked for crosstalk at the given edge rate.
      </p>
      <div className="row small" style={{ gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
        <label>Rise time</label>
        <input type="number" min={0.05} step={0.1} value={rise} onChange={(e) => setRise(Math.max(0.05, Number(e.target.value) || 1))} style={{ width: 60 }} />
        <span className="muted">ns</span>
        <label className="row" style={{ gap: 4 }} title="Field-solve each width/layer instead of closed-form estimates (slower)">
          <input type="checkbox" checked={field} onChange={(e) => setField(e.target.checked)} /> field solver
        </label>
        <span className="spacer" />
        <button className="primary small" disabled={busy || !design.traces.length} onClick={() => run(() => setR(signalIntegrity(design, { riseTime: rise, fieldSolve: field })))}>
          {busy ? "Analysing…" : "Analyse"}
        </button>
      </div>
      {!design.traces.length && <p className="muted small">Route the board first.</p>}
      {r && (
        <>
          <Issues issues={r.issues} />
          <table className="pin-table si-table">
            <thead>
              <tr className="muted small">
                <td>Net</td>
                <td>Length</td>
                <td>Delay</td>
                <td>Z (Ω)</td>
                <td>Vias</td>
              </tr>
            </thead>
            <tbody>
              {r.nets.map((n) => (
                <tr key={n.net} className={n.unreferenced > 0.5 ? "warn-row" : ""}>
                  <td>
                    {n.net}
                    {n.differential && <span className="muted"> (diff)</span>}
                  </td>
                  <td>{n.length.toFixed(1)}mm</td>
                  <td>{n.delay.toFixed(0)}ps</td>
                  <td>
                    {n.zMin === n.zMax ? n.zMin.toFixed(1) : `${n.zMin.toFixed(1)}–${n.zMax.toFixed(1)}`}
                    {n.target ? <span className="muted"> / {n.target}</span> : null}
                  </td>
                  <td>{n.vias}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

function PiView() {
  const { design, nets } = useEditor();
  const { busy, run } = useRunner();
  const power = useMemo(() => nets.filter((n) => n.named && !isGroundNet(n.name) && (railVoltage(n.name) !== null || /^V|PWR|VCC|VDD/i.test(n.name))), [nets]);
  const [net, setNet] = useState("");
  const current = power.find((n) => n.name === net) ?? power[0];
  const byId = useMemo(() => new Map(design.components.map((c) => [c.id, c])), [design.components]);
  const refs = useMemo(() => [...new Set((current?.terminals ?? []).map((t) => byId.get(t.comp)).filter((c) => c && c.ref && !c.ref.startsWith("#")).map((c) => c!.ref))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [current, byId]);
  const [source, setSource] = useState("");
  const [loads, setLoads] = useState<Record<string, number>>({});
  const [r, setR] = useState<IrDropResult | null>(null);
  const [dec, setDec] = useState<DecouplingResult | null>(null);
  const src = refs.includes(source) ? source : refs[0] ?? "";
  return (
    <>
      <p className="muted small" style={{ marginTop: 0 }}>
        DC voltage drop: the net's traces, vias and pours as a resistor network, fed at the source and drawn by the loads. Traces are checked against their IPC-2221 current capacity.
      </p>
      {!power.length ? (
        <p className="muted small">No power nets (named like +3V3, VBUS, VCC).</p>
      ) : (
        <>
          <div className="field">
            <label>Net</label>
            <select value={current?.name} onChange={(e) => (setNet(e.target.value), setR(null))}>
              {power.map((n) => (
                <option key={n.name}>{n.name}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Source</label>
            <select value={src} onChange={(e) => setSource(e.target.value)} title="Where the net is fed (regulator output, connector)">
              {refs.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </div>
          <div className="small muted" style={{ margin: "4px 0" }}>
            Load currents (A)
          </div>
          <div className="pi-loads">
            {refs
              .filter((x) => x !== src)
              .map((x) => (
                <label key={x} className="row small" style={{ gap: 4 }}>
                  <span style={{ width: 48 }}>{x}</span>
                  <input type="number" min={0} step={0.05} value={loads[x] ?? 0} onChange={(e) => setLoads({ ...loads, [x]: Math.max(0, Number(e.target.value) || 0) })} style={{ width: 70 }} />
                </label>
              ))}
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <span className="spacer" />
            <button
              className="primary small"
              disabled={busy || !src || !Object.values(loads).some((v) => v > 0)}
              onClick={() => run(() => setR(irDrop(design, current!.name, { source: src, loads: Object.entries(loads).filter(([k, v]) => v > 0 && refs.includes(k) && k !== src).map(([ref, c]) => ({ ref, current: c })) })))}
            >
              {busy ? "Solving…" : "Solve IR drop"}
            </button>
          </div>
          {r && !r.ok && <div className="issue"><span className="sev error">error</span><span>{r.error}</span></div>}
          {r?.ok && (
            <>
              <table className="pin-table">
                <tbody>
                  {r.loads.map((l) => (
                    <tr key={`${l.ref}.${l.pin}`}>
                      <td>
                        {l.ref}.{l.pin}
                      </td>
                      <td>{l.current.toFixed(3)} A</td>
                      <td>
                        <b>{(l.drop * 1000).toFixed(1)} mV</b>
                      </td>
                      <td className="muted">{l.voltage === null ? "" : `${l.voltage.toFixed(3)} V`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="muted small">{r.nodes.toLocaleString()} network nodes</div>
              <Issues issues={r.issues} />
            </>
          )}
        </>
      )}
      <h4 style={{ marginBottom: 4 }}>Decoupling</h4>
      <div className="row">
        <span className="muted small">Each IC power pin should have a capacitor to ground within 3 mm.</span>
        <span className="spacer" />
        <button className="small" onClick={() => setDec(decouplingCheck(design))}>
          Check
        </button>
      </div>
      {dec && (
        <>
          <Issues issues={dec.issues} />
          {dec.pins.length > 0 && (
            <table className="pin-table">
              <tbody>
                {dec.pins.map((p) => (
                  <tr key={`${p.ref}.${p.pin}`}>
                    <td>
                      {p.ref}.{p.pin}
                    </td>
                    <td className="muted">{p.net}</td>
                    <td>{p.cap ? `${p.cap} · ${p.distance}mm` : "none"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}

// Blue sequential ramp (light = cool, dark = hot), steps 100-700.
const RAMP = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b"];
const rampAt = (f: number) => RAMP[Math.max(0, Math.min(RAMP.length - 1, Math.round(f * (RAMP.length - 1))))];

function ThermalView() {
  const { design } = useEditor();
  const { busy, run } = useRunner();
  const [ambient, setAmbient] = useState(25);
  const [airflow, setAirflow] = useState(10);
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [r, setR] = useState<ThermalResult | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; t: number } | null>(null);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !r) return;
    c.width = r.nx;
    c.height = r.ny;
    const g = c.getContext("2d")!;
    const span = Math.max(1e-6, r.max - r.ambient);
    for (let j = 0; j < r.ny; j++)
      for (let i = 0; i < r.nx; i++) {
        const t = r.temps[j * r.nx + i];
        if (!Number.isFinite(t)) continue;
        g.fillStyle = rampAt((t - r.ambient) / span);
        g.fillRect(i, j, 1, 1);
      }
  }, [r]);
  const parts = design.components.filter((c) => !c.ref.startsWith("#") && c.pcb && !c.dnp);
  return (
    <>
      <p className="muted small" style={{ marginTop: 0 }}>
        Steady-state board temperature: heat spreads through the laminate and copper and leaves both faces by convection. Part power comes from the DC simulation unless you set it.
      </p>
      <div className="row small" style={{ gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
        <label>Ambient</label>
        <input type="number" value={ambient} onChange={(e) => setAmbient(Number(e.target.value) || 25)} style={{ width: 54 }} />
        <span className="muted">°C</span>
        <label title="Convection coefficient per face: ~10 still air, 25-50 with a fan">h</label>
        <input type="number" min={2} value={airflow} onChange={(e) => setAirflow(Math.max(2, Number(e.target.value) || 10))} style={{ width: 54 }} />
        <span className="muted">W/m²K</span>
        <span className="spacer" />
        <button className="primary small" disabled={busy} onClick={() => run(() => setR(thermalAnalysis(design, { ambient, h: airflow, power: Object.keys(overrides).length ? Object.fromEntries(Object.entries(overrides).filter(([, v]) => Number.isFinite(v))) : undefined })))}>
          {busy ? "Solving…" : "Solve"}
        </button>
      </div>
      <details className="small" style={{ marginBottom: 6 }}>
        <summary>Part power (W)</summary>
        <div className="pi-loads">
          {parts.map((c) => (
            <label key={c.id} className="row small" style={{ gap: 4 }}>
              <span style={{ width: 48 }}>{c.ref}</span>
              <input type="number" min={0} step={0.05} placeholder="sim" value={overrides[c.ref] ?? ""} onChange={(e) => setOverrides(e.target.value === "" ? Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== c.ref)) : { ...overrides, [c.ref]: Math.max(0, Number(e.target.value) || 0) })} style={{ width: 70 }} />
            </label>
          ))}
        </div>
      </details>
      {r && (
        <>
          <div className="heatmap">
            <canvas
              ref={canvas}
              style={{ width: "100%", aspectRatio: `${r.nx} / ${r.ny}`, imageRendering: "pixelated" }}
              onMouseMove={(e) => {
                const b = (e.target as HTMLCanvasElement).getBoundingClientRect();
                const i = Math.floor(((e.clientX - b.left) / b.width) * r.nx);
                const j = Math.floor(((e.clientY - b.top) / b.height) * r.ny);
                const t = r.temps[j * r.nx + i];
                setHover(Number.isFinite(t) ? { x: (i + 0.5) * r.pitch, y: (j + 0.5) * r.pitch, t } : null);
              }}
              onMouseLeave={() => setHover(null)}
              aria-label={`Board temperature map, ${r.ambient.toFixed(0)} to ${r.max.toFixed(1)} °C`}
            />
            {hover && (
              <div className="heat-tip small">
                {hover.t.toFixed(1)}°C at {hover.x.toFixed(1)}, {hover.y.toFixed(1)} mm
              </div>
            )}
          </div>
          <div className="heat-legend small">
            <span>{r.ambient.toFixed(0)}°C</span>
            <span className="heat-bar" style={{ background: `linear-gradient(to right, ${RAMP.join(",")})` }} />
            <span>{r.max.toFixed(1)}°C</span>
          </div>
          <div className="muted small">
            {r.totalPower.toFixed(2)} W total · grid {r.pitch.toFixed(2)} mm
          </div>
          <Issues issues={r.issues} />
          <table className="pin-table">
            <tbody>
              {r.parts
                .filter((p) => p.power > 0 || p.temp > r.ambient + 1)
                .slice(0, 20)
                .map((p) => (
                  <tr key={p.ref}>
                    <td>{p.ref}</td>
                    <td className="muted">{p.power.toFixed(3)} W</td>
                    <td>
                      <b>{p.temp.toFixed(1)}°C</b>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
