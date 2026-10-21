// One in-memory Y.Doc per open project, synced to browsers over the standard
// y-websocket protocol and persisted to disk as a Yjs state update.
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { WebSocket } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { projectFile } from "./store.js";
import { noteChange } from "./versions.js";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

export class Room {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly conns = new Map<WebSocket, Set<number>>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(readonly id: string) {
    this.awareness.setLocalState(null);
    const file = projectFile(id, "ydoc");
    if (fs.existsSync(file)) Y.applyUpdate(this.doc, fs.readFileSync(file));

    this.doc.on("update", (update: Uint8Array) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      this.broadcast(encoding.toUint8Array(enc));
      this.scheduleSave();
      noteChange(this);
    });

    this.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      const ids = this.conns.get(origin as WebSocket);
      if (ids) {
        added.forEach((c) => ids.add(c));
        removed.forEach((c) => ids.delete(c));
      }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
      this.broadcast(encoding.toUint8Array(enc));
    });
  }

  private broadcast(msg: Uint8Array) {
    for (const ws of this.conns.keys()) send(ws, msg);
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 500);
  }

  save() {
    const file = projectFile(this.id, "ydoc");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Y.encodeStateAsUpdate(this.doc));
  }

  connect(ws: WebSocket) {
    this.conns.set(ws, new Set());
    ws.binaryType = "arraybuffer";
    ws.on("message", (data: ArrayBuffer | Buffer) => this.onMessage(ws, new Uint8Array(data as ArrayBuffer)));

    let alive = true;
    ws.on("pong", () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30_000);

    ws.on("close", () => {
      clearInterval(ping);
      const ids = this.conns.get(ws);
      this.conns.delete(ws);
      if (ids?.size) awarenessProtocol.removeAwarenessStates(this.awareness, [...ids], null);
      if (this.conns.size === 0) this.save();
    });

    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    send(ws, encoding.toUint8Array(enc));
    const states = this.awareness.getStates();
    if (states.size) {
      const aw = encoding.createEncoder();
      encoding.writeVarUint(aw, MSG_AWARENESS);
      encoding.writeVarUint8Array(aw, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]));
      send(ws, encoding.toUint8Array(aw));
    }
  }

  private onMessage(ws: WebSocket, msg: Uint8Array) {
    try {
      const dec = decoding.createDecoder(msg);
      const type = decoding.readVarUint(dec);
      if (type === MSG_SYNC) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.readSyncMessage(dec, enc, this.doc, ws);
        if (encoding.length(enc) > 1) send(ws, encoding.toUint8Array(enc));
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(dec), ws);
      }
    } catch (err) {
      console.error(`[room ${this.id}] bad message`, err);
    }
  }
}

function send(ws: WebSocket, msg: Uint8Array) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(msg, (err) => err && ws.close());
}

const rooms = new Map<string, Room>();

export function getRoom(id: string): Room {
  let room = rooms.get(id);
  if (!room) {
    room = new Room(id);
    rooms.set(id, room);
  }
  return room;
}

export function dropRoom(id: string) {
  const room = rooms.get(id);
  if (!room) return;
  for (const ws of room.conns.keys()) ws.close();
  rooms.delete(id);
}

export function saveAll() {
  for (const r of rooms.values()) r.save();
}

export function roomIdFromRequest(req: IncomingMessage): string | null {
  const m = (req.url ?? "").match(/^\/yjs\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}
