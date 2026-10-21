import { compileRules, runDrc, runErc, setDesignRules, type Issue } from "@pcbian/core";
import { useEffect, useMemo, useState } from "react";
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
      <RulesEditor />
    </div>
  );
}

const RULES_EXAMPLE = `(rule "HV spacing"
  (condition "A.NetClass == 'HV' && B.NetClass != 'HV'")
  (constraint clearance (min 1.5mm)))
(rule "USB width" (condition "A.NetName == 'USB_D*'") (constraint track_width (min 0.2mm) (max 0.3mm)))
(rule "No vias under U1" (condition "A.insideArea('U1 keepout')") (constraint disallow via))`;

/** Custom design rules: edited as text, checked live, applied to the shared design on demand. */
function RulesEditor() {
  const { design, conn } = useEditor();
  const [open, setOpen] = useState(Boolean(design.rules));
  const [text, setText] = useState(design.rules ?? "");
  // Follow edits made by collaborators or the copilot while this panel is open.
  useEffect(() => setText(design.rules ?? ""), [design.rules]);
  const check = useMemo(() => compileRules({ rules: text, keepouts: design.keepouts }), [text, design.keepouts]);
  const dirty = text !== (design.rules ?? "");
  return (
    <div style={{ marginBottom: 16 }}>
      <h4 className="row" style={{ cursor: "pointer" }} onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} Custom rules <span className="muted small">{check.rules.length} active</span>
      </h4>
      {open && (
        <>
          <p className="muted small">
            KiCad-style rules checked by the DRC; later rules win. Constraints: <code>clearance</code>, <code>edge_clearance</code>, <code>track_width</code>, <code>via_diameter</code>, <code>hole_size</code>, <code>disallow track|via|pad</code>. Conditions use <code>A.</code>/<code>B.</code> with Type, PadType, NetName, NetClass, Layer, Reference, Footprint, Pad, and <code>insideArea('name')</code> / <code>intersectsArea('name')</code> for named keepouts (rule areas).
          </p>
          <textarea className="mono" rows={Math.min(16, Math.max(6, text.split("\n").length + 1))} value={text} placeholder={RULES_EXAMPLE} spellCheck={false} onChange={(e) => setText(e.target.value)} />
          {check.errors.map((e, i) => (
            <div key={i} className="issue">
              <span className="sev warning">warn</span>
              <span>{e}</span>
            </div>
          ))}
          <div className="row" style={{ marginTop: 6 }}>
            <button className="primary" disabled={!dirty} onClick={() => setDesignRules(conn.doc, text)}>
              Apply rules
            </button>
            {dirty && <button onClick={() => setText(design.rules ?? "")}>Revert</button>}
            {!text && <button onClick={() => setText(RULES_EXAMPLE)}>Insert example</button>}
          </div>
        </>
      )}
    </div>
  );
}
