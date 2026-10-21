# PCBian feature inventory (KiCad and Altium Designer)

This lists the capabilities of **KiCad 8** and **Altium Designer 24** and where PCBian stands on each. The **AI** column shows whether the copilot can do it on its own through a tool.

Legend: ✅ available · 🟡 partial / basic version · ⏳ planned (phase noted) · — not applicable

## 1. Projects, collaboration and data management

| Feature | KiCad | Altium | PCBian | AI | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| Project management (create, rename, delete, templates) | ✅ | ✅ | ✅ | — | Dashboard with 3 starter templates |
| Real-time multi-user editing | ❌ | 🟡 (A365) | ✅ | ✅ | Yjs CRDT, live cursors, presence, shared selection |
| Per-user undo / redo | ✅ | ✅ | ✅ | — | Only undoes your own edits |
| Comments / review markup on the design | ❌ | ✅ | ✅ | ✅ | Comments pinned on schematic or PCB, threads, resolve; mention @copilot to have the AI act and answer in the thread |
| Version history, diff, branching | 🟡 (git) | ✅ | ✅ | 🟡 | Named and automatic snapshots (every 10 min of editing and around each copilot run), change summary, restore (one undo step, Ctrl+Z reverts it), branch to a new project |
| Accounts, teams, permissions | — | ✅ | ⏳ | — | Deferred by choice; today anyone with the link can edit |
| Design variants (fitted / not fitted) | ✅ | ✅ | ✅ | ✅ | Named variants with not-fitted parts and value overrides; BOM, 3D, simulation and exports follow the active one |
| Release / approval workflow | ❌ | ✅ | ✅ | 🟡 | A release stamps the revision, saves a version, runs DRC/ERC/routing/BOM checks (failures need a recorded reason) and freezes the manufacturing package (Gerbers, drills, IPC-2581, ODB++, BOM, placement, PDFs, STEP); named approvers approve or reject; released packages are immutable. People are identified by display name (no accounts). The copilot reports release readiness; approval is for people |

## 2. Schematic capture

| Feature | KiCad | Altium | PCBian | AI | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| Place, move, rotate, duplicate, delete symbols | ✅ | ✅ | ✅ | ✅ | |
| Mirror symbols | ✅ | ✅ | ✅ | ✅ | M key; text stays readable |
| Wires with orthogonal routing, junctions | ✅ | ✅ | ✅ | ✅ | |
| Power symbols / global power nets | ✅ | ✅ | ✅ | ✅ | Rails named +5V, +3V3, VBUS… |
| Net labels (local/global/hierarchical) | ✅ | ✅ | ✅ | ✅ | KiCad-style scopes and net names (/net, /Sheet/net) |
| Multi-sheet schematics | ✅ | ✅ | ✅ | ✅ | Sheet tabs; nets join across sheets by name |
| Hierarchical sheets / sheet symbols / repeated channels | ✅ | ✅ | ✅ | ✅ | Sheet symbols with pins from hierarchical labels; double-click to open. A sheet can be repeated as channels (CH2, CH3…): synced copies with REF_CHn designators and per-channel ports, edits on the template reach every channel, layout replication copies placement and routing. Reused KiCad sheets and repeated Altium sheets import one sheet per instance |
| Buses and bus entries | ✅ | ✅ | 🟡 | ✅ | Bus wires with D[0..7] / {SDA SCL} names; members connect through labels (no bus-entry graphics) |
| No-connect flags | ✅ | ✅ | ✅ | ✅ | |
| Annotation (auto-numbering) | ✅ | ✅ | ✅ | ✅ | |
| Back/forward annotation with PCB | ✅ | ✅ | ✅ | ✅ | Single shared model: always in sync |
| Net highlighting / net navigator | ✅ | ✅ | 🟡 | ✅ | Click a wire to highlight its net |
| Text, graphics, title block | ✅ | ✅ | ✅ | ✅ | Notes, sheet frame and editable title block |
| Pin electrical types + full ERC matrix | ✅ | ✅ | ✅ | ✅ | Pin types: shorted outputs (several output pins of one part count as one driver), undriven inputs and power, open-collector conflicts; also hierarchy recursion and sheet reuse |
| Schematic PDF/SVG export | ✅ | ✅ | ✅ | ✅ | PDF (one page per sheet) and SVG per sheet, with title block |
| Find & replace, cross-probing | ✅ | ✅ | 🟡 | ✅ | Clicking a check issue jumps to the part in either view |

## 3. Libraries and parts

| Feature | KiCad | Altium | PCBian | AI | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| Built-in symbol + footprint library | ✅ (huge) | ✅ (huge) | 🟡 | ✅ | About 30 curated parts with parametric footprints |
| Parametric footprint generators (chip, SOIC, DIP, QFP, SOT, headers) | ✅ (wizards) | ✅ (IPC wizard) | ✅ | ✅ | |
| Create new parts (symbol + footprint) | ✅ | ✅ | ✅ | ✅ | Pin-list + package builder; the copilot creates parts from datasheet pinouts |
| Multi-unit parts (gates) | ✅ | ✅ | ✅ | ✅ | Each unit placed, rotated and moved on its own (any sheet); EAGLE gates, KiCad units and Altium part records import as units |
| Graphical symbol editor | ✅ | ✅ | ✅ | ✅ | Pin table (number, name, side, type) plus a drawing canvas: lines, polygons, rectangles, circles and text on a grid, pins placed and rotated by hand (tips on the connection grid), undo |
| Graphical footprint editor | ✅ | ✅ | ✅ | ✅ | Drag pads on a 0.05mm grid, SMD/THT pads, generate from package, auto silkscreen and courtyard |
| Import KiCad symbols/footprints (.kicad_sym/.kicad_mod) | ✅ | ✅ | ✅ | — | Matched by pin number; works with SnapEDA/Ultra Librarian KiCad downloads |
| Import whole KiCad libraries / projects | ✅ | ✅ | ✅ | — | Projects: every .kicad_sch sheet plus the .kicad_pcb (see Interoperability) |
| Supplier data (stock, price, lifecycle) | 🟡 (plugins) | ✅ | ✅ | ✅ | Mouser search API (MOUSER_API_KEY on the server, cached and rate limited): stock, lifecycle, price breaks at a build quantity, BOM cost, risks (stock, NRND/EOL), part search by value and package; priced BOM CSV |
| 3D models per footprint (STEP/WRL) | ✅ | ✅ | ✅ | — | Upload a STEP model per footprint with offset and rotation; shown in the 3D view (OpenCascade in the browser, colours kept) and placed in the STEP export assembly. Parts without one get a generated body |

## 4. PCB layout

| Feature | KiCad | Altium | PCBian | AI | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| Board outline (rectangle) | ✅ | ✅ | ✅ | ✅ | |
| Arbitrary outlines, cutouts, slots | ✅ | ✅ | ✅ | ✅ | Polygon outline, rounded corners, internal cutouts; used by DRC, pours, router, Gerber and 3D |
| Layer stack: 2 / 4 copper layers | ✅ | ✅ | ✅ | ✅ | |
| 6–32 layers, stackup manager, impedance | ✅ | ✅ | ✅ | ✅ | 2–32 layers; per-layer copper weight and dielectrics; IPC-2141 estimates and a 2D field solver (copper thickness, soldermask, each dielectric; Z0, εeff, odd/even/differential; width for a target), checked against exact stripline and Hammerstad-Jensen microstrip; impedance net classes |
| Footprint placement, rotate (any angle), flip to bottom | ✅ | ✅ | ✅ | ✅ | Angled pads exact in copper, DRC, router and every output |
| Auto-placement | ❌ | 🟡 | ✅ | ✅ | Connectivity-aware: connectors on edges, decoupling caps by their IC, wirelength-driven; shelf packer still available |
| Ratsnest | ✅ | ✅ | ✅ | — | |
| Interactive routing, 45° snapping | ✅ | ✅ | ✅ | ✅ | |
| Push-and-shove routing | ✅ | ✅ | ✅ | ✅ | Traces are bumped aside around traces, vias and pads (trying the other side when a pad blocks); vias of other nets move and their traces follow; new vias and dragged vias shove too; pads never move, crossings are refused |
| Layer switching with automatic vias | ✅ | ✅ | ✅ | ✅ | |
| Through vias | ✅ | ✅ | ✅ | ✅ | |
| Blind / buried / micro vias | ✅ | ✅ | ✅ | ✅ | Via spans in the editor, router (blind_vias), DRC, per-span drill files, KiCad I/O |
| Copper pours / zones with clearance | ✅ | ✅ | ✅ | ✅ | Exact polygon fills (Clipper): thermal-relief spokes or solid pad connection, configurable gap and spoke width; pour-to-pour shorts checked |
| Island removal, hatched fills, zone priority | ✅ | ✅ | ✅ | ✅ | Hatched fills keep solid copper around pads; higher-priority pours cut lower ones |
| Auto-router | ❌ (Freerouting) | ✅ | ✅ | ✅ | Multi-layer A* on a clearance distance field, net-class aware, fine-pitch aware, neck-down |
| Net classes (width, clearance, via size) | ✅ | ✅ | ✅ | ✅ | |
| Differential pairs | ✅ | ✅ | ✅ | ✅ | Pairs from net names or by hand; coupled auto-routing at the pair gap; gap solved from target Zdiff; skew and gap checks |
| Length tuning / matching (meanders) | ✅ | ✅ | ✅ | ✅ | Serpentines with clearance checks; length groups and pair skew matching |
| Teardrops | ✅ | ✅ | ✅ | ✅ | Pads and vias, on in board settings; in Gerbers |
| Keepout areas | ✅ | ✅ | ✅ | ✅ | Per-layer: no tracks, vias or pours; router, pours and DRC obey them |
| Silkscreen editing (text, graphics) | ✅ | ✅ | 🟡 | — | Reference designators auto-generated |
| Measurement, dimensions | ✅ | ✅ | ✅ | — | Live measure tool; dimensions saved on the board |
| Panelization | 🟡 (plugin) | ✅ | ✅ | ✅ | Arrays with routed gaps, breakaway tabs and mouse bites, or V-score; rails with fiducials and tooling holes; live preview; panel Gerbers, drills, NPTH and V-score layers |

## 5. Verification

| Feature | KiCad | Altium | PCBian | AI | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| ERC | ✅ | ✅ | ✅ | ✅ | |
| DRC: clearance, shorts, unrouted, outline, courtyard | ✅ | ✅ | ✅ | ✅ | Net-class aware |
| DRC: annular ring, drill size, layer misuse | ✅ | ✅ | ✅ | ✅ | |
| DRC: silk-to-pad, mask slivers, acid traps | ✅ | ✅ | ✅ | ✅ | Also keepout, edge clearance and parts overhanging the edge |
| Custom rule language | ✅ | ✅ | ✅ | ✅ | KiCad-style `(rule … (condition "…") (constraint …))` on type, pad type, net, net class, layer, reference, footprint and named areas (insideArea/intersectsArea); Altium rules import into it |
| Live DRC while editing | 🟡 | ✅ | ✅ | — | Markers update as you edit |

## 6. Simulation and analysis

| Feature | KiCad | Altium | PCBian | AI | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| DC operating point | ✅ (ngspice) | ✅ | ✅ | ✅ | MNA + Newton with source and gain stepping; rails from net names or simulation sources |
| Transient / AC / sweep analysis | ✅ | ✅ | ✅ | ✅ | Transient (from power-on, PULSE/SIN sources) and AC (gain/phase, -3dB) with charts and probes; DC sweeps and parameter steps |
| SPICE model import, transistor/IC models | ✅ | ✅ | ✅ | ✅ | .model cards (D, NPN, PNP, NMOS, PMOS/VDMOS) and .subckt macromodels with R, C, L, V, I, D, Q, M, E, F, G, H and nested X elements, local models and linear POLY sources (behavioural B/VALUE sources are not supported); any part can use one through a pin map, dual op-amps per half. The uA741 Boyle model matches its datasheet (supply current, bias, gain, GBW, slew) |
| Design checks from simulation (LED current, resistor power, fuse rating) | ❌ | 🟡 | ✅ | ✅ | |
| Signal / power integrity | ❌ | ✅ (add-on) | ✅ | ✅ | SI: impedance along each route against its target, delay, vias, length over a reference-plane gap, coupled-length crosstalk for an edge rate. PI: DC IR drop through traces, via barrels and meshed pours from source to loads, IPC-2221 trace current capacity, decoupling-capacitor distance per IC power pin |
| Thermal analysis | ❌ | 🟡 | ✅ | ✅ | Steady-state board temperature map: laminate plus copper coverage per layer, convection from both faces, part power from the DC simulation or given; hottest board temperature under each part |

## 7. Manufacturing outputs

| Feature | KiCad | Altium | PCBian | AI | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| Gerber RS-274X (copper, mask, paste, silk, outline) | ✅ | ✅ | ✅ | ✅ | Inner layers and pours included |
| Excellon drill | ✅ | ✅ | ✅ | ✅ | |
| BOM (CSV) | ✅ | ✅ | ✅ | ✅ | DNP excluded |
| Pick-and-place / centroid | ✅ | ✅ | ✅ | ✅ | |
| Fabrication notes | 🟡 | ✅ | ✅ | ✅ | |
| ODB++ / IPC-2581 | ✅ | ✅ | ✅ | ✅ | IPC-2581 rev C validates against the official schema; ODB++ v8 job (zipped) following KiCad's exporter conventions, not checked in a commercial viewer |
| Assembly drawings / PDF prints | ✅ | ✅ | ✅ | ✅ | Top and bottom assembly PDF; included in the fabrication zip |
| STEP / VRML 3D export | ✅ | ✅ | ✅ | ✅ | STEP AP214 B-rep of the shaped board (holes, cutouts); parts as their uploaded STEP models (an assembly) or box bodies; validated with OpenCascade |
| Fab readiness check | ❌ | 🟡 | ✅ | ✅ | Plus independent checkers (tools/fabcheck: gerbonara for Gerber/Excellon, a separate ODB++ reader) that compare the outputs against the design's pads, nets and drills |

## 8. 3D

| Feature | KiCad | Altium | PCBian | AI | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| 3D board viewer | ✅ | ✅ | ✅ | — | three.js: shaped board with cutouts, copper, pours, vias, holes, bodies |
| Realistic per-part 3D models | ✅ | ✅ | ✅ | — | Uploaded STEP models; package-based block models otherwise |
| MCAD collaboration (STEP in/out, enclosure fit) | 🟡 | ✅ | ✅ | ✅ | STEP models in; enclosure design out: base and lid with standoffs at mounting holes, headroom over the tallest part and wall openings for edge connectors, as STEP with the board inside, shown in the 3D view |

## 9. Interoperability

| Feature | KiCad | Altium | PCBian | AI | Notes |
| --- | :-: | :-: | :-: | :-: | --- |
| Export KiCad board (.kicad_pcb) | ✅ | 🟡 | ✅ | ✅ | Footprints, tracks, vias, zones, outline, nets |
| Export KiCad netlist (.net) | ✅ | 🟡 | ✅ | ✅ | |
| Import KiCad parts | ✅ | ✅ | ✅ | — | |
| Import KiCad board / schematic | ✅ | ✅ | ✅ | — | KiCad 6–9: hierarchy (incl. reused sheets), labels, multi-unit parts, footprints, tracks, zones, keepouts, outline. On KiCad's complex_hierarchy demo every pad's net matches KiCad's |
| Altium / Eagle import | 🟡 | ✅ | ✅ | — | EAGLE .sch + .brd (exact nets on Adafruit's AHT20 board); Altium .PcbDoc boards (angled pads, tracks, arcs, vias, pours, planes and splits, regions, design rules) and .SchDoc schematics (multi-part parts, ports, sheet entries, repeated sheets): the eDP adapter's schematic and board nets agree exactly, and the HiFive, eDP and Fastino boards import DRC-clean |

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
| Stackup, impedance targets (field-solved), differential pairs, length matching, HDI vias, push-and-shove | ✅ |
| Repeated channels and layout replication, multi-unit parts | ✅ |
| Supplier lookups (stock, price, lifecycle) and part numbers | ✅ |
| Signal/power integrity, thermal, decoupling and release-readiness reviews | ✅ |
| Panel planning and enclosure design | ✅ |
| Answers review comments in their threads (@copilot), adds its own | ✅ |
| SPICE model and subcircuit import, DC sweeps and parameter steps | ✅ |
| Snapshot before/after each run, so its changes can be compared or rolled back | ✅ |
| Shared live conversation, Stop button | ✅ |

## Roadmap

- **Phase 2 (done):** hierarchical sheets, buses, local/hierarchical labels, pin-type ERC matrix, graphical symbol/footprint editors, KiCad board/schematic import, thermal reliefs, island removal, keepouts, teardrops, arbitrary board outlines, transient/AC simulation with transistor models, schematic and assembly PDF export, connectivity-aware auto-placement.
- **Phase 3 (done):** stackup/impedance, 6–32 layers, blind/buried/micro vias, differential pairs, length tuning, push-and-shove, version history, comments, STEP, IPC-2581, ODB++, schematic SVG, EAGLE and Altium board import, hatched pours and priority, SPICE model import, sweeps.
- **Phase 4 (done):** any-angle rotation, exact pours, Altium schematic import and board accuracy, custom rule language, independent fabrication checkers, Mouser supplier data, multi-unit parts, repeated channels, free-hand symbol drawing, STEP models per footprint, field-solver impedance, via push-and-shove, SPICE subcircuits, signal/power integrity, thermal analysis, panelization, enclosure design, release workflow; Docker deployment with backups and a collaboration load test.
- **Next:** accounts and permissions (release approvals would then use real identities), bus-entry graphics, behavioural SPICE sources, a larger built-in library.
