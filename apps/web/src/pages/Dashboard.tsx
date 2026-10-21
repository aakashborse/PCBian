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
          <label className="template" style={{ cursor: "pointer", border: "1px dashed #3a4352" }} title="Select .kicad_sch files (all sheets) and/or a .kicad_pcb">
            <b>⇪ Import a design</b>
            <span className="muted small">KiCad (.kicad_sch sheets / .kicad_pcb), EAGLE (.sch / .brd) or Altium (.PcbDoc).</span>
            <input
              type="file"
              multiple
              accept=".kicad_sch,.kicad_pcb,.sch,.brd,.PcbDoc,.pcbdoc"
              style={{ display: "none" }}
              onChange={async (e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                if (!files.length) return;
                const ext = (f: File) => f.name.toLowerCase().split(".").pop() ?? "";
                const name = files[0].name.replace(/\.(kicad_sch|kicad_pcb|sch|brd|pcbdoc)$/i, "");
                try {
                  setError("Importing…");
                  const altium = files.find((f) => ext(f) === "pcbdoc");
                  const eagleSch = files.find((f) => ext(f) === "sch");
                  const eagleBrd = files.find((f) => ext(f) === "brd");
                  let p;
                  if (altium) {
                    const bytes = new Uint8Array(await altium.arrayBuffer());
                    let bin = "";
                    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
                    p = await api.importAltium(name, btoa(bin));
                  } else if (eagleSch || eagleBrd) p = await api.importEagle(name, { schematic: eagleSch ? await eagleSch.text() : undefined, board: eagleBrd ? await eagleBrd.text() : undefined });
                  else {
                    const sch = await Promise.all(files.filter((f) => ext(f) === "kicad_sch").map(async (f) => ({ name: f.name, text: await f.text() })));
                    const pcbFile = files.find((f) => ext(f) === "kicad_pcb");
                    p = await api.importKicad(name, sch, pcbFile ? await pcbFile.text() : undefined);
                  }
                  setError("");
                  try {
                    sessionStorage.setItem(`pcbian.import.${p.id}`, JSON.stringify(p.report));
                  } catch {
                    // storage unavailable: the report is simply not shown
                  }
                  navigate(`/p/${p.id}`);
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            />
          </label>
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
