// Compact, human/LLM-readable description of a design.
import { runDrc, runErc } from "./copper";
import { getPart } from "./library";
import { computeNets } from "./netlist";
import type { Design } from "./types";

export function describeDesign(design: Design): string {
  const byId = new Map(design.components.map((c) => [c.id, c]));
  const nets = computeNets(design);
  const lines: string[] = [];
  lines.push(`Project "${design.name}". Board ${design.board.width}x${design.board.height}mm, clearance ${design.board.clearance}mm, default trace ${design.board.defaultTraceWidth}mm.`);
  lines.push("", "Components (ref | part id | value | schematic x,y,rot | pcb x,y,rot,side):");
  const sorted = [...design.components].sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  if (!sorted.length) lines.push("  (none)");
  for (const c of sorted) {
    const part = getPart(c.partId);
    const pins = part?.symbol.pins.map((p) => (p.name === p.id ? p.id : `${p.id}=${p.name}`)).join(", ");
    const pcb = part?.footprint ? ` | pcb ${c.pcb.x.toFixed(2)},${c.pcb.y.toFixed(2)},${c.pcb.rot},${c.pcb.side}` : "";
    lines.push(`  ${c.ref} | ${c.partId} | ${c.value} | sch ${c.sch.x},${c.sch.y},${c.sch.rot}${pcb} | pins: ${pins}`);
  }
  lines.push("", "Nets (only nets with 2+ connections; format REF.pin):");
  let any = false;
  for (const n of nets) {
    if (n.terminals.length < 2) continue;
    const pins = n.terminals.map((t) => byId.get(t.comp)!).filter((c) => getPart(c.partId)?.kind === "part");
    any = true;
    lines.push(`  ${n.name}: ${n.terminals.filter((t) => getPart(byId.get(t.comp)!.partId)?.kind === "part").map((t) => `${byId.get(t.comp)!.ref}.${t.pin}`).join(" ")}${pins.length === 0 ? " (labels only)" : ""}`);
  }
  if (!any) lines.push("  (none)");
  lines.push("", `Routing: ${design.traces.length} traces, ${design.vias.length} vias.`);
  const erc = runErc(design, nets);
  const drc = runDrc(design);
  lines.push(`ERC: ${erc.length ? erc.map((i) => `[${i.severity}] ${i.message}`).join("; ") : "clean"}`);
  lines.push(`DRC: ${drc.length ? drc.slice(0, 25).map((i) => `[${i.severity}] ${i.message}`).join("; ") + (drc.length > 25 ? ` ... (${drc.length - 25} more)` : "") : "clean"}`);
  return lines.join("\n");
}
