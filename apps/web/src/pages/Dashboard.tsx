import { useEffect, useState } from "react";
import { api, type ProjectMeta, type Template } from "../lib/api";
import { navigate } from "../lib/router";
import { UserBadge } from "./UserBadge";

export function Dashboard() {
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [copilot, setCopilot] = useState<boolean | null>(null);
  const [error, setError] = useState("");

  const refresh = () => api.projects().then(setProjects).catch((e: Error) => setError(e.message));
  useEffect(() => {
    refresh();
    api.templates().then(setTemplates).catch(() => {});
    api.health().then((h) => setCopilot(h.copilot)).catch(() => setCopilot(false));
  }, []);

  const create = async (t: Template) => {
    const name = prompt("Project name", t.id === "blank" ? "My board" : t.name);
    if (name === null) return;
    try {
      const p = await api.create(name, t.id);
      navigate(`/p/${p.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="dash">
      <header>
        <div className="brand">
          <img src="/favicon.svg" alt="" />
          PCBian
        </div>
        <span className="spacer" />
        <UserBadge />
      </header>
      <section className="hero">
        <h1>Design circuit boards together, with an AI copilot.</h1>
        <p>
          Draw schematics, lay out and auto-route two-layer boards, run ERC/DRC and export Gerbers, all in the browser. Share the link and edit together in real time.
          {copilot === false && " (The AI copilot is disabled until ANTHROPIC_API_KEY is set on the server.)"}
        </p>
        <div className="templates">
          {templates.map((t) => (
            <button key={t.id} className="template" onClick={() => create(t)}>
              <b>{t.id === "blank" ? "+ " : ""}{t.name}</b>
              <span className="muted small">{t.description}</span>
            </button>
          ))}
        </div>
      </section>
      {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
      <h2 className="section-title">Projects</h2>
      {projects === null ? (
        <p className="muted">Loading…</p>
      ) : projects.length === 0 ? (
        <p className="muted">No projects yet. Start from a template above.</p>
      ) : (
        <div className="projects">
          {projects.map((p) => (
            <div key={p.id} className="project-card" onClick={() => navigate(`/p/${p.id}`)}>
              <span className="name">{p.name}</span>
              <span className="muted small">Updated {new Date(p.updatedAt).toLocaleString()}</span>
              <div className="row" onClick={(e) => e.stopPropagation()}>
                <button
                  className="ghost small"
                  onClick={async () => {
                    const name = prompt("Rename project", p.name);
                    if (name) await api.rename(p.id, name).then(refresh);
                  }}
                >
                  Rename
                </button>
                <button
                  className="ghost small danger"
                  onClick={async () => {
                    if (confirm(`Delete "${p.name}"? This cannot be undone.`)) await api.remove(p.id).then(refresh);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
