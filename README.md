# PCBian

PCBian is a browser-based, AI-assisted, real-time collaborative PCB design tool. You draw a schematic, lay out and route a two-layer board, check it, and export fabrication files, with a Claude-powered copilot that can read and edit the design alongside you.

It is an original implementation inspired by the *category* of tools like Flux.ai. No code, assets or branding were taken from any other product (see [docs/REA-NOTES.md](docs/REA-NOTES.md)).

## Features

- **Schematic editor**: parts library with search, place/move/rotate/duplicate, click-to-wire with orthogonal routing, power symbols and net labels, net highlighting, live netlist.
- **PCB editor**: footprints generated from the same parts, ratsnest, interactive routing with 45° snapping and layer switching (auto via), vias, top/bottom placement, layer visibility.
- **Auto-place and auto-route**: shelf-packing placer and a two-layer A* grid router with clearance-aware obstacle maps and vias.
- **Checks**: ERC (unconnected pins, single-pin nets, duplicate references) and DRC (shorts, clearance, unrouted nets, board outline, courtyard overlap, trace width), clickable to jump to the problem.
- **AI copilot**: chat with Claude, which uses tools to search parts, add components, wire pins, attach power nets, place/route the board and run checks. Its edits land in the shared document, so every collaborator watches it work, and the conversation itself is shared.
- **Real-time collaboration**: Yjs CRDT document synced over WebSockets; live cursors, presence avatars, remote selection outlines; per-user undo/redo.
- **Exports**: Gerber RS-274X (copper, mask, silkscreen, outline) + Excellon drill as a fabrication ZIP, BOM CSV, pick-and-place CSV, netlist, project JSON.
- **Starter templates**: blank board, 555 LED blinker, USB-C 3.3 V supply.

## Quick start

Requires Node.js 22+.

```bash
npm install
cp .env.example .env          # then put your key in ANTHROPIC_API_KEY
npm run dev                   # server on :8787, web app on http://localhost:5173
```

Production build (the server also serves the built web app):

```bash
npm run build
npm start                     # http://localhost:8787
```

Everything except the copilot works without an API key. Projects are stored under `./data` (override with `PCBIAN_DATA_DIR`).

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Enables the AI copilot |
| `PCBIAN_MODEL` | Copilot model (default `claude-opus-5-5`) |
| `PORT` | Server port (default `8787`) |
| `PCBIAN_DATA_DIR` | Where projects are stored (default `./data`) |

## Using the editor

**Schematic**: pick a part in the left library and click to place it (Shift+click places several). Click a pin to start a wire, click empty space to add corners, click another pin to finish. Drag the background to pan, scroll to zoom.

**PCB**: footprints start to the left of the board; drag them on or press **Auto-place**. Press **X** (Route), click a pad, click to add corners, click the destination pad. **L** switches layer (dropping a via mid-route). **Auto-route** routes everything left in the ratsnest.

| Key | Schematic | PCB |
| --- | --- | --- |
| `R` | Rotate selection | Rotate footprint |
| `F` | Zoom to fit | Flip footprint side (or fit when nothing is selected) |
| `Del` / `Backspace` | Delete part or wire | Delete trace or via |
| `Ctrl+D` | Duplicate part | |
| `X` / `V` / `S` | | Route / via / select tool |
| `L` | | Switch active layer |
| `Esc` | Cancel wire / placement | Finish route / back to select |
| `Ctrl+Z`, `Ctrl+Shift+Z` | Undo / redo your own edits | same |

Share a project by copying its URL (the **Share** button); everyone with the link edits the same live document.

## Architecture

```
packages/core   Design model, parts library + footprints, netlist, copper
                connectivity, ratsnest, ERC/DRC, auto-place, auto-router,
                Gerber/Excellon/BOM export, Yjs document helpers. Pure TS, shared
                by the server and the browser.
apps/server     Express + ws. One Y.Doc per project synced with the standard
                y-websocket protocol and persisted to disk; REST API for projects;
                the copilot agent loop (Anthropic SDK, streaming tool use).
apps/web        React + Vite. Dashboard, SVG schematic and PCB canvases, library,
                inspector, checks and copilot panels, presence.
```

The whole design lives in a single Yjs document (`components`, `wires`, `traces`, `vias`, `meta`, `chat`). The web client, the server and the copilot all mutate it through the same helpers in `packages/core/src/doc.ts` and `edit.ts`, which is why AI edits and human edits merge and sync the same way.

The copilot (`apps/server/src/copilot.ts`) runs a streaming manual tool loop against the Claude Messages API with adaptive thinking and server-side refusal fallbacks. Tool inputs are validated with zod before they touch the document, and the conversation history is persisted per project.

## Development

```bash
npm test          # vitest: netlist, auto-place/route + DRC, shorts, exports, pin resolution
npm run typecheck
```

## Current limitations

Compared with a mature commercial tool, this first version has a small built-in parts library (about 30 parts, no external part search), two copper layers, no copper pours/zones, no 3D viewer, no user accounts or permissions (anyone with a project link can edit it), and a grid router that is good for simple boards but not dense ones.
