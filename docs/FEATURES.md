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
| Design variants (fitted / not fitted) | ✅ | ✅ | 🟡 | ✅ | DNP flag per part; full variant sets ⏳ P2 |
| Release / approval workflow | ❌ | ✅ | ⏳ P4 | — | |

## 2. Schematic capture

| Feature | KiCad | Altium | PCBian | AI | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| Place, move, rotate, duplicate, delete symbols | ✅ | ✅ | ✅ | ✅ | |
| Mirror symbols | ✅ | ✅ | ⏳ P2 | ⏳ | |
| Wires with orthogonal routing, junctions | ✅ | ✅ | ✅ | ✅ | |
| Power symbols / global power nets | ✅ | ✅ | ✅ | ✅ | Rails named +5V, +3V3, VBUS… |
| Net labels (local/global) | ✅ | ✅ | 🟡 | ✅ | All labels are global; local/hierarchical label scopes ⏳ P2 |
| Multi-sheet schematics | ✅ | ✅ | ✅ | ✅ | Sheet tabs; nets join across sheets by name |
| Hierarchical sheets / sheet symbols / repeated channels | ✅ | ✅ | ⏳ P2 | ⏳ | |
| Buses and bus entries | ✅ | ✅ | ⏳ P2 | ⏳ | |
| No-connect flags | ✅ | ✅ | ✅ | ✅ | |
| Annotation (auto-numbering) | ✅ | ✅ | ✅ | ✅ | |
| Back/forward annotation with PCB | ✅ | ✅ | ✅ | ✅ | Single shared model: always in sync |
| Net highlighting / net navigator | ✅ | ✅ | 🟡 | ✅ | Click a wire to highlight its net |
| Text, graphics, title block | ✅ | ✅ | ⏳ P2 | ⏳ | |
| Pin electrical types + full ERC matrix | ✅ | ✅ | 🟡 | ✅ | ERC: unconnected pins, single-pin nets, NC misuse, duplicate refs, orphan sheets. Pin-type matrix ⏳ P2 |
| Schematic PDF/SVG export | ✅ | ✅ | ⏳ P2 | ⏳ | |
| Find & replace, cross-probing | ✅ | ✅ | 🟡 | ✅ | Clicking a check issue jumps to the part in either view |

## 3. Libraries and parts

| Feature | KiCad | Altium | PCBian | AI | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| Built-in symbol + footprint library | ✅ (huge) | ✅ (huge) | 🟡 | ✅ | About 30 curated parts with parametric footprints |
| Parametric footprint generators (chip, SOIC, DIP, QFP, SOT, headers) | ✅ (wizards) | ✅ (IPC wizard) | ✅ | ✅ | |
| Create new parts (symbol + footprint) | ✅ | ✅ | ✅ | ✅ | Pin-list + package builder; the copilot creates parts from datasheet pinouts |
| Graphical symbol editor | ✅ | ✅ | ⏳ P2 | — | |
| Graphical footprint editor | ✅ | ✅ | ⏳ P2 | — | |
| Import KiCad symbols/footprints (.kicad_sym/.kicad_mod) | ✅ | ✅ | ✅ | — | Matched by pin number; works with SnapEDA/Ultra Librarian KiCad downloads |
| Import whole KiCad libraries / projects | ✅ | ✅ | ⏳ P2 | ⏳ | |
| Supplier data (stock, price, lifecycle) | 🟡 (plugins) | ✅ | ⏳ P3 | ⏳ | Needs a distributor API (Octopart/DigiKey) |
| 3D models per footprint (STEP/WRL) | ✅ | ✅ | 🟡 | — | Generated block models; STEP import ⏳ P3 |

## 4. PCB layout

| Feature | KiCad | Altium | PCBian | AI | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| Board outline (rectangle) | ✅ | ✅ | ✅ | ✅ | |
| Arbitrary outlines, cutouts, slots | ✅ | ✅ | ⏳ P2 | ⏳ | |
| Layer stack: 2 / 4 copper layers | ✅ | ✅ | ✅ | ✅ | |
| 6–32 layers, stackup manager, impedance | ✅ | ✅ | ⏳ P3 | ⏳ | |
| Footprint placement, rotate, flip to bottom | ✅ | ✅ | ✅ | ✅ | |
| Auto-placement | ❌ | 🟡 | 🟡 | ✅ | Shelf packer; connectivity-aware placement ⏳ P2 |
| Ratsnest | ✅ | ✅ | ✅ | — | |
| Interactive routing, 45° snapping | ✅ | ✅ | ✅ | ✅ | |
| Push-and-shove routing | ✅ | ✅ | ⏳ P3 | — | |
| Layer switching with automatic vias | ✅ | ✅ | ✅ | ✅ | |
| Through vias | ✅ | ✅ | ✅ | ✅ | |
| Blind / buried / micro vias | ✅ | ✅ | ⏳ P3 | ⏳ | |
| Copper pours / zones with clearance | ✅ | ✅ | ✅ | ✅ | Solid connection; thermal reliefs ⏳ P2 |
| Island removal, hatched fills, zone priority | ✅ | ✅ | ⏳ P2 | ⏳ | |
| Auto-router | ❌ (Freerouting) | ✅ | ✅ | ✅ | Multi-layer A* on a clearance distance field, net-class aware, fine-pitch aware, neck-down |
| Net classes (width, clearance, via size) | ✅ | ✅ | ✅ | ✅ | |
| Differential pairs | ✅ | ✅ | ⏳ P3 | ⏳ | |
| Length tuning / matching (meanders) | ✅ | ✅ | ⏳ P3 | ⏳ | |
| Teardrops | ✅ | ✅ | ⏳ P2 | ⏳ | |
| Keepout areas | ✅ | ✅ | ⏳ P2 | ⏳ | |
| Silkscreen editing (text, graphics) | ✅ | ✅ | 🟡 | — | Reference designators auto-generated |
| Measurement, dimensions | ✅ | ✅ | ⏳ P2 | — | |
| Panelization | 🟡 (plugin) | ✅ | ⏳ P4 | ⏳ | |

## 5. Verification

| Feature | KiCad | Altium | PCBian | AI | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| ERC | ✅ | ✅ | ✅ | ✅ | |
| DRC: clearance, shorts, unrouted, outline, courtyard | ✅ | ✅ | ✅ | ✅ | Net-class aware |
| DRC: annular ring, drill size, layer misuse | ✅ | ✅ | ✅ | ✅ | |
| DRC: silk-to-pad, mask slivers, acid traps | ✅ | ✅ | ⏳ P2 | ⏳ | |
| Custom rule language | ✅ | ✅ | ⏳ P3 | ⏳ | |
| Live DRC while editing | 🟡 | ✅ | ✅ | — | Markers update as you edit |

## 6. Simulation and analysis

| Feature | KiCad | Altium | PCBian | AI | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| DC operating point | ✅ (ngspice) | ✅ | ✅ | ✅ | MNA + Newton; R, LED, diode, fuse, ferrite/inductor, LDO; rails from net names |
| Transient / AC / sweep analysis | ✅ | ✅ | ⏳ P2 | ⏳ | |
| SPICE model import, transistor/IC models | ✅ | ✅ | ⏳ P2 | ⏳ | |
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
| Assembly drawings / PDF prints | ✅ | ✅ | ⏳ P2 | ⏳ | |
| STEP / VRML 3D export | ✅ | ✅ | ⏳ P3 | ⏳ | |
| Fab readiness check | ❌ | 🟡 | ✅ | ✅ | |

## 8. 3D

| Feature | KiCad | Altium | PCBian | AI | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| 3D board viewer | ✅ | ✅ | ✅ | — | three.js: board, copper, pours, vias, holes, bodies |
| Realistic per-part 3D models | ✅ | ✅ | 🟡 | — | Package-based block models |
| MCAD collaboration (STEP in/out, enclosure fit) | 🟡 | ✅ | ⏳ P4 | ⏳ | |

## 9. Interoperability

| Feature | KiCad | Altium | PCBian | AI | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| Export KiCad board (.kicad_pcb) | ✅ | 🟡 | ✅ | ✅ | Footprints, tracks, vias, zones, outline, nets |
| Export KiCad netlist (.net) | ✅ | 🟡 | ✅ | ✅ | |
| Import KiCad parts | ✅ | ✅ | ✅ | — | |
| Import KiCad board / schematic | ✅ | ✅ | ⏳ P2 | ⏳ | |
| Altium / Eagle import | 🟡 | ✅ | ⏳ P3 | ⏳ | |

## 10. AI copilot (beyond KiCad / Altium)

| Capability | PCBian |
| --- | --- |
| Autonomous spec → schematic → layout → routed, DRC-clean board | ✅ |
| Creates missing parts from datasheet pinouts | ✅ |
| Multi-sheet organisation, no-connects, annotation | ✅ |
| Board setup: size, layer count, net classes, pours | ✅ |
| Placement (auto + targeted), routing (auto, per-net, manual traces, vias) | ✅ |
| Self-verification loop: ERC, DRC, DC simulation, fabrication readiness | ✅ |
| Shared live conversation, Stop button | ✅ |

## Roadmap

- **Phase 2:** hierarchical sheets, buses, local/hierarchical labels, pin-type ERC matrix, graphical symbol/footprint editors, KiCad board/schematic import, thermal reliefs, island removal, keepouts, teardrops, arbitrary board outlines, transient/AC simulation with transistor models, schematic and assembly PDF export, connectivity-aware auto-placement.
- **Phase 3:** differential pairs, length tuning, push-and-shove, 6+ layers with stackup/impedance, blind/buried vias, STEP export/import, ODB++/IPC-2581, supplier pricing/stock, version history, comments, accounts.
- **Phase 4:** signal/power integrity, thermal, panelization, MCAD co-design, release workflows.
