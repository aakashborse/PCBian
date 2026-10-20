import { addCustomPart, buildPart, importKicadPart, PARTS, searchParts, type PackageSpec, type PartDef } from "@pcbian/core";
import { useMemo, useState } from "react";
import { useEditor } from "./context";
import { SymbolThumb } from "./render";

export function Library() {
  const { placing, setPlacing, setMode, conn, design } = useEditor();
  const [q, setQ] = useState("");
  const [dialog, setDialog] = useState<"new" | "kicad" | null>(null);
  // `design` changes whenever the document does, which is when custom parts may have changed.
  const custom = useMemo(() => [...conn.doc.getMap<PartDef>("parts").values()], [conn.doc, design]);
  const list = useMemo(() => (q.trim() ? searchParts(q, 60, custom) : [...custom, ...PARTS]), [q, custom]);
  const cats = useMemo(() => {
    const m = new Map<string, PartDef[]>();
    for (const p of list) {
      if (!m.has(p.category)) m.set(p.category, []);
      m.get(p.category)!.push(p);
    }
    return [...m];
  }, [list]);
  return (
    <>
      <div className="panel-head" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <input placeholder="Search parts…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: "100%" }} />
        <div className="row">
          <button className="small" style={{ flex: 1 }} onClick={() => setDialog("new")} title="Create a part from a pin list and package">
            + New part
          </button>
          <button className="small" style={{ flex: 1 }} onClick={() => setDialog("kicad")} title="Import a KiCad symbol + footprint">
            Import KiCad
          </button>
        </div>
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
        {list.length === 0 && <p className="muted small">No parts match "{q}". Create it with "+ New part", import it from KiCad, or ask the copilot to create it.</p>}
      </div>
      {dialog === "new" && <NewPartDialog onClose={() => setDialog(null)} />}
      {dialog === "kicad" && <KicadImportDialog onClose={() => setDialog(null)} />}
    </>
  );
}

const PACKAGES: { label: string; spec: (n: number) => PackageSpec; fixed?: number }[] = [
  { label: "SOIC", spec: (n) => ({ type: "soic", pins: n }) },
  { label: "DIP", spec: (n) => ({ type: "dip", pins: n }) },
  { label: "TQFP (0.5mm)", spec: (n) => ({ type: "qfp", pins: n, pitch: 0.5 }) },
  { label: "TQFP (0.8mm)", spec: (n) => ({ type: "qfp", pins: n, pitch: 0.8 }) },
  { label: "Pin header", spec: (n) => ({ type: "header", pins: n }) },
  { label: "SOT-23", spec: () => ({ type: "sot23" }), fixed: 3 },
  { label: "SOT-223", spec: () => ({ type: "sot223" }), fixed: 4 },
  { label: "SOD-123", spec: () => ({ type: "sod123" }), fixed: 2 },
  { label: "0603 chip", spec: () => ({ type: "chip", size: "0603" }), fixed: 2 },
  { label: "0805 chip", spec: () => ({ type: "chip", size: "0805" }), fixed: 2 },
  { label: "THT 2-pin", spec: () => ({ type: "tht2" }), fixed: 2 },
];

function NewPartDialog({ onClose }: { onClose: () => void }) {
  const { conn, setPlacing, setMode } = useEditor();
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("U");
  const [desc, setDesc] = useState("");
  const [pkg, setPkg] = useState(0);
  const [pins, setPins] = useState("1 VCC\n2 GND\n3 IN\n4 OUT");
  const [error, setError] = useState("");
  const create = () => {
    try {
      const parsed = pins
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [number, ...rest] = l.split(/[\s,;:=]+/);
          return { number, name: rest.join(" ") || number };
        });
      const p = PACKAGES[pkg];
      const part = buildPart({ name: name.trim() || "Custom part", refPrefix: prefix.trim() || "U", description: desc.trim() || name, pins: parsed, package: p.spec(p.fixed ?? parsed.length) });
      addCustomPart(conn.doc, part);
      setMode("schematic");
      setPlacing(part.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>New part</h3>
        <p className="muted small" style={{ margin: 0 }}>
          Generates a schematic symbol and footprint. List one pin per line as "number name"; every pad of the package needs a pin.
        </p>
        <div className="row">
          <input placeholder="Name / MPN, e.g. MCP9700A" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 2 }} autoFocus />
          <input placeholder="Ref" value={prefix} onChange={(e) => setPrefix(e.target.value)} style={{ width: 60 }} />
        </div>
        <input placeholder="Description" value={desc} onChange={(e) => setDesc(e.target.value)} />
        <select value={pkg} onChange={(e) => setPkg(Number(e.target.value))}>
          {PACKAGES.map((p, i) => (
            <option key={p.label} value={i}>
              {p.label}
            </option>
          ))}
        </select>
        <textarea value={pins} onChange={(e) => setPins(e.target.value)} rows={8} style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }} />
        {error && <div style={{ color: "var(--danger)", fontSize: 12 }}>{error}</div>}
        <div className="row">
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={create}>
            Create &amp; place
          </button>
        </div>
      </div>
    </div>
  );
}

function KicadImportDialog({ onClose }: { onClose: () => void }) {
  const { conn, setPlacing, setMode } = useEditor();
  const [sym, setSym] = useState<string | null>(null);
  const [mod, setMod] = useState<string | null>(null);
  const [error, setError] = useState("");
  const read = (set: (s: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) f.text().then(set);
  };
  const doImport = () => {
    try {
      const part = importKicadPart(sym!, mod!);
      addCustomPart(conn.doc, part);
      setMode("schematic");
      setPlacing(part.id);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Import from KiCad</h3>
        <p className="muted small" style={{ margin: 0 }}>
          Choose a symbol (.kicad_sym, first symbol is used) and a footprint (.kicad_mod). Pins and pads are matched by number. Libraries such as SnapEDA/Ultra Librarian downloads in KiCad format work too.
        </p>
        <label className="small">
          Symbol (.kicad_sym)
          <input type="file" accept=".kicad_sym" onChange={read(setSym)} style={{ width: "100%" }} />
        </label>
        <label className="small">
          Footprint (.kicad_mod)
          <input type="file" accept=".kicad_mod" onChange={read(setMod)} style={{ width: "100%" }} />
        </label>
        {error && <div style={{ color: "var(--danger)", fontSize: 12 }}>{error}</div>}
        <div className="row">
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!sym || !mod} onClick={doImport}>
            Import &amp; place
          </button>
        </div>
      </div>
    </div>
  );
}
