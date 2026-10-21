import { computeNets, type Vec } from "@pcbian/core";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { navigate } from "../lib/router";
import { useDesign, useProjectConnection } from "../lib/useProject";
import { useUser } from "../lib/user";
import { HistoryPanel } from "./History";
import { BomPanel } from "./Bom";
import { ReviewPanel } from "./Review";
import { initials, UserBadge } from "../pages/UserBadge";
import { Checks } from "./Checks";
import { EditorContext, type EditorState, type FocusRequest, type Selection, type ViewMode } from "./context";
import { Copilot } from "./Copilot";
import { Inspector } from "./Inspector";
import { Library } from "./Library";
import { PcbCanvas } from "./PcbCanvas";
import { usePresence } from "./presence";
import { SchematicCanvas } from "./SchematicCanvas";

// Heavy, occasionally used parts load on demand: three.js for 3D, the simulator UI, and the
// exporters (with their zip/PDF/STEP writers).
const Board3D = lazy(() => import("./Board3D").then((m) => ({ default: m.Board3D })));
const Simulation = lazy(() => import("./Simulation").then((m) => ({ default: m.Simulation })));
const exporters = () => import("./exporters").then((m) => m.exporters);
const Loading = () => <div className="hint">Loading…</div>;

type RightTab = "copilot" | "inspect" | "checks" | "bom" | "sim" | "review" | "history";

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
  const [importReport, setImportReport] = useState<{ components: number; nets: number; sheets: number; traces: number; vias: number; zones: number; warnings: string[] } | null>(() => {
    try {
      const raw = sessionStorage.getItem(`pcbian.import.${projectId}`);
      if (raw) sessionStorage.removeItem(`pcbian.import.${projectId}`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

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
      if (s) setTab((t) => (s.kind === "comment" ? "review" : t === "checks" ? t : "inspect"));
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
      (selection.kind === "zone" && design.zones.some((z) => z.id === selection.id)) ||
      (selection.kind === "keepout" && design.keepouts.some((k) => k.id === selection.id)) ||
      (selection.kind === "dimension" && design.pcbGraphics.some((g) => g.id === selection.id)) ||
      (selection.kind === "graphic" && design.schGraphics.some((g) => g.id === selection.id)) ||
      (selection.kind === "comment" && design.comments.some((c) => c.id === selection.id));
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
                    ["Gerber + drill (fabrication .zip)", async () => (await exporters()).gerbers(design)],
                    ["Schematic (.pdf)", async () => (await exporters()).schematicPdf(design)],
                    ["Schematic (.svg)", async () => (await exporters()).svg(design)],
                    ["Assembly drawing (.pdf)", async () => (await exporters()).assemblyPdf(design)],
                    ["3D model (.step)", async () => (await exporters()).step(design)],
                    ["IPC-2581 (.xml)", async () => (await exporters()).ipc2581(design)],
                    ["ODB++ (.zip)", async () => (await exporters()).odb(design)],
                    ["Bill of materials (.csv)", async () => (await exporters()).bom(design)],
                    ["Pick and place (.csv)", async () => (await exporters()).pnp(design)],
                    ["KiCad board (.kicad_pcb)", async () => (await exporters()).kicadPcb(design)],
                    ["KiCad netlist (.net)", async () => (await exporters()).kicadNet(design)],
                    ["Netlist (.txt)", async () => (await exporters()).netlist(design)],
                    ["Project data (.json)", async () => (await exporters()).json(design)],
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
          {mode === "schematic" ? <SchematicCanvas presence={presence} /> : mode === "pcb" ? <PcbCanvas presence={presence} /> : (
            <Suspense fallback={<Loading />}>
              <Board3D />
            </Suspense>
          )}
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
            <button className={tab === "bom" ? "on" : ""} onClick={() => setTab("bom")} title="Bill of materials and supplier data">
              BOM
            </button>
            <button className={tab === "sim" ? "on" : ""} onClick={() => setTab("sim")}>
              Sim
            </button>
            <button className={tab === "review" ? "on" : ""} onClick={() => setTab("review")} title="Review comments">
              Review{design.comments.some((c) => !c.resolved) ? ` ${design.comments.filter((c) => !c.resolved).length}` : ""}
            </button>
            <button className={tab === "history" ? "on" : ""} onClick={() => setTab("history")} title="Version history">
              History
            </button>
          </div>
          {tab === "copilot" && <Copilot enabled={copilot} />}
          {tab === "inspect" && <Inspector />}
          {tab === "checks" && <Checks />}
          {tab === "bom" && <BomPanel />}
          {tab === "review" && <ReviewPanel />}
          {tab === "history" && <HistoryPanel />}
          {tab === "sim" && (
            <Suspense fallback={<Loading />}>
              <Simulation />
            </Suspense>
          )}
        </aside>
      </div>
      {toastMsg && <div className="toast">{toastMsg}</div>}
      {importReport && (
        <div className="modal-backdrop" onClick={() => setImportReport(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: "min(560px, calc(100vw - 32px))" }}>
            <h3>Import report</h3>
            <p className="small" style={{ margin: 0 }}>
              {importReport.components} components · {importReport.nets} nets · {importReport.sheets || 1} sheet(s) · {importReport.traces} track segments · {importReport.vias} vias · {importReport.zones} pours
            </p>
            {importReport.warnings.length > 0 && (
              <div className="card small" style={{ maxHeight: 260, overflow: "auto", margin: 0 }}>
                {importReport.warnings.map((w, i) => (
                  <div key={i} style={{ color: "var(--warn)", marginBottom: 3 }}>
                    ⚠ {w}
                  </div>
                ))}
              </div>
            )}
            <div className="row">
              <span className="spacer" />
              <button className="primary" onClick={() => setImportReport(null)}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}
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
