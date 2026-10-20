import { bomCsv, gerberFiles, netlistText, pickAndPlaceCsv, type Design } from "@pcbian/core";
import JSZip from "jszip";

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
  json: (d: Design) => download(`${safe(d.name)}.pcbian.json`, new Blob([JSON.stringify(d, null, 2)], { type: "application/json" })),
  async gerbers(d: Design) {
    const zip = new JSZip();
    const named = { ...d, name: safe(d.name) };
    for (const [file, body] of Object.entries(gerberFiles(named))) zip.file(file, body);
    zip.file(`${named.name}-bom.csv`, bomCsv(d));
    zip.file(`${named.name}-pos.csv`, pickAndPlaceCsv(d));
    download(`${named.name}-fabrication.zip`, await zip.generateAsync({ type: "blob" }));
  },
};
