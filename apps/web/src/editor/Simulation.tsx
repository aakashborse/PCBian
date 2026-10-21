import { parseValue, simulateAC, simulateDC, simulateTransient, type ACResult, type TransientResult } from "@pcbian/core";
import { useMemo, useState } from "react";
import { useEditor } from "./context";
import { LineChart, SERIES_COLORS, si } from "./LineChart";

const fmtA = (i: number) => si(i, "A");
const fmtW = (p: number) => si(p, "W");

type Mode = "dc" | "tran" | "ac";

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
          ] as const
        ).map(([m, label]) => (
          <button key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
            {label}
          </button>
        ))}
      </div>
      {mode === "dc" ? <DcView /> : mode === "tran" ? <TransientView /> : <AcView />}
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
        Live operating point. Supplies come from rail names (+5V, +3V3, VBUS…) or simulation sources. Models: R, C, L, diodes/LEDs, NPN, N-MOSFET, LM358, NE555, AMS1117.
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
