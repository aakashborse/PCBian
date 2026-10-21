import type { DesignDiff, ReleaseChecks, SupplierOffer } from "@pcbian/core";

export interface Release {
  id: string;
  revision: string;
  title: string;
  notes: string;
  versionId: string;
  status: "in_review" | "released" | "rejected" | "withdrawn";
  requestedBy: string;
  requestedAt: number;
  approvers: string[];
  required: number;
  decisions: { by: string; at: number; decision: "approve" | "reject"; comment: string }[];
  checks: ReleaseChecks;
  override?: string;
  files: string[];
  packageBytes: number;
  releasedAt?: number;
}

/** A release request the server refused, with the checks that failed (when that was the reason). */
export class ReleaseRefused extends Error {
  constructor(
    message: string,
    readonly checks?: ReleaseChecks,
  ) {
    super(message);
  }
}

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
  supplier: () => call<{ name: string; enabled: boolean }>("GET", "/api/supplier"),
  supplierLookup: (mpns: string[]) => call<{ offers: Record<string, SupplierOffer | null>; errors: string[] }>("POST", "/api/supplier/lookup", { mpns }),
  supplierSearch: (keyword: string) => call<{ offers: SupplierOffer[] }>("POST", "/api/supplier/search", { keyword }),
  templates: () => call<Template[]>("GET", "/api/templates"),
  projects: () => call<ProjectMeta[]>("GET", "/api/projects"),
  project: (id: string) => call<ProjectMeta>("GET", `/api/projects/${id}`),
  create: (name: string, template: string) => call<ProjectMeta>("POST", "/api/projects", { name, template }),
  importKicad: (name: string, schematics: { name: string; text: string }[], pcb?: string) =>
    call<ProjectMeta & { report: ImportReport }>("POST", "/api/projects/import", { name, schematics, pcb }),
  importEagle: (name: string, eagle: { schematic?: string; board?: string }) => call<ProjectMeta & { report: ImportReport }>("POST", "/api/projects/import", { name, eagle }),
  importAltium: (name: string, altium: { pcb?: string; schematics: { name: string; data: string }[] }) => call<ProjectMeta & { report: ImportReport }>("POST", "/api/projects/import", { name, altium }),
  rename: (id: string, name: string) => call<ProjectMeta>("PATCH", `/api/projects/${id}`, { name }),
  remove: (id: string) => call<void>("DELETE", `/api/projects/${id}`),
  ask: (id: string, message: string, author: string) => call<{ ok: boolean }>("POST", `/api/projects/${id}/copilot`, { message, author }),
  stopCopilot: (id: string) => call<{ stopped: boolean }>("POST", `/api/projects/${id}/copilot/stop`),
  resetCopilot: (id: string) => call<{ ok: boolean }>("POST", `/api/projects/${id}/copilot/reset`),
  versions: (id: string) => call<VersionMeta[]>("GET", `/api/projects/${id}/versions`),
  releases: (id: string) => call<{ releases: Release[]; suggestedRevision: string }>("GET", `/api/projects/${id}/releases`),
  async requestRelease(id: string, body: { revision: string; title?: string; notes?: string; approvers: string[]; required: number; author: string; override?: string }): Promise<Release> {
    const res = await fetch(`/api/projects/${id}/releases`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = (await res.json().catch(() => ({}))) as Release & { error?: string; checks?: ReleaseChecks };
    if (!res.ok) throw new ReleaseRefused(out.error ?? `${res.status}`, out.checks);
    return out;
  },
  decideRelease: (id: string, rid: string, by: string, decision: "approve" | "reject", comment?: string) => call<Release>("POST", `/api/projects/${id}/releases/${rid}/decision`, { by, decision, comment }),
  withdrawRelease: (id: string, rid: string, by: string) => call<Release>("POST", `/api/projects/${id}/releases/${rid}/withdraw`, { by }),
  saveVersion: (id: string, name: string, author: string) => call<VersionMeta>("POST", `/api/projects/${id}/versions`, { name, author }),
  versionDiff: (id: string, vid: string) => call<{ diff: DesignDiff; summary: string }>("GET", `/api/projects/${id}/versions/${vid}/diff`),
  versionUpdate: async (id: string, vid: string) => {
    const res = await fetch(`/api/projects/${id}/versions/${vid}/update`);
    if (!res.ok) throw new Error(`Version not found (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  },
  restoreVersion: (id: string, vid: string, author: string) => call<VersionMeta>("POST", `/api/projects/${id}/versions/${vid}/restore`, { author }),
  branchVersion: (id: string, vid: string, name: string, author: string) => call<ProjectMeta>("POST", `/api/projects/${id}/versions/${vid}/branch`, { name, author }),
};
