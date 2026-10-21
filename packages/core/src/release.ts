// Release support: the checks a release is judged by, the manufacturing package it freezes, and
// revision numbering. The approval workflow itself lives on the server.
import { bomLines } from "./supplier";
import { ratsnest, runDrc, runErc } from "./copper";
import { assemblyPdf, schematicPdf } from "./pdf";
import { bomCsv, drillFiles, gerberFiles, pickAndPlaceCsv } from "./export";
import { ipc2581 } from "./ipc2581";
import { odbFiles } from "./odb";
import { stepFile } from "./step";
import type { Design } from "./types";

export interface ReleaseChecks {
  drcErrors: number;
  drcWarnings: number;
  ercErrors: number;
  unrouted: number;
  /** BOM lines without a manufacturer part number. */
  bomWithoutMpn: number;
  /** One line per problem (first few of each kind), for reviewers. */
  details: string[];
  /** Whether nothing blocks manufacture (no DRC/ERC errors, everything routed). */
  clean: boolean;
}

export function releaseChecks(design: Design): ReleaseChecks {
  const drc = runDrc(design);
  const erc = runErc(design).filter((i) => i.severity === "error");
  const drcErrors = drc.filter((i) => i.severity === "error" && i.code !== "unrouted");
  const unrouted = ratsnest(design).length;
  const noMpn = bomLines(design).filter((l) => !l.mpn);
  const details = [
    ...drcErrors.slice(0, 5).map((i) => `DRC: ${i.message}`),
    ...erc.slice(0, 5).map((i) => `ERC: ${i.message}`),
    ...(unrouted ? [`${unrouted} connection(s) not routed`] : []),
    ...(noMpn.length ? [`${noMpn.length} BOM line(s) without a manufacturer part number: ${noMpn.slice(0, 5).map((l) => l.refs.join(" ")).join("; ")}`] : []),
  ];
  return {
    drcErrors: drcErrors.length,
    drcWarnings: drc.filter((i) => i.severity === "warning").length,
    ercErrors: erc.length,
    unrouted,
    bomWithoutMpn: noMpn.length,
    details,
    clean: !drcErrors.length && !erc.length && !unrouted,
  };
}

/**
 * The files a release freezes: fabrication (Gerbers, drills, IPC-2581, ODB++), assembly (BOM,
 * placement, assembly drawing), documentation (schematic) and the 3D model.
 */
export function releasePackage(design: Design, models: Record<string, string> = {}): Record<string, string | Uint8Array> {
  const name = design.name.replace(/[^A-Za-z0-9_.-]+/g, "_") || "board";
  const d = { ...design, name };
  const out: Record<string, string | Uint8Array> = {};
  for (const [f, body] of Object.entries({ ...gerberFiles(d), ...drillFiles(d) })) out[`fabrication/${f}`] = body;
  out[`fabrication/${name}.ipc2581.xml`] = ipc2581(d);
  for (const [f, body] of Object.entries(odbFiles(d))) out[`fabrication/odb/${f}`] = body;
  out[`assembly/${name}-bom.csv`] = bomCsv(d);
  out[`assembly/${name}-pos.csv`] = pickAndPlaceCsv(d);
  out[`assembly/${name}-assembly.pdf`] = assemblyPdf(d);
  out[`documentation/${name}-schematic.pdf`] = schematicPdf(d);
  out[`mechanical/${name}.step`] = stepFile(d, models);
  return out;
}

/** The revision after `prev`: A -> B, Z -> AA, 1 -> 2, 1.3 -> 1.4; none -> A. */
export function nextRevision(prev: string | undefined): string {
  const p = (prev ?? "").trim();
  if (!p) return "A";
  const num = p.match(/^(.*?)(\d+)$/);
  if (num) return `${num[1]}${Number(num[2]) + 1}`;
  if (/^[A-Z]+$/.test(p)) {
    const chars = p.split("");
    let i = chars.length - 1;
    while (i >= 0 && chars[i] === "Z") chars[i--] = "A";
    if (i < 0) return "A" + chars.join("");
    chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1);
    return chars.join("");
  }
  return `${p}-2`;
}
