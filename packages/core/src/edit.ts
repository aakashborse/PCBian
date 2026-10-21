// Higher-level editing operations that address parts by reference designator
// ("R1") and pins by "REF.pin" where pin is a pin number or name ("U1.8", "U1.VCC").
import type * as Y from "yjs";
import { addComponent, addWire, componentsMap, wiresMap } from "./doc";
import { schematicPins } from "./geometry";
import { allPins, getPart } from "./library";
import type { ComponentData, Terminal, Vec } from "./types";

export function findByRef(doc: Y.Doc, ref: string): ComponentData | undefined {
  const want = ref.trim().toUpperCase();
  for (const c of componentsMap(doc).values()) if (c.ref.toUpperCase() === want) return c;
  return undefined;
}

export function resolveTerminal(doc: Y.Doc, spec: string): Terminal {
  const dot = spec.indexOf(".");
  if (dot < 0) throw new Error(`Pin "${spec}" must look like REF.pin, e.g. R1.1 or U1.VCC`);
  const ref = spec.slice(0, dot);
  const pinSpec = spec.slice(dot + 1).trim();
  const comp = findByRef(doc, ref);
  if (!comp) throw new Error(`No component with reference ${ref}`);
  const pins = allPins(getPart(comp.partId)!);
  const byNum = pins.find((p) => p.id.toUpperCase() === pinSpec.toUpperCase());
  if (byNum) return { comp: comp.id, pin: byNum.id };
  const byName = pins.filter((p) => p.name.toUpperCase() === pinSpec.toUpperCase() || p.name.toUpperCase().split("/").includes(pinSpec.toUpperCase()));
  if (byName.length >= 1) return { comp: comp.id, pin: byName[0].id };
  throw new Error(`${comp.ref} has no pin "${pinSpec}". Pins: ${pins.map((p) => `${p.id}(${p.name})`).join(", ")}`);
}

export function connect(doc: Y.Doc, from: string, to: string) {
  const a = resolveTerminal(doc, from);
  const b = resolveTerminal(doc, to);
  return addWire(doc, a, b);
}

export function disconnectPin(doc: Y.Doc, spec: string): number {
  const t = resolveTerminal(doc, spec);
  const wires = wiresMap(doc);
  let n = 0;
  for (const w of [...wires.values()]) {
    if ((w.a.comp === t.comp && w.a.pin === t.pin) || (w.b.comp === t.comp && w.b.pin === t.pin)) {
      wires.delete(w.id);
      n++;
    }
  }
  return n;
}

const SIDE_DIR: Record<string, Vec> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } };

export const isPowerName = (n: string) => /^(A|D|P)?GND|^VSS$|^[+-]?\d+(\.\d+)?V\d*$|^[+-]?\d+V\d+$|^V(CC|DD|BUS|IN|BAT|SYS)\b|^\+/i.test(n.trim());

export type LabelScope = "auto" | "power" | "global" | "local" | "hierarchical";

/**
 * Drop a power symbol or label next to a pin and wire it up. "auto" uses a power symbol for
 * supply-looking names (GND, +3V3, VBUS...) and a global label for anything else.
 */
export function attachNet(doc: Y.Doc, spec: string, net: string, scope: LabelScope = "auto"): ComponentData {
  const t = resolveTerminal(doc, spec);
  const comp = componentsMap(doc).get(t.comp)!;
  const pin = schematicPins(comp).find((p) => p.id === t.pin)!;
  const isGnd = /^(A|D|P)?GND/i.test(net) || /^VSS/i.test(net);
  const kind = scope === "auto" ? (isPowerName(net) ? "power" : "global") : scope;
  const partId = kind === "power" ? (isGnd ? "power_gnd" : "power_rail") : kind === "global" ? "net_label" : kind === "local" ? "local_label" : "hier_label";
  // schematicPins() already reports the side after mirroring; rotate it into world space.
  // A multi-unit part's pin follows its own unit's placement.
  const unitSch = pin.unit > 1 ? (comp.units?.[pin.unit - 2] ?? comp.sch) : comp.sch;
  const dir = rotateDir(SIDE_DIR[pin.side], unitSch.rot);
  const at =
    kind === "power"
      ? { x: pin.world.x + dir.x * 20, y: pin.world.y + dir.y * 20 + (dir.y === 0 ? (isGnd ? 20 : -20) : 0) }
      : { x: pin.world.x + dir.x * 20, y: pin.world.y + dir.y * 20 };
  // Labels point away from the part: mirror them when they sit on the left of the pin.
  const sym = addComponent(doc, partId, { x: Math.round(at.x / 10) * 10, y: Math.round(at.y / 10) * 10 }, { value: net, sheet: pin.sheet });
  if (kind !== "power" && dir.x < 0) updateMirror(doc, sym.id);
  addWire(doc, t, { comp: sym.id, pin: "1" });
  return sym;
}

function updateMirror(doc: Y.Doc, id: string) {
  const c = componentsMap(doc).get(id)!;
  componentsMap(doc).set(id, { ...c, sch: { ...c.sch, mirror: true } });
}

function rotateDir(d: Vec, rot: number): Vec {
  switch (rot) {
    case 90:
      return { x: -d.y, y: d.x };
    case 180:
      return { x: -d.x, y: -d.y };
    case 270:
      return { x: d.y, y: -d.x };
    default:
      return d;
  }
}

/** Find an empty spot on the schematic for a new part, scanning a grid of slots. */
export function freeSchematicSpot(doc: Y.Doc): Vec {
  const taken = [...componentsMap(doc).values()].filter((c) => getPart(c.partId)?.kind === "part").map((c) => c.sch);
  for (let k = 0; k < 400; k++) {
    const at = { x: (k % 5) * 160, y: Math.floor(k / 5) * 140 };
    if (taken.every((p) => Math.abs(p.x - at.x) > 100 || Math.abs(p.y - at.y) > 90)) return at;
  }
  return { x: 0, y: 0 };
}
