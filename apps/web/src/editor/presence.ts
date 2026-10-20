import { chatArray, chatView, type ChatEntryView, type Vec } from "@pcbian/core";
import { useEffect, useState } from "react";
import type { WebsocketProvider } from "y-websocket";
import type * as Y from "yjs";
import type { LocalUser } from "../lib/user";
import type { ViewMode } from "./context";

export interface PresenceState {
  clientId: number;
  user: LocalUser;
  cursor: (Vec & { view: ViewMode }) | null;
  sel: string | null;
}

export function usePresence(provider: WebsocketProvider, user: LocalUser): PresenceState[] {
  const [states, setStates] = useState<PresenceState[]>([]);
  useEffect(() => {
    provider.awareness.setLocalStateField("user", user);
  }, [provider, user]);
  useEffect(() => {
    const aw = provider.awareness;
    const update = () => {
      const list: PresenceState[] = [];
      aw.getStates().forEach((s, clientId) => {
        if (clientId === aw.clientID || !s.user) return;
        list.push({ clientId, user: s.user as LocalUser, cursor: (s.cursor as PresenceState["cursor"]) ?? null, sel: (s.sel as string) ?? null });
      });
      setStates(list);
    };
    aw.on("change", update);
    update();
    return () => aw.off("change", update);
  }, [provider]);
  return states;
}

export function publishCursor(provider: WebsocketProvider, cursor: PresenceState["cursor"]) {
  provider.awareness.setLocalStateField("cursor", cursor);
}

export function useChat(doc: Y.Doc): ChatEntryView[] {
  const [entries, setEntries] = useState<ChatEntryView[]>([]);
  useEffect(() => {
    const arr = chatArray(doc);
    const update = () => setEntries(arr.toArray().map(chatView));
    arr.observeDeep(update);
    update();
    return () => arr.unobserveDeep(update);
  }, [doc]);
  return entries;
}
