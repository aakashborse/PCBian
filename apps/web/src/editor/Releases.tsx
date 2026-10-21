import type { ReleaseChecks } from "@pcbian/core";
import { useCallback, useEffect, useState } from "react";
import { api, ReleaseRefused, type Release } from "../lib/api";
import { useUser } from "../lib/user";
import { useEditor } from "./context";

const STATUS: Record<Release["status"], { label: string; tone: string }> = {
  in_review: { label: "In review", tone: "warn" },
  released: { label: "Released", tone: "ok" },
  rejected: { label: "Rejected", tone: "bad" },
  withdrawn: { label: "Withdrawn", tone: "muted" },
};
const day = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function Checks({ c }: { c: ReleaseChecks }) {
  return (
    <div className="small">
      <span className={`life ${c.clean ? "ok" : "bad"}`}>{c.clean ? "Checks pass" : "Checks fail"}</span> DRC {c.drcErrors} errors · ERC {c.ercErrors} errors · {c.unrouted} unrouted{c.bomWithoutMpn ? ` · ${c.bomWithoutMpn} BOM lines without MPN` : ""}
      {c.details.length > 0 && (
        <ul className="muted" style={{ margin: "4px 0 0", paddingLeft: 16 }}>
          {c.details.slice(0, 8).map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Releases: request one (frozen package + checks), approve or reject, download released packages. */
export function Releases({ onChange }: { onChange: () => void }) {
  const { projectId, toast } = useEditor();
  const user = useUser();
  const [data, setData] = useState<{ releases: Release[]; suggestedRevision: string } | null>(null);
  const [form, setForm] = useState<{ revision: string; notes: string; approvers: string; required: number; override: string; failed?: ReleaseChecks } | null>(null);
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState<Record<string, string>>({});
  const refresh = useCallback(() => api.releases(projectId).then(setData, (e) => toast((e as Error).message)), [projectId, toast]);
  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 20_000);
    return () => clearInterval(t);
  }, [refresh]);

  const submit = async () => {
    if (!form) return;
    setBusy(true);
    try {
      const approvers = form.approvers.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
      const r = await api.requestRelease(projectId, { revision: form.revision, notes: form.notes, approvers, required: form.required, author: user.name, override: form.override || undefined });
      toast(`Revision ${r.revision} is in review: ${r.files.length} files frozen`);
      setForm(null);
      refresh();
      onChange();
    } catch (e) {
      if (e instanceof ReleaseRefused && e.checks) setForm({ ...form, failed: e.checks });
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const decide = async (r: Release, decision: "approve" | "reject") => {
    try {
      const out = await api.decideRelease(projectId, r.id, user.name, decision, comment[r.id]);
      toast(out.status === "released" ? `Revision ${out.revision} released` : decision === "approve" ? "Approved" : "Rejected");
      refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const inReview = data?.releases.some((r) => r.status === "in_review");
  return (
    <div className="releases">
      <div className="row" style={{ marginBottom: 6 }}>
        <h4 style={{ margin: 0 }}>Releases</h4>
        <span className="spacer" />
        {!form && (
          <button className="small primary" disabled={!data || inReview} title={inReview ? "A release is already in review" : "Freeze the current design for manufacture and ask for approval"} onClick={() => setForm({ revision: data!.suggestedRevision, notes: "", approvers: "", required: 1, override: "" })}>
            Request release…
          </button>
        )}
      </div>
      {form && (
        <div className="card small release-form">
          <div className="field">
            <label>Revision</label>
            <input value={form.revision} onChange={(e) => setForm({ ...form, revision: e.target.value })} style={{ width: 80 }} />
          </div>
          <div className="field">
            <label>Approvers</label>
            <input value={form.approvers} placeholder="Names, comma separated" onChange={(e) => setForm({ ...form, approvers: e.target.value })} />
          </div>
          <div className="field">
            <label>Approvals needed</label>
            <input type="number" min={1} value={form.required} onChange={(e) => setForm({ ...form, required: Math.max(1, Number(e.target.value) || 1) })} style={{ width: 60 }} />
          </div>
          <textarea rows={3} placeholder="Release notes (what changed, build quantity…)" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} style={{ width: "100%" }} />
          {form.failed && (
            <>
              <Checks c={form.failed} />
              <input placeholder="Reason to release anyway (recorded with the release)" value={form.override} onChange={(e) => setForm({ ...form, override: e.target.value })} style={{ width: "100%", marginTop: 4 }} />
            </>
          )}
          <p className="muted" style={{ margin: "4px 0" }}>
            Requesting stamps revision {form.revision || "?"} into the title block, saves a version and freezes Gerbers, drills, IPC-2581, ODB++, BOM, placement, PDFs and STEP for review.
          </p>
          <div className="row">
            <span className="spacer" />
            <button className="small" onClick={() => setForm(null)}>
              Cancel
            </button>
            <button className="small primary" disabled={busy || !form.revision.trim() || !form.approvers.trim()} onClick={submit}>
              {busy ? "Building package…" : "Request release"}
            </button>
          </div>
        </div>
      )}
      {data?.releases.length === 0 && !form && <p className="muted small">No releases yet.</p>}
      {data?.releases.map((r) => {
        const st = STATUS[r.status];
        const mine = r.approvers.some((a) => a.toLowerCase() === user.name.toLowerCase()) && !r.decisions.some((d) => d.by.toLowerCase() === user.name.toLowerCase());
        const approvals = r.decisions.filter((d) => d.decision === "approve").length;
        return (
          <div key={r.id} className="card release">
            <div className="row" style={{ gap: 6 }}>
              <b>Rev {r.revision}</b>
              <span className={`life ${st.tone}`}>{st.label}</span>
              <span className="spacer" />
              <span className="muted small">{day(r.releasedAt ?? r.requestedAt)}</span>
            </div>
            <div className="small muted">
              Requested by {r.requestedBy} · approvers {r.approvers.join(", ")} ({approvals}/{r.required})
            </div>
            {r.notes && <div className="small" style={{ whiteSpace: "pre-wrap", margin: "4px 0" }}>{r.notes}</div>}
            <Checks c={r.checks} />
            {r.override && <div className="small warn-text">Released despite failing checks: {r.override}</div>}
            {r.decisions.map((d) => (
              <div key={d.by} className="small">
                {d.decision === "approve" ? "✓" : "✗"} <b>{d.by}</b> {d.decision === "approve" ? "approved" : "rejected"}
                {d.comment ? `: ${d.comment}` : ""} <span className="muted">{day(d.at)}</span>
              </div>
            ))}
            <div className="row small" style={{ gap: 4, marginTop: 6, flexWrap: "wrap" }}>
              {r.status !== "withdrawn" && (
                <a className="btn small" href={`/api/projects/${projectId}/releases/${r.id}/package`} download>
                  Package ({(r.packageBytes / 1024).toFixed(0)} KB, {r.files.length} files)
                </a>
              )}
              {r.status === "in_review" && mine && (
                <>
                  <input placeholder="Comment" value={comment[r.id] ?? ""} onChange={(e) => setComment({ ...comment, [r.id]: e.target.value })} style={{ flex: 1, minWidth: 100 }} />
                  <button className="small primary" onClick={() => decide(r, "approve")}>
                    Approve
                  </button>
                  <button className="small danger" onClick={() => decide(r, "reject")}>
                    Reject
                  </button>
                </>
              )}
              {r.status === "in_review" && !mine && !r.approvers.some((a) => a.toLowerCase() === user.name.toLowerCase()) && <span className="muted">Waiting for {r.approvers.filter((a) => !r.decisions.some((d) => d.by.toLowerCase() === a.toLowerCase())).join(", ")}</span>}
              {r.status === "in_review" && r.requestedBy.toLowerCase() === user.name.toLowerCase() && (
                <button
                  className="small ghost"
                  onClick={async () => {
                    try {
                      await api.withdrawRelease(projectId, r.id, user.name);
                      refresh();
                    } catch (e) {
                      toast((e as Error).message);
                    }
                  }}
                >
                  Withdraw
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
