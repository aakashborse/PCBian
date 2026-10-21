// Compact, human/LLM-readable description of a design.
import { runDrc, runErc } from "./copper";
import { netRules, sheetOf } from "./doc";
import { allPins, getPart } from "./library";
import { schematicViews } from "./geometry";
import { computeNets } from "./netlist";
import type { Design } from "./types";

export function describeDesign(design: Design): string {
  const byId = new Map(design.components.map((c) => [c.id, c]));
  const nets = computeNets(design);
  const b = design.board;
  const lines: string[] = [];
  lines.push(`Project "${design.name}". Board ${b.width}x${b.height}mm, ${b.layers} copper layers, ${b.thickness}mm thick, clearance ${b.clearance}mm, default trace ${b.defaultTraceWidth}mm.`);
  lines.push(`Sheets: ${design.sheets.map((s) => `${s.id} "${s.name}"`).join(", ")}`);
  if (design.netClasses.length) lines.push(`Net classes: ${design.netClasses.map((c) => `${c.name} (trace ${c.traceWidth}mm, clearance ${c.clearance}mm, via ${c.viaDiameter}/${c.viaDrill}mm): ${c.nets.join(", ") || "no nets"}`).join("; ")}`);
  lines.push("", "Components (ref | part id | value | sheet | schematic x,y,rot | pcb x,y,rot,side):");
  const sorted = [...design.components].sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  if (!sorted.length) lines.push("  (none)");
  for (const c of sorted) {
    const part = getPart(c.partId);
    const pins = (part ? allPins(part) : []).map((p) => (p.name === p.id ? p.id : `${p.id}=${p.name}`)).join(", ");
    const pcb = part?.footprint ? ` | pcb ${c.pcb.x.toFixed(2)},${c.pcb.y.toFixed(2)},${c.pcb.rot},${c.pcb.side}` : "";
    const nc = c.noConnect?.length ? ` | no-connect: ${c.noConnect.join(",")}` : "";
    const views = schematicViews(c);
    const units = views.length > 1 ? ` | units: ${views.slice(1).map((v) => `${v.unit} on ${sheetOf(design, v)} at ${v.sch.x},${v.sch.y},${v.sch.rot}`).join("; ")}` : "";
    lines.push(`  ${c.ref} | ${c.partId} | ${c.value} | ${sheetOf(design, c)} | sch ${c.sch.x},${c.sch.y},${c.sch.rot}${pcb} | pins: ${pins}${units}${nc}${c.dnp ? " | DNP" : ""}`);
  }
  lines.push("", "Nets (only nets with 2+ connections; format REF.pin):");
  let any = false;
  for (const n of nets) {
    if (n.terminals.length < 2) continue;
    const phys = n.terminals.filter((t) => getPart(byId.get(t.comp)!.partId)?.kind === "part");
    any = true;
    const r = netRules(design, n.name);
    lines.push(`  ${n.name}${r.className !== "Default" ? ` [${r.className}]` : ""}: ${phys.map((t) => `${byId.get(t.comp)!.ref}.${t.pin}`).join(" ")}${phys.length === 0 ? " (labels only)" : ""}`);
  }
  if (!any) lines.push("  (none)");
  lines.push("", `Routing: ${design.traces.length} traces, ${design.vias.length} vias, ${design.zones.length} copper pours${design.zones.length ? ` (${design.zones.map((z) => `${z.net} on ${z.layer}`).join(", ")})` : ""}.`);
  const erc = runErc(design, nets);
  const drc = runDrc(design);
  lines.push(`ERC: ${erc.length ? erc.map((i) => `[${i.severity}] ${i.message}`).join("; ") : "clean"}`);
  lines.push(`DRC: ${drc.length ? drc.slice(0, 25).map((i) => `[${i.severity}] ${i.message}`).join("; ") + (drc.length > 25 ? ` ... (${drc.length - 25} more)` : "") : "clean"}`);
  return lines.join("\n");
}
