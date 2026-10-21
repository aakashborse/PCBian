import { bomCost, bomCsv, bomLines, bomRisks, priceAt, updateComponent, type BomLine, type Lifecycle, type SupplierOffer } from "@pcbian/core";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useEditor } from "./context";

const LIFE: Record<Lifecycle, { label: string; tone: "ok" | "warn" | "bad" }> = {
  active: { label: "Active", tone: "ok" },
  new: { label: "New", tone: "ok" },
  nrnd: { label: "NRND", tone: "warn" },
  eol: { label: "End of life", tone: "bad" },
  obsolete: { label: "Obsolete", tone: "bad" },
  unknown: { label: "Unknown", tone: "warn" },
};

const money = (v: number, cur: string) => `${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 4 : 2 })} ${cur}`;

/** Bill of materials with live supplier data: stock, lifecycle and price at a build quantity. */
export function BomPanel() {
  const { design, conn, toast } = useEditor();
  const lines = useMemo(() => bomLines(design), [design]);
  const [boards, setBoards] = useState(10);
  const [supplier, setSupplier] = useState<{ name: string; enabled: boolean } | null>(null);
  const [offers, setOffers] = useState<Record<string, SupplierOffer | null>>({});
  const [busy, setBusy] = useState(false);
  const [finding, setFinding] = useState<{ key: string; results: SupplierOffer[] | "loading" } | null>(null);
  useEffect(() => {
    api.supplier().then(setSupplier, () => setSupplier({ name: "Mouser", enabled: false }));
  }, []);

  const setMpn = (line: BomLine, mpn: string) => {
    conn.doc.transact(() => {
      for (const ref of line.refs) {
        const c = design.components.find((x) => x.ref === ref);
        if (c) updateComponent(conn.doc, c.id, { mpn: mpn.trim() || undefined });
      }
    });
  };
  const check = async () => {
    setBusy(true);
    try {
      const r = await api.supplierLookup(lines.map((l) => l.mpn).filter(Boolean));
      setOffers((o) => ({ ...o, ...r.offers }));
      if (r.errors.length) toast(r.errors[0]);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const find = async (line: BomLine) => {
    setFinding({ key: line.key, results: "loading" });
    try {
      const { offers: found } = await api.supplierSearch(`${line.value} ${line.footprint}`.trim());
      setFinding({ key: line.key, results: found });
    } catch (e) {
      toast((e as Error).message);
      setFinding(null);
    }
  };
  const cost = bomCost(lines, offers, boards);
  const exportCsv = () => {
    const blob = new Blob([bomCsv(design, Object.keys(offers).length ? { offers, boards } : undefined)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${design.name.replace(/[^\w.-]+/g, "_")}-bom${Object.keys(offers).length ? `-${boards}x` : ""}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="panel-body bom">
      <div className="row" style={{ marginBottom: 8, gap: 6 }}>
        <h4 style={{ margin: 0 }}>Bill of materials</h4>
        <span className="muted small">{lines.length} lines</span>
        <span className="spacer" />
        <button className="small" onClick={exportCsv}>
          CSV
        </button>
      </div>
      <div className="row" style={{ gap: 6, marginBottom: 8 }}>
        <label className="small">Boards</label>
        <input type="number" min={1} value={boards} onChange={(e) => setBoards(Math.max(1, Number(e.target.value) || 1))} style={{ width: 70 }} />
        <span className="spacer" />
        <button className="primary small" disabled={!supplier?.enabled || busy || !lines.some((l) => l.mpn)} onClick={check} title={supplier?.enabled ? "" : "Set MOUSER_API_KEY on the server"}>
          {busy ? "Checking…" : `Check ${supplier?.name ?? "supplier"}`}
        </button>
      </div>
      {supplier && !supplier.enabled && <p className="muted small">Live price, stock and lifecycle need a Mouser API key: set MOUSER_API_KEY on the server.</p>}
      {cost.priced > 0 && (
        <div className="card bom-total">
          <b>{money(cost.total, cost.currency)}</b> for {boards} boards · {money(cost.perBoard, cost.currency)} each
          <div className="muted small">
            {cost.priced} of {cost.lines} lines priced
          </div>
        </div>
      )}
      {lines.map((l) => {
        const o = l.mpn ? offers[l.mpn] : undefined;
        const checked = l.mpn ? l.mpn in offers : false;
        const p = o ? priceAt(o, l.qty * boards) : null;
        const risks = checked || !l.mpn ? bomRisks(l, o, boards) : [];
        return (
          <div key={l.key} className="card bom-line">
            <div className="row" style={{ gap: 6 }}>
              <b className="small">{l.refs.join(" ")}</b>
              <span className="spacer" />
              <span className="muted small">
                ×{l.qty} · {l.value} · {l.footprint}
              </span>
            </div>
            <div className="row" style={{ gap: 4, marginTop: 4 }}>
              <input key={l.mpn} defaultValue={l.mpn} placeholder="Manufacturer part number" onBlur={(e) => e.target.value.trim() !== l.mpn && setMpn(l, e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} style={{ flex: 1, minWidth: 0 }} />
              {supplier?.enabled && (
                <button className="small" onClick={() => find(l)} title="Search the supplier by value and package">
                  Find
                </button>
              )}
            </div>
            {finding?.key === l.key && (
              <div className="bom-find">
                {finding.results === "loading" ? (
                  <span className="muted small">Searching…</span>
                ) : finding.results.length ? (
                  finding.results.slice(0, 6).map((r) => (
                    <button
                      key={r.sku}
                      className="bom-pick"
                      onClick={() => {
                        setMpn(l, r.mpn);
                        setOffers((x) => ({ ...x, [r.mpn]: r }));
                        setFinding(null);
                      }}
                    >
                      <b>{r.mpn}</b> {r.manufacturer} · {r.stock.toLocaleString()} in stock{r.priceBreaks[0] ? ` · ${money(r.priceBreaks[0].price, r.priceBreaks[0].currency)}` : ""}
                      <div className="muted small">{r.description}</div>
                    </button>
                  ))
                ) : (
                  <span className="muted small">Nothing in stock matched “{l.value} {l.footprint}”.</span>
                )}
              </div>
            )}
            {o && (
              <div className="row small" style={{ gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                <span className={`life ${LIFE[o.lifecycle].tone}`}>{LIFE[o.lifecycle].label}</span>
                <span>{o.stock.toLocaleString()} in stock</span>
                {p && (
                  <span>
                    {money(p.unit, p.currency)} × {p.orderQty} = <b>{money(p.extended, p.currency)}</b>
                  </span>
                )}
                {o.url && (
                  <a href={o.url} target="_blank" rel="noreferrer">
                    {o.supplier}
                  </a>
                )}
              </div>
            )}
            {risks.map((r) => (
              <div key={r} className="issue">
                <span className={`sev ${/no manufacturer/.test(r) ? "warning" : "error"}`}>{/no manufacturer/.test(r) ? "warn" : "risk"}</span>
                <span>{r}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
