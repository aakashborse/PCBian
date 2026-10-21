// Release and approval workflow. Requesting a release stamps the revision into the design, saves a
// named version, runs the release checks and freezes the manufacturing package; named approvers
// then approve or reject it. Enough approvals (and no rejection) release it; the package of a
// release never changes. People are identified by the display name the editor sends.
import fs from "node:fs";
import path from "node:path";
import { getDesign, getPart, nextRevision, releaseChecks, releasePackage, setTitleBlock, type ReleaseChecks } from "@pcbian/core";
import JSZip from "jszip";
import { modelPath } from "./models.js";
import type { Room } from "./rooms.js";
import { DATA_DIR, writeFileAtomic } from "./store.js";
import { saveVersion } from "./versions.js";

export type ReleaseStatus = "in_review" | "released" | "rejected" | "withdrawn";

export interface Release {
  id: string;
  revision: string;
  title: string;
  notes: string;
  /** The version saved when the release was requested (what the package was built from). */
  versionId: string;
  status: ReleaseStatus;
  requestedBy: string;
  requestedAt: number;
  /** People who must sign off, and how many approvals release it. */
  approvers: string[];
  required: number;
  decisions: { by: string; at: number; decision: "approve" | "reject"; comment: string }[];
  checks: ReleaseChecks;
  /** Reason given for requesting a release despite failing checks. */
  override?: string;
  files: string[];
  packageBytes: number;
  releasedAt?: number;
  closedAt?: number;
}

const dir = (projectId: string) => path.join(DATA_DIR, "projects", `${projectId}.releases`);
const indexFile = (projectId: string) => path.join(dir(projectId), "index.json");
export const packageFile = (projectId: string, rid: string) => path.join(dir(projectId), `${rid}.zip`);

export function listReleases(projectId: string): Release[] {
  try {
    return JSON.parse(fs.readFileSync(indexFile(projectId), "utf8")) as Release[];
  } catch {
    return [];
  }
}

function writeIndex(projectId: string, list: Release[]) {
  fs.mkdirSync(dir(projectId), { recursive: true });
  writeFileAtomic(indexFile(projectId), JSON.stringify(list, null, 1));
}

export class ReleaseError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly checks?: ReleaseChecks,
  ) {
    super(message);
  }
}

/** Revision suggested for the next release: after the last released one, or the design's own. */
export function suggestedRevision(room: Room): string {
  const released = listReleases(room.id).find((r) => r.status === "released");
  return released ? nextRevision(released.revision) : getDesign(room.doc).titleBlock.revision || "A";
}

export async function requestRelease(
  room: Room,
  req: { revision: string; title?: string; notes?: string; approvers: string[]; required?: number; author: string; override?: string },
): Promise<Release> {
  const list = listReleases(room.id);
  const revision = req.revision.trim();
  if (!/^[\w.-]{1,16}$/.test(revision)) throw new ReleaseError("Revision must be 1-16 letters, digits, dots or dashes");
  if (list.some((r) => r.revision === revision && (r.status === "released" || r.status === "in_review"))) throw new ReleaseError(`Revision ${revision} is already ${list.find((r) => r.revision === revision)!.status === "released" ? "released" : "in review"}`);
  if (list.some((r) => r.status === "in_review")) throw new ReleaseError("Another release is in review: approve, reject or withdraw it first", 409);
  const approvers = [...new Set(req.approvers.map((a) => a.trim()).filter(Boolean))];
  if (!approvers.length) throw new ReleaseError("Name at least one approver");
  const required = Math.max(1, Math.min(approvers.length, Math.floor(req.required ?? approvers.length)));
  const checks = releaseChecks(getDesign(room.doc));
  if (!checks.clean && !req.override?.trim()) throw new ReleaseError("The design does not pass the release checks; fix them or give a reason to release anyway", 422, checks);

  // Stamp the revision and date, then freeze that state as a version.
  room.doc.transact(() => setTitleBlock(room.doc, { revision, date: new Date().toISOString().slice(0, 10) }));
  const version = saveVersion(room, `Release ${revision}`, req.author, false);
  const design = getDesign(room.doc);
  const models: Record<string, string> = {};
  for (const c of design.components) {
    const m = getPart(c.partId)?.footprint?.model;
    const file = m?.file && modelPath(m.file);
    if (file && !models[m!.file]) models[m!.file] = fs.readFileSync(file, "utf8");
  }
  const files = releasePackage(design, models);
  const zip = new JSZip();
  for (const [name, body] of Object.entries(files)) zip.file(`${design.name.replace(/[^A-Za-z0-9_.-]+/g, "_")}-rev${revision}/${name}`, body);
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const release: Release = {
    id,
    revision,
    title: req.title?.trim() || `${design.name} rev ${revision}`,
    notes: req.notes?.trim() ?? "",
    versionId: version?.id ?? "",
    status: "in_review",
    requestedBy: req.author,
    requestedAt: Date.now(),
    approvers,
    required,
    decisions: [],
    checks,
    ...(checks.clean ? {} : { override: req.override!.trim() }),
    files: Object.keys(files).sort(),
    packageBytes: 0,
  };
  zip.file(
    `${design.name.replace(/[^A-Za-z0-9_.-]+/g, "_")}-rev${revision}/RELEASE.txt`,
    [`${release.title}`, `Revision ${revision}, requested by ${req.author} on ${new Date(release.requestedAt).toISOString()}`, `Approvers: ${approvers.join(", ")} (${required} needed)`, "", release.notes, "", "Checks:", ...(checks.details.length ? checks.details : ["All checks passed"]), ...(release.override ? ["", `Released despite failing checks: ${release.override}`] : []), ""].join("\n"),
  );
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  fs.mkdirSync(dir(room.id), { recursive: true });
  writeFileAtomic(packageFile(room.id, id), buf);
  release.packageBytes = buf.length;
  writeIndex(room.id, [release, ...list]);
  return release;
}

export function decide(projectId: string, rid: string, d: { by: string; decision: "approve" | "reject"; comment?: string }): Release {
  const list = listReleases(projectId);
  const r = list.find((x) => x.id === rid);
  if (!r) throw new ReleaseError("No such release", 404);
  if (r.status !== "in_review") throw new ReleaseError(`This release is ${r.status.replace("_", " ")}`, 409);
  const by = d.by.trim();
  if (!r.approvers.some((a) => a.toLowerCase() === by.toLowerCase())) throw new ReleaseError(`${by || "You"} is not an approver of this release (${r.approvers.join(", ")})`, 403);
  if (r.decisions.some((x) => x.by.toLowerCase() === by.toLowerCase())) throw new ReleaseError(`${by} has already decided`, 409);
  if (d.decision === "reject" && !d.comment?.trim()) throw new ReleaseError("Say why when rejecting");
  r.decisions.push({ by, at: Date.now(), decision: d.decision, comment: d.comment?.trim() ?? "" });
  if (d.decision === "reject") {
    r.status = "rejected";
    r.closedAt = Date.now();
  } else if (r.decisions.filter((x) => x.decision === "approve").length >= r.required) {
    r.status = "released";
    r.releasedAt = r.closedAt = Date.now();
  }
  writeIndex(projectId, list);
  return r;
}

export function withdraw(projectId: string, rid: string, by: string): Release {
  const list = listReleases(projectId);
  const r = list.find((x) => x.id === rid);
  if (!r) throw new ReleaseError("No such release", 404);
  if (r.status !== "in_review") throw new ReleaseError(`This release is ${r.status.replace("_", " ")}`, 409);
  if (r.requestedBy.toLowerCase() !== by.trim().toLowerCase()) throw new ReleaseError(`Only ${r.requestedBy}, who requested it, can withdraw it`, 403);
  r.status = "withdrawn";
  r.closedAt = Date.now();
  writeIndex(projectId, list);
  // A withdrawn release's package is not kept.
  fs.rmSync(packageFile(projectId, rid), { force: true });
  return r;
}

export function deleteReleases(projectId: string) {
  fs.rmSync(dir(projectId), { recursive: true, force: true });
}
