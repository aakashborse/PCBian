// Shared by the schematic importers: draw nets that arrive as pin lists (not wire geometry).
import type * as Y from "yjs";
import { addWire, componentsMap } from "./doc";
import { attachNet, isPowerName, type LabelScope } from "./edit";
import { schematicPin } from "./geometry";
import type { Terminal } from "./types";

/**
 * For each net and sheet, wire the pins together along a minimum spanning tree and label the net
 * (power names as power labels, nets spanning sheets as global labels). Auto-named nets stay
 * unlabelled unless they cross sheets, where `rename` gives them a usable label. Returns the
 * number of per-sheet nets drawn.
 */
export function drawImportedNets(doc: Y.Doc, netSheets: Map<string, Map<number, Terminal[]>>, isAuto: (name: string) => boolean, rename: (name: string) => string = (n) => n): number {
  let nets = 0;
  for (const [name, bySheet] of netSheets) {
    const auto = isAuto(name);
    const multi = bySheet.size > 1;
    for (const terms of bySheet.values()) {
      if (!terms.length) continue;
      nets++;
      // Minimum spanning tree of the net's pins on this sheet, redrawn as wires.
      const pos = (t: Terminal) => schematicPin(componentsMap(doc).get(t.comp)!, t.pin) ?? { x: 0, y: 0 };
      const inTree = [terms[0]];
      const rest = terms.slice(1);
      while (rest.length) {
        let best = { i: 0, j: 0, d: Infinity };
        inTree.forEach((a, i) =>
          rest.forEach((b, j) => {
            const pa = pos(a);
            const pb = pos(b);
            const d = Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y);
            if (d < best.d) best = { i, j, d };
          }),
        );
        const b = rest.splice(best.j, 1)[0];
        if (!(inTree[best.i].comp === b.comp && inTree[best.i].pin === b.pin)) addWire(doc, inTree[best.i], b);
        inTree.push(b);
      }
      if (!auto || multi) {
        const t = terms[0];
        const scope: LabelScope = isPowerName(name) ? "power" : multi ? "global" : "local";
        attachNet(doc, `${componentsMap(doc).get(t.comp)!.ref}.${t.pin}`, auto ? rename(name) : name, scope);
      }
    }
  }
  return nets;
}
