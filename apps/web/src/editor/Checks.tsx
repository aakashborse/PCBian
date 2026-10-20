import { runDrc, runErc, type Issue } from "@pcbian/core";
import { useMemo } from "react";
import { useEditor, type ViewMode } from "./context";

export function Checks() {
  const ed = useEditor();
  const { design, nets } = ed;
  const erc = useMemo(() => runErc(design, nets), [design, nets]);
  const drc = useMemo(() => runDrc(design), [design]);

  const open = (issue: Issue, view: ViewMode) => {
    ed.setMode(view);
    const ref = issue.refs?.[0];
    const c = ref ? design.components.find((x) => x.ref === ref) : undefined;
    if (c) ed.select({ kind: "component", id: c.id });
    const at = issue.at ?? (c ? (view === "pcb" ? c.pcb : c.sch) : undefined);
    if (at) ed.focusOn(view, at);
  };

  const section = (title: string, list: Issue[], view: ViewMode) => (
    <div style={{ marginBottom: 16 }}>
      <h4>
        {title}{" "}
        <span className="muted small">
          {list.filter((i) => i.severity === "error").length} errors · {list.filter((i) => i.severity === "warning").length} warnings
        </span>
      </h4>
      {list.length === 0 && <p className="muted small">✓ No issues</p>}
      {list.map((i, n) => (
        <div key={n} className="issue" onClick={() => open(i, view)}>
          <span className={`sev ${i.severity}`}>{i.severity === "error" ? "err" : "warn"}</span>
          <span>{i.message}</span>
        </div>
      ))}
    </div>
  );

  return (
    <div className="panel-body">
      {section("Electrical rules (ERC)", erc, "schematic")}
      {section("Design rules (DRC)", drc, "pcb")}
    </div>
  );
}
