// STEP AP214 export of the assembled board: the board as a B-rep solid extruded from its real
// outline (cutouts and drill holes included) and one box body per fitted component, with colours.
import { boardOutline } from "./doc";
import { courtyardCorners, padsOf, polygonArea } from "./geometry";
import { getPart } from "./library";
import { modelPlacement, parseStep, renumber, stepRoot, type StepData } from "./model3d";
import type { ComponentData, Design, Model3D, Vec } from "./types";

export type StepV3 = [number, number, number];
type V3 = StepV3;

class StepWriter {
  private lines: string[] = [];
  private n = 0;
  add(s: string): number {
    this.lines.push(`#${++this.n}=${s};`);
    return this.n;
  }
  /** Copy another file's entities in, renumbered past everything so far; returns the shift. */
  merge(data: StepData): number {
    const by = this.n;
    let max = 0;
    for (const [id, body] of data.entities) {
      this.lines.push(`#${id + by}=${renumber(body, by)};`);
      max = Math.max(max, id);
    }
    this.n += max;
    return by;
  }
  body() {
    return this.lines.join("\n");
  }
}

const num = (v: number) => {
  const r = Math.round(v * 1e6) / 1e6;
  const s = String(r);
  return /[.eE]/.test(s) ? s : `${s}.`;
};
const str = (s: string) => `'${s.replace(/'/g, "''").replace(/[^\x20-\x7e]/g, "_")}'`;

/** Builds closed planar B-rep solids, sharing each edge between its two faces. */
class SolidBuilder {
  private points = new Map<string, number>();
  private vertices = new Map<string, number>();
  private edges = new Map<string, number>();
  private faces: number[] = [];
  constructor(private w: StepWriter) {}
  private key = (p: V3) => p.map((v) => Math.round(v * 1e5)).join(",");
  point(p: V3) {
    const k = this.key(p);
    let id = this.points.get(k);
    if (!id) this.points.set(k, (id = this.w.add(`CARTESIAN_POINT('',(${p.map(num).join(",")}))`)));
    return id;
  }
  private vertex(p: V3) {
    const k = this.key(p);
    let id = this.vertices.get(k);
    if (!id) this.vertices.set(k, (id = this.w.add(`VERTEX_POINT('',#${this.point(p)})`)));
    return id;
  }
  dir(d: V3) {
    const l = Math.hypot(...d) || 1;
    return this.w.add(`DIRECTION('',(${d.map((v) => num(v / l)).join(",")}))`);
  }
  /** Oriented edge a→b; the reverse direction reuses the same edge with opposite sense. */
  private orientedEdge(a: V3, b: V3) {
    const ka = this.key(a);
    const kb = this.key(b);
    const rev = this.edges.get(`${kb}|${ka}`);
    if (rev) return this.w.add(`ORIENTED_EDGE('',*,*,#${rev},.F.)`);
    const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(...d);
    const line = this.w.add(`LINE('',#${this.point(a)},#${this.w.add(`VECTOR('',#${this.dir(d)},${num(len)})`)})`);
    const e = this.w.add(`EDGE_CURVE('',#${this.vertex(a)},#${this.vertex(b)},#${line},.T.)`);
    this.edges.set(`${ka}|${kb}`, e);
    return this.w.add(`ORIENTED_EDGE('',*,*,#${e},.T.)`);
  }
  /** Planar face: first loop is the outer boundary (CCW about `normal`), the rest are holes. */
  face(loops: V3[][], normal: V3, refDir: V3) {
    const bounds = loops.map((loop, i) => {
      const oes = loop.map((p, k) => this.orientedEdge(p, loop[(k + 1) % loop.length]));
      const el = this.w.add(`EDGE_LOOP('',(${oes.map((o) => `#${o}`).join(",")}))`);
      return this.w.add(`${i === 0 ? "FACE_OUTER_BOUND" : "FACE_BOUND"}('',#${el},.T.)`);
    });
    const ax = this.w.add(`AXIS2_PLACEMENT_3D('',#${this.point(loops[0][0])},#${this.dir(normal)},#${this.dir(refDir)})`);
    const plane = this.w.add(`PLANE('',#${ax})`);
    this.faces.push(this.w.add(`ADVANCED_FACE('',(${bounds.map((b) => `#${b}`).join(",")}),#${plane},.T.)`));
  }
  solid(name: string) {
    const shell = this.w.add(`CLOSED_SHELL('',(${this.faces.map((f) => `#${f}`).join(",")}))`);
    return this.w.add(`MANIFOLD_SOLID_BREP(${str(name)},#${shell})`);
  }
}

/** Extrude a polygon with holes between z0 and z1 as a closed solid. */
function prism(w: StepWriter, name: string, outer: Vec[], holes: Vec[][], z0: number, z1: number): number {
  const ccw = (p: Vec[]) => (polygonArea(p) < 0 ? [...p].reverse() : p);
  const cw = (p: Vec[]) => [...ccw(p)].reverse();
  const o = ccw(dedupe(outer));
  const hs = holes.map((h) => cw(dedupe(h)));
  const b = new SolidBuilder(w);
  const at = (p: Vec, z: number): V3 => [p.x, p.y, z];
  // Top (normal +z) keeps the loop orientation, bottom reverses it.
  b.face([o, ...hs].map((l) => l.map((p) => at(p, z1))), [0, 0, 1], [1, 0, 0]);
  b.face([o, ...hs].map((l) => [...l].reverse().map((p) => at(p, z0))), [0, 0, -1], [1, 0, 0]);
  for (const loop of [o, ...hs]) {
    loop.forEach((p, i) => {
      const q = loop[(i + 1) % loop.length];
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      // CCW outer loop / CW holes: (dy, -dx) points out of the material.
      b.face([[at(p, z0), at(q, z0), at(q, z1), at(p, z1)]], [dy, -dx, 0], [dx, dy, 0]);
    });
  }
  return b.solid(name);
}

const dedupe = (pts: Vec[]) => pts.filter((p, i) => Math.hypot(p.x - pts[(i + pts.length - 1) % pts.length].x, p.y - pts[(i + pts.length - 1) % pts.length].y) > 1e-6);

/** Body height (mm) from the footprint name: a coarse but useful envelope for enclosure fitting. */
export function bodyHeight(c: ComponentData): number {
  const name = (getPart(c.partId)?.footprint?.name ?? "").toUpperCase();
  if (/MOUNT|FIDUCIAL|HOLE/.test(name)) return 0;
  if (/0402/.test(name)) return 0.35;
  if (/0603/.test(name)) return 0.5;
  if (/0805/.test(name)) return 0.6;
  if (/1206|SOD/.test(name)) return 0.8;
  if (/SOT|SOIC|SSOP|TSSOP|MSOP|QFN|DFN/.test(name)) return 1.5;
  if (/QFP|LQFP|TQFP/.test(name)) return 1.6;
  if (/DIP/.test(name)) return 4;
  if (/CP_RADIAL|ELEC/.test(name)) return 7;
  if (/HEADER|PIN|CONN/.test(name)) return 8.5;
  if (/USB/.test(name)) return 3.2;
  if (/SW|BUTTON|TACT/.test(name)) return 3.5;
  return 1.5;
}

function circle(c: Vec, r: number, n = 16): Vec[] {
  return Array.from({ length: n }, (_, i) => ({ x: c.x + r * Math.cos((2 * Math.PI * i) / n), y: c.y + r * Math.sin((2 * Math.PI * i) / n) }));
}

/**
 * STEP AP214 text for the board and its components (mm, board bottom at z = 0, y up). Parts whose
 * footprint has a model, with that file's text in `models` (by file id), are placed as instances of
 * the model and the file becomes an assembly; other parts are boxes on the board.
 */
export interface StepSolid {
  name: string;
  /** Outline in the STEP frame (mm, y up), extruded from z0 to z1. */
  outer: Vec[];
  holes?: Vec[][];
  z0: number;
  z1: number;
  rgb: V3;
}

export function stepFile(design: Design, models: Record<string, string> = {}, opts: { extra?: StepSolid[]; boardless?: boolean } = {}): string {
  const w = new StepWriter();
  const H = design.board.height;
  const T = design.board.thickness;
  const flip = (p: Vec): Vec => ({ x: p.x, y: H - p.y });

  // Drill holes (pads and mounting holes; vias are left out to keep the model light).
  const holes: Vec[][] = [];
  for (const c of design.components) for (const p of padsOf(c)) if (p.drill && p.drill >= 0.5) holes.push(circle(flip(p.world), p.drill / 2));
  const solids: { id: number; rgb: V3 }[] = [];
  if (!opts.boardless) solids.push({ id: prism(w, "PCB", boardOutline(design.board).map(flip), [...(design.board.cutouts ?? []).map((h) => h.map(flip)), ...holes], 0, T), rgb: [0.05, 0.32, 0.2] });
  for (const x of opts.extra ?? []) solids.push({ id: prism(w, x.name, x.outer, x.holes ?? [], x.z0, x.z1), rgb: x.rgb });
  const placed: { c: ComponentData; m: Model3D }[] = [];
  for (const c of opts.boardless ? [] : design.components) {
    const part = getPart(c.partId);
    if (!part?.footprint || c.dnp) continue;
    const m = part.footprint.model;
    if (m && models[m.file]) {
      placed.push({ c, m });
      continue;
    }
    const h = bodyHeight(c);
    const corners = courtyardCorners(c, 0.25);
    if (!h || !corners) continue;
    const rect = corners.map(flip);
    const [z0, z1] = c.pcb.side === "top" ? [T, T + h] : [-h, 0];
    solids.push({ id: prism(w, c.ref, rect, [], z0, z1), rgb: /HEADER|CONN|USB/i.test(part.footprint.name) ? [0.12, 0.12, 0.14] : [0.16, 0.17, 0.2] });
  }

  // Product structure, units and colours.
  const appCtx = w.add("APPLICATION_CONTEXT('core data for automotive mechanical design processes')");
  w.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${appCtx})`);
  const prodCtx = w.add(`PRODUCT_CONTEXT('',#${appCtx},'mechanical')`);
  const pdCtx = w.add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${appCtx},'design')`);
  const product = (name: string) => {
    const p = w.add(`PRODUCT(${str(name)},${str(name)},'',(#${prodCtx}))`);
    const f = w.add(`PRODUCT_DEFINITION_FORMATION('','',#${p})`);
    const pd = w.add(`PRODUCT_DEFINITION('design','',#${f},#${pdCtx})`);
    return { pd, pds: w.add(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`) };
  };
  const boardProduct = product(placed.length ? `${design.name} PCB` : design.name);
  const lu = w.add("(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))");
  const au = w.add("(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))");
  const su = w.add("(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())");
  const unc = w.add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-05),#${lu},'distance_accuracy_value','confusion accuracy')`);
  const ctx = w.add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lu},#${au},#${su}))REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY'))`);
  const o = w.add("CARTESIAN_POINT('',(0.,0.,0.))");
  const origin = w.add(`AXIS2_PLACEMENT_3D('',#${o},#${w.add("DIRECTION('',(0.,0.,1.))")},#${w.add("DIRECTION('',(1.,0.,0.))")})`);
  const rep = w.add(`ADVANCED_BREP_SHAPE_REPRESENTATION(${str(design.name)},(${[...solids.map((s) => `#${s.id}`), `#${origin}`].join(",")}),#${ctx})`);
  w.add(`SHAPE_DEFINITION_REPRESENTATION(#${boardProduct.pds},#${rep})`);
  const styled = solids.map((s) => {
    const col = w.add(`COLOUR_RGB('',${s.rgb.map(num).join(",")})`);
    const fas = w.add(`FILL_AREA_STYLE('',(#${w.add(`FILL_AREA_STYLE_COLOUR('',#${col})`)}))`);
    const sss = w.add(`SURFACE_SIDE_STYLE('',(#${w.add(`SURFACE_STYLE_FILL_AREA(#${fas})`)}))`);
    const psa = w.add(`PRESENTATION_STYLE_ASSIGNMENT((#${w.add(`SURFACE_STYLE_USAGE(.BOTH.,#${sss})`)}))`);
    return w.add(`STYLED_ITEM('color',(#${psa}),#${s.id})`);
  });
  w.add(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(${styled.map((s) => `#${s}`).join(",")}),#${ctx})`);

  if (placed.length) {
    // Assembly: the board and one instance of a model per part, each placed by a transformation.
    const top = product(design.name);
    const axis = (t: V3, z: V3, x: V3) => w.add(`AXIS2_PLACEMENT_3D('',#${w.add(`CARTESIAN_POINT('',(${t.map(num).join(",")}))`)},#${w.add(`DIRECTION('',(${z.map(num).join(",")}))`)},#${w.add(`DIRECTION('',(${x.map(num).join(",")}))`)})`);
    const topOrigin = axis([0, 0, 0], [0, 0, 1], [1, 0, 0]);
    const roots = new Map<string, { pd: number; rep: number }>();
    for (const { m } of placed) {
      if (roots.has(m.file)) continue;
      const data = parseStep(models[m.file]);
      const root = stepRoot(data);
      const by = w.merge(data);
      roots.set(m.file, { pd: root.productDefinition + by, rep: root.representation + by });
    }
    const instances = placed.map(({ c, m }) => {
      const a = modelPlacement(c, m, design.board, "step");
      return { name: c.ref, ...roots.get(m.file)!, at: axis(a.t, a.z, a.x) };
    });
    const boardAt = axis([0, 0, 0], [0, 0, 1], [1, 0, 0]);
    const topRep = w.add(`SHAPE_REPRESENTATION(${str(design.name)},(${[topOrigin, boardAt, ...instances.map((i) => i.at)].map((i) => `#${i}`).join(",")}),#${ctx})`);
    w.add(`SHAPE_DEFINITION_REPRESENTATION(#${top.pds},#${topRep})`);
    const link = (n: number, name: string, pd: number, childRep: number, at: number) => {
      const nauo = w.add(`NEXT_ASSEMBLY_USAGE_OCCURRENCE('${n}',${str(name)},'',#${top.pd},#${pd},$)`);
      const pds = w.add(`PRODUCT_DEFINITION_SHAPE('','',#${nauo})`);
      const idt = w.add(`ITEM_DEFINED_TRANSFORMATION('','',#${topOrigin},#${at})`);
      const rr = w.add(`(REPRESENTATION_RELATIONSHIP('','',#${childRep},#${topRep})REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(#${idt})SHAPE_REPRESENTATION_RELATIONSHIP())`);
      w.add(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(#${rr},#${pds})`);
    };
    link(1, "PCB", boardProduct.pd, rep, boardAt);
    instances.forEach((i, k) => link(k + 2, i.name, i.pd, i.rep, i.at));
  }

  const stamp = new Date().toISOString().slice(0, 19);
  return [
    "ISO-10303-21;",
    "HEADER;",
    `FILE_DESCRIPTION(('PCBian board model'),'2;1');`,
    `FILE_NAME(${str(`${design.name}.step`)},'${stamp}',(''),(''),'PCBian','PCBian','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    "ENDSEC;",
    "DATA;",
    w.body(),
    "ENDSEC;",
    "END-ISO-10303-21;",
    "",
  ].join("\n");
}
