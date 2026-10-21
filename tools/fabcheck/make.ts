// Write a design's fabrication outputs plus what they must contain, for gerber_check.py and
// odb_check.py to verify with independent parsers.
//
//   npx tsx tools/fabcheck/make.ts <out-dir> <design files…>       (KiCad, EAGLE or Altium files)
//   npx tsx tools/fabcheck/make.ts <out-dir> path/to/<project>.ydoc  (a PCBian project file)
//
// Writes <out-dir>/gerber/* (Gerber X2 + Excellon), <out-dir>/odb/* (ODB++ tree) and
// <out-dir>/expect.json.
import fs from "node:fs";
import path from "node:path";
import * as Y from "yjs";
import { drillFiles, fabExpectations, gerberFiles, getDesign, importAltiumProject, importEagleProject, importKicadProject, initDoc, odbFiles, runDrc } from "../../packages/core/src/index.ts";

const [out, ...inputs] = process.argv.slice(2);
if (!out || !inputs.length) {
  console.error("usage: make.ts <out-dir> <design files…>");
  process.exit(2);
}
const doc = new Y.Doc();
const ext = (f: string) => path.extname(f).toLowerCase();
const read = (f: string) => fs.readFileSync(f);
if (inputs.length === 1 && ext(inputs[0]) === ".ydoc") Y.applyUpdate(doc, read(inputs[0]));
else {
  initDoc(doc, path.basename(inputs[0]).replace(/\.[^.]+$/, ""));
  const by = (e: string) => inputs.filter((f) => ext(f) === e);
  const report =
    by(".pcbdoc").length || by(".schdoc").length
      ? importAltiumProject(doc, { pcb: by(".pcbdoc")[0] ? new Uint8Array(read(by(".pcbdoc")[0])) : undefined, schematics: by(".schdoc").map((f) => ({ name: path.basename(f), data: new Uint8Array(read(f)) })) })
      : by(".brd").length || by(".sch").length
        ? importEagleProject(doc, { board: by(".brd")[0] && read(by(".brd")[0]).toString("utf8"), schematic: by(".sch")[0] && read(by(".sch")[0]).toString("utf8") })
        : importKicadProject(doc, { pcb: by(".kicad_pcb")[0] && read(by(".kicad_pcb")[0]).toString("utf8"), schematics: by(".kicad_sch").map((f) => ({ name: path.basename(f), text: read(f).toString("utf8") })) });
  for (const w of report.warnings) console.log(`import: ${w}`);
}
const design = getDesign(doc);
const errors = runDrc(design).filter((i) => i.severity === "error").length;
fs.rmSync(out, { recursive: true, force: true });
const write = (rel: string, data: string | Uint8Array) => {
  const f = path.join(out, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
};
for (const [name, text] of Object.entries({ ...gerberFiles(design), ...drillFiles(design) })) write(`gerber/${name}`, text);
for (const [name, text] of Object.entries(odbFiles(design))) write(`odb/${name}`, text);
write("expect.json", JSON.stringify(fabExpectations(design), null, 1));
console.log(`${design.name}: ${design.components.length} components, ${design.traces.length} traces, ${design.vias.length} vias, ${design.zones.length} pours, ${errors} DRC errors -> ${out}`);
