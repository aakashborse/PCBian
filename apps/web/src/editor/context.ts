import type { ChatEntryView, Design, Net, Vec } from "@pcbian/core";
import { createContext, useContext } from "react";
import type { ProjectConnection } from "../lib/useProject";

/** What is selected; `unit` picks one unit of a multi-unit part on the schematic (default 1). */
export type Selection = { kind: "component" | "wire" | "trace" | "via" | "zone" | "keepout" | "dimension" | "graphic" | "comment"; id: string; unit?: number } | null;
export type ViewMode = "schematic" | "pcb" | "3d";

export interface FocusRequest {
  view: ViewMode;
  at: Vec;
  n: number;
}

export interface EditorState {
  projectId: string;
  conn: ProjectConnection;
  design: Design;
  nets: Net[];
  selection: Selection;
  select: (s: Selection) => void;
  mode: ViewMode;
  setMode: (m: ViewMode) => void;
  placing: string | null;
  setPlacing: (partId: string | null) => void;
  focus: FocusRequest | null;
  focusOn: (view: ViewMode, at: Vec) => void;
  toast: (msg: string) => void;
}

export const EditorContext = createContext<EditorState | null>(null);

export function useEditor(): EditorState {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error("useEditor outside EditorContext");
  return ctx;
}

export type { ChatEntryView };
