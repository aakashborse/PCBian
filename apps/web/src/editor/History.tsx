import type { DesignDiff } from "@pcbian/core";
import { useCallback, useEffect, useState } from "react";
import { api, type VersionMeta } from "../lib/api";
import { navigate } from "../lib/router";
import { useUser } from "../lib/user";
import { useEditor } from "./context";

const when = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function HistoryPanel() {
  const { projectId, toast } = useEditor();
  const user = useUser();
  const [list, setList] = useState<VersionMeta[] | null>(null);
  const [name, setName] = useState("");
  const [showAuto, setShowAuto] = useState(true);
  const [diffs, setDiffs] = useState<Record<string, { diff: DesignDiff; summary: string } | "loading">>({});
  const refresh = useCallback(() => api.versions(projectId).then(setList, (e) => toast((e as Error).message)), [projectId, toast]);
  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 20_000);
    return () => clearInterval(t);
  }, [refresh]);

  const save = async () => {
    await api.saveVersion(projectId, name.trim() || "Saved version", user.name);
    setName("");
    toast("Version saved");
    refresh();
  };
  const compare = async (id: string) => {
    if (diffs[id]) return setDiffs(({ [id]: _, ...rest }) => rest);
    setDiffs((d) => ({ ...d, [id]: "loading" }));
    const r = await api.versionDiff(projectId, id);
    setDiffs((d) => ({ ...d, [id]: r }));
  };
  const shown = (list ?? []).filter((v) => showAuto || !v.auto);
  return (
    <div className="panel-body">
      <h4 style={{ marginTop: 0 }}>Version history</h4>
      <div className="row" style={{ gap: 4, marginBottom: 10 }}>
        <input placeholder="Version name, e.g. Rev A for review" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} style={{ flex: 1, minWidth: 0 }} />
        <button className="primary small" onClick={save}>
          Save
        </button>
      </div>
      <label className="small row muted" style={{ gap: 4, marginBottom: 8 }}>
        <input type="checkbox" checked={showAuto} onChange={(e) => setShowAuto(e.target.checked)} />
        Show autosaves and copilot snapshots
      </label>
      {list === null && <p className="muted small">Loading…</p>}
      {list?.length === 0 && <p className="muted small">No versions yet. Versions are saved automatically every 10 minutes of editing and around every copilot run; save one by name for milestones.</p>}
      {shown.map((v) => {
        const d = diffs[v.id];
        return (
          <div key={v.id} className={`card version${v.auto ? " auto" : ""}`}>
            <div className="row" style={{ gap: 6 }}>
              <b className="small">{v.name}</b>
              <span className="spacer" />
              <span className="muted small">{when(v.createdAt)}</span>
            </div>
            <div className="muted small">
              {v.author} · {v.summary}
            </div>
            <div className="row" style={{ gap: 4, marginTop: 6 }}>
              <button className="small" onClick={() => compare(v.id)}>
                {d ? "Hide changes" : "Changes since"}
              </button>
              <button
                className="small"
                onClick={async () => {
                  if (!confirm(`Restore "${v.name}"? The current design is saved as a version first, so this can be undone.`)) return;
                  await api.restoreVersion(projectId, v.id, user.name);
                  toast(`Restored "${v.name}"`);
                  refresh();
                }}
              >
                Restore
              </button>
              <button
                className="small"
                onClick={async () => {
                  const n = prompt("Name of the new branch project", `${v.name} branch`);
                  if (!n) return;
                  const p = await api.branchVersion(projectId, v.id, n, user.name);
                  navigate(`/p/${p.id}`);
                }}
                title="Start a new project from this version"
              >
                Branch
              </button>
            </div>
            {d === "loading" && <p className="muted small">Comparing…</p>}
            {d && d !== "loading" && <DiffView d={d.diff} />}
          </div>
        );
      })}
    </div>
  );
}

function DiffView({ d }: { d: DesignDiff }) {
  if (d.same) return <p className="muted small">No changes since this version.</p>;
  const rows: [string, string][] = [];
  if (d.components.added.length) rows.push(["Parts added", d.components.added.join(", ")]);
  if (d.components.removed.length) rows.push(["Parts removed", d.components.removed.join(", ")]);
  for (const c of d.components.changed.slice(0, 12)) rows.push([c.ref, c.what.join(", ")]);
  if (d.components.changed.length > 12) rows.push(["…", `${d.components.changed.length - 12} more parts changed`]);
  if (d.nets.added.length) rows.push(["Nets added", d.nets.added.join(", ")]);
  if (d.nets.removed.length) rows.push(["Nets removed", d.nets.removed.join(", ")]);
  if (d.wires.added || d.wires.removed) rows.push(["Wires", `+${d.wires.added} / −${d.wires.removed}`]);
  if (d.traces.added || d.traces.removed || d.traces.changed) rows.push(["Traces", `+${d.traces.added} / −${d.traces.removed} / ${d.traces.changed} edited`]);
  if (d.vias.added || d.vias.removed) rows.push(["Vias", `+${d.vias.added} / −${d.vias.removed}`]);
  if (d.zones.added || d.zones.removed) rows.push(["Pours", `+${d.zones.added} / −${d.zones.removed}`]);
  if (d.sheets.added.length || d.sheets.removed.length) rows.push(["Sheets", [...d.sheets.added.map((s) => `+${s}`), ...d.sheets.removed.map((s) => `−${s}`)].join(", ")]);
  for (const b of d.board) rows.push(["Board", b]);
  if (d.rules.length) rows.push(["Also", d.rules.join(", ")]);
  return (
    <table className="pin-table small" style={{ marginTop: 6 }}>
      <tbody>
        {rows.map(([k, v], i) => (
          <tr key={i}>
            <td style={{ whiteSpace: "nowrap" }}>{k}</td>
            <td className="muted">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
