import { PARTS, searchParts } from "@pcbian/core";
import { useMemo, useState } from "react";
import { useEditor } from "./context";
import { SymbolThumb } from "./render";

export function Library() {
  const { placing, setPlacing, setMode } = useEditor();
  const [q, setQ] = useState("");
  const list = useMemo(() => (q.trim() ? searchParts(q, 50) : PARTS), [q]);
  const cats = useMemo(() => {
    const m = new Map<string, typeof PARTS>();
    for (const p of list) {
      if (!m.has(p.category)) m.set(p.category, []);
      m.get(p.category)!.push(p);
    }
    return [...m];
  }, [list]);
  return (
    <>
      <div className="panel-head">
        <input placeholder="Search parts…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: "100%" }} />
      </div>
      <div className="panel-body" style={{ paddingTop: 0 }}>
        {cats.map(([cat, parts]) => (
          <div key={cat}>
            <div className="lib-cat">{cat}</div>
            {parts.map((p) => (
              <button
                key={p.id}
                className={`lib-item ${placing === p.id ? "on" : ""}`}
                title={`${p.description}${p.footprint ? `\nFootprint: ${p.footprint.name}` : ""}`}
                onClick={() => {
                  setMode("schematic");
                  setPlacing(placing === p.id ? null : p.id);
                }}
              >
                <SymbolThumb part={p} />
                <span>
                  <div style={{ fontSize: 12.5 }}>{p.name}</div>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {p.footprint?.name ?? "Symbol"}
                  </div>
                </span>
              </button>
            ))}
          </div>
        ))}
        {list.length === 0 && <p className="muted small">No parts match "{q}". Try the copilot: it can suggest alternatives.</p>}
      </div>
    </>
  );
}
