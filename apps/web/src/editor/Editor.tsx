import { computeNets, type Vec } from "@pcbian/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { navigate } from "../lib/router";
import { useDesign, useProjectConnection } from "../lib/useProject";
import { useUser } from "../lib/user";
import { initials, UserBadge } from "../pages/UserBadge";
import { Board3D } from "./Board3D";
import { Checks } from "./Checks";
import { EditorContext, type EditorState, type FocusRequest, type Selection, type ViewMode } from "./context";
import { Copilot } from "./Copilot";
import { exporters } from "./exporters";
import { Inspector } from "./Inspector";
import { Library } from "./Library";
import { PcbCanvas } from "./PcbCanvas";
import { usePresence } from "./presence";
import { SchematicCanvas } from "./SchematicCanvas";
import { Simulation } from "./Simulation";

type RightTab = "copilot" | "inspect" | "checks" | "sim";

export function Editor({ projectId }: { projectId: string }) {
  const { conn, synced, online } = useProjectConnection(projectId);
  const design = useDesign(conn.doc);
  const nets = useMemo(() => computeNets(design), [design]);
  const user = useUser();
  const presence = usePresence(conn.provider, user);

  const [selection, setSelection] = useState<Selection>(null);
  const [mode, setMode] = useState<ViewMode>("schematic");
  const [placing, setPlacing] = useState<string | null>(null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [tab, setTab] = useState<RightTab>("copilot");
  const [toastMsg, setToastMsg] = useState("");
  const [menu, setMenu] = useState(false);
  const [copilot, setCopilot] = useState<boolean | null>(null);
  const [missing, setMissing] = useState(false);
  const toastTimer = useRef<number>(0);

  useEffect(() => {
    api.health().then((h) => setCopilot(h.copilot)).catch(() => setCopilot(false));
    api.project(projectId).catch(() => setMissing(true));
  }, [projectId]);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(""), 3500);
  }, []);

  const select = useCallback(
    (s: Selection) => {
      setSelection(s);
      conn.provider.awareness.setLocalStateField("sel", s?.kind === "component" ? s.id : null);
      if (s) setTab((t) => (t === "checks" ? t : "inspect"));
    },
    [conn],
  );

  // Drop the selection if a collaborator deletes the selected object.
  useEffect(() => {
    if (!selection) return;
    const exists =
      (selection.kind === "component" && design.components.some((c) => c.id === selection.id)) ||
      (selection.kind === "wire" && design.wires.some((w) => w.id === selection.id)) ||
      (selection.kind === "trace" && design.traces.some((t) => t.id === selection.id)) ||
      (selection.kind === "via" && design.vias.some((v) => v.id === selection.id)) ||
      (selection.kind === "zone" && design.zones.some((z) => z.id === selection.id));
    if (!exists) select(null);
  }, [design, selection, select]);

  // Global undo / redo (only undoes your own edits).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        conn.undo.undo();
      } else if ((k === "z" && e.shiftKey) || k === "y") {
        e.preventDefault();
        conn.undo.redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [conn]);

  const focusOn = useCallback((view: ViewMode, at: Vec) => setFocus((f) => ({ view, at, n: (f?.n ?? 0) + 1 })), []);

  const state: EditorState = {
    projectId,
    conn,
    design,
    nets,
    selection,
    select,
    mode,
    setMode: (m) => {
      setMode(m);
      if (m === "pcb") setPlacing(null);
    },
    placing,
    setPlacing,
    focus,
    focusOn,
    toast,
  };

  if (missing) {
    return (
      <div className="loading">
        <div style={{ textAlign: "center" }}>
          <p>This project doesn't exist or was deleted.</p>
          <button onClick={() => navigate("/")}>Back to projects</button>
        </div>
      </div>
    );
  }
  if (!synced) return <div className="loading">Connecting to project…</div>;

  return (
    <EditorContext.Provider value={state}>
      <div className="editor">
        <div className="topbar">
          <button className="ghost brand" onClick={() => navigate("/")} title="All projects" style={{ fontSize: 15, padding: "4px 6px" }}>
            <img src="/favicon.svg" alt="" style={{ width: 22, height: 22 }} />
          </button>
          <ProjectName projectId={projectId} name={design.name} onError={toast} />
          <div className="tabs">
            <button className={mode === "schematic" ? "on" : ""} onClick={() => state.setMode("schematic")}>
              Schematic
            </button>
            <button className={mode === "pcb" ? "on" : ""} onClick={() => state.setMode("pcb")}>
              PCB
            </button>
            <button className={mode === "3d" ? "on" : ""} onClick={() => state.setMode("3d")}>
              3D
            </button>
          </div>
          <button className="ghost" onClick={() => conn.undo.undo()} title="Undo (Ctrl+Z)">
            ↶
          </button>
          <button className="ghost" onClick={() => conn.undo.redo()} title="Redo (Ctrl+Shift+Z)">
            ↷
          </button>
          <span className="spacer" />
          <span className={`status-dot ${online ? "on" : ""}`} title={online ? "Live: changes sync in real time" : "Offline: reconnecting…"} />
          <div className="avatars">
            {presence.map((p) => (
              <span key={p.clientId} className="avatar" style={{ background: p.user.color }} title={p.user.name}>
                {initials(p.user.name)}
              </span>
            ))}
          </div>
          <UserBadge />
          <button
            onClick={() => {
              navigator.clipboard?.writeText(location.href).then(
                () => toast("Link copied. Anyone with the link can edit this project live."),
                () => toast(location.href),
              );
            }}
          >
            Share
          </button>
          <div style={{ position: "relative" }}>
            <button className="primary" onClick={() => setMenu(!menu)}>
              Export ▾
            </button>
            {menu && (
              <div className="menu" onMouseLeave={() => setMenu(false)}>
                {(
                  [
                    ["Gerber + drill (fabrication .zip)", () => exporters.gerbers(design)],
                    ["Bill of materials (.csv)", () => exporters.bom(design)],
                    ["Pick and place (.csv)", () => exporters.pnp(design)],
                    ["KiCad board (.kicad_pcb)", () => exporters.kicadPcb(design)],
                    ["KiCad netlist (.net)", () => exporters.kicadNet(design)],
                    ["Netlist (.txt)", () => exporters.netlist(design)],
                    ["Project data (.json)", () => exporters.json(design)],
                  ] as const
                ).map(([label, fn]) => (
                  <button
                    key={label}
                    onClick={() => {
                      setMenu(false);
                      void fn();
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <aside className="left">
          <Library />
        </aside>

        <main className="main">
          {mode === "schematic" ? <SchematicCanvas presence={presence} /> : mode === "pcb" ? <PcbCanvas presence={presence} /> : <Board3D />}
        </main>

        <aside className="right">
          <div className="panel-tabs">
            <button className={tab === "copilot" ? "on" : ""} onClick={() => setTab("copilot")}>
              ✦ Copilot
            </button>
            <button className={tab === "inspect" ? "on" : ""} onClick={() => setTab("inspect")}>
              Inspect
            </button>
            <button className={tab === "checks" ? "on" : ""} onClick={() => setTab("checks")}>
              Checks
            </button>
            <button className={tab === "sim" ? "on" : ""} onClick={() => setTab("sim")}>
              Sim
            </button>
          </div>
          {tab === "copilot" && <Copilot enabled={copilot} />}
          {tab === "inspect" && <Inspector />}
          {tab === "checks" && <Checks />}
          {tab === "sim" && <Simulation />}
        </aside>
      </div>
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </EditorContext.Provider>
  );

}

function ProjectName({ projectId, name: current, onError }: { projectId: string; name: string; onError: (msg: string) => void }) {
  const [name, setName] = useState(current);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setName(current);
  }, [current, editing]);
  return (
    <input
      className="title-input"
      value={name}
      onFocus={() => setEditing(true)}
      onChange={(e) => setName(e.target.value)}
      onBlur={() => {
        setEditing(false);
        const n = name.trim();
        if (n && n !== current) api.rename(projectId, n).catch((e: Error) => onError(e.message));
        else setName(current);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}
