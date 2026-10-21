import { addSpiceModels, deleteSpiceModel, parseSpiceModels, parseValue, simulateAC, simulateDC, simulateTransient, sweepDC, type ACResult, type SweepResult, type TransientResult } from "@pcbian/core";
import { useMemo, useState } from "react";
import { useEditor } from "./context";
import { LineChart, SERIES_COLORS, si } from "./LineChart";

const fmtA = (i: number) => si(i, "A");
const fmtW = (p: number) => si(p, "W");

type Mode = "dc" | "tran" | "ac" | "sweep" | "models";

export function Simulation() {
  const [mode, setMode] = useState<Mode>("dc");
  return (
    <div className="panel-body">
      <div className="tabs" style={{ marginBottom: 10, width: "fit-content" }}>
        {(
          [
            ["dc", "DC"],
            ["tran", "Transient"],
            ["ac", "AC"],
            ["sweep", "Sweep"],
            ["models", "Models"],
          ] as const
        ).map(([m, label]) => (
          <button key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
            {label}
          </button>
        ))}
      </div>
      {mode === "dc" ? <DcView /> : mode === "tran" ? <TransientView /> : mode === "ac" ? <AcView /> : mode === "sweep" ? <SweepView /> : <ModelsView />}
    </div>
  );
}

function Warnings({ list }: { list: string[] }) {
  if (!list.length) return null;
  return (
    <div className="card small" style={{ borderColor: "#5b4a12" }}>
      {list.map((w, i) => (
        <div key={i} style={{ color: "var(--warn)", marginBottom: 3 }}>
          ⚠ {w}
        </div>
      ))}
    </div>
  );
}

function DcView() {
  const { design } = useEditor();
  const r = useMemo(() => simulateDC(design), [design]);
  return (
    <>
      <p className="muted small" style={{ marginTop: 0 }}>
        Live operating point. Supplies come from rail names (+5V, +3V3, VBUS…) or simulation sources. Built-in models: R, C, L, diodes/LEDs, BJTs, MOSFETs, LM358, NE555, AMS1117; any part can use an imported SPICE subcircuit (Models tab).
      </p>
      {!r.ok ? (
        <div className="card small">{r.error}</div>
      ) : (
        <>
          <Warnings list={r.warnings} />
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
    </>
  );
}

function ProbePicker({ all, picked, setPicked }: { all: string[]; picked: string[]; setPicked: (p: string[]) => void }) {
  return (
    <div className="probe-list">
      {all.map((n) => {
        const i = picked.indexOf(n);
        return (
          <label key={n} className="small">
            <input
              type="checkbox"
              checked={i >= 0}
              disabled={i < 0 && picked.length >= SERIES_COLORS.length}
              onChange={(e) => setPicked(e.target.checked ? [...picked, n] : picked.filter((x) => x !== n))}
            />
            {i >= 0 && <i style={{ background: SERIES_COLORS[i] }} />}
            {n}
          </label>
        );
      })}
    </div>
  );
}

// Named nets first, then auto-named ones; ground is the reference, so never a default probe.
const defaultProbes = (names: string[]) => {
  const live = names.filter((n) => !/GND/i.test(n));
  return [...live.filter((n) => !n.startsWith("Net-(")), ...live.filter((n) => n.startsWith("Net-("))].slice(0, 3);
};

function TransientView() {
  const { design, toast } = useEditor();
  const [tstop, setTstop] = useState("10m");
  const [points, setPoints] = useState(2000);
  const [res, setRes] = useState<TransientResult | null>(null);
  const [probes, setProbes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const run = () => {
    const t = parseValue(tstop);
    if (!t || t <= 0) return toast("Enter a stop time such as 10m or 2");
    setBusy(true);
    // Let the button repaint before the (synchronous) solve.
    setTimeout(() => {
      const r = simulateTransient(design, { tstop: t, points });
      setRes(r);
      if (r.ok && !probes.some((p) => r.nodes[p])) setProbes(defaultProbes(Object.keys(r.nodes)));
      setBusy(false);
    }, 20);
  };
  const currents = res?.ok ? Object.keys(res.currents).filter((k) => /^(D|Q|R|V|L)/.test(k)).slice(0, 4) : [];
  return (
    <>
      <p className="muted small" style={{ marginTop: 0 }}>
        From power-on: capacitors start discharged, supplies are on at t=0. Add a "Voltage Source (simulation)" with PULSE/SIN values for stimulus.
      </p>
      <div className="row" style={{ marginBottom: 10 }}>
        <label className="small muted">Stop</label>
        <input value={tstop} onChange={(e) => setTstop(e.target.value)} style={{ width: 70 }} title="Stop time, e.g. 10m, 2, 500u" />
        <label className="small muted">Points</label>
        <input type="number" value={points} min={50} max={20000} onChange={(e) => setPoints(Number(e.target.value))} style={{ width: 70 }} />
        <button className="primary" onClick={run} disabled={busy}>
          {busy ? "Running…" : "Run"}
        </button>
      </div>
      {res && !res.ok && <div className="card small">{res.error}</div>}
      {res?.ok && (
        <>
          <Warnings list={res.warnings} />
          {probes.filter((p) => res.nodes[p]).length > 0 && <LineChart title="Node voltages" x={res.time} xLabel="time" yUnit="V" series={probes.filter((p) => res.nodes[p]).map((p) => ({ name: p, values: res.nodes[p] }))} />}
          {currents.length > 0 && <LineChart title="Currents" x={res.time} xLabel="time" yUnit="A" height={120} series={currents.map((c) => ({ name: c, values: res.currents[c] }))} />}
          <h4>Probes</h4>
          <ProbePicker all={Object.keys(res.nodes)} picked={probes} setPicked={setProbes} />
        </>
      )}
    </>
  );
}

function AcView() {
  const { design, toast } = useEditor();
  const [fstart, setFstart] = useState("10");
  const [fstop, setFstop] = useState("1M");
  const [res, setRes] = useState<ACResult | null>(null);
  const [probes, setProbes] = useState<string[]>([]);
  const run = () => {
    const a = parseValue(fstart);
    const b = parseValue(fstop);
    if (!a || !b || b <= a) return toast("Enter a frequency range, e.g. 10 to 1M");
    const r = simulateAC(design, { fstart: a, fstop: b, pointsPerDecade: 40 });
    setRes(r);
    if (r.ok && !probes.some((p) => r.nodes[p])) setProbes(defaultProbes(Object.keys(r.nodes)));
  };
  const shown = res?.ok ? probes.filter((p) => res.nodes[p]) : [];
  return (
    <>
      <p className="muted small" style={{ marginTop: 0 }}>
        Small-signal sweep around the operating point. Excite the circuit with a simulation voltage source valued e.g. "DC 0 AC 1".
      </p>
      <div className="row" style={{ marginBottom: 10 }}>
        <label className="small muted">From</label>
        <input value={fstart} onChange={(e) => setFstart(e.target.value)} style={{ width: 60 }} />
        <label className="small muted">to</label>
        <input value={fstop} onChange={(e) => setFstop(e.target.value)} style={{ width: 60 }} />
        <span className="small muted">Hz</span>
        <button className="primary" onClick={run}>
          Run
        </button>
      </div>
      {res && !res.ok && <div className="card small">{res.error}</div>}
      {res?.ok && (
        <>
          <Warnings list={res.warnings} />
          {shown.length > 0 && (
            <>
              <LineChart title="Gain" x={res.freq} xLabel="freq" yUnit="dB" logX formatX={(v) => si(v, "Hz")} series={shown.map((p) => ({ name: p, values: res.nodes[p].mag }))} />
              <LineChart title="Phase" x={res.freq} xLabel="freq" yUnit="°" logX height={120} formatX={(v) => si(v, "Hz")} series={shown.map((p) => ({ name: p, values: res.nodes[p].phase }))} />
            </>
          )}
          <h4>Probes</h4>
          <ProbePicker all={Object.keys(res.nodes)} picked={probes} setPicked={setProbes} />
        </>
      )}
    </>
  );
}

const SWEEPABLE = /^(sim_vsource|sim_isource|resistor)/;

function SweepView() {
  const { design, toast } = useEditor();
  const refs = design.components.filter((c) => SWEEPABLE.test(c.partId) && !c.dnp).map((c) => c.ref);
  const [ref, setRef] = useState(refs[0] ?? "");
  // Sources sweep 0..5 V by default; resistors a decade either side of their value.
  const range = (r: string): [string, string] => {
    const c = design.components.find((x) => x.ref === r);
    const v = c && !c.partId.startsWith("sim_") ? parseValue(c.value) : null;
    return v ? [si(v / 10), si(v * 10)] : ["0", "5"];
  };
  const [from, setFrom] = useState(() => range(refs[0] ?? "")[0]);
  const [to, setTo] = useState(() => range(refs[0] ?? "")[1]);
  const [points, setPoints] = useState(41);
  const [res, setRes] = useState<SweepResult | null>(null);
  const [probes, setProbes] = useState<string[]>([]);
  const comp = design.components.find((c) => c.ref === ref);
  const unit = comp?.partId.startsWith("resistor") ? "Ω" : comp?.partId.startsWith("sim_isource") ? "A" : "V";
  const run = () => {
    const a = parseValue(from);
    const b = parseValue(to);
    if (a === null || b === null || a === b) return toast("Enter a sweep range, e.g. 0 to 5");
    const r = sweepDC(design, { ref, from: a, to: b, points });
    setRes(r);
    if (r.ok && !probes.some((p) => r.nodes[p])) setProbes(defaultProbes(Object.keys(r.nodes)));
  };
  const shown = res?.ok ? probes.filter((p) => res.nodes[p]) : [];
  return (
    <>
      <p className="muted small" style={{ marginTop: 0 }}>
        DC sweep: step a source voltage or a resistance and plot the operating point, e.g. a transistor transfer curve.
      </p>
      {refs.length === 0 ? (
        <div className="card small">Add a simulation source or a resistor to sweep.</div>
      ) : (
        <div className="row" style={{ marginBottom: 10, flexWrap: "wrap" }}>
          <select
            value={ref}
            onChange={(e) => {
              setRef(e.target.value);
              const [a, b] = range(e.target.value);
              setFrom(a);
              setTo(b);
            }}
          >
            {refs.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
          <input value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 54 }} title="From" />
          <span className="small muted">to</span>
          <input value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 54 }} title="To" />
          <input type="number" value={points} min={2} max={500} onChange={(e) => setPoints(Number(e.target.value))} style={{ width: 54 }} title="Points" />
          <button className="primary" onClick={run}>
            Run
          </button>
        </div>
      )}
      {res && !res.ok && <div className="card small">{res.error}</div>}
      {res?.ok && (
        <>
          <Warnings list={res.warnings} />
          {shown.length > 0 && <LineChart title={`Node voltages vs ${res.param}`} x={res.x} xLabel={res.param} yUnit="V" formatX={(v) => si(v, unit)} series={shown.map((p) => ({ name: p, values: res.nodes[p] }))} />}
          <h4>Probes</h4>
          <ProbePicker all={Object.keys(res.nodes)} picked={probes} setPicked={setProbes} />
        </>
      )}
    </>
  );
}

function ModelsView() {
  const { design, conn, toast } = useEditor();
  const [text, setText] = useState("");
  const users = (name: string) => design.components.filter((c) => c.model?.toUpperCase() === name).map((c) => c.ref);
  return (
    <>
      <p className="muted small" style={{ marginTop: 0 }}>
        Paste vendor SPICE models: <code>.model</code> cards (diodes, NPN/PNP, NMOS/PMOS, VDMOS) and <code>.subckt</code> macromodels (op-amps, regulators… with R, C, L, V, I, D, Q, M, E, F, G, H and nested X elements, including linear POLY sources). Assign them to parts in the Inspector.
      </p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} style={{ width: "100%", fontFamily: "monospace", fontSize: 11 }} placeholder=".model 1N4148 D(IS=2.52n RS=0.568 N=1.752)" />
      <button
        className="primary small"
        style={{ margin: "6px 0 10px" }}
        disabled={!text.trim()}
        onClick={() => {
          const r = parseSpiceModels(text);
          addSpiceModels(conn.doc, r.models, r.subckts);
          const names = [...r.models.map((m) => m.name), ...r.subckts.map((s) => `${s.name} (subcircuit)`)];
          toast([names.length ? `Imported ${names.join(", ")}` : "", ...r.warnings].filter(Boolean).join(" · "));
          if (names.length) setText("");
        }}
      >
        Import models
      </button>
      {design.spiceModels.length === 0 && design.spiceSubckts.length === 0 && <p className="muted small">No models yet; parts use the built-in models.</p>}
      <table className="pin-table">
        <tbody>
          {design.spiceSubckts.map((m) => (
            <tr key={`x:${m.name}`}>
              <td>
                <b>{m.name}</b> <span className="muted">subcircuit</span>
                <div className="muted small" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={m.ports.join(" ")}>
                  ports {m.ports.join(" ")} · {m.lines.length} lines
                </div>
              </td>
              <td className="muted small">{users(m.name).join(", ") || "unused"}</td>
              <td>
                <button className="ghost small danger" onClick={() => deleteSpiceModel(conn.doc, m.name)}>
                  ×
                </button>
              </td>
            </tr>
          ))}
          {design.spiceModels.map((m) => (
            <tr key={m.name}>
              <td>
                <b>{m.name}</b> <span className="muted">{m.type}</span>
                <div className="muted small" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={Object.entries(m.params).map(([k, v]) => `${k}=${v}`).join(" ")}>
                  {Object.entries(m.params)
                    .slice(0, 6)
                    .map(([k, v]) => `${k}=${+v.toPrecision(3)}`)
                    .join(" ")}
                </div>
              </td>
              <td className="muted small">{users(m.name).join(", ") || "unused"}</td>
              <td>
                <button className="ghost small danger" onClick={() => deleteSpiceModel(conn.doc, m.name)}>
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
