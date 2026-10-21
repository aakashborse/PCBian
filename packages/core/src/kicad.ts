// KiCad interoperability: S-expression parsing, footprint/symbol import and
// board/netlist export (KiCad 7/8 file formats).
import { analyzeCopper } from "./copper";
import { normAngle } from "./geometry";
import { netRules } from "./doc";
import { copperLayers, kicadLayerName, OZ_MM, stackupOf, viaKind, viaLayers } from "./stackup";
import { icSymbol, getPart } from "./library";
import { computeNets, netByTerminal, termKey } from "./netlist";
import type { Design, Footprint, Pad, PartDef, PartSymbol, PinType, Shape, SymbolPin, Vec } from "./types";

// ---------- S-expressions ----------

export type SExpr = string | SExpr[];

export function parseSExpr(text: string): SExpr {
  let i = 0;
  const skip = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const read = (): SExpr => {
    skip();
    if (text[i] === "(") {
      i++;
      const list: SExpr[] = [];
      for (;;) {
        skip();
        if (i >= text.length) throw new Error("Unexpected end of file");
        if (text[i] === ")") {
          i++;
          return list;
        }
        list.push(read());
      }
    }
    if (text[i] === '"') {
      i++;
      let s = "";
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) i++;
        s += text[i++];
      }
      i++;
      return s;
    }
    const start = i;
    while (i < text.length && !/[\s()]/.test(text[i])) i++;
    return text.slice(start, i);
  };
  return read();
}

const isList = (e: SExpr): e is SExpr[] => Array.isArray(e);
const head = (e: SExpr) => (isList(e) && typeof e[0] === "string" ? e[0] : "");
const children = (e: SExpr, name: string) => (isList(e) ? e.filter((c) => head(c) === name) : []) as SExpr[][];
const child = (e: SExpr, name: string) => children(e, name)[0];
const num = (e: SExpr | undefined, i: number, d = 0) => (e && isList(e) && typeof e[i] === "string" ? Number(e[i]) : d);

const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const f = (n: number) => String(Math.round(n * 1e4) / 1e4);
let uuidN = 0;
const uuid = () => {
  const h = (n: number) => Math.floor(Math.random() * 16 ** n).toString(16).padStart(n, "0");
  uuidN++;
  return `${h(8)}-${h(4)}-4${h(3)}-${(8 + (uuidN % 4)).toString(16)}${h(3)}-${h(12)}`;
};

// ---------- import ----------

/** Import a KiCad footprint (.kicad_mod). */
export function importKicadFootprint(text: string): Footprint {
  const root = parseSExpr(text);
  if (head(root) !== "footprint" && head(root) !== "module") throw new Error("Not a KiCad footprint file");
  const name = (root as SExpr[])[1] as string;
  const pads: Pad[] = [];
  for (const p of children(root, "pad")) {
    const [, id, type, shape] = p as string[];
    const at = child(p, "at");
    const size = child(p, "size");
    const drill = child(p, "drill");
    let w = num(size, 1);
    let h = num(size, 2);
    const ang = ((num(at, 3) % 360) + 360) % 360;
    if (ang === 90 || ang === 270) [w, h] = [h, w];
    pads.push({
      id: String(id),
      x: num(at, 1),
      y: num(at, 2),
      w,
      h,
      shape: shape === "circle" ? "circle" : shape === "oval" ? "oval" : "rect",
      ...(type === "thru_hole" && drill ? { drill: Number(drill.find((x) => typeof x === "string" && /^[\d.]+$/.test(x)) ?? 0.8) } : {}),
    });
  }
  if (!pads.length) throw new Error("Footprint has no pads");
  const silk: Shape[] = [];
  const crt: Vec[] = [];
  for (const kind of ["fp_line", "fp_rect", "fp_circle", "fp_poly"]) {
    for (const g of children(root, kind)) {
      const layer = (child(g, "layer")?.[1] as string) ?? "";
      if (kind === "fp_line") {
        const a = { x: num(child(g, "start"), 1), y: num(child(g, "start"), 2) };
        const b = { x: num(child(g, "end"), 1), y: num(child(g, "end"), 2) };
        if (layer.endsWith("SilkS")) silk.push({ kind: "line", points: [a, b] });
        if (layer.endsWith("CrtYd")) crt.push(a, b);
      } else if (kind === "fp_rect") {
        const a = { x: num(child(g, "start"), 1), y: num(child(g, "start"), 2) };
        const b = { x: num(child(g, "end"), 1), y: num(child(g, "end"), 2) };
        if (layer.endsWith("SilkS")) silk.push({ kind: "rect", x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
        if (layer.endsWith("CrtYd")) crt.push(a, b);
      } else if (kind === "fp_circle") {
        const c = { x: num(child(g, "center"), 1), y: num(child(g, "center"), 2) };
        const e = { x: num(child(g, "end"), 1), y: num(child(g, "end"), 2) };
        const r = Math.hypot(e.x - c.x, e.y - c.y);
        if (layer.endsWith("SilkS")) silk.push({ kind: "circle", x: c.x, y: c.y, r });
        if (layer.endsWith("CrtYd")) crt.push({ x: c.x - r, y: c.y - r }, { x: c.x + r, y: c.y + r });
      } else {
        const pts = children(child(g, "pts") ?? [], "xy").map((xy) => ({ x: num(xy, 1), y: num(xy, 2) }));
        if (layer.endsWith("SilkS") && pts.length > 1) silk.push({ kind: "polygon", points: pts });
      }
    }
  }
  // Courtyard: use the drawn one if present, otherwise pad extents + margin (centred on the origin).
  const pts = crt.length ? crt : pads.flatMap((p) => [{ x: p.x - p.w / 2 - 0.25, y: p.y - p.h / 2 - 0.25 }, { x: p.x + p.w / 2 + 0.25, y: p.y + p.h / 2 + 0.25 }]);
  const ext = Math.max(...pts.map((p) => Math.abs(p.x)));
  const eyt = Math.max(...pts.map((p) => Math.abs(p.y)));
  return { name: String(name).replace(/^.*:/, ""), pads, courtyard: { w: ext * 2, h: eyt * 2 }, silk };
}

/** Import the first symbol of a KiCad symbol library (.kicad_sym). Units: 2.54mm = one 10-unit grid step. */
export function importKicadSymbol(text: string, symbolName?: string): { name: string; refPrefix: string; value: string; description: string; symbol: PartSymbol; pins: { id: string; name: string }[] } {
  const root = parseSExpr(text);
  let syms = children(root, "symbol");
  if (head(root) === "symbol") syms = [root as SExpr[]];
  const sym = symbolName ? syms.find((s) => s[1] === symbolName) : syms[0];
  if (!sym) throw new Error("No symbol found in the KiCad file");
  return symbolFromSExpr(sym);
}

const KTYPE: Record<string, PinType> = {
  input: "input",
  output: "output",
  bidirectional: "bidirectional",
  tri_state: "tristate",
  passive: "passive",
  free: "passive",
  unspecified: "unspecified",
  power_in: "power_in",
  power_out: "power_out",
  open_collector: "open_collector",
  open_emitter: "open_collector",
  no_connect: "nc",
};

/** Convert a KiCad symbol definition (lib_symbols entry or .kicad_sym symbol). Units are merged; De Morgan body 2 is skipped. */
export function symbolFromSExpr(sym: SExpr[]): { name: string; refPrefix: string; value: string; description: string; symbol: PartSymbol; pins: { id: string; name: string }[]; power: boolean } {
  const props = new Map(children(sym, "property").map((p) => [p[1] as string, p[2] as string]));
  const k = 10 / 2.54;
  // Per KiCad unit (0 = common to every unit).
  const byUnit = new Map<number, { pins: SymbolPin[]; shapes: Shape[] }>();
  const bucket = (u: number) => byUnit.get(u) ?? (byUnit.set(u, { pins: [], shapes: [] }), byUnit.get(u)!);
  const seen = new Set<string>();
  const walk = (e: SExpr[], unit: number) => {
    const { pins, shapes } = bucket(unit);
    for (const p of children(e, "pin")) {
      const at = child(p, "at");
      const len = num(child(p, "length"), 1, 2.54);
      const ang = ((num(at, 3) % 360) + 360) % 360;
      const side: SymbolPin["side"] = ang === 0 ? "left" : ang === 180 ? "right" : ang === 90 ? "bottom" : "top";
      const name = (child(p, "name")?.[1] as string) ?? "";
      const number = (child(p, "number")?.[1] as string) ?? "";
      if (seen.has(number)) continue;
      seen.add(number);
      pins.push({ id: number, name: name === "~" || name === "" ? number : name, x: Math.round(num(at, 1) * k), y: Math.round(-num(at, 2) * k), side, length: Math.round(len * k), showName: name !== "~", showNumber: true, type: KTYPE[p[1] as string] ?? "passive" });
    }
    for (const r of children(e, "rectangle")) {
      const a = child(r, "start");
      const b = child(r, "end");
      const x0 = num(a, 1) * k;
      const y0 = -num(a, 2) * k;
      const x1 = num(b, 1) * k;
      const y1 = -num(b, 2) * k;
      shapes.push({ kind: "rect", x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) });
    }
    for (const pl of children(e, "polyline")) {
      const pts = children(child(pl, "pts") ?? [], "xy").map((xy) => ({ x: num(xy, 1) * k, y: -num(xy, 2) * k }));
      if (pts.length > 1) shapes.push({ kind: "line", points: pts });
    }
    for (const c of children(e, "circle")) shapes.push({ kind: "circle", x: num(child(c, "center"), 1) * k, y: -num(child(c, "center"), 2) * k, r: num(child(c, "radius"), 1) * k });
    // Sub-symbols are named NAME_unit_style; skip alternate (De Morgan) body styles.
    for (const sub of children(e, "symbol")) {
      const m = String(sub[1]).match(/_(\d+)_(\d+)$/);
      if (m?.[2] === "2") continue;
      walk(sub, m ? Number(m[1]) : unit);
    }
  };
  walk(sym, 0);
  // Units 1..n; common (unit 0) graphics appear on every unit, common pins on the first.
  const unitNos = [...byUnit.keys()].filter((u) => u > 0).sort((a, b) => a - b);
  const common = bucket(0);
  const unitSyms = (unitNos.length ? unitNos : [0]).map((u, i) => {
    const own = u === 0 ? { pins: [], shapes: [] } : bucket(u);
    return { pins: [...(i === 0 ? common.pins : []), ...own.pins], shapes: [...common.shapes, ...own.shapes] };
  });
  const pins = unitSyms.flatMap((u) => u.pins);
  const shapes = unitSyms[0].shapes;
  if (!pins.length) throw new Error("Symbol has no pins");
  const twoPin = pins.length <= 2;
  pins.forEach((p) => {
    if (twoPin) {
      p.showName = false;
      p.showNumber = false;
    }
  });
  const ys = pins.map((p) => p.y);
  const minY = Math.min(...ys, ...shapes.flatMap((s) => (s.kind === "rect" ? [s.y] : [])));
  return {
    name: String(sym[1]).replace(/^.*:/, ""),
    refPrefix: (props.get("Reference") ?? "U").replace(/[^A-Za-z#]/g, "") || "U",
    value: props.get("Value") ?? String(sym[1]),
    description: props.get("Description") ?? props.get("ki_description") ?? "",
    symbol: {
      shapes: shapes.length ? shapes : icSymbol(pins.map((p) => [p.id, p.name]), []).shapes,
      pins: unitSyms[0].pins,
      refPos: { x: 0, y: minY - 8 },
      valuePos: { x: 0, y: Math.max(...ys) + 16 },
      ...(unitSyms.length > 1 ? { units: unitSyms.slice(1).map((u, i) => ({ name: String.fromCharCode(66 + i), pins: u.pins, shapes: u.shapes })) } : {}),
    },
    pins: pins.map((p) => ({ id: p.id, name: p.name })),
    power: children(sym, "power").length > 0,
  };
}

/** Combine an imported symbol and footprint into a part. Pins and pads are matched by number. */
export function importKicadPart(symText: string, modText: string, id = `kicad_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`): PartDef {
  const s = importKicadSymbol(symText);
  const footprint = importKicadFootprint(modText);
  const padIds = new Set(footprint.pads.map((p) => p.id));
  const missing = s.pins.filter((p) => !padIds.has(p.id)).map((p) => p.id);
  if (missing.length) throw new Error(`Symbol pins ${missing.join(", ")} have no matching footprint pads`);
  // Pads without a symbol pin (e.g. mounting tabs) are dropped to keep pins and pads consistent.
  footprint.pads = footprint.pads.filter((p) => s.pins.some((pin) => pin.id === p.id));
  return { id, name: s.name, category: "Imported (KiCad)", description: s.description || s.name, kind: "part", refPrefix: s.refPrefix, defaultValue: s.value, keywords: ["kicad", "imported"], symbol: s.symbol, footprint };
}

// ---------- export ----------


/** KiCad netlist (.net, s-expression format "E") importable by Pcbnew. */
export function kicadNetlist(design: Design): string {
  const byId = new Map(design.components.map((c) => [c.id, c]));
  const parts = design.components.filter((c) => getPart(c.partId)?.kind === "part");
  const nets = computeNets(design).filter((n) => n.terminals.some((t) => getPart(byId.get(t.comp)!.partId)?.kind === "part"));
  const lines = [`(export (version "E")`, `  (design (source ${q(design.name)}) (tool "PCBian"))`, "  (components"];
  for (const c of parts) {
    const p = getPart(c.partId)!;
    lines.push(`    (comp (ref ${q(c.ref)}) (value ${q(c.value)}) (footprint ${q(`PCBian:${p.footprint?.name ?? ""}`)}) (libsource (lib "PCBian") (part ${q(p.id)}) (description ${q(p.description)})))`);
  }
  lines.push("  )", "  (nets");
  nets.forEach((n, i) => {
    const nodes = n.terminals.filter((t) => getPart(byId.get(t.comp)!.partId)?.kind === "part").map((t) => `(node (ref ${q(byId.get(t.comp)!.ref)}) (pin ${q(t.pin)}))`);
    lines.push(`    (net (code ${q(String(i + 1))}) (name ${q(n.name)}) ${nodes.join(" ")})`);
  });
  lines.push("  )", ")", "");
  return lines.join("\n");
}

/** KiCad 8 board file (.kicad_pcb) with footprints, tracks, vias, zones and outline. */
export function kicadPcb(design: Design): string {
  const nets = computeNets(design);
  const netOf = netByTerminal(nets);
  const analysis = analyzeCopper(design, nets);
  const netCode = new Map<string, number>();
  nets.forEach((n) => netCode.set(n.name, netCode.size + 1));
  const netRef = (name: string | undefined) => (name && netCode.has(name) ? `(net ${netCode.get(name)} ${q(name)})` : "(net 0 \"\")");
  const layers = copperLayers(design.board);
  const out: string[] = [];
  out.push(`(kicad_pcb (version 20240108) (generator "pcbian") (generator_version "0.2")`);
  out.push(`  (general (thickness ${f(design.board.thickness)}) (legacy_teardrops no))`, `  (paper "A4")`, "  (layers");
  out.push(`    (0 "F.Cu" signal)`);
  layers.slice(1, -1).forEach((l) => out.push(`    (${l.slice(2)} "${kicadLayerName(l)}" signal)`));
  out.push(
    `    (31 "B.Cu" signal)`,
    `    (34 "B.Paste" user)`,
    `    (35 "F.Paste" user)`,
    `    (36 "B.SilkS" user "B.Silkscreen")`,
    `    (37 "F.SilkS" user "F.Silkscreen")`,
    `    (38 "B.Mask" user)`,
    `    (39 "F.Mask" user)`,
    `    (44 "Edge.Cuts" user)`,
    `    (46 "B.CrtYd" user "B.Courtyard")`,
    `    (47 "F.CrtYd" user "F.Courtyard")`,
    `    (48 "B.Fab" user)`,
    `    (49 "F.Fab" user)`,
    "  )",
  );
  // Physical stackup so KiCad's board setup (and its impedance calculator) sees the same build.
  const st = stackupOf(design.board);
  out.push("  (setup", "    (stackup");
  if (st.maskThickness) out.push(`      (layer "F.Mask" (type "Top Solder Mask") (thickness ${f(st.maskThickness)}) (epsilon_r ${st.maskEr ?? 3.8}))`);
  layers.forEach((l, i) => {
    out.push(`      (layer "${kicadLayerName(l)}" (type "copper") (thickness ${f(st.copperOz[i] * OZ_MM)}))`);
    const d = st.dielectrics[i];
    if (d) out.push(`      (layer "dielectric ${i + 1}" (type "${d.kind}") (thickness ${f(d.thickness)}) (material "FR4") (epsilon_r ${d.er}) (loss_tangent 0.02))`);
  });
  if (st.maskThickness) out.push(`      (layer "B.Mask" (type "Bottom Solder Mask") (thickness ${f(st.maskThickness)}) (epsilon_r ${st.maskEr ?? 3.8}))`);
  out.push("      (copper_finish \"HAL lead-free\")", "    )", "    (pad_to_mask_clearance 0)", "  )");
  out.push(`  (net 0 "")`);
  for (const [name, code] of netCode) out.push(`  (net ${code} ${q(name)})`);

  for (const c of design.components) {
    const part = getPart(c.partId);
    if (!part?.footprint) continue;
    const fp = part.footprint;
    const bottom = c.pcb.side === "bottom";
    const ang = normAngle(360 - c.pcb.rot);
    const sx = (x: number) => (bottom ? -x : x);
    const cu = bottom ? "B" : "F";
    const smd = fp.pads.every((p) => !p.drill);
    out.push(`  (footprint ${q(`PCBian:${fp.name}`)} (layer "${cu}.Cu") (uuid ${q(uuid())}) (at ${f(c.pcb.x)} ${f(c.pcb.y)}${ang ? ` ${ang}` : ""})`);
    const mirror = bottom ? " (justify mirror)" : "";
    out.push(`    (property "Reference" ${q(c.ref)} (at 0 ${f(-fp.courtyard.h / 2 - 1)} ${ang}) (layer "${cu}.SilkS") (uuid ${q(uuid())}) (effects (font (size 1 1) (thickness 0.15))${mirror}))`);
    out.push(`    (property "Value" ${q(c.value)} (at 0 ${f(fp.courtyard.h / 2 + 1)} ${ang}) (layer "${cu}.Fab") (uuid ${q(uuid())}) (effects (font (size 1 1) (thickness 0.15))${mirror}))`);
    out.push(`    (attr ${smd ? "smd" : "through_hole"}${c.dnp ? " dnp" : ""})`);
    for (const s of fp.silk) {
      if (s.kind === "line" || s.kind === "polygon") {
        const pts = s.kind === "polygon" ? [...s.points, s.points[0]] : s.points;
        for (let i = 1; i < pts.length; i++) out.push(`    (fp_line (start ${f(sx(pts[i - 1].x))} ${f(pts[i - 1].y)}) (end ${f(sx(pts[i].x))} ${f(pts[i].y)}) (stroke (width 0.12) (type solid)) (layer "${cu}.SilkS") (uuid ${q(uuid())}))`);
      } else if (s.kind === "rect") {
        out.push(`    (fp_rect (start ${f(sx(s.x))} ${f(s.y)}) (end ${f(sx(s.x + s.w))} ${f(s.y + s.h)}) (stroke (width 0.12) (type solid)) (fill none) (layer "${cu}.SilkS") (uuid ${q(uuid())}))`);
      } else if (s.kind === "circle") {
        out.push(`    (fp_circle (center ${f(sx(s.x))} ${f(s.y)}) (end ${f(sx(s.x + s.r))} ${f(s.y)}) (stroke (width 0.12) (type solid)) (fill ${s.fill ? "solid" : "none"}) (layer "${cu}.SilkS") (uuid ${q(uuid())}))`);
      }
    }
    const { w, h } = fp.courtyard;
    out.push(`    (fp_rect (start ${f(-w / 2)} ${f(-h / 2)}) (end ${f(w / 2)} ${f(h / 2)}) (stroke (width 0.05) (type solid)) (fill none) (layer "${cu}.CrtYd") (uuid ${q(uuid())}))`);
    for (const p of fp.pads) {
      const net = netOf.get(termKey({ comp: c.id, pin: p.id }));
      const shape = p.shape === "circle" ? "circle" : p.shape === "oval" ? "oval" : "roundrect";
      const rr = shape === "roundrect" ? " (roundrect_rratio 0.25)" : "";
      const lay = p.drill ? `(layers "*.Cu" "*.Mask")` : `(layers "${cu}.Cu" "${cu}.Paste" "${cu}.Mask")`;
      // KiCad pad angles are absolute: the footprint's plus the pad's own (mirrored on the bottom).
      const pang = normAngle(ang - (bottom ? -(p.rot ?? 0) : p.rot ?? 0));
      out.push(`    (pad ${q(p.id)} ${p.drill ? "thru_hole" : "smd"} ${shape} (at ${f(sx(p.x))} ${f(p.y)}${pang ? ` ${pang}` : ""}) (size ${f(p.w)} ${f(p.h)})${p.drill ? ` (drill ${f(p.drill)})` : ""} ${lay}${rr} ${netRef(net)} (uuid ${q(uuid())}))`);
    }
    out.push("  )");
  }

  out.push(`  (gr_rect (start 0 0) (end ${f(design.board.width)} ${f(design.board.height)}) (stroke (width 0.1) (type default)) (fill none) (layer "Edge.Cuts") (uuid ${q(uuid())}))`);
  for (const t of design.traces) {
    const it = analysis.items.find((x) => x.key === `trace:${t.id}`);
    const net = it && analysis.netOfItem(it);
    for (let i = 1; i < t.points.length; i++) {
      const a = t.points[i - 1];
      const b = t.points[i];
      out.push(`  (segment (start ${f(a.x)} ${f(a.y)}) (end ${f(b.x)} ${f(b.y)}) (width ${f(t.width)}) (layer "${kicadLayerName(t.layer)}") ${netRef(net)} (uuid ${q(uuid())}))`);
    }
  }
  for (const v of design.vias) {
    const it = analysis.items.find((x) => x.key === `via:${v.id}`);
    const span = viaLayers(design.board, v);
    const kind = viaKind(design.board, v);
    // KiCad writes buried vias with the "blind" keyword too.
    const type = kind === "through" ? "" : kind === "micro" ? "micro " : "blind ";
    out.push(`  (via ${type}(at ${f(v.x)} ${f(v.y)}) (size ${f(v.diameter)}) (drill ${f(v.drill)}) (layers "${kicadLayerName(span[0])}" "${kicadLayerName(span[span.length - 1])}") ${netRef(it && analysis.netOfItem(it))} (uuid ${q(uuid())}))`);
  }
  for (const z of design.zones) {
    const r = netRules(design, z.net);
    out.push(`  (zone ${netRef(z.net)} (net_name ${q(z.net)}) (layer "${kicadLayerName(z.layer)}") (uuid ${q(uuid())}) (hatch edge 0.5)`);
    if (z.priority) out.push(`    (priority ${z.priority})`);
    out.push(`    (connect_pads${z.padConnection === "solid" ? " yes" : ""} (clearance ${f(r.clearance)})) (min_thickness 0.25) (filled_areas_thickness no)`);
    const hatch = z.fill === "hatch" ? ` (mode hatch) (hatch_thickness ${f(z.hatchWidth ?? Math.max(0.25, r.traceWidth))}) (hatch_gap ${f(z.hatchGap ?? 1)}) (hatch_orientation 0)` : "";
    out.push(`    (fill yes${hatch} (thermal_gap ${f(z.thermalGap ?? 0.5)}) (thermal_bridge_width ${f(z.spokeWidth ?? Math.max(0.3, r.traceWidth))})${z.removeIslands === false ? " (island_removal_mode 1)" : ""})`);
    out.push(`    (polygon (pts ${z.points.map((p) => `(xy ${f(p.x)} ${f(p.y)})`).join(" ")}))`);
    out.push("  )");
  }
  out.push(")", "");
  return out.join("\n");
}
