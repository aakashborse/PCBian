// Multi-user collaboration load test: N clients edit one project at once over the same Yjs
// websocket protocol the editor uses, then every replica (and a fresh client reading the
// server's copy) must hold the identical design.
//
//   npx tsx tools/loadtest/collab.ts [--url http://localhost:8787] [--clients 20] [--edits 30]
//
// Exit status 1 if the replicas diverge or an update never arrives.
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";
import * as Y from "yjs";
import { addComment, addTrace, getDesign, updateComponent } from "../../packages/core/src/index.ts";

process.setMaxListeners(0); // one exit hook per provider
const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const base = arg("url", "http://localhost:8787");
const N = Number(arg("clients", "20"));
const EDITS = Number(arg("edits", "30"));
const ws = base.replace(/^http/, "ws") + "/yjs";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rnd = (n: number) => Math.floor(Math.random() * n);

function connect(id: string) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(ws, id, doc, { WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket, disableBc: true });
  const synced = new Promise<void>((resolve) => provider.on("sync", (s: boolean) => s && resolve()));
  return { doc, provider, synced };
}

/** Canonical design state: map iteration order may differ between replicas, content may not. */
const fingerprint = (doc: Y.Doc) => {
  const d = getDesign(doc);
  const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => (a.id < b.id ? -1 : 1));
  return JSON.stringify([byId(d.components), byId(d.traces), byId(d.vias), byId(d.zones), byId(d.comments), d.board, d.netClasses]);
};

async function main() {
  const res = await fetch(`${base}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `Load test ${new Date().toISOString()}`, template: "blinker555" }) });
  if (!res.ok) throw new Error(`create project: ${res.status}`);
  const { id } = (await res.json()) as { id: string };
  console.log(`project ${id}: ${N} clients x ${EDITS} edits`);

  const clients = Array.from({ length: N }, () => connect(id));
  const t0 = Date.now();
  await Promise.all(clients.map((c) => c.synced));
  console.log(`all clients synced in ${Date.now() - t0} ms`);

  // Propagation latency: client 0 stamps the doc, everyone else reports when they see it.
  const latencies: number[] = [];
  for (let k = 0; k < 5; k++) {
    const stamp = `${Date.now()}-${k}`;
    const seen = clients.slice(1).map(
      (c) =>
        new Promise<void>((resolve) => {
          const meta = c.doc.getMap("meta");
          const check = () => {
            if (meta.get("loadtest") === stamp) {
              latencies.push(Date.now() - start);
              meta.unobserve(check);
              resolve();
            }
          };
          meta.observe(check);
        }),
    );
    const start = Date.now();
    clients[0].doc.getMap("meta").set("loadtest", stamp);
    await Promise.race([Promise.all(seen), sleep(10_000)]);
  }
  latencies.sort((a, b) => a - b);
  const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((latencies.length * p) / 100))];
  console.log(`propagation: ${latencies.length}/${5 * (N - 1)} delivered, p50 ${pct(50)} ms, p95 ${pct(95)} ms, max ${latencies[latencies.length - 1]} ms`);

  // Concurrent edits: everyone moves the same parts (conflicts), adds traces and comments.
  const tEdit = Date.now();
  await Promise.all(
    clients.map(async (c, ci) => {
      for (let e = 0; e < EDITS; e++) {
        const d = getDesign(c.doc);
        const comp = d.components[rnd(d.components.length)];
        const r = rnd(10);
        if (r < 5 && comp) updateComponent(c.doc, comp.id, { pcb: { ...comp.pcb, x: comp.pcb.x + (rnd(21) - 10) / 10, y: comp.pcb.y + (rnd(21) - 10) / 10 } });
        else if (r < 8) addTrace(c.doc, { layer: rnd(2) ? "top" : "bottom", width: 0.25, points: [{ x: rnd(40), y: rnd(30) }, { x: rnd(40), y: rnd(30) }] });
        else addComment(c.doc, { author: `client ${ci}`, color: "#888", text: `edit ${e}`, view: "pcb", pos: { x: rnd(40), y: rnd(30) } });
        await sleep(rnd(40));
      }
    }),
  );
  console.log(`${N * EDITS} edits sent in ${Date.now() - tEdit} ms`);

  // Convergence.
  let same = false;
  const tConv = Date.now();
  while (Date.now() - tConv < 20_000) {
    const fps = clients.map((c) => fingerprint(c.doc));
    if (fps.every((f) => f === fps[0])) {
      same = true;
      break;
    }
    await sleep(100);
  }
  console.log(same ? `all ${N} replicas converged ${Date.now() - tConv} ms after the last edit` : "REPLICAS DIVERGED");

  // The server's copy, read by a client that joins afterwards.
  const late = connect(id);
  await late.synced;
  const serverSame = fingerprint(late.doc) === fingerprint(clients[0].doc);
  const d = getDesign(late.doc);
  console.log(`late joiner: ${d.components.length} components, ${d.traces.length} traces, ${d.comments.length} comments — ${serverSame ? "matches" : "DOES NOT MATCH"} the clients`);

  for (const c of [...clients, late]) c.provider.destroy();
  const ok = same && serverSame && latencies.length === 5 * (N - 1);
  console.log(ok ? "COLLABORATION LOAD TEST PASSED" : "COLLABORATION LOAD TEST FAILED");
  if (process.argv.includes("--keep")) console.log(`kept project ${id}`);
  else await fetch(`${base}/api/projects/${id}`, { method: "DELETE" });
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
