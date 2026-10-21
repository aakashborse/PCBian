# PCBian

PCBian is a browser-based, AI-assisted, real-time collaborative PCB design tool. You draw a schematic, lay out and route a board of up to 32 layers, check and analyse it, and release fabrication files, with a Claude-powered copilot that can read and edit the design alongside you.

It is an original implementation inspired by the *category* of tools like Flux.ai. No code, assets or branding were taken from any other product (see [docs/REA-NOTES.md](docs/REA-NOTES.md)).

## Features

The full KiCad/Altium comparison, with status and roadmap, is in [docs/FEATURES.md](docs/FEATURES.md).

- **Schematic**: parts library with search, hierarchical sheets with sheet symbols, repeated channels (a template sheet with synced copies), multi-unit parts placed unit by unit, global/local/hierarchical labels, buses, mirror, click-to-wire, power symbols, notes, sheet frame and title block, no-connect flags, annotation, assembly variants, net highlighting.
- **Parts**: parametric footprints (chip, SOIC, DIP, QFP, SOT, headers, mounting holes, fiducials…), a pin-list part builder, a part editor (pin table with pin types, free-hand symbol drawing, drag-and-drop footprint pads, a STEP model per footprint), KiCad `.kicad_sym` + `.kicad_mod` import, and live Mouser stock, price and lifecycle in the BOM.
- **PCB**: 2–32 layer boards with a dielectric stackup, closed-form and field-solved impedance, blind/buried/micro vias, polygon or rounded outlines and cutouts, parts at any angle, interactive routing with 45° snapping and layer switching (automatic vias), copper pours (solid or hatched, with priority) with thermal reliefs and island removal, differential pairs, length tuning with meanders, push-and-shove for traces and vias, keepouts, teardrops, measure and dimensions, net classes, a custom rule language, footprints on either side, and layout replication for repeated channels.
- **Auto-place and auto-route**: connectivity-aware placement (connectors on edges, decoupling caps by their IC) and a multi-layer A* router that routes differential pairs coupled and can use blind vias on a clearance distance field. It handles net classes, adapts its grid to fine-pitch parts and narrows wide traces at small pads.
- **Checks**: ERC (pin-type conflicts such as shorted outputs and undriven inputs, unconnected pins, single-pin nets, no-connect misuse, duplicate refs, hierarchy) and DRC (shorts, net-class and custom-rule clearance, unrouted nets, outline and edge clearance, keepouts, courtyards, layers, via drill/annular ring, trace widths, silk over pads, mask slivers, acid traps, pour-to-pour shorts).
- **Simulation**: DC operating point, transient, AC, DC sweeps and parameter steps with charts (R, C, L, diodes/LEDs, BJTs, MOSFETs, LM358, NE555, AMS1117; imported SPICE .model cards and .subckt macromodels with controlled sources; DC/PULSE/SIN/AC sources or supplies from rail names), with LED-current, resistor-power and fuse warnings.
- **Analysis**: signal integrity (impedance along each route, delay, reference-plane gaps, crosstalk), power integrity (DC IR drop through traces, vias and pours; trace current capacity; decoupling placement) and a steady-state board temperature map.
- **3D and MCAD**: three.js shaped board with copper, pours, vias, holes and uploaded STEP models (or package-shaped bodies); an enclosure generator (base and lid, standoffs, connector openings) exported as STEP with the board inside.
- **Manufacturing and interop**: Gerber RS-274X for every copper layer, mask, paste and silkscreen, Excellon drill, BOM (optionally priced), pick-and-place, fab notes with the stackup, schematic PDF/SVG and assembly PDF, STEP assembly, IPC-2581, ODB++, KiCad `.kicad_pcb` and netlist export, panelization (tabs and mouse bites or V-score, rails, fiducials); import of KiCad projects, EAGLE schematics and boards, and Altium `.SchDoc` schematics and `.PcbDoc` boards. Independent checkers in `tools/fabcheck` verify Gerber/drill and ODB++ outputs against the design.
- **Releases**: a release stamps the revision, freezes the whole manufacturing package with its check results, and is approved or rejected by named reviewers.
- **Autonomous AI copilot**: Claude can do everything in the editor through 63 tools. Given a spec, it plans, creates missing parts, draws a hierarchical schematic, simulates (DC, transient, AC, subcircuits), sets up layers and net classes, places, pours, routes and repeats until ERC/DRC are clean, reviews signal/power integrity and thermals, then checks release readiness. Everyone sees it work live, and it can be stopped at any time.
- **Real-time collaboration**: Yjs CRDT over WebSockets, live cursors, presence, per-user undo/redo, review comments pinned on the design, and version history with diffs, restore and branching.

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
| `PCBIAN_DATA_DIR` | Where projects, uploaded models and releases are stored (default `./data`) |
| `MOUSER_API_KEY` | Live stock, price and lifecycle in the BOM panel |

To run it on a server with Docker and automatic backups, see [deploy/README.md](deploy/README.md).

## Using the editor

**Schematic**: pick a part in the left library and click to place it (Shift+click places several). Click a pin to start a wire, click empty space to add corners, click another pin to finish. Drag the background to pan, scroll to zoom.

**Schematic sheets** are tabs along the bottom (+ adds, double-click renames). Put a child sheet inside another with **Sheet symbol…**; its pins are the child's hierarchical labels, and double-clicking it opens the child. **Label…** places global, local or hierarchical labels; **Bus** and **Text** draw buses and notes. **No-connect** (Q) toggles flags on pins; **Annotate** renumbers references. Select a part and use **Edit part…** in the Inspector to change its pins or footprint.

**PCB**: footprints start to the left of the board; drag them on or press **Auto-place**. Press **X** (Route), click a pad, click to add corners, click the destination pad. **L** cycles the active layer (dropping a via mid-route). **P** (Pour) draws a copper-pour outline, or use **Fill board**; **K** draws a keepout and **M** measures (two clicks leave a dimension). **Outline…** draws a custom board outline or a cutout (double-click or Enter closes a polygon). Layer count, thickness and net classes are in the Inspector when nothing is selected. **Auto-route** routes everything left in the ratsnest.

Differential pairs, length groups, the stackup and impedance calculator are in the Inspector when nothing is selected; select a trace to see its impedance and tune its net length. Turn on **Shove** in the route tool to push other traces aside. **Comment** pins a review note (mention @copilot to hand it to the AI); the **Review** and **History** tabs list threads and versions.

**3D** shows the assembled board. The **Sim** tab shows the DC operating point live and runs transient and AC analyses with probe charts. **Import a design** on the dashboard takes KiCad (`.kicad_sch` sheets + `.kicad_pcb`), EAGLE (`.sch` + `.brd`) or Altium (`.PcbDoc`) files.

| Key | Schematic | PCB |
| --- | --- | --- |
| `R` | Rotate selection | Rotate footprint |
| `M` | Mirror selection | Measure tool |
| `K` | | Keepout tool |
| `F` | Zoom to fit | Flip footprint side (or fit when nothing is selected) |
| `Del` / `Backspace` | Delete part or wire | Delete trace or via |
| `Ctrl+D` | Duplicate part | |
| `X` / `V` / `S` / `P` | | Route / via / select / pour tool |
| `Q` | Toggle no-connect tool | |
| `L` | | Cycle active layer |
| `Esc` | Cancel wire / placement | Finish route / back to select |
| `Ctrl+Z`, `Ctrl+Shift+Z` | Undo / redo your own edits | same |

**Repeated channels**: on a sheet's tab, ⧉ repeats it as channels (CH2, CH3…). Edit the template sheet; the channel sheets follow (they are read-only, or **Detach** one to edit it on its own). In the PCB, place one part of each channel and use **Replicate layout** in the Inspector to copy the template's placement and routing. **Multi-unit parts** (dual op-amps, logic gates) show a Units row in the Inspector; each unit moves and rotates on its own.

**Part editor**: the Symbol tab's **Draw** mode draws the body (lines, polygons, rectangles, circles, text) and places pins by hand; the Footprint tab takes a **STEP model** (offset and rotation) for the 3D view and STEP export.

**Analysis** (right panel) runs signal integrity, IR drop and decoupling, and thermal analysis. The stackup card's **Field-solve** buttons compute impedance (and widths for a target) with the 2D solver. The **BOM** tab looks up stock, prices and lifecycle at a build quantity (needs `MOUSER_API_KEY`).

**Export** also offers **Panel…** (array, tabs or V-score, rails; live preview and zip) and **Enclosure…** (base and lid STEP; can be shown in the 3D view). **History** holds releases: **Request release…** freezes the package and asks the named approvers, who approve or reject it there.

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

The whole design lives in a single Yjs document (`components`, `wires`, `traces`, `vias`, `zones`, `keepouts`, `schGraphics`, `pcbGraphics`, `parts`, `comments`, `meta`, `chat`); version snapshots are stored next to it on the server. The web client, the server and the copilot all mutate it through the same helpers in `packages/core/src/doc.ts` and `edit.ts`, which is why AI edits and human edits merge and sync the same way.

The copilot (`apps/server/src/copilot.ts`) runs a streaming manual tool loop against the Claude Messages API with adaptive thinking and server-side refusal fallbacks. Tool inputs are validated with zod before they touch the document, and the conversation history is persisted per project.

## Development

```bash
npm test          # vitest: netlist and hierarchy, channels and units, routing (pairs, blind vias, tuning, shove), pours, DRC/ERC and rules, simulation and subcircuits, field solver, SI/PI/thermal, panels, enclosures, releases, KiCad/EAGLE/Altium import, PDFs, STEP/IPC-2581/ODB++, history
npm run typecheck
npm run fabcheck -- out/board data/projects/<id>.ydoc   # independent Gerber/drill and ODB++ checks (tools/fabcheck/README.md)
npx tsx tools/loadtest/collab.ts --url http://localhost:8787 --clients 20   # multi-user convergence test
```

## Current limitations

See [docs/FEATURES.md](docs/FEATURES.md) for the full list. The main gaps compared with KiCad/Altium: no accounts or permissions (anyone with a project link can edit it, and release approvers are identified by display name); behavioural SPICE sources (B elements, VALUE/TABLE expressions) are not simulated; the built-in library is small (import KiCad parts for more); ODB++ output follows the published format and passes the independent checker but has not been opened in a commercial CAM viewer; panel tabs follow the board's bounding box, so shaped boards may need their tabs checked; analyses are first-order engineering models (quasi-static field solver, DC IR drop, steady-state 2D thermal), not full-wave or CFD tools.
