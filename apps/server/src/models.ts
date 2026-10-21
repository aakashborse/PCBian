// Uploaded STEP models for footprints, stored once per content (the id is a hash of the file), so
// a model shared by many parts or projects is kept a single time.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, writeFileAtomic } from "./store.js";

export const MAX_MODEL_BYTES = 30 * 1024 * 1024;
const dir = () => path.join(DATA_DIR, "models");
const fileOf = (id: string) => path.join(dir(), `${id}.step`);
const ID = /^[a-f0-9]{32}$/;

/** Store a STEP file; returns its id. Throws when it is not a STEP file. */
export function saveModel(data: Buffer): string {
  if (!/^\s*ISO-10303-21\s*;/.test(data.subarray(0, 200).toString("latin1"))) throw new Error("Not a STEP file (it must start with ISO-10303-21)");
  const id = crypto.createHash("sha256").update(data).digest("hex").slice(0, 32);
  if (!fs.existsSync(fileOf(id))) {
    fs.mkdirSync(dir(), { recursive: true });
    writeFileAtomic(fileOf(id), data);
  }
  return id;
}

/** Path of a stored model, or null for an unknown or malformed id. */
export function modelPath(id: string): string | null {
  return ID.test(id) && fs.existsSync(fileOf(id)) ? fileOf(id) : null;
}
