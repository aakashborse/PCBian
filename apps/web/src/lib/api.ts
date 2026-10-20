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

export const api = {
  health: () => call<{ ok: boolean; copilot: boolean }>("GET", "/api/health"),
  templates: () => call<Template[]>("GET", "/api/templates"),
  projects: () => call<ProjectMeta[]>("GET", "/api/projects"),
  project: (id: string) => call<ProjectMeta>("GET", `/api/projects/${id}`),
  create: (name: string, template: string) => call<ProjectMeta>("POST", "/api/projects", { name, template }),
  rename: (id: string, name: string) => call<ProjectMeta>("PATCH", `/api/projects/${id}`, { name }),
  remove: (id: string) => call<void>("DELETE", `/api/projects/${id}`),
  ask: (id: string, message: string, author: string) => call<{ ok: boolean }>("POST", `/api/projects/${id}/copilot`, { message, author }),
  stopCopilot: (id: string) => call<{ stopped: boolean }>("POST", `/api/projects/${id}/copilot/stop`),
  resetCopilot: (id: string) => call<{ ok: boolean }>("POST", `/api/projects/${id}/copilot/reset`),
};
