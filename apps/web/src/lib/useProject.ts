import { getDesign, syncChannels, type Design } from "@pcbian/core";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

export interface ProjectConnection {
  doc: Y.Doc;
  provider: WebsocketProvider;
  undo: Y.UndoManager;
}

export function useProjectConnection(id: string): { conn: ProjectConnection; synced: boolean; online: boolean } {
  const conn = useMemo(() => {
    const doc = new Y.Doc();
    // Count updates from the start: the first sync can land before React subscribes.
    trackVersions(doc);
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/yjs`;
    const provider = new WebsocketProvider(url, id, doc);
    keepChannelsInSync(doc);
    const undo = new Y.UndoManager(["components", "wires", "traces", "vias", "zones", "parts", "keepouts", "schGraphics", "pcbGraphics", "meta", "comments"].map((k) => doc.getMap(k)), { captureTimeout: 400 });
    return { doc, provider, undo };
  }, [id]);
  const [synced, setSynced] = useState(false);
  const [online, setOnline] = useState(false);

  useEffect(() => {
    const onSync = (s: boolean) => setSynced(s);
    const onStatus = ({ status }: { status: string }) => setOnline(status === "connected");
    conn.provider.on("sync", onSync);
    conn.provider.on("status", onStatus);
    // The provider may have connected and synced before this effect subscribed.
    setSynced(conn.provider.synced);
    setOnline(conn.provider.wsconnected);
    return () => {
      conn.provider.off("sync", onSync);
      conn.provider.off("status", onStatus);
      conn.undo.destroy();
      conn.provider.destroy();
      conn.doc.destroy();
    };
  }, [conn]);
  return { conn, synced, online };
}

/**
 * After each local edit (including undo/redo), bring repeated-channel sheets in line with their
 * templates. Remote edits are synced by the client that made them. The sync itself is not undoable
 * on its own: undoing the template edit re-syncs the channels.
 */
function keepChannelsInSync(doc: Y.Doc) {
  let queued = false;
  doc.on("afterTransaction", (tr: Y.Transaction) => {
    if (!tr.local || tr.origin === "channels" || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      doc.transact(() => syncChannels(doc), "channels");
    });
  });
}

const versions = new WeakMap<Y.Doc, number>();
const listeners = new WeakMap<Y.Doc, Set<() => void>>();

/** Keep a version number per document that bumps on every update, whoever is listening. */
function trackVersions(doc: Y.Doc) {
  if (listeners.has(doc)) return;
  listeners.set(doc, new Set());
  doc.on("update", () => {
    versions.set(doc, (versions.get(doc) ?? 0) + 1);
    for (const cb of listeners.get(doc)!) cb();
  });
}

/** Subscribe to document changes; returns a version number that bumps on every update. */
export function useDocVersion(doc: Y.Doc): number {
  trackVersions(doc);
  return useSyncExternalStore(
    (cb) => {
      listeners.get(doc)!.add(cb);
      return () => listeners.get(doc)!.delete(cb);
    },
    () => versions.get(doc) ?? 0,
  );
}

/** Re-renders on every document change and returns a plain snapshot of the design. */
export function useDesign(doc: Y.Doc): Design {
  const version = useDocVersion(doc);
  return useMemo(() => getDesign(doc), [doc, version]);
}
