// Panelization: an array of boards in a frame for fabrication and assembly. The panel is itself a
// design (the board copied into place, the routed slots as cutouts, fiducials on the rails), so
// its Gerbers and drill files come from the ordinary exporters; mouse-bite and tooling holes go
// in a non-plated drill file, and V-score lines in their own layer.
import { boardOutline } from "./doc";
import { drillFiles, gerberFiles } from "./export";
import { difference, islands, polygon, union } from "./poly";
import type { ComponentData, Design, Vec } from "./types";

export interface PanelOptions {
  cols: number;
  rows: number;
  /** Routed gap between boards (and between boards and rails), mm; ignored for V-score. */
  gap?: number;
  /** Frame rail width (mm), on the sides listed in `rails`. */
  rail?: number;
  /** Which panel sides get a rail: top/bottom, left/right, all or none. */
  rails?: "tb" | "lr" | "all" | "none";
  /** How boards separate: tabs with mouse bites in routed gaps, or V-score lines (no gaps). */
  separation?: "tabs" | "vscore";
  /** Tab width along the board edge (mm). */
  tabWidth?: number;
  /** Tabs per board side (default by side length). */
  tabsPerSide?: number;
  mouseBites?: boolean;
  /** Three fiducials and four tooling holes on the rails. */
  fiducials?: boolean;
  toolingHoles?: boolean;
}

export interface Panel {
  design: Design;
  width: number;
  height: number;
  /** Top-left corner of each board copy. */
  boards: Vec[];
  tabs: Vec[][];
  /** Non-plated holes: mouse bites and tooling holes. */
  npth: { at: Vec; d: number }[];
  /** V-score lines (full panel width or height). */
  vscore: [Vec, Vec][];
  warnings: string[];
}

const rect = (x0: number, y0: number, x1: number, y1: number): Vec[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

export function panelize(design: Design, o: PanelOptions): Panel {
  const cols = Math.max(1, Math.floor(o.cols));
  const rows = Math.max(1, Math.floor(o.rows));
  const vscore = o.separation === "vscore";
  const gap = vscore ? 0 : (o.gap ?? 2);
  const railW = o.rail ?? 5;
  const rails = o.rails ?? "tb";
  const railT = rails === "tb" || rails === "all" ? railW : 0;
  const railL = rails === "lr" || rails === "all" ? railW : 0;
  const W = design.board.width;
  const H = design.board.height;
  // Rails sit one gap away from the boards (or touch them, for V-score).
  const offX = railL ? railL + gap : 0;
  const offY = railT ? railT + gap : 0;
  const PW = 2 * offX + cols * W + (cols - 1) * gap;
  const PH = 2 * offY + rows * H + (rows - 1) * gap;
  const warnings: string[] = [];
  const outline = boardOutline(design.board);
  const bb = { x0: Math.min(...outline.map((p) => p.x)), y0: Math.min(...outline.map((p) => p.y)), x1: Math.max(...outline.map((p) => p.x)), y1: Math.max(...outline.map((p) => p.y)) };
  if (outline.length !== 4 || bb.x0 > 0.01 || bb.y0 > 0.01 || bb.x1 < W - 0.01 || bb.y1 < H - 0.01) warnings.push("The board is not a plain rectangle: tabs are placed on its bounding box and may need checking");

  const boards: Vec[] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) boards.push({ x: offX + i * (W + gap), y: offY + j * (H + gap) });
  const move = (p: Vec, d: Vec) => ({ x: p.x + d.x, y: p.y + d.y });

  // Tabs bridge each board side that faces a gap to whatever is across it (a board or a rail).
  const tabs: Vec[][] = [];
  const npth: { at: Vec; d: number }[] = [];
  const tw = o.tabWidth ?? 3;
  if (!vscore && gap > 0) {
    const count = (len: number) => o.tabsPerSide ?? (len >= 60 ? 3 : len >= 25 ? 2 : 1);
    for (const b of boards) {
      const sides: { a: Vec; b: Vec; out: Vec; len: number }[] = [
        { a: { x: b.x, y: b.y }, b: { x: b.x + W, y: b.y }, out: { x: 0, y: -1 }, len: W },
        { a: { x: b.x, y: b.y + H }, b: { x: b.x + W, y: b.y + H }, out: { x: 0, y: 1 }, len: W },
        { a: { x: b.x, y: b.y }, b: { x: b.x, y: b.y + H }, out: { x: -1, y: 0 }, len: H },
        { a: { x: b.x + W, y: b.y }, b: { x: b.x + W, y: b.y + H }, out: { x: 1, y: 0 }, len: H },
      ];
      for (const s of sides) {
        // Is there something across the gap? A rail, or another board.
        const across = move({ x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 }, { x: s.out.x * (gap + 0.1), y: s.out.y * (gap + 0.1) });
        const onBoard = boards.some((q) => across.x > q.x && across.x < q.x + W && across.y > q.y && across.y < q.y + H);
        const onRail = across.y < railT || across.y > PH - railT || across.x < railL || across.x > PW - railL;
        const inside = across.x > 0 && across.x < PW && across.y > 0 && across.y < PH;
        if (!inside || !(onBoard || onRail)) continue;
        // Only one tab per shared gap between two boards: the board on the left/top places it.
        if (onBoard && (s.out.x < 0 || s.out.y < 0)) continue;
        const n = count(s.len);
        const along = { x: (s.b.x - s.a.x) / s.len, y: (s.b.y - s.a.y) / s.len };
        for (let k = 0; k < n; k++) {
          const c = move(s.a, { x: along.x * ((s.len * (k + 1)) / (n + 1)), y: along.y * ((s.len * (k + 1)) / (n + 1)) });
          const half = { x: (along.x * tw) / 2, y: (along.y * tw) / 2 };
          const far = { x: s.out.x * gap, y: s.out.y * gap };
          // Overlap the board and the far side slightly so the union has no slivers.
          const ov = { x: -s.out.x * 0.05, y: -s.out.y * 0.05 };
          const p0 = move(move(c, ov), { x: -half.x, y: -half.y });
          const p1 = move(move(c, ov), half);
          tabs.push([p0, p1, move(move(p1, far), { x: -ov.x * 2, y: -ov.y * 2 }), move(move(p0, far), { x: -ov.x * 2, y: -ov.y * 2 })]);
          if (o.mouseBites ?? true) {
            // A row of 0.5 mm holes on each edge the tab joins, slightly inside the board and the far
            // side, so the break leaves a clean edge.
            const holes = Math.max(3, Math.floor(tw / 0.75));
            for (const edge of [0, gap]) {
              const inset = edge === 0 ? -0.25 : 0.25;
              for (let h = 0; h < holes; h++) {
                const f = (h - (holes - 1) / 2) * 0.75;
                npth.push({ at: move(c, { x: along.x * f + s.out.x * (edge + inset), y: along.y * f + s.out.y * (edge + inset) }), d: 0.5 });
              }
            }
          }
        }
      }
    }
  }

  // The routed slots: everything inside the frame that is neither board nor tab nor rail.
  const frame = polygon(rect(0, 0, PW, PH));
  const solid = union(...boards.map((b) => polygon(outline.map((p) => move(p, b)))), ...tabs.map((t) => polygon(t)), ...(railT ? [polygon(rect(0, 0, PW, railT)), polygon(rect(0, PH - railT, PW, PH))] : []), ...(railL ? [polygon(rect(0, 0, railL, PH)), polygon(rect(PW - railL, 0, PW, PH))] : []));
  const slots = gap > 0 ? islands(difference(frame, solid)).map((isl) => isl[0]) : [];
  const cutouts = [...slots, ...boards.flatMap((b) => (design.board.cutouts ?? []).map((c) => c.map((p) => move(p, b))))];

  // Copies of the board's content, one per position.
  const copy = <T extends { id: string }>(xs: T[], f: (x: T, d: Vec, k: number) => T) => boards.flatMap((d, k) => xs.map((x) => f(x, d, k)));
  const components: ComponentData[] = copy(design.components, (c, d, k) => ({ ...c, id: `${c.id}@${k}`, pcb: { ...c.pcb, x: c.pcb.x + d.x, y: c.pcb.y + d.y } }));
  const idOf = (id: string, k: number) => `${id}@${k}`;
  const wires = boards.flatMap((_, k) => design.wires.map((w) => ({ ...w, id: `${w.id}@${k}`, a: { ...w.a, comp: idOf(w.a.comp, k) }, b: { ...w.b, comp: idOf(w.b.comp, k) } })));

  // Fiducials (copper dots with mask openings) and tooling holes on the rails.
  const extra: ComponentData[] = [];
  if (railT || railL) {
    const r = Math.max(railT, railL);
    const inset = r / 2;
    if (o.fiducials ?? true) {
      const spots = railT
        ? [{ x: inset + 5, y: railT / 2 }, { x: PW - inset - 5, y: railT / 2 }, { x: inset + 5, y: PH - railT / 2 }]
        : [{ x: railL / 2, y: inset + 5 }, { x: railL / 2, y: PH - inset - 5 }, { x: PW - railL / 2, y: inset + 5 }];
      spots.forEach((p, k) => extra.push({ id: `panel-fid-${k}`, partId: "fiducial", ref: `FID${k + 1}`, value: "Fiducial", sch: { x: 0, y: 0, rot: 0 }, pcb: { x: p.x, y: p.y, rot: 0, side: "top" } }, { id: `panel-fidb-${k}`, partId: "fiducial", ref: `FID${k + 4}`, value: "Fiducial", sch: { x: 0, y: 0, rot: 0 }, pcb: { x: p.x, y: p.y, rot: 0, side: "bottom" } }));
    }
    if ((o.toolingHoles ?? true) && r >= 4) {
      const d = Math.min(3, r - 1.5);
      const spots = railT
        ? [{ x: 2.5, y: railT / 2 }, { x: PW - 2.5, y: railT / 2 }, { x: 2.5, y: PH - railT / 2 }, { x: PW - 2.5, y: PH - railT / 2 }]
        : [{ x: railL / 2, y: 2.5 }, { x: railL / 2, y: PH - 2.5 }, { x: PW - railL / 2, y: 2.5 }, { x: PW - railL / 2, y: PH - 2.5 }];
      for (const p of spots) npth.push({ at: p, d });
    }
  } else if (o.fiducials ?? true) warnings.push("No rails: fiducials and tooling holes were left out (put fiducials on the board itself)");

  // V-score lines along every row and column boundary (and along the rails).
  const vs: [Vec, Vec][] = [];
  if (vscore) {
    for (let i = 0; i <= cols; i++) {
      const x = offX + i * W;
      if ((i === 0 || i === cols) && !railL) continue;
      vs.push([{ x, y: 0 }, { x, y: PH }]);
    }
    for (let j = 0; j <= rows; j++) {
      const y = offY + j * H;
      if ((j === 0 || j === rows) && !railT) continue;
      vs.push([{ x: 0, y }, { x: PW, y }]);
    }
  }

  const panel: Design = {
    ...design,
    name: `${design.name}-panel`,
    board: { ...design.board, width: PW, height: PH, outline: undefined, cutouts },
    components: [...components, ...extra],
    wires,
    traces: copy(design.traces, (t, d) => ({ ...t, points: t.points.map((p) => move(p, d)) })).map((t, n) => ({ ...t, id: `${t.id}@${n}` })),
    vias: copy(design.vias, (v, d) => ({ ...v, x: v.x + d.x, y: v.y + d.y })).map((v, n) => ({ ...v, id: `${v.id}@${n}` })),
    zones: copy(design.zones, (z, d) => ({ ...z, points: z.points.map((p) => move(p, d)) })).map((z, n) => ({ ...z, id: `${z.id}@${n}` })),
    keepouts: copy(design.keepouts, (k, d) => ({ ...k, points: k.points.map((p) => move(p, d)) })).map((k, n) => ({ ...k, id: `${k.id}@${n}` })),
    pcbGraphics: copy(design.pcbGraphics, (g, d) => ({ ...g, points: g.points.map((p) => move(p, d)) })).map((g, n) => ({ ...g, id: `${g.id}@${n}` })),
  };
  return { design: panel, width: PW, height: PH, boards, tabs, npth, vscore: vs, warnings };
}

/** Fabrication files for a panel: Gerbers and drills of the panel design, NPTH holes, V-score layer. */
export function panelFiles(design: Design, o: PanelOptions): { files: Record<string, string>; panel: Panel } {
  const panel = panelize(design, o);
  const d = panel.design;
  const files: Record<string, string> = { ...gerberFiles(d), ...drillFiles(d) };
  const H = panel.height;
  if (panel.npth.length) {
    const tools = [...new Set(panel.npth.map((h) => h.d.toFixed(3)))];
    const out = ["M48", "; Non-plated holes (mouse bites, tooling)", "METRIC,TZ", ...tools.map((t, i) => `T${i + 1}C${t}`), "%", "G90", "G05"];
    tools.forEach((t, i) => {
      out.push(`T${i + 1}`);
      for (const h of panel.npth.filter((x) => x.d.toFixed(3) === t)) out.push(`X${h.at.x.toFixed(3)}Y${(H - h.at.y).toFixed(3)}`);
    });
    out.push("M30", "");
    files[`${d.name}-NPTH.drl`] = out.join("\n");
  }
  if (panel.vscore.length) {
    const f = (v: number) => Math.round(v * 1e6).toString();
    const xy = (p: Vec) => `X${f(p.x)}Y${f(H - p.y)}`;
    const body = ["%TF.GenerationSoftware,PCBian,0.1*%", "%TF.FileFunction,Other,V-score*%", "%FSLAX46Y46*%", "%MOMM*%", "%LPD*%", "%ADD10C,0.1000*%", "D10*", ...panel.vscore.flatMap(([a, b]) => [`${xy(a)}D02*`, `${xy(b)}D01*`]), "M02*", ""];
    files[`${d.name}-VScore.gbr`] = body.join("\n");
  }
  files[`${d.name}-README.txt`] = [
    `Panel of ${o.cols} x ${o.rows} "${design.name}" boards, ${panel.width.toFixed(2)} x ${panel.height.toFixed(2)} mm.`,
    `Board ${design.board.width} x ${design.board.height} mm; ${o.separation === "vscore" ? "separated by V-score (see -VScore.gbr; score depth per fab default)" : `routed gaps of ${o.gap ?? 2} mm with ${panel.tabs.length} breakaway tabs${(o.mouseBites ?? true) ? " and mouse-bite holes (-NPTH.drl)" : ""}`}.`,
    `Rails: ${o.rails ?? "tb"} ${o.rail ?? 5} mm${panel.npth.some((h) => h.d > 1) ? "; tooling holes in -NPTH.drl" : ""}.`,
    ...panel.warnings.map((w) => `Note: ${w}`),
    "",
  ].join("\n");
  return { files, panel };
}
