// Live supplier data from Mouser's search API (key from MOUSER_API_KEY). Lookups are cached on
// disk for a day and spaced out to stay inside Mouser's rate limit (30 requests a minute).
import fs from "node:fs";
import path from "node:path";
import { bestOffer, parseMouserResponse, type SupplierOffer } from "@pcbian/core";
import { DATA_DIR, writeFileAtomic } from "./store.js";

// Overridable for testing against a stand-in server.
const API = process.env.MOUSER_API_BASE ?? "https://api.mouser.com/api/v1/search";
const TTL = 24 * 3600 * 1000;
const SPACING = 2100;

type Fetch = typeof fetch;

export class MouserClient {
  private cache = new Map<string, { at: number; offers: SupplierOffer[] }>();
  private queue: Promise<unknown> = Promise.resolve();
  private last = 0;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly cacheFile: string | null,
    private readonly fetchImpl: Fetch = fetch,
    private readonly spacing = SPACING,
  ) {
    if (cacheFile && fs.existsSync(cacheFile)) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(cacheFile, "utf8")) as Record<string, { at: number; offers: SupplierOffer[] }>)) this.cache.set(k, v);
      } catch {
        // A damaged cache is only a cache.
      }
    }
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  /** Offers for manufacturer part numbers (best match per MPN, or null when Mouser has none). */
  async lookup(mpns: string[]): Promise<{ offers: Record<string, SupplierOffer | null>; errors: string[] }> {
    const offers: Record<string, SupplierOffer | null> = {};
    const errors: string[] = [];
    for (const mpn of [...new Set(mpns.map((m) => m.trim()).filter(Boolean))]) {
      try {
        const found = await this.search(`mpn:${mpn.toUpperCase()}`, "partnumber", { SearchByPartRequest: { mouserPartNumber: mpn, partSearchOptions: "Exact" } });
        offers[mpn] = bestOffer(found, mpn) ?? null;
      } catch (e) {
        errors.push(`${mpn}: ${(e as Error).message}`);
      }
    }
    return { offers, errors };
  }

  /** Keyword search, e.g. "10k 0603 resistor 1%" (the top results). */
  async keyword(text: string, records = 10): Promise<SupplierOffer[]> {
    return this.search(`kw:${text.toLowerCase()}:${records}`, "keyword", { SearchByKeywordRequest: { keyword: text, records, startingRecord: 0, searchOptions: "InStock", searchWithYourSignUpLanguage: "false" } });
  }

  private async search(key: string, kind: "partnumber" | "keyword", body: unknown): Promise<SupplierOffer[]> {
    if (!this.apiKey) throw new Error("Supplier lookups need MOUSER_API_KEY on the server");
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL) return hit.offers;
    const run = async () => {
      const wait = this.last + this.spacing - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      const res = await this.fetchImpl(`${API}/${kind}?apiKey=${encodeURIComponent(this.apiKey!)}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`Mouser HTTP ${res.status}`);
      return parseMouserResponse(await res.json());
    };
    // One request at a time, in order.
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    const offers = await p;
    this.cache.set(key, { at: Date.now(), offers });
    this.persist();
    return offers;
  }

  private persist() {
    if (!this.cacheFile) return;
    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
    writeFileAtomic(this.cacheFile, JSON.stringify(Object.fromEntries(this.cache)));
  }
}

export const mouser = new MouserClient(process.env.MOUSER_API_KEY, path.join(DATA_DIR, "supplier-cache.json"));
