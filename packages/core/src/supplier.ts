// Supplier data for the bill of materials: BOM lines, Mouser search-API responses normalised into
// offers, price breaks at a build quantity, and the risks worth flagging (stock, lifecycle).
import { getPart } from "./library";
import type { Design } from "./types";

export type Lifecycle = "active" | "new" | "nrnd" | "eol" | "obsolete" | "unknown";

export interface PriceBreak {
  qty: number;
  price: number;
  currency: string;
}

export interface SupplierOffer {
  supplier: "Mouser";
  /** Supplier's own part number. */
  sku: string;
  mpn: string;
  manufacturer: string;
  description: string;
  stock: number;
  lifecycle: Lifecycle;
  leadTime?: string;
  priceBreaks: PriceBreak[];
  minQty: number;
  multQty: number;
  url?: string;
  datasheet?: string;
  rohs?: string;
}

export interface BomLine {
  key: string;
  refs: string[];
  /** Parts per board. */
  qty: number;
  value: string;
  part: string;
  footprint: string;
  mpn: string;
}

/** BOM lines: fitted parts grouped by library part, value and manufacturer part number. */
export function bomLines(design: Design): BomLine[] {
  const groups = new Map<string, BomLine>();
  for (const c of design.components) {
    const part = getPart(c.partId);
    if (!part || part.kind !== "part" || !part.footprint || c.dnp) continue;
    const mpn = c.mpn ?? part.mpn ?? "";
    const key = `${c.partId}|${c.value}|${mpn}`;
    if (!groups.has(key)) groups.set(key, { key, refs: [], qty: 0, value: c.value, part: part.name, footprint: part.footprint.name, mpn });
    const g = groups.get(key)!;
    g.refs.push(c.ref);
    g.qty++;
  }
  const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  return [...groups.values()].map((g) => ({ ...g, refs: g.refs.sort(natural) })).sort((a, b) => natural(a.refs[0], b.refs[0]));
}

const LIFECYCLE: [RegExp, Lifecycle][] = [
  [/obsolete/i, "obsolete"],
  [/end of life|\beol\b/i, "eol"],
  [/not recommended|nrnd/i, "nrnd"],
  [/new/i, "new"],
];

/** "$0.013", "0,10 €", "1.234,50 kr" -> number. */
export function parsePrice(s: string | number): number {
  if (typeof s === "number") return s;
  let t = s.replace(/[^\d.,]/g, "");
  // The last separator is the decimal one when both appear, or a lone comma with 1-3 trailing digits.
  const lastDot = t.lastIndexOf(".");
  const lastComma = t.lastIndexOf(",");
  if (lastComma > lastDot) t = t.replace(/\./g, "").replace(",", ".");
  else t = t.replace(/,/g, "");
  const v = Number(t);
  return Number.isFinite(v) ? v : NaN;
}

interface MouserPart {
  MouserPartNumber?: string;
  ManufacturerPartNumber?: string;
  Manufacturer?: string;
  Description?: string;
  Availability?: string;
  AvailabilityInStock?: string | null;
  LifecycleStatus?: string | null;
  LeadTime?: string;
  PriceBreaks?: { Quantity: number; Price: string; Currency: string }[];
  Min?: string;
  Mult?: string;
  ProductDetailUrl?: string;
  DataSheetUrl?: string;
  ROHSStatus?: string;
}

/** Offers from a Mouser search API response (part-number or keyword search). Throws on API errors. */
export function parseMouserResponse(json: unknown): SupplierOffer[] {
  const r = json as { Errors?: { Message?: string }[]; SearchResults?: { Parts?: MouserPart[] } | null };
  if (r?.Errors?.length) throw new Error(`Mouser: ${r.Errors.map((e) => e.Message ?? "error").join("; ")}`);
  return (r?.SearchResults?.Parts ?? []).map((p) => {
    const stock = Number(p.AvailabilityInStock ?? (p.Availability ?? "").match(/^([\d,]+)\s+In Stock/i)?.[1]?.replace(/,/g, "") ?? 0) || 0;
    const life = p.LifecycleStatus ? (LIFECYCLE.find(([re]) => re.test(p.LifecycleStatus!))?.[1] ?? "unknown") : "active";
    return {
      supplier: "Mouser" as const,
      sku: p.MouserPartNumber ?? "",
      mpn: p.ManufacturerPartNumber ?? "",
      manufacturer: p.Manufacturer ?? "",
      description: p.Description ?? "",
      stock,
      lifecycle: life,
      ...(p.LeadTime ? { leadTime: p.LeadTime } : {}),
      priceBreaks: (p.PriceBreaks ?? []).map((b) => ({ qty: b.Quantity, price: parsePrice(b.Price), currency: b.Currency })).filter((b) => Number.isFinite(b.price)).sort((a, b) => a.qty - b.qty),
      minQty: Number(p.Min ?? 1) || 1,
      multQty: Number(p.Mult ?? 1) || 1,
      ...(p.ProductDetailUrl ? { url: p.ProductDetailUrl } : {}),
      ...(p.DataSheetUrl ? { datasheet: p.DataSheetUrl } : {}),
      ...(p.ROHSStatus ? { rohs: p.ROHSStatus } : {}),
    };
  });
}

/** The offer for a manufacturer part number: an exact MPN match with the most stock, else the first. */
export function bestOffer(offers: SupplierOffer[], mpn: string): SupplierOffer | undefined {
  const norm = (s: string) => s.replace(/[\s-]/g, "").toUpperCase();
  const exact = offers.filter((o) => norm(o.mpn) === norm(mpn));
  return (exact.length ? exact : offers).slice().sort((a, b) => b.stock - a.stock)[0];
}

/** Order quantity (respecting minimum and multiple) and the price break that applies to it. */
export function priceAt(offer: SupplierOffer, needed: number): { orderQty: number; unit: number; extended: number; currency: string } | null {
  if (!offer.priceBreaks.length) return null;
  const orderQty = Math.max(offer.minQty, Math.ceil(needed / offer.multQty) * offer.multQty);
  const brk = [...offer.priceBreaks].reverse().find((b) => b.qty <= orderQty) ?? offer.priceBreaks[0];
  return { orderQty, unit: brk.price, extended: Math.round(brk.price * orderQty * 100) / 100, currency: brk.currency };
}

/** What could stop a line from being built in this quantity. */
export function bomRisks(line: BomLine, offer: SupplierOffer | undefined | null, boards: number): string[] {
  if (!line.mpn) return ["no manufacturer part number"];
  if (!offer) return ["not found at the supplier"];
  const out: string[] = [];
  const need = line.qty * boards;
  if (offer.stock < need) out.push(offer.stock ? `only ${offer.stock} in stock for ${need}` : "out of stock");
  if (offer.lifecycle === "obsolete") out.push("obsolete");
  else if (offer.lifecycle === "eol") out.push("end of life");
  else if (offer.lifecycle === "nrnd") out.push("not recommended for new designs");
  return out;
}

/** BOM cost summary for a number of boards. */
export function bomCost(lines: BomLine[], offers: Record<string, SupplierOffer | null | undefined>, boards: number) {
  let total = 0;
  let currency = "";
  let priced = 0;
  for (const l of lines) {
    const o = l.mpn ? offers[l.mpn] : undefined;
    const p = o && priceAt(o, l.qty * boards);
    if (!p) continue;
    total += p.extended;
    currency ||= p.currency;
    priced++;
  }
  return { total: Math.round(total * 100) / 100, perBoard: boards ? Math.round((total / boards) * 100) / 100 : 0, currency, priced, lines: lines.length };
}
