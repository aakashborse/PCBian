// Version history: named and automatic snapshots of a project's Yjs document, stored next to it.
import fs from "node:fs";
import path from "node:path";
import { designDiff, designFromUpdate, getDesign, restoreInto, summarizeDiff } from "@pcbian/core";
import * as Y from "yjs";
import type { Room } from "./rooms.js";
import { DATA_DIR, writeFileAtomic } from "./store.js";

export interface VersionMeta {
  id: string;
  name: string;
  author: string;
  createdAt: number;
  auto: boolean;
  /** Change summary relative to the previous version. */
  summary: string;
  stats: { parts: number; traces: number; vias: number };
}

const AUTO_EVERY_MS = 10 * 60_000;
const MAX_AUTO = 60;

export const versionsDir = (projectId: string) => path.join(DATA_DIR, "projects", `${projectId}.versions`);
const indexFile = (projectId: string) => path.join(versionsDir(projectId), "index.json");
const snapFile = (projectId: string, vid: string) => path.join(versionsDir(projectId), `${vid}.ydoc`);

export function listVersions(projectId: string): VersionMeta[] {
  try {
    return JSON.parse(fs.readFileSync(indexFile(projectId), "utf8")) as VersionMeta[];
  } catch {
    return [];
  }
}

function writeIndex(projectId: string, list: VersionMeta[]) {
  fs.mkdirSync(versionsDir(projectId), { recursive: true });
  writeFileAtomic(indexFile(projectId), JSON.stringify(list, null, 1));
}

export function versionUpdate(projectId: string, vid: string): Uint8Array | null {
  if (!/^[a-z0-9]+$/.test(vid)) return null;
  try {
    return new Uint8Array(fs.readFileSync(snapFile(projectId, vid)));
  } catch {
    return null;
  }
}

const lastSnapshot = new Map<string, number>();

/** Save the room's current state as a version. Returns null when nothing changed since the last one. */
export function saveVersion(room: Room, name: string, author: string, auto = false): VersionMeta | null {
  const list = listVersions(room.id);
  const update = Y.encodeStateAsUpdate(room.doc);
  const cur = getDesign(room.doc);
  const prev = list[0] ? versionUpdate(room.id, list[0].id) : null;
  const diff = prev ? designDiff(designFromUpdate(prev), cur) : null;
  if (auto && diff?.same) return null;
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  fs.mkdirSync(versionsDir(room.id), { recursive: true });
  writeFileAtomic(snapFile(room.id, id), update);
  const meta: VersionMeta = {
    id,
    name,
    author,
    createdAt: Date.now(),
    auto,
    summary: diff ? summarizeDiff(diff) : "First version",
    stats: { parts: cur.components.length, traces: cur.traces.length, vias: cur.vias.length },
  };
  let next = [meta, ...list];
  // Keep every named version; prune the oldest automatic ones.
  const autos = next.filter((v) => v.auto);
  for (const old of autos.slice(MAX_AUTO)) {
    fs.rmSync(snapFile(room.id, old.id), { force: true });
    next = next.filter((v) => v.id !== old.id);
  }
  writeIndex(room.id, next);
  lastSnapshot.set(room.id, Date.now());
  return meta;
}

/** Called on every document change: takes an automatic snapshot at most every 10 minutes of editing. */
export function noteChange(room: Room) {
  const last = lastSnapshot.get(room.id) ?? listVersions(room.id)[0]?.createdAt ?? 0;
  if (Date.now() - last < AUTO_EVERY_MS) return;
  lastSnapshot.set(room.id, Date.now());
  // Defer so the snapshot includes the whole burst of edits that triggered it.
  setTimeout(() => {
    try {
      saveVersion(room, "Autosave", "PCBian", true);
    } catch (err) {
      console.error(`[versions ${room.id}]`, err);
    }
  }, 2000);
}

export function diffVersion(room: Room, vid: string) {
  const u = versionUpdate(room.id, vid);
  if (!u) return null;
  const d = designDiff(designFromUpdate(u), getDesign(room.doc));
  return { diff: d, summary: summarizeDiff(d) };
}

/** Restore a version into the live document (saving the current state first, so it can be undone). */
export function restoreVersion(room: Room, vid: string, author: string): VersionMeta | null {
  const u = versionUpdate(room.id, vid);
  if (!u) return null;
  const target = listVersions(room.id).find((v) => v.id === vid);
  saveVersion(room, `Before restoring "${target?.name ?? vid}"`, author, false);
  const snap = new Y.Doc();
  Y.applyUpdate(snap, u);
  restoreInto(room.doc, snap);
  return saveVersion(room, `Restored "${target?.name ?? vid}"`, author, false);
}

export function deleteVersions(projectId: string) {
  fs.rmSync(versionsDir(projectId), { recursive: true, force: true });
}
