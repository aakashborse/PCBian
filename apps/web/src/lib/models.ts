// Footprint STEP models in the browser: upload, fetch (cached by content id) and tessellate with
// OCCT (occt-import-js, WebAssembly; loaded only when a design has models).
import { getPart, type Design } from "@pcbian/core";

export async function uploadModel(file: File): Promise<{ id: string; size: number }> {
  const res = await fetch("/api/models", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file });
  const body = (await res.json().catch(() => ({}))) as { id?: string; size?: number; error?: string };
  if (!res.ok || !body.id) throw new Error(body.error ?? `Upload failed (${res.status})`);
  return { id: body.id, size: body.size ?? file.size };
}

const texts = new Map<string, Promise<string>>();
export function modelText(id: string): Promise<string> {
  if (!texts.has(id)) {
    const p = fetch(`/api/models/${id}`).then((r) => {
      if (!r.ok) throw new Error(`Model ${id} is missing on the server`);
      return r.text();
    });
    p.catch(() => texts.delete(id));
    texts.set(id, p);
  }
  return texts.get(id)!;
}

/** Model files used by the design's fitted parts. */
export function designModelIds(d: Design): string[] {
  const ids = new Set<string>();
  for (const c of d.components) {
    const m = getPart(c.partId)?.footprint?.model;
    if (m?.file && !c.dnp) ids.add(m.file);
  }
  return [...ids];
}

/** Texts of every model the design uses (models that fail to load are left out). */
export async function designModels(d: Design): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    designModelIds(d).map(async (id) => {
      try {
        out[id] = await modelText(id);
      } catch {
        // Exported as a box instead.
      }
    }),
  );
  return out;
}

export interface ModelMesh {
  positions: Float32Array;
  normals: Float32Array | null;
  index: Uint32Array;
  /** Per-face colours: index ranges (in triangles) with an RGB colour. */
  faces: { first: number; last: number; color: [number, number, number] | null }[];
  color: [number, number, number] | null;
}

interface OcctResult {
  success: boolean;
  meshes: { color?: [number, number, number]; brep_faces?: { first: number; last: number; color: [number, number, number] | null }[]; attributes: { position: { array: number[] }; normal?: { array: number[] } }; index: { array: number[] } }[];
}
type Occt = { ReadStepFile: (data: Uint8Array, params: null) => OcctResult };

let occt: Promise<Occt> | null = null;
function loadOcct(): Promise<Occt> {
  occt ??= Promise.all([import("occt-import-js"), import("occt-import-js/dist/occt-import-js.wasm?url")]).then(([mod, wasm]) => {
    const init = ((mod as { default?: unknown }).default ?? mod) as (o: { locateFile: (f: string) => string }) => Promise<Occt>;
    return init({ locateFile: () => wasm.default });
  });
  return occt;
}

const meshes = new Map<string, Promise<ModelMesh[]>>();
/** Triangle meshes of a model, in its own frame (mm). */
export function modelMeshes(id: string): Promise<ModelMesh[]> {
  if (!meshes.has(id)) {
    const p = Promise.all([loadOcct(), modelText(id)]).then(([o, text]) => {
      const r = o.ReadStepFile(new TextEncoder().encode(text), null);
      if (!r.success) throw new Error("The STEP file could not be read");
      return r.meshes.map((m) => ({
        positions: new Float32Array(m.attributes.position.array),
        normals: m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null,
        index: new Uint32Array(m.index.array),
        faces: m.brep_faces ?? [],
        color: m.color ?? null,
      }));
    });
    p.catch(() => meshes.delete(id));
    meshes.set(id, p);
  }
  return meshes.get(id)!;
}
