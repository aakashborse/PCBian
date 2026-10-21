import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { addComponent, attachNet, getDesign, initDoc, nextRevision, updateComponent } from "@pcbian/core";

// A throwaway data directory for this test's projects.
process.env.PCBIAN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pcbian-rel-"));
const { getRoom } = await import("../src/rooms");
const rel = await import("../src/releases");

function project(id: string) {
  const room = getRoom(id);
  initDoc(room.doc, "Widget");
  const r = addComponent(room.doc, "resistor_0603", { x: 0, y: 0 });
  updateComponent(room.doc, r.id, { pcb: { x: 10, y: 10, rot: 0, side: "top" } });
  attachNet(room.doc, `${r.ref}.1`, "+5V");
  attachNet(room.doc, `${r.ref}.2`, "GND");
  return room;
}

describe("release workflow", () => {
  it("numbers revisions", () => {
    expect([undefined, "A", "B", "Z", "AZ", "1", "1.9", "v2"].map((r) => nextRevision(r))).toEqual(["A", "B", "C", "AA", "BA", "2", "1.10", "v3"]);
  });

  it("requests, approves and freezes a release package", async () => {
    const room = project("relA");
    const r = await rel.requestRelease(room, { revision: "A", approvers: ["Ana", "Ben"], required: 2, author: "Cleo", notes: "First build" });
    expect(r.status).toBe("in_review");
    expect(r.checks.clean).toBe(true);
    // The revision is stamped into the design (and so into the package).
    expect(getDesign(room.doc).titleBlock.revision).toBe("A");
    expect(r.files.some((f) => /F_Cu\.gtl$/.test(f))).toBe(true);
    expect(r.files.some((f) => /\.step$/.test(f))).toBe(true);
    const zip = await JSZip.loadAsync(fs.readFileSync(rel.packageFile("relA", r.id)));
    expect(Object.keys(zip.files).some((f) => f.endsWith("RELEASE.txt"))).toBe(true);
    // Only named approvers decide, once each; a second release cannot start meanwhile.
    expect(() => rel.decide("relA", r.id, { by: "Mallory", decision: "approve" })).toThrow(/not an approver/);
    await expect(rel.requestRelease(room, { revision: "B", approvers: ["Ana"], author: "Cleo" })).rejects.toThrow(/in review/);
    expect(rel.decide("relA", r.id, { by: "ana", decision: "approve" }).status).toBe("in_review");
    expect(() => rel.decide("relA", r.id, { by: "Ana", decision: "approve" })).toThrow(/already decided/);
    const done = rel.decide("relA", r.id, { by: "Ben", decision: "approve", comment: "LGTM" });
    expect(done.status).toBe("released");
    expect(rel.suggestedRevision(room)).toBe("B");
    // Released revisions are not reused.
    await expect(rel.requestRelease(room, { revision: "A", approvers: ["Ana"], author: "Cleo" })).rejects.toThrow(/already released/);
  });

  it("blocks failing designs unless overridden, and handles rejection and withdrawal", async () => {
    const room = project("relB");
    // An unrouted connection fails the checks.
    const a = addComponent(room.doc, "resistor_0603", { x: 0, y: 0 });
    const b = addComponent(room.doc, "resistor_0603", { x: 0, y: 0 });
    updateComponent(room.doc, a.id, { pcb: { x: 20, y: 10, rot: 0, side: "top" } });
    updateComponent(room.doc, b.id, { pcb: { x: 30, y: 10, rot: 0, side: "top" } });
    attachNet(room.doc, `${a.ref}.2`, "SIG", "global");
    attachNet(room.doc, `${b.ref}.1`, "SIG", "global");
    await expect(rel.requestRelease(room, { revision: "A", approvers: ["Ana"], author: "Cleo" })).rejects.toThrow(/release checks/);
    const r = await rel.requestRelease(room, { revision: "A", approvers: ["Ana"], author: "Cleo", override: "Prototype; SIG is a wire link" });
    expect(r.checks.unrouted).toBe(1);
    expect(r.override).toMatch(/Prototype/);
    expect(() => rel.decide("relB", r.id, { by: "Ana", decision: "reject" })).toThrow(/why/);
    expect(rel.decide("relB", r.id, { by: "Ana", decision: "reject", comment: "Route SIG" }).status).toBe("rejected");
    const r2 = await rel.requestRelease(room, { revision: "A", approvers: ["Ana"], author: "Cleo", override: "Prototype" });
    expect(() => rel.withdraw("relB", r2.id, "Ana")).toThrow(/Only Cleo/);
    expect(rel.withdraw("relB", r2.id, "Cleo").status).toBe("withdrawn");
    expect(fs.existsSync(rel.packageFile("relB", r2.id))).toBe(false);
  });
});
