import { readFileSync } from "node:fs";
import * as CFB from "cfb";
const f = CFB.read(readFileSync(process.argv[2]), { type: "buffer" });
console.log(f.FullPaths.slice(0, 12));
const e = f.FullPaths.findIndex((p) => /\/FileHeader$/.test(p));
const buf = Buffer.from(f.FileIndex[e].content as any);
let pos = 0; const recs: Record<string, string>[] = [];
while (pos < buf.length - 4) { const raw = buf.readUInt32LE(pos); const len = raw & 0xffffff; pos += 4; const s = buf.subarray(pos, pos + len).toString("latin1").replace(/\0+$/, ""); pos += len; recs.push(Object.fromEntries(s.split("|").filter((kv) => kv.includes("=")).map((kv) => [kv.slice(0, kv.indexOf("=")).toUpperCase(), kv.slice(kv.indexOf("=") + 1)]))); }
const cnt: Record<string, number> = {}; for (const r of recs) cnt[r.RECORD ?? "hdr"] = (cnt[r.RECORD ?? "hdr"] ?? 0) + 1; console.log(cnt);
const show = (t: string, n = 2) => recs.filter((r) => r.RECORD === t).slice(0, n).forEach((r) => console.log(t, JSON.stringify(r).slice(0, 600)));
for (const t of (process.argv[3] ?? "1,2,17,25,27,15,16,18,34,41,45").split(",")) show(t);
