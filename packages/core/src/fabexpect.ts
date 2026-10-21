// What the fabrication outputs must contain, for independent checkers (tools/fabcheck) that read
// the Gerber/Excellon and ODB++ files with their own parsers and compare. Coordinates use the
// fabrication frame: millimetres, origin at the board's bottom-left, y up.
import { analyzeCopper } from "./copper";
import { boardOutline } from "./doc";
import { padsOf } from "./geometry";
import { copperLayers, viaKind, viaLayers } from "./stackup";
import type { CopperLayer, Design, Vec } from "./types";

export interface FabProbe {
  /** A point that must be covered by copper on the layer. */
  x: number;
  y: number;
  /** Net carried (pads and routed copper whose net is known). */
  net?: string;
  /** Items in the same cluster must end up in one piece of copper (across layers, via holes). */
  cluster: string;
  what: string;
}

export interface FabExpect {
  name: string;
  outline: Vec[];
  copper: { layer: CopperLayer; index: number; probes: FabProbe[] }[];
  /** Plated and non-plated holes that go through the whole board. */
  drills: { x: number; y: number; d: number; plated: boolean }[];
  /** Blind/buried/micro vias: holes that only join some layers (by index, top = 0). */
  partialHoles: { x: number; y: number; d: number; from: number; to: number }[];
}

export function fabExpectations(design: Design): FabExpect {
  const H = design.board.height;
  const F = (p: Vec) => ({ x: round(p.x), y: round(H - p.y) });
  const a = analyzeCopper(design);
  const layers = copperLayers(design.board);
  const copper = layers.map((layer, index) => ({ layer, index, probes: [] as FabProbe[] }));
  const at = (l: CopperLayer) => copper.find((c) => c.layer === l);
  for (const it of a.items) {
    const cluster = a.clusterOf.get(it.key)!;
    const net = a.netOfItem(it);
    if (it.kind === "pad") {
      for (const l of it.pad.layers) at(l)?.probes.push({ ...F(it.pad.world), net, cluster, what: `${it.pad.ref}.${it.pad.id}` });
    } else if (it.kind === "via") {
      for (const l of it.layers) at(l)?.probes.push({ ...F(it.via), net, cluster, what: "via" });
    } else {
      // Midpoints of segments: pads cover the ends.
      it.trace.points.slice(1).forEach((p, i) => {
        const q = it.trace.points[i];
        at(it.trace.layer)?.probes.push({ ...F({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }), net, cluster, what: `trace ${it.trace.id}` });
      });
    }
  }
  const drills: FabExpect["drills"] = [];
  for (const c of design.components) for (const p of padsOf(c)) if (p.drill) drills.push({ ...F(p.world), d: p.drill, plated: true });
  const partialHoles: FabExpect["partialHoles"] = [];
  for (const v of design.vias) {
    if (viaKind(design.board, v) === "through") drills.push({ ...F(v), d: v.drill, plated: true });
    else {
      const span = viaLayers(design.board, v).map((l) => layers.indexOf(l));
      partialHoles.push({ ...F(v), d: v.drill, from: Math.min(...span), to: Math.max(...span) });
    }
  }
  return { name: design.name, outline: boardOutline(design.board).map(F), copper, drills, partialHoles };
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;
