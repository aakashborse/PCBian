import type { DesignDiff } from "@pcbian/core";

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface Template {
  id: string;
  name: string;
  description: string;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export interface ImportReport {
  components: number;
  nets: number;
  sheets: number;
  traces: number;
  vias: number;
  zones: number;
  warnings: string[];
}

export interface VersionMeta {
  id: string;
  name: string;
  author: string;
  createdAt: number;
  auto: boolean;
  summary: string;
  stats: { parts: number; traces: number; vias: number };
}

export const api = {
  health: () => call<{ ok: boolean; copilot: boolean }>("GET", "/api/health"),
  templates: () => call<Template[]>("GET", "/api/templates"),
  projects: () => call<ProjectMeta[]>("GET", "/api/projects"),
  project: (id: string) => call<ProjectMeta>("GET", `/api/projects/${id}`),
  create: (name: string, template: string) => call<ProjectMeta>("POST", "/api/projects", { name, template }),
  importKicad: (name: string, schematics: { name: string; text: string }[], pcb?: string) =>
    call<ProjectMeta & { report: ImportReport }>("POST", "/api/projects/import", { name, schematics, pcb }),
  importEagle: (name: string, eagle: { schematic?: string; board?: string }) => call<ProjectMeta & { report: ImportReport }>("POST", "/api/projects/import", { name, eagle }),
  importAltium: (name: string, base64: string) => call<ProjectMeta & { report: ImportReport }>("POST", "/api/projects/import", { name, altium: base64 }),
  rename: (id: string, name: string) => call<ProjectMeta>("PATCH", `/api/projects/${id}`, { name }),
  remove: (id: string) => call<void>("DELETE", `/api/projects/${id}`),
  ask: (id: string, message: string, author: string) => call<{ ok: boolean }>("POST", `/api/projects/${id}/copilot`, { message, author }),
  stopCopilot: (id: string) => call<{ stopped: boolean }>("POST", `/api/projects/${id}/copilot/stop`),
  resetCopilot: (id: string) => call<{ ok: boolean }>("POST", `/api/projects/${id}/copilot/reset`),
  versions: (id: string) => call<VersionMeta[]>("GET", `/api/projects/${id}/versions`),
  saveVersion: (id: string, name: string, author: string) => call<VersionMeta>("POST", `/api/projects/${id}/versions`, { name, author }),
  versionDiff: (id: string, vid: string) => call<{ diff: DesignDiff; summary: string }>("GET", `/api/projects/${id}/versions/${vid}/diff`),
  restoreVersion: (id: string, vid: string, author: string) => call<VersionMeta>("POST", `/api/projects/${id}/versions/${vid}/restore`, { author }),
  branchVersion: (id: string, vid: string, name: string, author: string) => call<ProjectMeta>("POST", `/api/projects/${id}/versions/${vid}/branch`, { name, author }),
};
