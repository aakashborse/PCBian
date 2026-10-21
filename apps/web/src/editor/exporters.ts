import { enclosureStep, type EnclosureOptions, panelFiles, type PanelOptions, assemblyPdf, bomCsv, gerberFiles, ipc2581, kicadNetlist, kicadPcb, netlistText, odbFiles, pickAndPlaceCsv, schematicPdf, schematicSvgs, stepFile, type Design } from "@pcbian/core";
import JSZip from "jszip";
import { designModels } from "../lib/models";

function download(name: string, data: Blob) {
  const url = URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, "_") || "board";

export const exporters = {
  bom: (d: Design) => download(`${safe(d.name)}-bom.csv`, new Blob([bomCsv(d)], { type: "text/csv" })),
  netlist: (d: Design) => download(`${safe(d.name)}.net.txt`, new Blob([netlistText(d)], { type: "text/plain" })),
  pnp: (d: Design) => download(`${safe(d.name)}-pos.csv`, new Blob([pickAndPlaceCsv(d)], { type: "text/csv" })),
  kicadPcb: (d: Design) => download(`${safe(d.name)}.kicad_pcb`, new Blob([kicadPcb(d)], { type: "text/plain" })),
  kicadNet: (d: Design) => download(`${safe(d.name)}.net`, new Blob([kicadNetlist(d)], { type: "text/plain" })),
  schematicPdf: (d: Design) => download(`${safe(d.name)}-schematic.pdf`, new Blob([schematicPdf(d) as BlobPart], { type: "application/pdf" })),
  assemblyPdf: (d: Design) => download(`${safe(d.name)}-assembly.pdf`, new Blob([assemblyPdf(d) as BlobPart], { type: "application/pdf" })),
  // Parts with an uploaded model are placed as that model; the rest as boxes.
  step: async (d: Design) => download(`${safe(d.name)}.step`, new Blob([stepFile(d, await designModels(d))], { type: "model/step" })),
  ipc2581: (d: Design) => download(`${safe(d.name)}.ipc2581.xml`, new Blob([ipc2581(d)], { type: "application/xml" })),
  async odb(d: Design) {
    const zip = new JSZip();
    for (const [file, body] of Object.entries(odbFiles(d))) zip.file(file, body);
    download(`${safe(d.name)}-odb.zip`, await zip.generateAsync({ type: "blob" }));
  },
  async svg(d: Design) {
    const sheets = schematicSvgs(d);
    if (sheets.length === 1) return download(`${safe(d.name)}-schematic.svg`, new Blob([sheets[0].svg], { type: "image/svg+xml" }));
    const zip = new JSZip();
    sheets.forEach((s, i) => zip.file(`${safe(d.name)}-${i + 1}-${safe(s.sheet)}.svg`, s.svg));
    download(`${safe(d.name)}-schematic-svg.zip`, await zip.generateAsync({ type: "blob" }));
  },
  json: (d: Design) => download(`${safe(d.name)}.pcbian.json`, new Blob([JSON.stringify(d, null, 2)], { type: "application/json" })),
  async gerbers(d: Design) {
    const zip = new JSZip();
    const named = { ...d, name: safe(d.name) };
    for (const [file, body] of Object.entries(gerberFiles(named))) zip.file(file, body);
    zip.file(`${named.name}-bom.csv`, bomCsv(d));
    zip.file(`${named.name}-pos.csv`, pickAndPlaceCsv(d));
    zip.file(`${named.name}.kicad_pcb`, kicadPcb(named));
    zip.file(`${named.name}-schematic.pdf`, schematicPdf(d));
    zip.file(`${named.name}-assembly.pdf`, assemblyPdf(d));
    download(`${named.name}-fabrication.zip`, await zip.generateAsync({ type: "blob" }));
  },
  /** Enclosure base and lid (and the board with its models) as STEP. */
  async enclosure(d: Design, opts: EnclosureOptions, withBoard: boolean) {
    download(`${safe(d.name)}-enclosure.step`, new Blob([enclosureStep(d, opts, withBoard, withBoard ? await designModels(d) : {})], { type: "model/step" }));
  },
  /** Panel fabrication files: Gerbers, drills (plated and non-plated), V-score, panel placement. */
  async panel(d: Design, opts: PanelOptions) {
    const zip = new JSZip();
    const named = { ...d, name: safe(d.name) };
    const { files, panel } = panelFiles(named, opts);
    for (const [file, body] of Object.entries(files)) zip.file(file, body);
    zip.file(`${panel.design.name}-pos.csv`, pickAndPlaceCsv(panel.design));
    download(`${panel.design.name}-${opts.cols}x${opts.rows}.zip`, await zip.generateAsync({ type: "blob" }));
  },
};
