// Copilot tools. Each tool validates its input with zod and edits the shared Yjs
// document through @pcbian/core, so AI edits behave exactly like human edits.
import {
  addComponent,
  addCustomPart,
  addSheet,
  addTrace,
  addVia,
  addZone,
  analyzeCopper,
  annotate,
  attachNet,
  autoPlace,
  autoRoute,
  boardOutlineZone,
  bomCsv,
  buildPart,
  clearRouting,
  componentsMap,
  connect,
  copperLayers,
  customParts,
  deleteComponent,
  deleteNetClass,
  deleteSheet,
  deleteTrace,
  deleteVia,
  deleteZone,
  describeDesign,
  disconnectPin,
  findByRef,
  freeSchematicSpot,
  gerberFiles,
  getDesign,
  getPart,
  renameSheet,
  resolveTerminal,
  runDrc,
  runErc,
  searchParts,
  setBoard,
  setNetClass,
  simulateDC,
  updateComponent,
  zonesMap,
  type CopperLayer,
  type Rotation,
} from "@pcbian/core";
import type * as Y from "yjs";
import { z } from "zod";

const pinSpec = z.string().describe('Pin as REF.pin, e.g. "R1.2" or "U1.VCC"');
const rotation = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);
const layer = z.enum(["top", "in1", "in2", "bottom"]);
const point = z.object({ x: z.number(), y: z.number() });

export interface ToolDef<S extends z.ZodObject> {
  description: string;
  schema: S;
  run: (doc: Y.Doc, input: z.infer<S>) => string | object;
  label: (input: z.infer<S>) => string;
}
const tool = <S extends z.ZodObject>(t: ToolDef<S>) => t;

const each = <T>(items: T[], fn: (x: T) => string) =>
  items
    .map((x) => {
      try {
        return fn(x);
      } catch (e) {
        return `${typeof x === "string" ? x : JSON.stringify(x)}: ERROR ${(e as Error).message}`;
      }
    })
    .join("\n");

function sheetId(doc: Y.Doc, sheet: string | undefined): string | undefined {
  if (!sheet) return undefined;
  const s = getDesign(doc).sheets.find((x) => x.id === sheet || x.name.toLowerCase() === sheet.toLowerCase());
  if (!s) throw new Error(`No sheet "${sheet}". Sheets: ${getDesign(doc).sheets.map((x) => `${x.id} (${x.name})`).join(", ")}`);
  return s.id;
}

function assertLayer(doc: Y.Doc, l: CopperLayer) {
  const layers = copperLayers(getDesign(doc).board);
  if (!layers.includes(l)) throw new Error(`Layer ${l} does not exist on this ${layers.length}-layer board (layers: ${layers.join(", ")}). Use set_board to change the layer count.`);
}

export const TOOLS = {
  get_design: tool({
    description: "Return the full current design: board, sheets, net classes, components with pins, nets, routing, ERC and DRC results.",
    schema: z.object({}),
    run: (doc) => describeDesign(getDesign(doc)),
    label: () => "Read design",
  }),

  // ----- parts -----
  search_parts: tool({
    description: "Search the parts library (built-in and this project's custom parts) by keywords, e.g. 'ldo 3.3v', 'mosfet', 'led'. Returns part ids, descriptions and pins.",
    schema: z.object({ query: z.string() }),
    run: (doc, { query }) => {
      const res = searchParts(query, 8, customParts(doc));
      if (!res.length) return "No matching parts. If the component you need is missing, create it with create_part.";
      return res.map((p) => ({ part_id: p.id, name: p.name, description: p.description, default_value: p.defaultValue, footprint: p.footprint?.name ?? null, pins: p.symbol.pins.map((pin) => `${pin.id}=${pin.name}`).join(", ") }));
    },
    label: ({ query }) => `Search parts "${query}"`,
  }),
  create_part: tool({
    description:
      "Create a new library part (symbol + footprint) for a component that is not in the library, e.g. a specific IC. List every pad of the package with its pin name from the datasheet (use NC for unconnected pads). Returns the new part_id to use with add_component.",
    schema: z.object({
      name: z.string().describe("Part name / MPN, e.g. 'ATtiny85-20SU'"),
      ref_prefix: z.string().describe("Reference prefix, e.g. U, Q, J"),
      description: z.string(),
      value: z.string().optional(),
      pins: z.array(z.object({ number: z.string(), name: z.string(), side: z.enum(["left", "right"]).optional() })).min(1),
      package: z.object({
        type: z.enum(["dip", "soic", "qfp", "header", "chip", "sot23", "sot223", "sod123", "tht2"]),
        pins: z.number().int().positive().optional().describe("Pin count for dip/soic/qfp/header"),
        pitch: z.number().positive().optional().describe("qfp pitch or tht2 lead spacing (mm)"),
        size: z.enum(["0402", "0603", "0805", "1206"]).optional().describe("For chip packages"),
      }),
    }),
    run: (doc, i) => {
      const pkg = i.package;
      const spec =
        pkg.type === "chip"
          ? { type: "chip" as const, size: pkg.size ?? "0603" }
          : pkg.type === "sot23" || pkg.type === "sot223" || pkg.type === "sod123"
            ? { type: pkg.type }
            : pkg.type === "tht2"
              ? { type: "tht2" as const, pitch: pkg.pitch }
              : pkg.type === "qfp"
                ? { type: "qfp" as const, pins: pkg.pins ?? i.pins.length, pitch: pkg.pitch }
                : { type: pkg.type, pins: pkg.pins ?? i.pins.length };
      const part = addCustomPart(doc, buildPart({ name: i.name, refPrefix: i.ref_prefix, description: i.description, value: i.value, pins: i.pins, package: spec, mpn: i.name, keywords: i.name.toLowerCase().split(/[\s-]+/) }));
      return { part_id: part.id, footprint: part.footprint?.name, pins: part.symbol.pins.map((p) => `${p.id}=${p.name}`).join(", ") };
    },
    label: ({ name }) => `Create part ${name}`,
  }),

  // ----- schematic -----
  add_component: tool({
    description: "Add a part to the schematic. Omit x/y to auto-place it in a free spot. Optionally choose the sheet (id or name). Returns the reference designator and pins.",
    schema: z.object({ part_id: z.string(), value: z.string().optional(), x: z.number().optional(), y: z.number().optional(), rotation: rotation.optional(), sheet: z.string().optional() }),
    run: (doc, { part_id, value, x, y, rotation, sheet }) => {
      const at = x !== undefined && y !== undefined ? { x: Math.round(x / 10) * 10, y: Math.round(y / 10) * 10 } : freeSchematicSpot(doc);
      const c = addComponent(doc, part_id, at, { value, rot: rotation as Rotation | undefined, sheet: sheetId(doc, sheet) });
      const part = getPart(part_id)!;
      return { ref: c.ref, value: c.value, at, pins: part.symbol.pins.map((p) => `${p.id}=${p.name}`).join(", ") };
    },
    label: ({ part_id, value }) => `Add ${getPart(part_id)?.name ?? part_id}${value ? ` (${value})` : ""}`,
  }),
  connect: tool({
    description: "Draw wires between pairs of pins (both pins must be on the same sheet; use net labels or attach_net across sheets).",
    schema: z.object({ connections: z.array(z.object({ from: pinSpec, to: pinSpec })).min(1) }),
    run: (doc, { connections }) =>
      each(connections, ({ from, to }) => {
        const d = getDesign(doc);
        const a = componentsMap(doc).get(resolveTerminal(doc, from).comp)!;
        const b = componentsMap(doc).get(resolveTerminal(doc, to).comp)!;
        if ((a.sheet ?? d.sheets[0].id) !== (b.sheet ?? d.sheets[0].id)) throw new Error("pins are on different sheets; use attach_net with a shared net name instead");
        connect(doc, from, to);
        return `${from} -> ${to}: ok`;
      }),
    label: ({ connections }) => `Wire ${connections.map((c) => `${c.from}→${c.to}`).join(", ")}`,
  }),
  attach_net: tool({
    description: "Connect pins to a named net by placing a power symbol / net label next to each pin. Every pin with the same net name is connected, across all sheets. Use for GND, supply rails (+3V3, +5V, VBUS) and shared signals (SDA, SCL, ...).",
    schema: z.object({ net: z.string(), pins: z.array(pinSpec).min(1) }),
    run: (doc, { net, pins }) =>
      each(pins, (p) => {
        const sym = attachNet(doc, p, net);
        const owner = componentsMap(doc).get(resolveTerminal(doc, p).comp)!;
        if (owner.sheet) updateComponent(doc, sym.id, { sheet: owner.sheet });
        return `${p}: ok`;
      }),
    label: ({ net, pins }) => `Attach ${pins.join(", ")} to ${net}`,
  }),
  set_no_connect: tool({
    description: "Mark pins as intentionally unconnected (no-connect flags) so ERC does not report them.",
    schema: z.object({ pins: z.array(pinSpec).min(1), connected: z.boolean().optional().describe("false (default) marks no-connect; true removes the flag") }),
    run: (doc, { pins, connected }) =>
      each(pins, (p) => {
        const t = resolveTerminal(doc, p);
        const c = componentsMap(doc).get(t.comp)!;
        const set = new Set(c.noConnect ?? []);
        if (connected) set.delete(t.pin);
        else set.add(t.pin);
        updateComponent(doc, c.id, { noConnect: [...set] });
        return `${p}: ${connected ? "flag removed" : "no-connect"}`;
      }),
    label: ({ pins }) => `No-connect ${pins.join(", ")}`,
  }),
  disconnect_pin: tool({
    description: "Remove every wire attached to a pin.",
    schema: z.object({ pin: pinSpec }),
    run: (doc, { pin }) => `Removed ${disconnectPin(doc, pin)} wire(s)`,
    label: ({ pin }) => `Disconnect ${pin}`,
  }),
  update_component: tool({
    description: "Change a component's value, reference, schematic position/rotation, sheet or do-not-populate flag.",
    schema: z.object({ ref: z.string(), value: z.string().optional(), new_ref: z.string().optional(), x: z.number().optional(), y: z.number().optional(), rotation: rotation.optional(), sheet: z.string().optional(), dnp: z.boolean().optional() }),
    run: (doc, { ref, value, new_ref, x, y, rotation, sheet, dnp }) => {
      const c = findByRef(doc, ref);
      if (!c) throw new Error(`No component ${ref}`);
      updateComponent(doc, c.id, {
        ...(value !== undefined && { value }),
        ...(new_ref !== undefined && { ref: new_ref }),
        ...(sheet !== undefined && { sheet: sheetId(doc, sheet) }),
        ...(dnp !== undefined && { dnp }),
        sch: { x: x ?? c.sch.x, y: y ?? c.sch.y, rot: (rotation ?? c.sch.rot) as Rotation },
      });
      return "ok";
    },
    label: ({ ref }) => `Update ${ref}`,
  }),
  delete_component: tool({
    description: "Delete components (and their wires) by reference.",
    schema: z.object({ refs: z.array(z.string()).min(1) }),
    run: (doc, { refs }) =>
      each(refs, (ref) => {
        const c = findByRef(doc, ref);
        if (!c) throw new Error("not found");
        deleteComponent(doc, c.id);
        return `${ref}: deleted`;
      }),
    label: ({ refs }) => `Delete ${refs.join(", ")}`,
  }),
  manage_sheets: tool({
    description: "Add, rename or delete schematic sheets (multi-sheet / hierarchical designs). Deleting a sheet deletes its components.",
    schema: z.object({ action: z.enum(["add", "rename", "delete"]), sheet: z.string().optional().describe("Sheet id or name (rename/delete)"), name: z.string().optional().describe("New name (add/rename)") }),
    run: (doc, { action, sheet, name }) => {
      if (action === "add") return addSheet(doc, name ?? `Sheet ${getDesign(doc).sheets.length + 1}`);
      const id = sheetId(doc, sheet);
      if (!id) throw new Error("sheet is required");
      if (action === "rename") renameSheet(doc, id, name ?? "Sheet");
      else deleteSheet(doc, id);
      return getDesign(doc).sheets;
    },
    label: ({ action, name, sheet }) => `${action[0].toUpperCase() + action.slice(1)} sheet ${name ?? sheet ?? ""}`,
  }),
  annotate: tool({
    description: "Renumber all reference designators in order (sheet, then top-to-bottom, left-to-right).",
    schema: z.object({}),
    run: (doc) => {
      const r = annotate(doc);
      return r.size ? [...r].map(([a, b]) => `${a}→${b}`).join(", ") : "Already annotated";
    },
    label: () => "Annotate references",
  }),

  // ----- board setup -----
  set_board: tool({
    description: "Change board size (mm), copper layer count (2 or 4), thickness, default clearance and default trace width.",
    schema: z.object({ width: z.number().positive().optional(), height: z.number().positive().optional(), layers: z.union([z.literal(2), z.literal(4)]).optional(), thickness: z.number().positive().optional(), clearance: z.number().positive().optional(), trace_width: z.number().positive().optional() }),
    run: (doc, { width, height, layers, thickness, clearance, trace_width }) => {
      setBoard(doc, { ...(width && { width }), ...(height && { height }), ...(layers && { layers }), ...(thickness && { thickness }), ...(clearance && { clearance }), ...(trace_width && { defaultTraceWidth: trace_width }) });
      return getDesign(doc).board;
    },
    label: () => "Update board settings",
  }),
  set_net_class: tool({
    description: "Create or update a net class (design rules for a group of nets), e.g. Power nets with 0.5mm traces. Assigning a net removes it from other classes. Set delete=true to remove the class.",
    schema: z.object({ name: z.string(), nets: z.array(z.string()).default([]), trace_width: z.number().positive().default(0.25), clearance: z.number().positive().default(0.2), via_diameter: z.number().positive().default(0.6), via_drill: z.number().positive().default(0.3), delete: z.boolean().optional() }),
    run: (doc, i) => {
      if (i.delete) deleteNetClass(doc, i.name);
      else setNetClass(doc, { name: i.name, nets: i.nets, traceWidth: i.trace_width, clearance: i.clearance, viaDiameter: i.via_diameter, viaDrill: i.via_drill });
      return getDesign(doc).netClasses;
    },
    label: ({ name }) => `Net class ${name}`,
  }),

  // ----- layout -----
  place_pcb: tool({
    description: "Move footprints on the PCB (mm from board top-left, y down). Put connectors at board edges, decoupling caps next to IC supply pins.",
    schema: z.object({ placements: z.array(z.object({ ref: z.string(), x: z.number(), y: z.number(), rotation: rotation.optional(), side: z.enum(["top", "bottom"]).optional() })).min(1) }),
    run: (doc, { placements }) =>
      each(placements, ({ ref, x, y, rotation, side }) => {
        const c = findByRef(doc, ref);
        if (!c) throw new Error(`No component ${ref}`);
        updateComponent(doc, c.id, { pcb: { x, y, rot: (rotation ?? c.pcb.rot) as Rotation, side: side ?? c.pcb.side } });
        return `${ref}: ok`;
      }),
    label: ({ placements }) => `Place ${placements.map((p) => p.ref).join(", ")}`,
  }),
  auto_place: tool({
    description: "Automatically pack all footprints onto the board, centred.",
    schema: z.object({}),
    run: (doc) => {
      const { placements, fits } = autoPlace(getDesign(doc));
      for (const [id, pcb] of placements) updateComponent(doc, id, { pcb });
      return fits ? "All parts placed on the board." : "Parts placed, but they do not all fit; enlarge the board with set_board and run auto_place again.";
    },
    label: () => "Auto-place footprints",
  }),
  add_copper_pour: tool({
    description: "Add a copper pour (zone) for a net on a layer, e.g. a GND plane. Omit outline to cover the whole board. Same-net pads inside the pour are connected through it; other nets get clearance automatically.",
    schema: z.object({ net: z.string(), layer, outline: z.array(point).min(3).optional() }),
    run: (doc, { net, layer: l, outline }) => {
      assertLayer(doc, l);
      const z = addZone(doc, { net, layer: l, points: outline ?? boardOutlineZone(getDesign(doc).board) });
      return `Pour ${z.id} for ${net} on ${l}`;
    },
    label: ({ net, layer: l }) => `Pour ${net} on ${l}`,
  }),
  delete_copper_pours: tool({
    description: "Delete copper pours, optionally only those for a given net and/or layer.",
    schema: z.object({ net: z.string().optional(), layer: layer.optional() }),
    run: (doc, { net, layer: l }) => {
      let n = 0;
      for (const z of [...zonesMap(doc).values()]) {
        if ((net && z.net !== net) || (l && z.layer !== l)) continue;
        deleteZone(doc, z.id);
        n++;
      }
      return `Deleted ${n} pour(s)`;
    },
    label: () => "Delete pours",
  }),
  auto_route: tool({
    description: "Auto-route unrouted connections on all copper layers (keeps existing traces). Honours net classes. Optionally route only some nets first (e.g. power) by listing them.",
    schema: z.object({ nets: z.array(z.string()).optional(), trace_width: z.number().positive().optional() }),
    run: (doc, { nets, trace_width }) => {
      const r = autoRoute(getDesign(doc), { width: trace_width, nets });
      for (const t of r.traces) addTrace(doc, t);
      for (const v of r.vias) addVia(doc, v, v.diameter, v.drill);
      return `Routed ${r.routed} connection(s), ${r.vias.length} via(s). ${r.failed.length ? `Failed: ${r.failed.map((f) => `${f.net} (${f.a.x.toFixed(1)},${f.a.y.toFixed(1)})→(${f.b.x.toFixed(1)},${f.b.y.toFixed(1)})`).join("; ")}. Try moving parts apart, enlarging the board, adding a GND pour, or going to 4 layers.` : "No failures."}`;
    },
    label: ({ nets }) => `Auto-route${nets ? ` ${nets.join(", ")}` : " board"}`,
  }),
  route_trace: tool({
    description: "Draw a trace manually as a polyline (mm) on a layer. Endpoints should land on pad centres or other copper of the same net.",
    schema: z.object({ layer, width: z.number().positive(), points: z.array(point).min(2) }),
    run: (doc, { layer: l, width, points }) => {
      assertLayer(doc, l);
      return `Trace ${addTrace(doc, { layer: l, width, points }).id}`;
    },
    label: ({ layer: l }) => `Route trace on ${l}`,
  }),
  add_via: tool({
    description: "Place a through via at a point (mm).",
    schema: z.object({ x: z.number(), y: z.number(), diameter: z.number().positive().default(0.6), drill: z.number().positive().default(0.3) }),
    run: (doc, { x, y, diameter, drill }) => `Via ${addVia(doc, { x, y }, diameter, drill).id}`,
    label: ({ x, y }) => `Via at ${x},${y}`,
  }),
  unroute: tool({
    description: "Delete traces and vias: all of them, or only those belonging to the listed nets.",
    schema: z.object({ nets: z.array(z.string()).optional() }),
    run: (doc, { nets }) => {
      if (!nets) {
        clearRouting(doc);
        return "All routing removed";
      }
      const d = getDesign(doc);
      const a = analyzeCopper(d);
      let n = 0;
      for (const it of a.items) {
        const net = a.netOfItem(it);
        if (!net || !nets.includes(net)) continue;
        if (it.kind === "trace") deleteTrace(doc, it.trace.id), n++;
        if (it.kind === "via") deleteVia(doc, it.via.id), n++;
      }
      return `Removed ${n} trace(s)/via(s)`;
    },
    label: ({ nets }) => `Unroute ${nets?.join(", ") ?? "all"}`,
  }),

  // ----- verification -----
  run_checks: tool({
    description: "Run the electrical rules check (schematic) and design rules check (PCB).",
    schema: z.object({}),
    run: (doc) => {
      const d = getDesign(doc);
      return { erc: runErc(d).map((i) => `[${i.severity}] ${i.message}`), drc: runDrc(d).map((i) => `[${i.severity}] ${i.message}`) };
    },
    label: () => "Run ERC + DRC",
  }),
  simulate_dc: tool({
    description: "Run a DC operating-point simulation: node voltages, currents through resistors/diodes/LEDs, supply currents, and warnings (LED overcurrent, resistor power, fuse rating). Supplies come from rail names (+5V, +3V3, VBUS); AMS1117 regulators are modelled.",
    schema: z.object({}),
    run: (doc) => {
      const r = simulateDC(getDesign(doc));
      if (!r.ok) return `Simulation failed: ${r.error}`;
      const mA = (i: number) => `${(i * 1000).toFixed(3)}mA`;
      return {
        nodes: r.nodes.map((n) => `${n.net}=${n.voltage.toFixed(3)}V`).join(", "),
        elements: r.elements.map((e) => `${e.label}: ${mA(e.current)}, ${e.voltage.toFixed(3)}V, ${(e.power * 1000).toFixed(1)}mW`),
        supplies: r.supplies.map((s) => `${s.name}: ${mA(s.current)} (${(s.power * 1000).toFixed(1)}mW)`),
        warnings: r.warnings,
      };
    },
    label: () => "Simulate DC operating point",
  }),
  fabrication_check: tool({
    description: "Final manufacturing readiness report: ERC/DRC error counts, unrouted nets, BOM size and the list of fabrication files that the Export menu will produce.",
    schema: z.object({}),
    run: (doc) => {
      const d = getDesign(doc);
      const erc = runErc(d);
      const drc = runDrc(d);
      return {
        ready: !erc.some((i) => i.severity === "error") && !drc.some((i) => i.severity === "error" || i.code === "unrouted"),
        erc_errors: erc.filter((i) => i.severity === "error").length,
        drc_errors: drc.filter((i) => i.severity === "error").length,
        unrouted: drc.filter((i) => i.code === "unrouted").map((i) => i.message),
        bom_lines: bomCsv(d).trim().split("\n").length - 1,
        files: Object.keys(gerberFiles(d)),
      };
    },
    label: () => "Fabrication readiness check",
  }),
};

export type ToolName = keyof typeof TOOLS;
