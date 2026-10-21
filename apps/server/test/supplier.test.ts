import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MouserClient } from "../src/supplier";

const fixture = (n: string) => JSON.parse(readFileSync(new URL(`../../../packages/core/test/fixtures/${n}.json`, import.meta.url), "utf8"));

function fakeFetch(responses: Record<string, unknown>) {
  const calls: { url: string; body: unknown; at: number }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body, at: Date.now() });
    const mpn = body.SearchByPartRequest?.mouserPartNumber ?? body.SearchByKeywordRequest?.keyword;
    return new Response(JSON.stringify(responses[mpn] ?? { Errors: [], SearchResults: { NumberOfResult: 0, Parts: [] } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("Mouser client", () => {
  it("looks parts up once, spaced out, and caches them", async () => {
    const { f, calls } = fakeFetch({ "RC0603FR-0710KL": fixture("mouser-partnumber"), NE555P: fixture("mouser-nrnd") });
    const m = new MouserClient("KEY", null, f, 60);
    const r = await m.lookup(["RC0603FR-0710KL", "NE555P", "NOPE-123", "RC0603FR-0710KL"]);
    expect(r.errors).toEqual([]);
    expect(r.offers["RC0603FR-0710KL"]).toMatchObject({ sku: "603-RC0603FR-0710KL", stock: 1250000 });
    expect(r.offers.NE555P).toMatchObject({ lifecycle: "nrnd" });
    expect(r.offers["NOPE-123"]).toBeNull();
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe("https://api.mouser.com/api/v1/search/partnumber?apiKey=KEY");
    expect(calls[0].body).toEqual({ SearchByPartRequest: { mouserPartNumber: "RC0603FR-0710KL", partSearchOptions: "Exact" } });
    // Requests are spaced to respect the rate limit.
    expect(calls[2].at - calls[1].at).toBeGreaterThanOrEqual(55);
    await m.lookup(["NE555P"]);
    expect(calls).toHaveLength(3);
  });

  it("reports API errors per part and refuses without a key", async () => {
    const { f } = fakeFetch({ BAD: fixture("mouser-error") });
    const r = await new MouserClient("KEY", null, f, 0).lookup(["BAD"]);
    expect(r.errors[0]).toMatch(/BAD: Mouser: Invalid unique identifier/);
    const off = new MouserClient(undefined, null, f, 0);
    expect(off.enabled).toBe(false);
    await expect(off.keyword("10k")).rejects.toThrow(/MOUSER_API_KEY/);
  });
});
