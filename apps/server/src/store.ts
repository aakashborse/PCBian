// Project index persisted as JSON next to the per-project Yjs documents.
import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = path.resolve(process.env.PCBIAN_DATA_DIR ?? path.join(process.cwd(), "data"));

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

const indexFile = () => path.join(DATA_DIR, "projects.json");

/** Write a file so readers (and backups) only ever see the old or the new content. */
export function writeFileAtomic(file: string, data: string | Uint8Array) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export const projectFile = (id: string, ext: "ydoc" | "chat.json") => path.join(DATA_DIR, "projects", `${id}.${ext}`);

export function listProjects(): ProjectMeta[] {
  try {
    return JSON.parse(fs.readFileSync(indexFile(), "utf8")) as ProjectMeta[];
  } catch {
    return [];
  }
}

function writeIndex(list: ProjectMeta[]) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(indexFile(), JSON.stringify(list, null, 2));
}

export function getProject(id: string) {
  return listProjects().find((p) => p.id === id);
}

export function createProjectMeta(name: string): ProjectMeta {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const meta = { id, name, createdAt: Date.now(), updatedAt: Date.now() };
  writeIndex([meta, ...listProjects()]);
  return meta;
}

export function updateProjectMeta(id: string, patch: Partial<Omit<ProjectMeta, "id">>) {
  writeIndex(listProjects().map((p) => (p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p)));
}

export function deleteProjectMeta(id: string) {
  writeIndex(listProjects().filter((p) => p.id !== id));
  for (const ext of ["ydoc", "chat.json"] as const) fs.rmSync(projectFile(id, ext), { force: true });
}
