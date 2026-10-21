// Copilot tools. Each tool validates its input with zod and edits the shared Yjs
// document through @pcbian/core, so AI edits behave exactly like human edits.
import {
  addComponent,
  addCustomPart,
  addSheet,
  addTrace,
  addVia,
  addKeepout,
  addSchGraphic,
  addZone,
  analyzeCopper,
  busMembers,
  deleteVariant,
  keepoutsMap,
  setActiveVariant,
  setBoardOutline,
  setTitleBlock,
  setVariant,
  sheetPartId,
  simulateAC,
  simulateTransient,
  zoneFill,
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
      pins: z.array(z.object({ number: z.string(), name: z.string(), side: z.enum(["left", "right"]).optional(), type: z.enum(["input", "output", "bidirectional", "tristate", "passive", "power_in", "power_out", "open_collector", "unspecified", "nc"]).optional() })).min(1),
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
    description:
      "Connect pins to a named net by placing a power symbol or label next to each pin. scope 'auto' (default) uses power symbols for supply names (GND, +3V3, VBUS) and global labels otherwise; 'local' labels join only on the same sheet; 'hierarchical' labels become pins of the sheet's sheet symbol (see add_sheet_symbol).",
    schema: z.object({ net: z.string(), pins: z.array(pinSpec).min(1), scope: z.enum(["auto", "power", "global", "local", "hierarchical"]).optional() }),
    run: (doc, { net, pins, scope }) =>
      each(pins, (p) => {
        attachNet(doc, p, net, scope ?? "auto");
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
    description: "Change a component's value, reference, schematic position/rotation/mirror, sheet or do-not-populate flag.",
    schema: z.object({ ref: z.string(), value: z.string().optional(), new_ref: z.string().optional(), x: z.number().optional(), y: z.number().optional(), rotation: rotation.optional(), mirror: z.boolean().optional(), sheet: z.string().optional(), dnp: z.boolean().optional() }),
    run: (doc, { ref, value, new_ref, x, y, rotation, mirror, sheet, dnp }) => {
      const c = findByRef(doc, ref);
      if (!c) throw new Error(`No component ${ref}`);
      updateComponent(doc, c.id, {
        ...(value !== undefined && { value }),
        ...(new_ref !== undefined && { ref: new_ref }),
        ...(sheet !== undefined && { sheet: sheetId(doc, sheet) }),
        ...(dnp !== undefined && { dnp }),
        sch: { x: x ?? c.sch.x, y: y ?? c.sch.y, rot: (rotation ?? c.sch.rot) as Rotation, mirror: mirror ?? c.sch.mirror },
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
    description:
      "Change board size (mm), copper layer count (2 or 4), thickness, default clearance/trace width, rounded corners, a custom outline polygon (mm; replaces width/height with its bounding box), internal cutouts/slots, and teardrops.",
    schema: z.object({
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      layers: z.union([z.literal(2), z.literal(4)]).optional(),
      thickness: z.number().positive().optional(),
      clearance: z.number().positive().optional(),
      trace_width: z.number().positive().optional(),
      corner_radius: z.number().min(0).optional(),
      outline: z.array(point).min(3).nullable().optional().describe("Custom outline; null restores the rectangle"),
      cutouts: z.array(z.array(point).min(3)).optional(),
      teardrops: z.boolean().optional(),
    }),
    run: (doc, i) => {
      setBoard(doc, {
        ...(i.width && { width: i.width }),
        ...(i.height && { height: i.height }),
        ...(i.layers && { layers: i.layers }),
        ...(i.thickness && { thickness: i.thickness }),
        ...(i.clearance && { clearance: i.clearance }),
        ...(i.trace_width && { defaultTraceWidth: i.trace_width }),
        ...(i.corner_radius !== undefined && { cornerRadius: i.corner_radius }),
        ...(i.cutouts && { cutouts: i.cutouts }),
        ...(i.teardrops !== undefined && { teardrops: i.teardrops }),
      });
      if (i.outline !== undefined) setBoardOutline(doc, i.outline);
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
    description: "Automatically place all footprints. mode 'cluster' (default) groups parts by connectivity, puts connectors on board edges and decoupling caps next to their ICs; 'pack' just packs them tightly.",
    schema: z.object({ mode: z.enum(["cluster", "pack"]).optional() }),
    run: (doc, { mode }) => {
      const { placements, fits } = autoPlace(getDesign(doc), { mode });
      for (const [id, pcb] of placements) updateComponent(doc, id, { pcb });
      return fits ? "All parts placed on the board." : "Parts placed, but they do not all fit; enlarge the board with set_board and run auto_place again.";
    },
    label: () => "Auto-place footprints",
  }),
  add_copper_pour: tool({
    description: "Add a copper pour (zone) for a net on a layer, e.g. a GND plane. Omit outline to cover the whole board. Same-net pads inside the pour are connected through it; other nets get clearance automatically.",
    schema: z.object({
      net: z.string(),
      layer,
      outline: z.array(point).min(3).optional(),
      pad_connection: z.enum(["thermal", "solid"]).optional().describe("thermal (default) eases soldering; solid for high current"),
      thermal_gap: z.number().positive().optional(),
      spoke_width: z.number().positive().optional(),
      remove_islands: z.boolean().optional(),
    }),
    run: (doc, { net, layer: l, outline, pad_connection, thermal_gap, spoke_width, remove_islands }) => {
      assertLayer(doc, l);
      const z = addZone(doc, { net, layer: l, points: outline ?? boardOutlineZone(getDesign(doc).board), padConnection: pad_connection, thermalGap: thermal_gap, spokeWidth: spoke_width, removeIslands: remove_islands });
      const fill = zoneFill(getDesign(doc), getDesign(doc).zones.find((x) => x.id === z.id)!);
      return `Pour ${z.id} for ${net} on ${l}: ${fill.islands.length} island(s) kept, ${fill.removed.length ? "isolated islands removed" : "no isolated islands"}`;
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


  // ----- hierarchy, buses, documentation -----
  add_sheet_symbol: tool({
    description:
      "Instantiate a child sheet inside a parent sheet (hierarchical design). The symbol's pins are the hierarchical labels on the child sheet (create them with attach_net scope 'hierarchical'). Wire its pins with connect using REF.LABELNAME. Each child sheet should be instantiated once.",
    schema: z.object({ child_sheet: z.string(), parent_sheet: z.string().optional(), x: z.number().optional(), y: z.number().optional() }),
    run: (doc, { child_sheet, parent_sheet, x, y }) => {
      const child = sheetId(doc, child_sheet)!;
      const parent = sheetId(doc, parent_sheet) ?? getDesign(doc).sheets[0].id;
      if (child === parent) throw new Error("A sheet cannot contain its own symbol");
      getDesign(doc); // refresh the derived sheet-symbol part
      const at = x !== undefined && y !== undefined ? { x, y } : freeSchematicSpot(doc);
      const c = addComponent(doc, sheetPartId(child), at, { value: child, sheet: parent === getDesign(doc).sheets[0].id ? undefined : parent });
      return { ref: c.ref, pins: getPart(sheetPartId(child))!.symbol.pins.map((p) => p.id) };
    },
    label: ({ child_sheet }) => `Sheet symbol for ${child_sheet}`,
  }),
  add_bus: tool({
    description: "Draw a bus on a sheet, e.g. name 'D[0..7]' or '{SDA SCL}'. Buses are graphical; members connect through labels with the member names (attach_net).",
    schema: z.object({ sheet: z.string().optional(), name: z.string(), points: z.array(point).min(2) }),
    run: (doc, { sheet, name, points }) => {
      addSchGraphic(doc, { sheet: sheetId(doc, sheet) ?? getDesign(doc).sheets[0].id, kind: "bus", points, text: name });
      return `Bus ${name} with members ${busMembers(name).join(", ")}`;
    },
    label: ({ name }) => `Bus ${name}`,
  }),
  add_note: tool({
    description: "Add a text note to a schematic sheet (design notes, block titles).",
    schema: z.object({ sheet: z.string().optional(), text: z.string(), x: z.number(), y: z.number(), size: z.number().optional() }),
    run: (doc, { sheet, text, x, y, size }) => addSchGraphic(doc, { sheet: sheetId(doc, sheet) ?? getDesign(doc).sheets[0].id, kind: "text", points: [{ x, y }], text, size: size ?? 10 }).id,
    label: () => "Add note",
  }),
  set_title_block: tool({
    description: "Set the title block shown on schematic and assembly drawings.",
    schema: z.object({ title: z.string().optional(), revision: z.string().optional(), date: z.string().optional(), company: z.string().optional(), author: z.string().optional() }),
    run: (doc, i) => {
      setTitleBlock(doc, Object.fromEntries(Object.entries(i).filter(([, v]) => v !== undefined)));
      return getDesign(doc).titleBlock;
    },
    label: () => "Title block",
  }),

  // ----- keepouts, variants -----
  add_keepout: tool({
    description: "Add a keepout area (mm polygon) that forbids tracks, vias and/or copper pours on the given layers, e.g. under an antenna or around a mounting screw head.",
    schema: z.object({ outline: z.array(point).min(3), layers: z.array(layer).min(1), no_tracks: z.boolean().default(true), no_vias: z.boolean().default(true), no_pours: z.boolean().default(true) }),
    run: (doc, i) => addKeepout(doc, { points: i.outline, layers: i.layers, noTracks: i.no_tracks, noVias: i.no_vias, noPours: i.no_pours }).id,
    label: () => "Add keepout",
  }),
  delete_keepouts: tool({
    description: "Delete all keepout areas.",
    schema: z.object({}),
    run: (doc) => {
      const n = keepoutsMap(doc).size;
      keepoutsMap(doc).clear();
      return `Deleted ${n} keepout(s)`;
    },
    label: () => "Delete keepouts",
  }),
  manage_variants: tool({
    description: "Assembly variants: 'set' creates/updates a variant (refs not fitted, value overrides), 'activate' makes one active ('' = base design; BOM, 3D, simulation and exports follow it), 'delete' removes it.",
    schema: z.object({ action: z.enum(["set", "activate", "delete"]), name: z.string(), dnp: z.array(z.string()).optional(), values: z.record(z.string(), z.string()).optional() }),
    run: (doc, { action, name, dnp, values }) => {
      if (action === "set") setVariant(doc, { name, dnp: dnp ?? [], values: values ?? {} });
      else if (action === "activate") setActiveVariant(doc, name);
      else deleteVariant(doc, name);
      const d = getDesign(doc);
      return { variants: d.variants, active: d.activeVariant || "(base)" };
    },
    label: ({ action, name }) => `Variant ${action} ${name}`,
  }),

  // ----- simulation -----
  simulate_transient: tool({
    description:
      "Transient simulation from power-on (capacitors start discharged). Models: R, C, L, diodes/LEDs, NPN BJT, N-MOSFET, LM358 op-amp, NE555 timer, AMS1117 LDO, simulation sources (sim_vsource values like 'PULSE(0 5 0 1u 1u 0.5m 1m)' or 'SIN(0 1 1k)'). Returns min/max/final values and frequency of the probed nets and peak currents.",
    schema: z.object({ tstop: z.number().positive().describe("Stop time in seconds"), points: z.number().int().positive().optional(), nets: z.array(z.string()).optional().describe("Nets to report (default: all named nets)") }),
    run: (doc, { tstop, points, nets }) => {
      const r = simulateTransient(getDesign(doc), { tstop, points: points ?? 2000 });
      if (!r.ok) return `Simulation failed: ${r.error}`;
      const pick = nets?.length ? nets : Object.keys(r.nodes).filter((n) => !n.startsWith("Net-("));
      const summary = pick.filter((n) => r.nodes[n]).map((n) => {
        const v = r.nodes[n];
        const lo = Math.min(...v);
        const hi = Math.max(...v);
        const mid = (lo + hi) / 2;
        const rises: number[] = [];
        for (let i = 1; i < v.length; i++) if (v[i - 1] < mid && v[i] >= mid) rises.push(r.time[i]);
        const f = hi - lo > 0.05 && rises.length >= 3 ? (rises.length - 2) / (rises[rises.length - 1] - rises[1]) : null;
        return `${n}: min ${lo.toFixed(3)}V, max ${hi.toFixed(3)}V, final ${v[v.length - 1].toFixed(3)}V${f ? `, ~${f.toPrecision(3)}Hz` : ""}`;
      });
      const peaks = Object.entries(r.currents).map(([ref, i]) => `${ref}: peak ${(Math.max(...i.map(Math.abs)) * 1000).toFixed(2)}mA`);
      return { nets: summary, currents: peaks, warnings: r.warnings };
    },
    label: ({ tstop }) => `Transient ${tstop}s`,
  }),
  simulate_ac: tool({
    description: "AC small-signal sweep. Needs a sim_vsource with an AC magnitude (value 'DC 0 AC 1'). Reports gain (dB) and phase at decade points and the -3dB frequency for the probed nets.",
    schema: z.object({ fstart: z.number().positive(), fstop: z.number().positive(), nets: z.array(z.string()).min(1) }),
    run: (doc, { fstart, fstop, nets }) => {
      const r = simulateAC(getDesign(doc), { fstart, fstop, pointsPerDecade: 20 });
      if (!r.ok) return `AC analysis failed: ${r.error}`;
      return nets.filter((n) => r.nodes[n]).map((n) => {
        const { mag, phase } = r.nodes[n];
        const ref = mag[0];
        const i3 = mag.findIndex((m) => m < ref - 3.0103);
        // Interpolate the crossing on the log-frequency axis rather than reporting the next grid point.
        const f3 = i3 > 0 ? r.freq[i3 - 1] * (r.freq[i3] / r.freq[i3 - 1]) ** ((mag[i3 - 1] - (ref - 3.0103)) / (mag[i3 - 1] - mag[i3])) : r.freq[i3];
        const pts = r.freq.map((f, i) => ({ f, i })).filter((_, i) => i % 20 === 0).map(({ f, i }) => `${f.toPrecision(3)}Hz ${mag[i].toFixed(1)}dB ${phase[i].toFixed(0)}°`);
        return `${n}: ${pts.join("; ")}${i3 >= 0 ? `; -3dB at ~${f3.toPrecision(3)}Hz` : "; no -3dB point in range"}`;
      });
    },
    label: ({ nets }) => `AC sweep ${nets.join(", ")}`,
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
        files: [...Object.keys(gerberFiles(d)), "schematic.pdf", "assembly.pdf", `${d.name}.kicad_pcb`],
      };
    },
    label: () => "Fabrication readiness check",
  }),
};

export type ToolName = keyof typeof TOOLS;
