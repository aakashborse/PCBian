import { analyzeCopper, deleteDiffPair, deleteLengthGroup, diffImpedance, gapForDiffImpedance, matchLengths, netLengths, setDiffPair, setLengthGroup, suggestDiffPairs, tracesMap, tuneLength, type DiffPair, type LengthGroup, type TraceChange } from "@pcbian/core";
import { useMemo, useState } from "react";
import { useEditor } from "./context";
import { NumField } from "./Inspector";

function useApply() {
  const { conn } = useEditor();
  return (changes: TraceChange[]) => {
    conn.undo.stopCapturing();
    conn.doc.transact(() => {
      for (const c of changes) {
        const t = tracesMap(conn.doc).get(c.id);
        if (t) tracesMap(conn.doc).set(c.id, { ...t, points: c.points });
      }
    });
  };
}

/** Differential pair definitions with impedance and skew read-outs. */
export function DiffPairsCard() {
  const { design, conn, nets } = useEditor();
  const names = nets.filter((n) => n.terminals.length > 1).map((n) => n.name);
  const suggestions = suggestDiffPairs(names, design.diffPairs);
  const lens = useMemo(() => netLengths(design), [design]);
  const [pos, setPos] = useState("");
  const [neg, setNeg] = useState("");
  const add = (positive: string, negative: string, name: string) =>
    setDiffPair(conn.doc, { name, positive, negative, width: design.board.defaultTraceWidth, gap: Math.max(design.board.clearance, 0.15), maxSkew: 0.15 });
  const save = (p: DiffPair) => setDiffPair(conn.doc, p);
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h4 style={{ margin: "0 0 6px" }}>Differential pairs</h4>
      {design.diffPairs.length === 0 && <p className="muted small" style={{ margin: 0 }}>Pairs are routed as coupled traces at a fixed width and gap, and DRC checks their skew.</p>}
      {design.diffPairs.map((p) => {
        const a = lens.get(p.positive);
        const b = lens.get(p.negative);
        const skew = a !== undefined && b !== undefined ? Math.abs(a - b) : null;
        return (
          <div key={p.name} style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 8 }}>
            <div className="row">
              <b className="small">{p.name}</b>
              <span className="muted small">
                {p.positive} / {p.negative}
              </span>
              <span className="spacer" />
              <button className="ghost small danger" onClick={() => deleteDiffPair(conn.doc, p.name)}>
                Remove
              </button>
            </div>
            <NumField label="Width" value={p.width} onChange={(width) => save({ ...p, width })} min={0.05} />
            <NumField label="Gap" value={p.gap} onChange={(gap) => save({ ...p, gap })} min={0.05} />
            <NumField
              label="Target Ω"
              value={p.impedance ?? 0}
              step={1}
              onChange={(z) => {
                const gap = z > 0 ? gapForDiffImpedance(design.board, "top", p.width, z) : null;
                save({ ...p, impedance: z > 0 ? z : undefined, ...(gap ? { gap: Math.round(gap * 1000) / 1000 } : {}) });
              }}
            />
            <NumField label="Max skew" value={p.maxSkew} onChange={(maxSkew) => save({ ...p, maxSkew })} min={0.01} />
            <div className="kv small">
              <span>Zdiff (outer)</span>
              <span>{diffImpedance(design.board, "top", p.width, p.gap).toFixed(1)} Ω</span>
              <span>Skew</span>
              <span style={{ color: skew !== null && skew > p.maxSkew ? "var(--warn)" : undefined }}>{skew === null ? "not routed" : `${skew.toFixed(2)} mm`}</span>
            </div>
            {skew !== null && skew > p.maxSkew && <MatchButton nets={[p.positive, p.negative]} label="Fix skew" />}
          </div>
        );
      })}
      {suggestions.length > 0 && (
        <div className="small" style={{ marginTop: 8 }}>
          <span className="muted">Suggested: </span>
          {suggestions.map(([p, n, base]) => (
            <button key={p} className="ghost small" onClick={() => add(p, n, base)}>
              + {p}/{n}
            </button>
          ))}
        </div>
      )}
      <div className="row" style={{ marginTop: 8, gap: 4 }}>
        <select value={pos} onChange={(e) => setPos(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
          <option value="">P net…</option>
          {names.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
        <select value={neg} onChange={(e) => setNeg(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
          <option value="">N net…</option>
          {names.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
        <button className="small" disabled={!pos || !neg || pos === neg} onClick={() => (add(pos, neg, pos.replace(/[_+]?P?$/i, "") || pos), setPos(""), setNeg(""))}>
          Add
        </button>
      </div>
    </div>
  );
}

function MatchButton({ nets, target, label = "Match lengths" }: { nets: string[]; target?: number; label?: string }) {
  const { design, toast } = useEditor();
  const apply = useApply();
  return (
    <button
      className="small"
      style={{ marginTop: 6 }}
      onClick={() => {
        const m = matchLengths(design, nets, target);
        apply(m.changes);
        const bad = m.results.filter((r) => !r.ok);
        toast(bad.length ? bad.map((r) => r.reason).join(" · ") : `Matched to ${m.target.toFixed(2)} mm`);
      }}
    >
      {label}
    </button>
  );
}

/** Length-matching groups with per-net lengths. */
export function LengthGroupsCard() {
  const { design, conn, nets } = useEditor();
  const names = nets.filter((n) => n.terminals.length > 1).map((n) => n.name);
  const lens = useMemo(() => netLengths(design), [design]);
  const save = (g: LengthGroup) => setLengthGroup(conn.doc, g);
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <h4 style={{ margin: 0 }}>Length groups</h4>
        <span className="spacer" />
        <button className="small" onClick={() => save({ name: `Group ${design.lengthGroups.length + 1}`, nets: [], tolerance: 0.5 })}>
          + Group
        </button>
      </div>
      {design.lengthGroups.length === 0 && <p className="muted small" style={{ margin: 0 }}>Nets in a group must be routed to the same length (buses, DDR lanes).</p>}
      {design.lengthGroups.map((g) => {
        const routed = g.nets.filter((n) => lens.has(n));
        const target = g.target ?? Math.max(0, ...routed.map((n) => lens.get(n)!));
        return (
          <div key={g.name} style={{ borderTop: "1px solid var(--border)", paddingTop: 8, marginTop: 8 }}>
            <div className="row">
              <b className="small">{g.name}</b>
              <span className="spacer" />
              <button className="ghost small danger" onClick={() => deleteLengthGroup(conn.doc, g.name)}>
                Remove
              </button>
            </div>
            <NumField label="Target (0 = longest)" value={g.target ?? 0} onChange={(t) => save({ ...g, target: t > 0 ? t : undefined })} step={1} />
            <NumField label="Tolerance" value={g.tolerance} onChange={(tolerance) => save({ ...g, tolerance })} min={0.01} />
            <div className="field">
              <label>Nets</label>
              <select multiple value={g.nets} onChange={(e) => save({ ...g, nets: [...e.target.selectedOptions].map((o) => o.value) })} style={{ height: 70 }}>
                {names.map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </div>
            <table className="pin-table small">
              <tbody>
                {g.nets.map((n) => {
                  const l = lens.get(n);
                  const off = l === undefined ? null : l - target;
                  return (
                    <tr key={n}>
                      <td>{n}</td>
                      <td style={{ textAlign: "right" }}>{l === undefined ? "—" : `${l.toFixed(2)} mm`}</td>
                      <td style={{ textAlign: "right", color: off !== null && Math.abs(off) > g.tolerance ? "var(--warn)" : "var(--muted)" }}>{off === null ? "" : `${off >= 0 ? "+" : ""}${off.toFixed(2)}`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {routed.length > 0 && <MatchButton nets={g.nets} target={g.target} />}
          </div>
        );
      })}
    </div>
  );
}

/** Length read-out and tuning for the net of a selected trace. */
export function TraceLengthTuner({ traceId }: { traceId: string }) {
  const { design, toast } = useEditor();
  const apply = useApply();
  const { net, current } = useMemo(() => {
    const a = analyzeCopper(design);
    const it = a.items.find((x) => x.kind === "trace" && x.trace.id === traceId);
    const n = it ? a.netOfItem(it) : undefined;
    return { net: n, current: n ? netLengths(design, a).get(n) ?? 0 : 0 };
  }, [design, traceId]);
  const [target, setTarget] = useState("");
  if (!net) return null;
  return (
    <div className="card small" style={{ marginBottom: 12 }}>
      <div className="kv">
        <span>Net</span>
        <span>{net}</span>
        <span>Net length</span>
        <span>{current.toFixed(2)} mm</span>
      </div>
      <div className="row" style={{ marginTop: 6, gap: 4 }}>
        <input placeholder="target mm" value={target} onChange={(e) => setTarget(e.target.value)} style={{ width: 80 }} />
        <button
          className="small"
          disabled={!(Number(target) > 0)}
          onClick={() => {
            const r = tuneLength(design, net, Number(target));
            apply(r.changes);
            toast(r.ok ? `${net}: ${r.before.toFixed(2)} → ${r.after.toFixed(2)} mm` : r.reason ?? "Could not tune");
          }}
        >
          Tune with meanders
        </button>
      </div>
    </div>
  );
}
