import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importKicadProject, initDoc, setName } from "@pcbian/core";
import express from "express";
import { WebSocketServer } from "ws";
import { copilotEnabled, isBusy, resetCopilot, runCopilot, stopCopilot } from "./copilot.js";
import { dropRoom, getRoom, roomIdFromRequest, saveAll } from "./rooms.js";
import { createProjectMeta, deleteProjectMeta, getProject, listProjects, updateProjectMeta } from "./store.js";
import { buildTemplate, TEMPLATES, type TemplateId } from "./templates.js";

const PORT = Number(process.env.PORT ?? 8787);
const app = express();
app.use(express.json({ limit: "60mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, copilot: copilotEnabled() });
});

app.get("/api/templates", (_req, res) => {
  res.json(TEMPLATES);
});

app.get("/api/projects", (_req, res) => {
  res.json(listProjects());
});

app.post("/api/projects", (req, res) => {
  const name = String(req.body?.name ?? "").trim() || "Untitled project";
  const template = (TEMPLATES.some((t) => t.id === req.body?.template) ? req.body.template : "blank") as TemplateId;
  const meta = createProjectMeta(name);
  const room = getRoom(meta.id);
  buildTemplate(room.doc, template, name);
  room.save();
  res.status(201).json(meta);
});

// Create a project from KiCad files (.kicad_sch sheets and/or a .kicad_pcb board).
app.post("/api/projects/import", (req, res) => {
  const schematics = Array.isArray(req.body?.schematics) ? (req.body.schematics as { name: string; text: string }[]).filter((f) => typeof f?.text === "string") : [];
  const pcb = typeof req.body?.pcb === "string" ? req.body.pcb : undefined;
  if (!schematics.length && !pcb) return void res.status(400).json({ error: "Provide at least one .kicad_sch or a .kicad_pcb file" });
  const name = String(req.body?.name ?? "").trim() || "Imported KiCad project";
  const meta = createProjectMeta(name);
  const room = getRoom(meta.id);
  try {
    initDoc(room.doc, name);
    const report = importKicadProject(room.doc, { schematics, pcb });
    room.save();
    res.status(201).json({ ...meta, report });
  } catch (e) {
    dropRoom(meta.id);
    deleteProjectMeta(meta.id);
    res.status(400).json({ error: `Import failed: ${(e as Error).message}` });
  }
});

app.get("/api/projects/:id", (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return void res.status(404).json({ error: "Not found" });
  res.json(p);
});

app.patch("/api/projects/:id", (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return void res.status(404).json({ error: "Not found" });
  const name = String(req.body?.name ?? "").trim();
  if (name) {
    updateProjectMeta(p.id, { name });
    setName(getRoom(p.id).doc, name);
  }
  res.json(getProject(p.id));
});

app.delete("/api/projects/:id", (req, res) => {
  dropRoom(req.params.id);
  deleteProjectMeta(req.params.id);
  res.status(204).end();
});

app.post("/api/projects/:id/copilot", (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return void res.status(404).json({ error: "Not found" });
  if (!copilotEnabled()) return void res.status(503).json({ error: "The copilot is not configured. Set ANTHROPIC_API_KEY on the server." });
  const message = String(req.body?.message ?? "").trim();
  const author = String(req.body?.author ?? "Someone").slice(0, 40);
  if (!message) return void res.status(400).json({ error: "Empty message" });
  if (isBusy(p.id)) return void res.status(409).json({ error: "The copilot is busy with another request on this project" });
  updateProjectMeta(p.id, {});
  // The reply streams into the shared Yjs chat log; the HTTP call returns immediately.
  void runCopilot(getRoom(p.id), message, author);
  res.status(202).json({ ok: true });
});

app.post("/api/projects/:id/copilot/stop", (req, res) => {
  res.json({ stopped: stopCopilot(req.params.id) });
});

app.post("/api/projects/:id/copilot/reset", (req, res) => {
  const p = getProject(req.params.id);
  if (!p) return void res.status(404).json({ error: "Not found" });
  if (isBusy(p.id)) return void res.status(409).json({ error: "The copilot is busy" });
  resetCopilot(getRoom(p.id));
  res.json({ ok: true });
});

// Serve the built web app in production.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api|yjs).*/, (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const id = roomIdFromRequest(req);
  if (!id || !getProject(id)) return void socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => getRoom(id).connect(ws));
});

server.listen(PORT, () => {
  console.log(`PCBian server on http://localhost:${PORT} (copilot ${copilotEnabled() ? "enabled" : "disabled: set ANTHROPIC_API_KEY"})`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    saveAll();
    process.exit(0);
  });
}
