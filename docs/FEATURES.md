# PCBian feature inventory (KiCad and Altium Designer)

This lists the capabilities of **KiCad 8** and **Altium Designer 24** and where PCBian stands on each. The **AI** column shows whether the copilot can do it on its own through a tool.

Legend: ✅ available · 🟡 partial / basic version · ⏳ planned (phase noted) · — not applicable

## 1. Projects, collaboration and data management

| Feature | KiCad | Altium | PCBian | AI | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| Project management (create, rename, delete, templates) | ✅ | ✅ | ✅ | — | Dashboard with 3 starter templates |
| Real-time multi-user editing | ❌ | 🟡 (A365) | ✅ | ✅ | Yjs CRDT, live cursors, presence, shared selection |
| Per-user undo / redo | ✅ | ✅ | ✅ | — | Only undoes your own edits |
| Comments / review markup on the design | ❌ | ✅ | ⏳ P3 | ⏳ | |
| Version history, diff, branching | 🟡 (git) | ✅ | ⏳ P3 | ⏳ | Yjs snapshots planned |
| Accounts, teams, permissions | — | ✅ | ⏳ P3 | — | Today anyone with the link can edit |
| Design variants (fitted / not fitted) | ✅ | ✅ | ✅ | ✅ | Named variants with not-fitted parts and value overrides; BOM, 3D, simulation and exports follow the active one |
| Release / approval workflow | ❌ | ✅ | ⏳ P4 | — | |

## 2. Schematic capture

| Feature | KiCad | Altium | PCBian | AI | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| Place, move, rotate, duplicate, delete symbols | ✅ | ✅ | ✅ | ✅ | |
| Mirror symbols | ✅ | ✅ | ✅ | ✅ | M key; text stays readable |
| Wires with orthogonal routing, junctions | ✅ | ✅ | ✅ | ✅ | |
| Power symbols / global power nets | ✅ | ✅ | ✅ | ✅ | Rails named +5V, +3V3, VBUS… |
| Net labels (local/global/hierarchical) | ✅ | ✅ | ✅ | ✅ | KiCad-style scopes and net names (/net, /Sheet/net) |
| Multi-sheet schematics | ✅ | ✅ | ✅ | ✅ | Sheet tabs; nets join across sheets by name |
| Hierarchical sheets / sheet symbols / repeated channels | ✅ | ✅ | 🟡 | ✅ | Sheet symbols with pins from hierarchical labels; double-click to open. Reused sheets are imported from KiCad as one sheet per instance; native repeated channels ⏳ P3 |
| Buses and bus entries | ✅ | ✅ | 🟡 | ✅ | Bus wires with D[0..7] / {SDA SCL} names; members connect through labels (no bus-entry graphics) |
| No-connect flags | ✅ | ✅ | ✅ | ✅ | |
| Annotation (auto-numbering) | ✅ | ✅ | ✅ | ✅ | |
| Back/forward annotation with PCB | ✅ | ✅ | ✅ | ✅ | Single shared model: always in sync |
| Net highlighting / net navigator | ✅ | ✅ | 🟡 | ✅ | Click a wire to highlight its net |
| Text, graphics, title block | ✅ | ✅ | ✅ | ✅ | Notes, sheet frame and editable title block |
| Pin electrical types + full ERC matrix | ✅ | ✅ | ✅ | ✅ | Pin types: shorted outputs, undriven inputs and power, open-collector conflicts; also hierarchy recursion and sheet reuse |
| Schematic PDF/SVG export | ✅ | ✅ | 🟡 | ✅ | PDF with one page per sheet and title block; SVG ⏳ P3 |
| Find & replace, cross-probing | ✅ | ✅ | 🟡 | ✅ | Clicking a check issue jumps to the part in either view |

## 3. Libraries and parts

| Feature | KiCad | Altium | PCBian | AI | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| Built-in symbol + footprint library | ✅ (huge) | ✅ (huge) | 🟡 | ✅ | About 30 curated parts with parametric footprints |
| Parametric footprint generators (chip, SOIC, DIP, QFP, SOT, headers) | ✅ (wizards) | ✅ (IPC wizard) | ✅ | ✅ | |
| Create new parts (symbol + footprint) | ✅ | ✅ | ✅ | ✅ | Pin-list + package builder; the copilot creates parts from datasheet pinouts |
| Graphical symbol editor | ✅ | ✅ | 🟡 | ✅ | Pin table (number, name, side, type) with live preview; no free-hand body drawing yet |
| Graphical footprint editor | ✅ | ✅ | ✅ | ✅ | Drag pads on a 0.05mm grid, SMD/THT pads, generate from package, auto silkscreen and courtyard |
| Import KiCad symbols/footprints (.kicad_sym/.kicad_mod) | ✅ | ✅ | ✅ | — | Matched by pin number; works with SnapEDA/Ultra Librarian KiCad downloads |
| Import whole KiCad libraries / projects | ✅ | ✅ | ✅ | — | Projects: every .kicad_sch sheet plus the .kicad_pcb (see Interoperability) |
| Supplier data (stock, price, lifecycle) | 🟡 (plugins) | ✅ | ⏳ P3 | ⏳ | Needs a distributor API (Octopart/DigiKey) |
| 3D models per footprint (STEP/WRL) | ✅ | ✅ | 🟡 | — | Generated block models; STEP import ⏳ P3 |

## 4. PCB layout

| Feature | KiCad | Altium | PCBian | AI | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| Board outline (rectangle) | ✅ | ✅ | ✅ | ✅ | |
| Arbitrary outlines, cutouts, slots | ✅ | ✅ | ✅ | ✅ | Polygon outline, rounded corners, internal cutouts; used by DRC, pours, router, Gerber and 3D |
| Layer stack: 2 / 4 copper layers | ✅ | ✅ | ✅ | ✅ | |
| 6–32 layers, stackup manager, impedance | ✅ | ✅ | ⏳ P3 | ⏳ | |
| Footprint placement, rotate, flip to bottom | ✅ | ✅ | ✅ | ✅ | |
| Auto-placement | ❌ | 🟡 | ✅ | ✅ | Connectivity-aware: connectors on edges, decoupling caps by their IC, wirelength-driven; shelf packer still available |
| Ratsnest | ✅ | ✅ | ✅ | — | |
| Interactive routing, 45° snapping | ✅ | ✅ | ✅ | ✅ | |
| Push-and-shove routing | ✅ | ✅ | ⏳ P3 | — | |
| Layer switching with automatic vias | ✅ | ✅ | ✅ | ✅ | |
| Through vias | ✅ | ✅ | ✅ | ✅ | |
| Blind / buried / micro vias | ✅ | ✅ | ⏳ P3 | ⏳ | |
| Copper pours / zones with clearance | ✅ | ✅ | ✅ | ✅ | Thermal-relief spokes or solid pad connection, configurable gap and spoke width |
| Island removal, hatched fills, zone priority | ✅ | ✅ | 🟡 | ✅ | Isolated islands removed; hatched fills and zone priority ⏳ P3 |
| Auto-router | ❌ (Freerouting) | ✅ | ✅ | ✅ | Multi-layer A* on a clearance distance field, net-class aware, fine-pitch aware, neck-down |
| Net classes (width, clearance, via size) | ✅ | ✅ | ✅ | ✅ | |
| Differential pairs | ✅ | ✅ | ⏳ P3 | ⏳ | |
| Length tuning / matching (meanders) | ✅ | ✅ | ⏳ P3 | ⏳ | |
| Teardrops | ✅ | ✅ | ✅ | ✅ | Pads and vias, on in board settings; in Gerbers |
| Keepout areas | ✅ | ✅ | ✅ | ✅ | Per-layer: no tracks, vias or pours; router, pours and DRC obey them |
| Silkscreen editing (text, graphics) | ✅ | ✅ | 🟡 | — | Reference designators auto-generated |
| Measurement, dimensions | ✅ | ✅ | ✅ | — | Live measure tool; dimensions saved on the board |
| Panelization | 🟡 (plugin) | ✅ | ⏳ P4 | ⏳ | |

## 5. Verification

| Feature | KiCad | Altium | PCBian | AI | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| ERC | ✅ | ✅ | ✅ | ✅ | |
| DRC: clearance, shorts, unrouted, outline, courtyard | ✅ | ✅ | ✅ | ✅ | Net-class aware |
| DRC: annular ring, drill size, layer misuse | ✅ | ✅ | ✅ | ✅ | |
| DRC: silk-to-pad, mask slivers, acid traps | ✅ | ✅ | ✅ | ✅ | Also keepout, edge clearance and parts overhanging the edge |
| Custom rule language | ✅ | ✅ | ⏳ P3 | ⏳ | |
| Live DRC while editing | 🟡 | ✅ | ✅ | — | Markers update as you edit |

## 6. Simulation and analysis

| Feature | KiCad | Altium | PCBian | AI | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| DC operating point | ✅ (ngspice) | ✅ | ✅ | ✅ | MNA + Newton with source and gain stepping; rails from net names or simulation sources |
| Transient / AC / sweep analysis | ✅ | ✅ | 🟡 | ✅ | Transient (from power-on, PULSE/SIN sources) and AC (gain/phase, -3dB) with charts and probes; parameter sweeps ⏳ P3 |
| SPICE model import, transistor/IC models | ✅ | ✅ | 🟡 | ✅ | Built-in models: NPN (Ebers-Moll), N-MOSFET (level 1), LM358, NE555, AMS1117; SPICE model import ⏳ P3 |
| Design checks from simulation (LED current, resistor power, fuse rating) | ❌ | 🟡 | ✅ | ✅ | |
| Signal / power integrity | ❌ | ✅ (add-on) | ⏳ P4 | ⏳ | |
| Thermal analysis | ❌ | 🟡 | ⏳ P4 | ⏳ | |

## 7. Manufacturing outputs

| Feature | KiCad | Altium | PCBian | AI | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| Gerber RS-274X (copper, mask, paste, silk, outline) | ✅ | ✅ | ✅ | ✅ | Inner layers and pours included |
| Excellon drill | ✅ | ✅ | ✅ | ✅ | |
| BOM (CSV) | ✅ | ✅ | ✅ | ✅ | DNP excluded |
| Pick-and-place / centroid | ✅ | ✅ | ✅ | ✅ | |
| Fabrication notes | 🟡 | ✅ | ✅ | ✅ | |
| ODB++ / IPC-2581 | ✅ | ✅ | ⏳ P3 | ⏳ | |
| Assembly drawings / PDF prints | ✅ | ✅ | ✅ | ✅ | Top and bottom assembly PDF; included in the fabrication zip |
| STEP / VRML 3D export | ✅ | ✅ | ⏳ P3 | ⏳ | |
| Fab readiness check | ❌ | 🟡 | ✅ | ✅ | |

## 8. 3D

| Feature | KiCad | Altium | PCBian | AI | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| 3D board viewer | ✅ | ✅ | ✅ | — | three.js: shaped board with cutouts, copper, pours, vias, holes, bodies |
| Realistic per-part 3D models | ✅ | ✅ | 🟡 | — | Package-based block models |
| MCAD collaboration (STEP in/out, enclosure fit) | 🟡 | ✅ | ⏳ P4 | ⏳ | |

## 9. Interoperability

| Feature | KiCad | Altium | PCBian | AI | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| Export KiCad board (.kicad_pcb) | ✅ | 🟡 | ✅ | ✅ | Footprints, tracks, vias, zones, outline, nets |
| Export KiCad netlist (.net) | ✅ | 🟡 | ✅ | ✅ | |
| Import KiCad parts | ✅ | ✅ | ✅ | — | |
| Import KiCad board / schematic | ✅ | ✅ | ✅ | — | KiCad 6–9: hierarchy (incl. reused sheets), labels, multi-unit parts, footprints, tracks, zones, keepouts, outline. On KiCad's complex_hierarchy demo every pad's net matches KiCad's |
| Altium / Eagle import | 🟡 | ✅ | ⏳ P3 | ⏳ | |

## 10. AI copilot (beyond KiCad / Altium)

| Capability | PCBian |
| --- | --- |
| Autonomous spec → schematic → layout → routed, DRC-clean board | ✅ |
| Creates missing parts from datasheet pinouts | ✅ |
| Multi-sheet and hierarchical organisation, label scopes, buses, notes, title block | ✅ |
| Board setup: size, outline, cutouts, layer count, net classes, thermal pours, keepouts, teardrops | ✅ |
| Placement (auto + targeted), routing (auto, per-net, manual traces, vias) | ✅ |
| Self-verification loop: ERC, DRC, DC/transient/AC simulation, fabrication readiness | ✅ |
| Assembly variants | ✅ |
| Shared live conversation, Stop button | ✅ |

## Roadmap

- **Phase 2 (done):** hierarchical sheets, buses, local/hierarchical labels, pin-type ERC matrix, graphical symbol/footprint editors, KiCad board/schematic import, thermal reliefs, island removal, keepouts, teardrops, arbitrary board outlines, transient/AC simulation with transistor models, schematic and assembly PDF export, connectivity-aware auto-placement.
- **Phase 3:** native repeated channels, hatched zones and priority, parameter sweeps and SPICE model import, free-hand symbol drawing, schematic SVG, differential pairs, length tuning, push-and-shove, 6+ layers with stackup/impedance, blind/buried vias, STEP export/import, ODB++/IPC-2581, supplier pricing/stock, version history, comments, accounts.
- **Phase 4:** signal/power integrity, thermal, panelization, MCAD co-design, release workflows.
