// AI copilot: a Claude tool-use loop whose tools edit the project's shared Yjs
// document directly, so every collaborator sees the copilot's changes live.
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import {
  addComponent,
  addTrace,
  addVia,
  appendChat,
  attachNet,
  autoPlace,
  autoRoute,
  clearRouting,
  connect,
  deleteComponent,
  describeDesign,
  disconnectPin,
  findByRef,
  freeSchematicSpot,
  getDesign,
  getPart,
  runDrc,
  runErc,
  searchParts,
  setBoard,
  updateComponent,
  type Rotation,
} from "@pcbian/core";
import * as Y from "yjs";
import { z } from "zod";
import type { Room } from "./rooms.js";
import { projectFile } from "./store.js";

const MODEL = process.env.PCBIAN_MODEL || "claude-opus-5-5";
const MAX_TOOL_ROUNDS = 25;

export const copilotEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const SYSTEM_PROMPT = `You are the PCBian copilot, an expert electronics engineer embedded in a collaborative browser-based schematic and PCB editor. Several engineers may be watching the same project while you work; every tool call you make edits the shared design immediately.

How the design works:
- Parts come from a built-in library; find them with search_parts and add them with add_component using the part id. Each component gets a reference designator (R1, U1...).
- Pins are addressed as REF.pin, where pin is the pin number or pin name (e.g. "R1.1", "U1.VCC", "U2.PB5/SCK" or "U2.17"). Prefer pin numbers when a name is ambiguous (e.g. ICs with several GND pins).
- Wires connect two pins. Power and ground nets are made with attach_net, which drops a power symbol (GND, +3V3, +5V, VBUS...) next to a pin; every symbol with the same net name is the same net. Use attach_net for any rail or signal shared by many pins instead of daisy-chaining wires.
- Schematic coordinates are in grid units (10 = one grid step, y grows downward). PCB coordinates are millimetres with the origin at the board's top-left corner, y grows downward.
- New parts are staged left of the board on the PCB. auto_place packs them onto the board and auto_route routes the remaining ratsnest on two layers.

Working style:
- Call get_design first whenever you need the current state; collaborators may have changed it since your last turn.
- Follow sound engineering practice: decoupling capacitors next to every IC supply pin, pull-ups/pull-downs where needed, current-limiting resistors for LEDs, correct regulator input/output capacitors, and sensible component values. Briefly justify non-obvious values.
- After making a circuit, run run_checks and fix ERC errors you introduced.
- Only route or rearrange the PCB when the user asks for layout work.
- Keep replies short and concrete: say what you changed and anything the user must decide. Use plain text with simple Markdown lists; no tables.`;

// ---------- tools ----------

const pinSpec = z.string().describe('Pin as REF.pin, e.g. "R1.2" or "U1.VCC"');
const rotation = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);

interface ToolDef<S extends z.ZodObject> {
  description: string;
  schema: S;
  run: (doc: Y.Doc, input: z.infer<S>) => string | object;
  label: (input: z.infer<S>) => string;
}
const tool = <S extends z.ZodObject>(t: ToolDef<S>) => t;

const TOOLS = {
  get_design: tool({
    description: "Return the full current design: components with pins, nets, routing stats, ERC and DRC results.",
    schema: z.object({}),
    run: (doc) => describeDesign(getDesign(doc)),
    label: () => "Read design",
  }),
  search_parts: tool({
    description: "Search the parts library by keywords (e.g. 'ldo 3.3v', 'mosfet', 'led'). Returns part ids, descriptions and pins.",
    schema: z.object({ query: z.string() }),
    run: (_doc, { query }) =>
      searchParts(query, 8).map((p) => ({
        part_id: p.id,
        name: p.name,
        description: p.description,
        default_value: p.defaultValue,
        footprint: p.footprint?.name ?? null,
        pins: p.symbol.pins.map((pin) => `${pin.id}=${pin.name}`).join(", "),
      })),
    label: ({ query }) => `Search parts "${query}"`,
  }),
  add_component: tool({
    description: "Add a part to the schematic. Omit x/y to auto-place it in a free spot. Returns the new reference designator and its pins.",
    schema: z.object({
      part_id: z.string(),
      value: z.string().optional().describe("Component value, e.g. 10k, 100nF, Red"),
      x: z.number().optional(),
      y: z.number().optional(),
      rotation: rotation.optional(),
    }),
    run: (doc, { part_id, value, x, y, rotation }) => {
      const at = x !== undefined && y !== undefined ? { x: Math.round(x / 10) * 10, y: Math.round(y / 10) * 10 } : freeSchematicSpot(doc);
      const c = addComponent(doc, part_id, at, { value, rot: rotation as Rotation | undefined });
      const part = getPart(part_id)!;
      return { ref: c.ref, value: c.value, at, pins: part.symbol.pins.map((p) => `${p.id}=${p.name}`).join(", ") };
    },
    label: ({ part_id, value }) => `Add ${part_id}${value ? ` (${value})` : ""}`,
  }),
  connect: tool({
    description: "Draw wires between pairs of pins.",
    schema: z.object({ connections: z.array(z.object({ from: pinSpec, to: pinSpec })).min(1) }),
    run: (doc, { connections }) => {
      const results = connections.map(({ from, to }) => {
        try {
          connect(doc, from, to);
          return `${from} -> ${to}: ok`;
        } catch (e) {
          return `${from} -> ${to}: ERROR ${(e as Error).message}`;
        }
      });
      return results.join("\n");
    },
    label: ({ connections }) => `Wire ${connections.map((c) => `${c.from}→${c.to}`).join(", ")}`,
  }),
  attach_net: tool({
    description: "Connect pins to a named power/ground net (GND, +3V3, +5V, VBUS, ...) by placing a power symbol next to each pin.",
    schema: z.object({ net: z.string(), pins: z.array(pinSpec).min(1) }),
    run: (doc, { net, pins }) =>
      pins
        .map((p) => {
          try {
            attachNet(doc, p, net);
            return `${p}: ok`;
          } catch (e) {
            return `${p}: ERROR ${(e as Error).message}`;
          }
        })
        .join("\n"),
    label: ({ net, pins }) => `Attach ${pins.join(", ")} to ${net}`,
  }),
  disconnect_pin: tool({
    description: "Remove every wire attached to a pin.",
    schema: z.object({ pin: pinSpec }),
    run: (doc, { pin }) => `Removed ${disconnectPin(doc, pin)} wire(s)`,
    label: ({ pin }) => `Disconnect ${pin}`,
  }),
  update_component: tool({
    description: "Change a component's value, reference, or schematic position/rotation.",
    schema: z.object({
      ref: z.string(),
      value: z.string().optional(),
      new_ref: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      rotation: rotation.optional(),
    }),
    run: (doc, { ref, value, new_ref, x, y, rotation }) => {
      const c = findByRef(doc, ref);
      if (!c) throw new Error(`No component ${ref}`);
      updateComponent(doc, c.id, {
        ...(value !== undefined && { value }),
        ...(new_ref !== undefined && { ref: new_ref }),
        sch: { x: x ?? c.sch.x, y: y ?? c.sch.y, rot: (rotation ?? c.sch.rot) as Rotation },
      });
      return "ok";
    },
    label: ({ ref }) => `Update ${ref}`,
  }),
  delete_component: tool({
    description: "Delete a component and its wires.",
    schema: z.object({ ref: z.string() }),
    run: (doc, { ref }) => {
      const c = findByRef(doc, ref);
      if (!c) throw new Error(`No component ${ref}`);
      deleteComponent(doc, c.id);
      return "deleted";
    },
    label: ({ ref }) => `Delete ${ref}`,
  }),
  set_board: tool({
    description: "Change board size (mm) and design rules.",
    schema: z.object({ width: z.number().positive().optional(), height: z.number().positive().optional(), clearance: z.number().positive().optional(), trace_width: z.number().positive().optional() }),
    run: (doc, { width, height, clearance, trace_width }) => {
      setBoard(doc, { ...(width && { width }), ...(height && { height }), ...(clearance && { clearance }), ...(trace_width && { defaultTraceWidth: trace_width }) });
      return "ok";
    },
    label: () => "Update board settings",
  }),
  place_pcb: tool({
    description: "Move a footprint on the PCB (mm from board top-left).",
    schema: z.object({ ref: z.string(), x: z.number(), y: z.number(), rotation: rotation.optional(), side: z.enum(["top", "bottom"]).optional() }),
    run: (doc, { ref, x, y, rotation, side }) => {
      const c = findByRef(doc, ref);
      if (!c) throw new Error(`No component ${ref}`);
      updateComponent(doc, c.id, { pcb: { x, y, rot: (rotation ?? c.pcb.rot) as Rotation, side: side ?? c.pcb.side } });
      return "ok";
    },
    label: ({ ref, x, y }) => `Place ${ref} at ${x},${y}mm`,
  }),
  auto_place: tool({
    description: "Automatically pack all footprints onto the board.",
    schema: z.object({}),
    run: (doc) => {
      const { placements, fits } = autoPlace(getDesign(doc));
      for (const [id, pcb] of placements) updateComponent(doc, id, { pcb });
      return fits ? "All parts placed on the board." : "Parts placed, but they do not all fit; consider enlarging the board with set_board.";
    },
    label: () => "Auto-place footprints",
  }),
  auto_route: tool({
    description: "Auto-route all unrouted connections on two layers (keeps existing traces).",
    schema: z.object({ trace_width: z.number().positive().optional() }),
    run: (doc, { trace_width }) => {
      const r = autoRoute(getDesign(doc), { width: trace_width });
      for (const t of r.traces) addTrace(doc, t);
      for (const v of r.vias) addVia(doc, v);
      return `Routed ${r.routed} connection(s), ${r.vias.length} via(s). ${r.failed.length ? `Failed: ${r.failed.map((f) => f.net).join(", ")}` : "No failures."}`;
    },
    label: () => "Auto-route board",
  }),
  clear_routing: tool({
    description: "Delete all traces and vias.",
    schema: z.object({}),
    run: (doc) => {
      clearRouting(doc);
      return "cleared";
    },
    label: () => "Clear routing",
  }),
  run_checks: tool({
    description: "Run the electrical rules check (schematic) and design rules check (PCB).",
    schema: z.object({}),
    run: (doc) => {
      const d = getDesign(doc);
      return { erc: runErc(d).map((i) => `[${i.severity}] ${i.message}`), drc: runDrc(d).map((i) => `[${i.severity}] ${i.message}`) };
    },
    label: () => "Run ERC + DRC",
  }),
};

type ToolName = keyof typeof TOOLS;

const toolParams: Anthropic.Beta.BetaTool[] = Object.entries(TOOLS).map(([name, t]) => {
  const { $schema: _, ...schema } = z.toJSONSchema(t.schema) as Record<string, unknown>;
  return {
    name,
    description: t.description,
    input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
    eager_input_streaming: true,
  };
});

// ---------- conversation state ----------

const histories = new Map<string, Anthropic.Beta.BetaMessageParam[]>();
const busy = new Set<string>();

function loadHistory(id: string): Anthropic.Beta.BetaMessageParam[] {
  let h = histories.get(id);
  if (!h) {
    try {
      h = JSON.parse(fs.readFileSync(projectFile(id, "chat.json"), "utf8"));
    } catch {
      h = [];
    }
    histories.set(id, h!);
  }
  return h!;
}

function saveHistory(id: string) {
  const file = projectFile(id, "chat.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(histories.get(id) ?? []));
}

export function resetCopilot(room: Room) {
  histories.set(room.id, []);
  saveHistory(room.id);
  room.doc.transact(() => {
    const chat = room.doc.getArray("chat");
    chat.delete(0, chat.length);
  }, "copilot");
}

export const isBusy = (id: string) => busy.has(id);

let client: Anthropic | null = null;

/** Run one copilot turn. Output streams into the shared chat log in the Yjs doc. */
export async function runCopilot(room: Room, message: string, author: string) {
  if (busy.has(room.id)) throw new Error("The copilot is already working on this project");
  busy.add(room.id);
  const doc = room.doc;
  const history = loadHistory(room.id);
  appendChat(doc, "user", author, message);
  const entry = appendChat(doc, "assistant", "Copilot", "", "streaming");
  const text = entry.get("text") as Y.Text;
  const tools = entry.get("tools") as Y.Array<string>;

  let pending = "";
  let flushTimer: NodeJS.Timeout | null = null;
  const flush = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    if (!pending) return;
    const chunk = pending;
    pending = "";
    doc.transact(() => text.insert(text.length, chunk), "copilot");
  };
  const write = (delta: string) => {
    pending += delta;
    if (!flushTimer) flushTimer = setTimeout(flush, 80);
  };

  // Persist the user turn right away so the history stays append-only even if the run fails.
  history.push({ role: "user", content: `[${author}]: ${message}` });
  saveHistory(room.id);

  try {
    client ??= new Anthropic();
    let jsonRetries = 0;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 32000,
        system: SYSTEM_PROMPT,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        tools: toolParams,
        messages: history,
      });
      let wroteText = false;
      stream.on("text", (delta) => {
        if (!wroteText && text.length + pending.length > 0) write("\n\n");
        wroteText = true;
        write(delta);
      });

      let msg: Anthropic.Beta.BetaMessage;
      try {
        msg = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        // With eager input streaming, an unparseable tool input surfaces as a non-API error: re-issue the turn.
        if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
        continue;
      }

      if (msg.stop_reason === "refusal") {
        write("\n\nI can't help with that request.");
        break;
      }
      history.push({ role: "assistant", content: msg.content as Anthropic.Beta.BetaContentBlockParam[] });
      if (msg.stop_reason === "pause_turn") continue;
      const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (uses.length === 0) break;
      if (msg.stop_reason === "max_tokens") {
        // A tool input cut off at max_tokens may parse as a truncated object; don't run it.
        history.push({ role: "user", content: uses.map((u) => ({ type: "tool_result" as const, tool_use_id: u.id, is_error: true, content: "Output was truncated; please retry with a smaller step." })) });
        continue;
      }

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const use of uses) {
        const def = TOOLS[use.name as ToolName] as ToolDef<z.ZodObject> | undefined;
        if (!def) {
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: `Unknown tool ${use.name}` });
          continue;
        }
        const parsed = def.schema.safeParse(use.input);
        if (!parsed.success) {
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: `Invalid input: ${parsed.error.message}` });
          continue;
        }
        try {
          let out: string | object = "";
          doc.transact(() => {
            out = def.run(doc, parsed.data);
          }, "copilot");
          doc.transact(() => tools.push([def.label(parsed.data)]), "copilot");
          results.push({ type: "tool_result", tool_use_id: use.id, content: typeof out === "string" ? out : JSON.stringify(out, null, 1) });
        } catch (e) {
          doc.transact(() => tools.push([`⚠ ${def.label(parsed.data)}`]), "copilot");
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: (e as Error).message });
        }
      }
      history.push({ role: "user", content: results });
      saveHistory(room.id);
    }
    flush();
    doc.transact(() => entry.set("status", "done"), "copilot");
  } catch (err) {
    flush();
    const msg = err instanceof Anthropic.AuthenticationError ? "The Anthropic API key is missing or invalid. Set ANTHROPIC_API_KEY on the server." : err instanceof Anthropic.RateLimitError ? "Rate limited by the Anthropic API; try again shortly." : `Copilot error: ${(err as Error).message}`;
    console.error("[copilot]", err);
    doc.transact(() => {
      text.insert(text.length, `${text.length ? "\n\n" : ""}${msg}`);
      entry.set("status", "error");
    }, "copilot");
    // Keep history valid for the next turn: it must not end on an assistant tool_use without results.
    const last = history[history.length - 1];
    if (last?.role === "assistant" && Array.isArray(last.content) && last.content.some((b) => b.type === "tool_use")) {
      history.push({ role: "user", content: last.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use").map((b) => ({ type: "tool_result" as const, tool_use_id: b.id, is_error: true, content: "Run aborted." })) });
    }
  } finally {
    saveHistory(room.id);
    busy.delete(room.id);
  }
}
