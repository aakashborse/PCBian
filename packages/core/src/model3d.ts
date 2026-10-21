// Footprint STEP models: where a model lands for a placed part (in the STEP export frame and in the
// 3D view's frame), and merging uploaded STEP files into an exported assembly.
import { toWorld } from "./geometry";
import type { BoardSettings, ComponentData, Model3D } from "./types";

export type V3 = [number, number, number];
/** Affine map: linear part as columns (images of x, y, z) plus translation. */
export interface Affine {
  x: V3;
  y: V3;
  z: V3;
  t: V3;
}

const rad = (d: number) => (d * Math.PI) / 180;

/** The model's own rotation (x, then y, then z) and offset. */
function userTransform(m: Model3D, p: V3): V3 {
  let [x, y, z] = p;
  const r = m.rotate ?? { x: 0, y: 0, z: 0 };
  if (r.x) [y, z] = [y * Math.cos(rad(r.x)) - z * Math.sin(rad(r.x)), y * Math.sin(rad(r.x)) + z * Math.cos(rad(r.x))];
  if (r.y) [x, z] = [x * Math.cos(rad(r.y)) + z * Math.sin(rad(r.y)), -x * Math.sin(rad(r.y)) + z * Math.cos(rad(r.y))];
  if (r.z) [x, y] = [x * Math.cos(rad(r.z)) - y * Math.sin(rad(r.z)), x * Math.sin(rad(r.z)) + y * Math.cos(rad(r.z))];
  const o = m.offset ?? { x: 0, y: 0, z: 0 };
  return [x + o.x, y + o.y, z + o.z];
}

/**
 * Where a part's model goes. "step": the STEP export frame (mm, y up, board bottom at z = 0).
 * "view": the 3D view's frame (x = board x, y = up with the top surface at 0, z = board y).
 */
export function modelPlacement(c: ComponentData, m: Model3D, board: Pick<BoardSettings, "height" | "thickness">, frame: "step" | "view"): Affine {
  const top = c.pcb.side !== "bottom";
  const T = board.thickness;
  const f = (p: V3): V3 => {
    const [mx, my, mz] = userTransform(m, p);
    // Model y points the other way to the footprint's (y-down) frame.
    const w = toWorld({ x: mx, y: -my }, c.pcb, !top);
    if (frame === "step") return [w.x, board.height - w.y, top ? T + mz : -mz];
    return [w.x, top ? mz : -T - mz, w.y];
  };
  const t = f([0, 0, 0]);
  const d = (p: V3): V3 => {
    const q = f(p);
    return [q[0] - t[0], q[1] - t[1], q[2] - t[2]];
  };
  return { x: d([1, 0, 0]), y: d([0, 1, 0]), z: d([0, 0, 1]), t };
}

// ---------- STEP files ----------

export interface StepData {
  /** Entity bodies by id (everything after "#n="). */
  entities: Map<number, string>;
}

/** The DATA section's entities. Comments are dropped; strings are kept verbatim. */
export function parseStep(text: string): StepData {
  const start = text.search(/\bDATA\s*;/);
  if (!/^\s*ISO-10303-21\s*;/.test(text) || start < 0) throw new Error("Not a STEP file (ISO-10303-21)");
  const entities = new Map<number, string>();
  let i = text.indexOf(";", start) + 1;
  let cur = "";
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") {
      // A string runs to the next lone quote ('' is an escaped quote inside it).
      let j = i + 1;
      while (j < text.length && !(text[j] === "'" && text[j + 1] !== "'")) j += text[j] === "'" ? 2 : 1;
      cur += text.slice(i, j + 1);
      i = j;
    } else if (ch === "/" && text[i + 1] === "*") {
      const j = text.indexOf("*/", i + 2);
      i = j < 0 ? text.length : j + 1;
    } else if (ch === ";") {
      const stmt = cur.trim();
      cur = "";
      if (/^ENDSEC$/i.test(stmt)) break;
      const m = stmt.match(/^#(\d+)\s*=\s*([\s\S]*)$/);
      if (m) entities.set(Number(m[1]), m[2].replace(/\s*\n\s*/g, " "));
    } else cur += ch;
  }
  return { entities };
}

/** Each #ref in an entity body (outside strings) shifted by `by`. */
export function renumber(body: string, by: number): string {
  return body.replace(/'(?:[^']|'')*'|#(\d+)/g, (m, n) => (n === undefined ? m : `#${Number(n) + by}`));
}

const refs = (body: string) => [...body.replace(/'(?:[^']|'')*'/g, "''").matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
const kind = (body: string) => body.match(/^\s*\(?\s*([A-Z_0-9]+)/)?.[1] ?? "";

/**
 * The top of a STEP file's product structure: the product definition that is no other's child,
 * and its shape representation.
 */
export function stepRoot(data: StepData): { productDefinition: number; representation: number; name: string } {
  const children = new Set<number>();
  for (const b of data.entities.values()) if (kind(b) === "NEXT_ASSEMBLY_USAGE_OCCURRENCE") children.add(refs(b)[1]);
  for (const [, b] of data.entities) {
    if (kind(b) !== "SHAPE_DEFINITION_REPRESENTATION") continue;
    const [pdsId, rep] = refs(b);
    const pds = data.entities.get(pdsId);
    if (!pds || kind(pds) !== "PRODUCT_DEFINITION_SHAPE") continue;
    const pd = refs(pds)[0];
    if (kind(data.entities.get(pd) ?? "") !== "PRODUCT_DEFINITION" || children.has(pd)) continue;
    const pdf = data.entities.get(refs(data.entities.get(pd)!)[0]) ?? "";
    const product = data.entities.get(refs(pdf)[0]) ?? "";
    const name = product.match(/'((?:[^']|'')*)'/)?.[1]?.replace(/''/g, "'") ?? "model";
    return { productDefinition: pd, representation: rep, name };
  }
  throw new Error("The STEP file has no product with a shape");
}
