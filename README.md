# PCBian

PCBian is a browser-based, AI-assisted, real-time collaborative PCB design tool. You draw a schematic, lay out and route a two-layer board, check it, and export fabrication files, with a Claude-powered copilot that can read and edit the design alongside you.

It is an original implementation inspired by the *category* of tools like Flux.ai. No code, assets or branding were taken from any other product (see [docs/REA-NOTES.md](docs/REA-NOTES.md)).

## Features

The full KiCad/Altium comparison, with status and roadmap, is in [docs/FEATURES.md](docs/FEATURES.md).

- **Schematic**: parts library with search, multi-sheet schematics (nets join across sheets by name), click-to-wire, power symbols and net labels, no-connect flags, annotation, DNP flags, net highlighting.
- **Parts**: parametric footprints (chip, SOIC, DIP, QFP, SOT, headers…), a pin-list part builder, and KiCad `.kicad_sym` + `.kicad_mod` import.
- **PCB**: 2- or 4-layer boards, interactive routing with 45° snapping and layer switching (automatic vias), copper pours with automatic clearance, net classes (width, clearance, via size), footprints on either side.
- **Auto-place and auto-route**: a multi-layer A* router on a clearance distance field. It handles net classes, adapts its grid to fine-pitch parts and narrows wide traces at small pads.
- **Checks**: ERC (unconnected pins, single-pin nets, no-connect misuse, duplicate refs) and DRC (shorts, net-class clearance, unrouted nets, outline, courtyards, layers, via drill/annular ring, trace widths).
- **Simulation**: DC operating point (resistors, LEDs, diodes, fuses, inductors, LDO regulators; supplies from rail names), with LED-current, resistor-power and fuse warnings.
- **3D viewer**: three.js board with copper, pours, vias, holes and package-shaped component bodies.
- **Manufacturing and interop**: Gerber RS-274X for every copper layer (pours as regions), mask, paste and silkscreen with reference text, Excellon drill, BOM, pick-and-place, fab notes, KiCad `.kicad_pcb` and KiCad netlist export.
- **Autonomous AI copilot**: Claude can do everything in the editor through about 30 tools. Given a spec, it plans, creates missing parts, draws the schematic across sheets, simulates, sets up layers and net classes, places, pours, routes and repeats until ERC/DRC are clean, then runs a fabrication-readiness check. Everyone sees it work live, and it can be stopped at any time.
- **Real-time collaboration**: Yjs CRDT over WebSockets, live cursors, presence, per-user undo/redo.

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

**Schematic sheets** are tabs along the bottom (+ adds, double-click renames). **No-connect** (Q) toggles flags on pins; **Annotate** renumbers references.

**PCB**: footprints start to the left of the board; drag them on or press **Auto-place**. Press **X** (Route), click a pad, click to add corners, click the destination pad. **L** cycles the active layer (dropping a via mid-route). **P** (Pour) draws a copper-pour outline, or use **Fill board**. Layer count, thickness and net classes are in the Inspector when nothing is selected. **Auto-route** routes everything left in the ratsnest.

**3D** shows the assembled board; the **Sim** tab shows the DC operating point live.

| Key | Schematic | PCB |
| --- | --- | --- |
| `R` | Rotate selection | Rotate footprint |
| `F` | Zoom to fit | Flip footprint side (or fit when nothing is selected) |
| `Del` / `Backspace` | Delete part or wire | Delete trace or via |
| `Ctrl+D` | Duplicate part | |
| `X` / `V` / `S` / `P` | | Route / via / select / pour tool |
| `Q` | Toggle no-connect tool | |
| `L` | | Cycle active layer |
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
npm test          # vitest: netlist, routing (2/4 layers, net classes), pours, DRC/ERC, simulation, KiCad I/O, part builder
npm run typecheck
```

## Current limitations

See [docs/FEATURES.md](docs/FEATURES.md) for the full list and roadmap. The main gaps compared with KiCad/Altium: no hierarchical sheet symbols or buses yet, no graphical symbol/footprint editors (parts come from the builder or KiCad import), at most 4 copper layers, no differential pairs, length tuning or push-and-shove, DC-only simulation, block-shaped 3D models with no STEP export, no KiCad board/schematic import, and no accounts (anyone with a project link can edit it).
