// ODB++ (v8) job export: matrix, step header, profile, per-layer features (metric, polarity-aware),
// drill layers per span, component layers and EDA data (packages and nets).
// Returns the job's file tree; the web app zips it (fabs accept a zipped ODB++ directory or .tgz).
import { boardOutline } from "./doc";
import { fabData, type Feature } from "./fabfeatures";
import { padsOf, polygonArea } from "./geometry";
import { getPart } from "./library";
import { netByTerminal, termKey, computeNets } from "./netlist";
import { copperLayers } from "./stackup";
import type { CopperLayer, Design, Vec } from "./types";

const mm = (v: number) => (Math.round(v * 1e5) / 1e5).toFixed(5).replace(/0+$/, "").replace(/\.$/, "");
const um = (v: number) => String(Math.max(1, Math.round(v * 1000)));

export const odbLayerName = (l: CopperLayer) => (l === "top" ? "top" : l === "bottom" ? "bottom" : `in${l.slice(2)}`);

/** Features file text with its own symbol table. */
function featuresFile(features: Feature[], H: number): string {
  const symbols: string[] = [];
  const sym = (name: string) => {
    let i = symbols.indexOf(name);
    if (i < 0) i = symbols.push(name) - 1;
    return i;
  };
  const y = (v: number) => mm(H - v);
  const body: string[] = [];
  for (const f of features) {
    const pol = f.dark ? "P" : "N";
    if (f.kind === "line") {
      const s = sym(`r${um(f.width)}`);
      for (let i = 1; i < f.points.length; i++) body.push(`L ${mm(f.points[i - 1].x)} ${y(f.points[i - 1].y)} ${mm(f.points[i].x)} ${y(f.points[i].y)} ${s} ${pol} 0`);
    } else if (f.kind === "pad") {
      const name = f.shape === "circle" ? `r${um(f.w)}` : f.shape === "oval" ? `oval${um(f.w)}x${um(f.h)}` : `rect${um(f.w)}x${um(f.h)}`;
      body.push(`P ${mm(f.at.x)} ${y(f.at.y)} ${sym(name)} ${pol} 0 0`);
    } else body.push(...surface(f.points, pol, H));
  }
  return ["UNITS=MM", "#", "#Feature symbol names", "#", ...symbols.map((s, i) => `$${i} ${s}`), "#", "#Layer features", "#", ...body, ""].join("\n");
}

/** ODB++ surface: islands clockwise, holes counter-clockwise (y up). */
function surface(points: Vec[], pol: "P" | "N", H: number, holes: Vec[][] = []): string[] {
  const up = (p: Vec) => ({ x: p.x, y: H - p.y });
  const ring = (pts: Vec[], clockwise: boolean, tag: "I" | "H") => {
    let r = pts.map(up);
    if (polygonArea(r) > 0 === clockwise) r = [...r].reverse();
    return [`OB ${mm(r[0].x)} ${mm(r[0].y)} ${tag}`, ...r.slice(1).map((p) => `OS ${mm(p.x)} ${mm(p.y)}`), `OS ${mm(r[0].x)} ${mm(r[0].y)}`, "OE"];
  };
  return [`S ${pol} 0`, ...ring(points, true, "I"), ...holes.flatMap((h) => ring(h, false, "H")), "SE"];
}

export function odbFiles(design: Design): Record<string, string> {
  const H = design.board.height;
  const data = fabData(design);
  const job = design.name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_|_$/g, "") || "pcbian";
  const step = "pcb";
  const root = `${job}/`;
  const files: Record<string, string> = {};
  const layers = copperLayers(design.board);
  const date = new Date().toISOString().replace(/[-:]/g, "").replace("T", ".").slice(0, 15);

  // ---- matrix (rows top to bottom) ----
  const rows: { name: string; type: string; context?: string; start?: string; end?: string }[] = [
    { name: "comp_+_top", type: "COMPONENT" },
    { name: "sst", type: "SILK_SCREEN" },
    { name: "spt", type: "SOLDER_PASTE" },
    { name: "smt", type: "SOLDER_MASK" },
    ...layers.map((l) => ({ name: odbLayerName(l), type: "SIGNAL" })),
    { name: "smb", type: "SOLDER_MASK" },
    { name: "spb", type: "SOLDER_PASTE" },
    { name: "ssb", type: "SILK_SCREEN" },
    { name: "comp_+_bot", type: "COMPONENT" },
    ...data.drills.map((d) => ({ name: d.name, type: "DRILL", start: odbLayerName(layers[d.from]), end: odbLayerName(layers[d.to]) })),
  ];
  files[`${root}matrix/matrix`] = [
    "STEP {",
    "   COL=1",
    `   NAME=${step.toUpperCase()}`,
    "}",
    "",
    ...rows.flatMap((r, i) => ["LAYER {", `   ROW=${i + 1}`, `   CONTEXT=${r.context ?? "BOARD"}`, `   TYPE=${r.type}`, `   NAME=${r.name.toUpperCase()}`, "   POLARITY=POSITIVE", `   START_NAME=${(r.start ?? "").toUpperCase()}`, `   END_NAME=${(r.end ?? "").toUpperCase()}`, "   OLD_NAME=", "}", ""]),
  ].join("\n");
  files[`${root}misc/info`] = ["UNITS=MM", `JOB_NAME=${job}`, "ODB_VERSION_MAJOR=8", "ODB_VERSION_MINOR=1", "ODB_SOURCE=PCBian", `CREATION_DATE=${date}`, `SAVE_DATE=${date}`, "SAVE_APP=PCBian", "SAVE_USER=pcbian", ""].join("\n");
  files[`${root}fonts/standard`] = "XSIZE 0.302000\nYSIZE 0.302000\nOFFSET 0.000000\n";
  const sd = `${root}steps/${step}/`;
  files[`${sd}stephdr`] = ["UNITS=MM", "X_DATUM=0", "Y_DATUM=0", "X_ORIGIN=0", "Y_ORIGIN=0", "TOP_ACTIVE=0", "BOTTOM_ACTIVE=0", "RIGHT_ACTIVE=0", "LEFT_ACTIVE=0", "AFFECTING_BOM=", "AFFECTING_BOM_CHANGED=0", ""].join("\n");
  files[`${sd}profile`] = ["UNITS=MM", "#", "#Layer features", "#", ...surface(boardOutline(design.board), "P", H, design.board.cutouts ?? []), ""].join("\n");

  // ---- layer features ----
  const layerDir = (n: string) => `${sd}layers/${n}/`;
  for (const c of data.copper) files[`${layerDir(odbLayerName(c.layer))}features`] = featuresFile(c.features, H);
  files[`${layerDir("smt")}features`] = featuresFile(data.mask.top, H);
  files[`${layerDir("smb")}features`] = featuresFile(data.mask.bottom, H);
  files[`${layerDir("spt")}features`] = featuresFile(data.paste.top, H);
  files[`${layerDir("spb")}features`] = featuresFile(data.paste.bottom, H);
  files[`${layerDir("sst")}features`] = featuresFile(data.silk.top, H);
  files[`${layerDir("ssb")}features`] = featuresFile(data.silk.bottom, H);
  for (const d of data.drills) {
    const syms: string[] = [];
    const lines = d.holes.map((h) => {
      const name = `r${um(h.diameter)}`;
      let i = syms.indexOf(name);
      if (i < 0) i = syms.push(name) - 1;
      return `P ${mm(h.at.x)} ${mm(H - h.at.y)} ${i} P 0 0;0=${h.via ? 2 : h.plated ? 0 : 1}`;
    });
    files[`${layerDir(d.name)}features`] = ["UNITS=MM", "#", ...syms.map((s, i) => `$${i} ${s}`), "#", "@0 .drill", "&0 plated", "&1 non_plated", "&2 via", "#", ...lines, ""].join("\n");
    // Drill tool table (sizes in microns, like the symbols).
    const tools = new Map<string, { type: string; size: string }>();
    for (const h of d.holes) {
      const type = h.via ? "VIA" : h.plated ? "PLATED" : "NON_PLATED";
      tools.set(`${type}:${um(h.diameter)}`, { type, size: um(h.diameter) });
    }
    files[`${layerDir(d.name)}tools`] = [
      "UNITS=MM",
      `THICKNESS=${um(design.board.thickness)}`,
      "USER_PARAMS=",
      ...[...tools.values()].flatMap((t, i) => ["TOOLS {", `   NUM=${i + 1}`, `   TYPE=${t.type}`, "   TYPE2=STANDARD", "   MIN_TOL=0", "   MAX_TOL=0", "   BIT=", `   FINISH_SIZE=${t.size}`, `   DRILL_SIZE=${t.size}`, "}"]),
      "",
    ].join("\n");
  }

  // ---- EDA data: nets and packages; components refer to both ----
  const nets = computeNets(design).filter((n) => n.terminals.length);
  const netOf = netByTerminal(nets);
  const netIdx = new Map(nets.map((n, i) => [n.name, i]));
  const parts = design.components.filter((c) => getPart(c.partId)?.footprint && !c.dnp);
  const pkgs = [...new Set(parts.map((c) => getPart(c.partId)!.footprint!.name))];
  const eda: string[] = ["HDR PCBian", "UNITS=MM", `LYR ${["comp_+_top", "comp_+_bot", ...layers.map(odbLayerName)].join(" ").toUpperCase()}`, "#"];
  for (const n of nets) eda.push(`NET ${n.name.replace(/\s/g, "_")}`);
  eda.push("#");
  for (const name of pkgs) {
    const fp = parts.map((c) => getPart(c.partId)!.footprint!).find((f) => f.name === name)!;
    const xs = fp.pads.flatMap((p) => [p.x - p.w / 2, p.x + p.w / 2]);
    const ys = fp.pads.flatMap((p) => [p.y - p.h / 2, p.y + p.h / 2]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const pitch = fp.pads.length > 1 ? Math.min(...fp.pads.slice(1).map((p, i) => Math.hypot(p.x - fp.pads[i].x, p.y - fp.pads[i].y) || Infinity)) : 0;
    eda.push(`PKG ${name.replace(/\s/g, "_")} ${mm(Number.isFinite(pitch) ? pitch : 0)} ${mm(x0)} ${mm(-y1)} ${mm(x1)} ${mm(-y0)}`, `RC ${mm(x0)} ${mm(-y1)} ${mm(x1 - x0)} ${mm(y1 - y0)}`);
    for (const p of fp.pads) eda.push(`PIN ${p.id} ${p.drill ? "T" : "S"} ${mm(p.x)} ${mm(-p.y)} 0 E ${p.drill ? "T" : "S"}`, `RC ${mm(p.x - p.w / 2)} ${mm(-p.y - p.h / 2)} ${mm(p.w)} ${mm(p.h)}`);
    eda.push("#");
  }
  files[`${sd}eda/data`] = eda.join("\n") + "\n";

  for (const side of ["top", "bottom"] as const) {
    const out = ["UNITS=MM", "#"];
    parts
      .filter((c) => c.pcb.side === side)
      .forEach((c, k) => {
        const part = getPart(c.partId)!;
        const pkg = pkgs.indexOf(part.footprint!.name);
        const rot = side === "top" ? c.pcb.rot : (360 - c.pcb.rot) % 360;
        out.push(`CMP ${pkg} ${mm(c.pcb.x)} ${mm(H - c.pcb.y)} ${rot} ${side === "bottom" ? "M" : "N"} ${c.ref} ${(part.mpn ?? part.id).replace(/\s/g, "_")}`);
        out.push(`PRP VALUE '${c.value.replace(/'/g, "")}'`);
        padsOf(c).forEach((p, i) => out.push(`TOP ${i} ${mm(p.world.x)} ${mm(H - p.world.y)} ${rot} ${side === "bottom" ? "M" : "N"} ${netIdx.get(netOf.get(termKey({ comp: c.id, pin: p.id })) ?? "") ?? -1} 0 ${p.id}`));
        out.push(`# CMP ${k}`);
      });
    files[`${layerDir(side === "top" ? "comp_+_top" : "comp_+_bot")}components`] = out.join("\n") + "\n";
  }
  return files;
}
