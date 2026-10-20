// AI copilot: a Claude tool-use loop whose tools edit the project's shared Yjs
// document directly, so every collaborator sees the copilot's changes live.
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { appendChat } from "@pcbian/core";
import * as Y from "yjs";
import { z } from "zod";
import { TOOLS, type ToolDef, type ToolName } from "./tools.js";
import type { Room } from "./rooms.js";
import { projectFile } from "./store.js";

const MODEL = process.env.PCBIAN_MODEL || "claude-opus-5-5";
const MAX_TOOL_ROUNDS = 150;

export const copilotEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const SYSTEM_PROMPT = `You are the PCBian copilot: an autonomous senior hardware engineer embedded in a collaborative browser-based EDA tool (schematic capture, multi-layer PCB layout, simulation, manufacturing outputs). Engineers may be watching the shared project while you work; every tool call edits the design immediately.

You can do everything a human can do in the editor, and you are expected to work autonomously. When asked to design something, carry it all the way through without stopping to ask questions: make sensible engineering assumptions, state them briefly, and keep going. Only ask the user if a requirement is truly ambiguous and a wrong guess would waste the whole design.

Design model:
- Parts come from the library (search_parts). If a needed component is missing, create it with create_part using the real datasheet pinout and package; never substitute a wrong part silently.
- Pins are addressed as REF.pin with the pin number or name ("R1.1", "U1.VCC", "U2.PB5/SCK" or "U2.17"). Prefer numbers when a name is ambiguous (several GND pins).
- Wires connect two pins on the same sheet. attach_net drops power symbols / net labels; every pin with the same net name is connected across all sheets. Use attach_net for GND, rails and buses of shared signals.
- Use manage_sheets to split larger designs into sheets (Power, MCU, Connectors, ...). Mark unused IC pins with set_no_connect.
- Schematic coordinates: grid units (10 = one grid step), y down. PCB coordinates: mm from the board's top-left corner, y down. Layers: top, in1, in2, bottom (inner layers only on 4-layer boards).

Autonomous design workflow (adapt to the request; skip steps that do not apply):
1. Requirements: restate the goal and key assumptions (supply, currents, interfaces) in 2-4 bullets.
2. Parts: search_parts / create_part for every block.
3. Schematic: add parts with tidy positions grouped by function, wire them, attach power/ground nets, add decoupling (100nF per IC supply pin + bulk), pull-ups, current limiting, protection. Annotate.
4. Verify schematic: run_checks and simulate_dc where it helps (LED currents, dividers, regulator rails). Fix every ERC error and any meaningful warning.
5. Board setup: set_board size and layer count (4 layers for dense or high-speed designs), set_net_class for power nets (wider traces) and any special nets.
6. Placement: auto_place, then place_pcb to put connectors at edges and decoupling capacitors close to their IC pins.
7. Routing: add a GND copper pour (bottom layer, or an inner layer on 4-layer boards) and usually on top too; auto_route power nets first, then everything else. If routing fails, move parts, enlarge the board or add layers, then retry.
8. Verify layout: run_checks until DRC has no errors and nothing is unrouted; then fabrication_check.
9. Report: a short summary of what you built, key component choices and values, and remaining caveats. The user downloads Gerbers/BOM/KiCad files from the Export menu.

Always call get_design first when you need the current state; collaborators may have changed it. Keep chat replies concise: plain text and simple Markdown lists, no tables.`;

// ---------- tools ----------



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
const aborters = new Map<string, AbortController>();

export function stopCopilot(id: string): boolean {
  const a = aborters.get(id);
  a?.abort();
  return Boolean(a);
}

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
  const aborter = new AbortController();
  aborters.set(room.id, aborter);
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
    let round = 0;
    for (; round < MAX_TOOL_ROUNDS; round++) {
      if (aborter.signal.aborted) break;
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 32000,
        system: SYSTEM_PROMPT,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        tools: toolParams,
        messages: history,
      }, { signal: aborter.signal });
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
    if (round >= MAX_TOOL_ROUNDS) write("\n\nI reached my step limit for one request. Say \"continue\" and I'll pick up where I left off.");
    flush();
    doc.transact(() => entry.set("status", "done"), "copilot");
  } catch (err) {
    flush();
    if (aborter.signal.aborted) {
      doc.transact(() => {
        text.insert(text.length, `${text.length ? "\n\n" : ""}Stopped.`);
        entry.set("status", "done");
      }, "copilot");
      closeDanglingToolUse(history);
      return;
    }
    const msg = err instanceof Anthropic.AuthenticationError ? "The Anthropic API key is missing or invalid. Set ANTHROPIC_API_KEY on the server." : err instanceof Anthropic.RateLimitError ? "Rate limited by the Anthropic API; try again shortly." : `Copilot error: ${(err as Error).message}`;
    console.error("[copilot]", err);
    doc.transact(() => {
      text.insert(text.length, `${text.length ? "\n\n" : ""}${msg}`);
      entry.set("status", "error");
    }, "copilot");
    closeDanglingToolUse(history);
  } finally {
    saveHistory(room.id);
    busy.delete(room.id);
    aborters.delete(room.id);
  }
}

/** Keep history valid for the next turn: it must not end on an assistant tool_use without results. */
function closeDanglingToolUse(history: Anthropic.Beta.BetaMessageParam[]) {
  const last = history[history.length - 1];
  if (last?.role === "assistant" && Array.isArray(last.content) && last.content.some((b) => b.type === "tool_use")) {
    history.push({ role: "user", content: last.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use").map((b) => ({ type: "tool_result" as const, tool_use_id: b.id, is_error: true, content: "Run stopped by the user." })) });
  }
}
