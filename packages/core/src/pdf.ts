// Minimal vector PDF writer (Helvetica, lines, rectangles, circles, text) plus the
// schematic and assembly-drawing exports built on it.
import { boardOutline, sheetOf } from "./doc";
import { courtyardRect, rotate, toWorld } from "./geometry";
import { getPart } from "./library";
import type { Design, Shape, Vec } from "./types";

type RGB = [number, number, number];

/** Drawing surface shared by the PDF and SVG writers (y down, units = points). */
export interface DrawPage {
  readonly w: number;
  readonly h: number;
  stroke(rgb: RGB, width: number): this;
  fill(rgb: RGB): this;
  polyline(pts: Vec[], close?: boolean, fill?: boolean): this;
  rect(x: number, y: number, w: number, h: number, fill?: boolean): this;
  circle(c: Vec, r: number, fill?: boolean): this;
  text(x: number, y: number, size: number, str: string, anchor?: "start" | "middle" | "end", rgb?: RGB): this;
}

/** SVG page with the same API as the PDF page. */
export class SvgPage implements DrawPage {
  els: string[] = [];
  private strokeColor = "#000";
  private strokeW = 1;
  private fillColor = "#000";
  constructor(
    readonly w: number,
    readonly h: number,
  ) {}
  private n = (v: number) => (Math.round(v * 100) / 100).toString();
  private col = (rgb: RGB) => `#${rgb.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, "0")).join("")}`;
  private paint = (fill: boolean) => `fill="${fill ? this.fillColor : "none"}" stroke="${this.strokeColor}" stroke-width="${this.n(this.strokeW)}" stroke-linecap="round" stroke-linejoin="round"`;
  stroke(rgb: RGB, width: number) {
    this.strokeColor = this.col(rgb);
    this.strokeW = width;
    return this;
  }
  fill(rgb: RGB) {
    this.fillColor = this.col(rgb);
    return this;
  }
  polyline(pts: Vec[], close = false, fill = false) {
    if (pts.length < 2) return this;
    const d = pts.map((p) => `${this.n(p.x)},${this.n(p.y)}`).join(" ");
    this.els.push(`<${close ? "polygon" : "polyline"} points="${d}" ${this.paint(fill && close)}/>`);
    return this;
  }
  rect(x: number, y: number, w: number, h: number, fill = false) {
    this.els.push(`<rect x="${this.n(x)}" y="${this.n(y)}" width="${this.n(w)}" height="${this.n(h)}" ${this.paint(fill)}/>`);
    return this;
  }
  circle(c: Vec, r: number, fill = false) {
    this.els.push(`<circle cx="${this.n(c.x)}" cy="${this.n(c.y)}" r="${this.n(r)}" ${this.paint(fill)}/>`);
    return this;
  }
  text(x: number, y: number, size: number, str: string, anchor: "start" | "middle" | "end" = "start", rgb: RGB = [0, 0, 0]) {
    const esc = str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    this.els.push(`<text x="${this.n(x)}" y="${this.n(y)}" font-size="${this.n(size)}" text-anchor="${anchor}" fill="${this.col(rgb)}">${esc}</text>`);
    return this;
  }
  toString() {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${this.w}pt" height="${this.h}pt" viewBox="0 0 ${this.w} ${this.h}" font-family="Helvetica, Arial, sans-serif">\n<rect width="100%" height="100%" fill="#ffffff"/>\n${this.els.join("\n")}\n</svg>\n`;
  }
}

class PdfPage implements DrawPage {
  ops: string[] = [];
  constructor(
    readonly w: number,
    readonly h: number,
  ) {}
  private n = (v: number) => (Math.round(v * 100) / 100).toString();
  stroke(rgb: RGB, width: number) {
    this.ops.push(`${rgb.map(this.n).join(" ")} RG ${this.n(width)} w 1 J 1 j`);
    return this;
  }
  fill(rgb: RGB) {
    this.ops.push(`${rgb.map(this.n).join(" ")} rg`);
    return this;
  }
  polyline(pts: Vec[], close = false, fill = false) {
    if (pts.length < 2) return this;
    this.ops.push(`${this.n(pts[0].x)} ${this.n(this.h - pts[0].y)} m`);
    for (const p of pts.slice(1)) this.ops.push(`${this.n(p.x)} ${this.n(this.h - p.y)} l`);
    this.ops.push(fill ? (close ? "b" : "f") : close ? "s" : "S");
    return this;
  }
  rect(x: number, y: number, w: number, h: number, fill = false) {
    this.ops.push(`${this.n(x)} ${this.n(this.h - y - h)} ${this.n(w)} ${this.n(h)} re ${fill ? "B" : "S"}`);
    return this;
  }
  circle(c: Vec, r: number, fill = false) {
    const k = 0.5523 * r;
    const y = this.h - c.y;
    const n = this.n;
    this.ops.push(
      `${n(c.x + r)} ${n(y)} m`,
      `${n(c.x + r)} ${n(y + k)} ${n(c.x + k)} ${n(y + r)} ${n(c.x)} ${n(y + r)} c`,
      `${n(c.x - k)} ${n(y + r)} ${n(c.x - r)} ${n(y + k)} ${n(c.x - r)} ${n(y)} c`,
      `${n(c.x - r)} ${n(y - k)} ${n(c.x - k)} ${n(y - r)} ${n(c.x)} ${n(y - r)} c`,
      `${n(c.x + k)} ${n(y - r)} ${n(c.x + r)} ${n(y - k)} ${n(c.x + r)} ${n(y)} c`,
      fill ? "B" : "S",
    );
    return this;
  }
  text(x: number, y: number, size: number, str: string, anchor: "start" | "middle" | "end" = "start", rgb: RGB = [0, 0, 0]) {
    const safe = toWinAnsi(str);
    const width = safe.length * size * 0.52;
    const dx = anchor === "middle" ? -width / 2 : anchor === "end" ? -width : 0;
    const esc = safe.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    this.ops.push(`BT ${rgb.map(this.n).join(" ")} rg /F1 ${this.n(size)} Tf ${this.n(x + dx)} ${this.n(this.h - y)} Td (${esc}) Tj ET`);
    return this;
  }
}

function toWinAnsi(s: string) {
  return s.replace(/Ω/g, "ohm").replace(/[−–—]/g, "-").replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
}

export class PdfDocument {
  pages: PdfPage[] = [];
  addPage(w = 842, h = 595) {
    const p = new PdfPage(w, h);
    this.pages.push(p);
    return p;
  }
  /** Serialise to bytes (Latin-1). */
  toBytes(): Uint8Array {
    const objs: string[] = [];
    const add = (s: string) => objs.push(s) - 1 + 1; // 1-based object numbers
    add("<< /Type /Catalog /Pages 2 0 R >>");
    add(""); // pages, filled below
    add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const kids: number[] = [];
    for (const p of this.pages) {
      const stream = p.ops.join("\n");
      const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.w} ${p.h}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content} 0 R >>`));
    }
    objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
    let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
    const offsets: number[] = [];
    objs.forEach((o, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return bytes;
  }
}

// ---------- shared drawing helpers ----------

function drawShape(page: DrawPage, s: Shape, map: (p: Vec) => Vec, scale: number, rgb: RGB) {
  page.stroke(rgb, Math.max(0.4, 1.2 * scale));
  if (s.kind === "line") page.polyline(s.points.map(map));
  else if (s.kind === "polygon") page.fill(rgb).polyline(s.points.map(map), true, Boolean(s.fill));
  else if (s.kind === "rect") page.polyline([{ x: s.x, y: s.y }, { x: s.x + s.w, y: s.y }, { x: s.x + s.w, y: s.y + s.h }, { x: s.x, y: s.y + s.h }].map(map), true);
  else if (s.kind === "circle") page.fill(rgb).circle(map({ x: s.x, y: s.y }), s.r * scale, Boolean(s.fill));
  else if (s.kind === "text") {
    const p = map({ x: s.x, y: s.y });
    page.text(p.x, p.y, (s.size ?? 8) * scale, s.text, s.anchor ?? "start", rgb);
  }
}

function titleBlock(page: DrawPage, design: Design, sheetLabel: string) {
  const tb = design.titleBlock;
  const w = 270;
  const h = 62;
  const x = page.w - 20 - w;
  const y = page.h - 20 - h;
  page.stroke([0.2, 0.2, 0.2], 0.8).rect(x, y, w, h);
  page.polyline([{ x, y: y + 22 }, { x: x + w, y: y + 22 }]).polyline([{ x, y: y + 42 }, { x: x + w, y: y + 42 }]);
  page.text(x + 6, y + 16, 11, tb.title || design.name);
  page.text(x + 6, y + 36, 8, `Sheet: ${sheetLabel}`);
  page.text(x + w - 6, y + 36, 8, `Rev ${tb.revision}`, "end");
  page.text(x + 6, y + 56, 7, [tb.company, tb.author].filter(Boolean).join(" · ") || "PCBian");
  page.text(x + w - 6, y + 56, 7, tb.date || new Date().toISOString().slice(0, 10), "end");
  page.stroke([0.2, 0.2, 0.2], 1).rect(12, 12, page.w - 24, page.h - 24);
}

// ---------- schematic ----------

/** One A4-landscape page per sheet with symbols, wires, labels, graphics and a title block. */
export function schematicPdf(design: Design): Uint8Array {
  const pdf = new PdfDocument();
  for (const sheet of design.sheets) drawSchematicSheet(pdf.addPage(), design, sheet);
  return pdf.toBytes();
}

/** One SVG per schematic sheet (A4 landscape, same drawing as the PDF). */
export function schematicSvgs(design: Design): { sheet: string; svg: string }[] {
  return design.sheets.map((sheet) => {
    const page = new SvgPage(842, 595);
    drawSchematicSheet(page, design, sheet);
    return { sheet: sheet.name, svg: page.toString() };
  });
}

function drawSchematicSheet(page: DrawPage, design: Design, sheet: Design["sheets"][number]) {
  const byId = new Map(design.components.map((c) => [c.id, c]));
  {
    const comps = design.components.filter((c) => sheetOf(design, c) === sheet.id);
    const pinPos = (compId: string, pin: string) => {
      const c = byId.get(compId);
      const p = c && getPart(c.partId)?.symbol.pins.find((x) => x.id === pin);
      return c && p ? toWorld(p, c.sch, Boolean(c.sch.mirror)) : null;
    };
    // Bounds of everything on the sheet.
    const pts: Vec[] = [];
    for (const c of comps) {
      const part = getPart(c.partId);
      if (!part) continue;
      for (const p of part.symbol.pins) pts.push(toWorld(p, c.sch, Boolean(c.sch.mirror)));
      pts.push({ x: c.sch.x - 40, y: c.sch.y - 30 }, { x: c.sch.x + 40, y: c.sch.y + 30 });
    }
    const gfx = design.schGraphics.filter((g) => g.sheet === sheet.id);
    for (const g of gfx) pts.push(...g.points);
    if (!pts.length) pts.push({ x: 0, y: 0 }, { x: 100, y: 100 });
    const x0 = Math.min(...pts.map((p) => p.x)) - 20;
    const y0 = Math.min(...pts.map((p) => p.y)) - 20;
    const x1 = Math.max(...pts.map((p) => p.x)) + 20;
    const y1 = Math.max(...pts.map((p) => p.y)) + 20;
    const availW = page.w - 40;
    const availH = page.h - 40 - 70;
    const k = Math.min(availW / (x1 - x0), availH / (y1 - y0), 1.6);
    const ox = 20 + (availW - (x1 - x0) * k) / 2;
    const oy = 20 + (availH - (y1 - y0) * k) / 2;
    const map = (p: Vec) => ({ x: ox + (p.x - x0) * k, y: oy + (p.y - y0) * k });

    const wireRgb: RGB = [0.04, 0.48, 0.24];
    for (const w of design.wires) {
      if (!comps.some((c) => c.id === w.a.comp)) continue;
      const a = pinPos(w.a.comp, w.a.pin);
      const b = pinPos(w.b.comp, w.b.pin);
      if (!a || !b) continue;
      const route = [a, ...w.points, b];
      const path: Vec[] = [route[0]];
      for (let i = 1; i < route.length; i++) {
        const p = route[i - 1];
        const q = route[i];
        if (p.x !== q.x && p.y !== q.y) path.push({ x: q.x, y: p.y });
        path.push(q);
      }
      page.stroke(wireRgb, Math.max(0.5, 1.2 * k)).polyline(path.map(map));
    }
    for (const g of gfx) {
      const rgb: RGB = g.kind === "bus" ? [0.1, 0.25, 0.7] : [0.3, 0.3, 0.3];
      if (g.kind === "text") page.text(map(g.points[0]).x, map(g.points[0]).y, (g.size ?? 10) * k, g.text ?? "", "start", rgb);
      else if (g.kind === "rect" && g.points.length >= 2) {
        const [a, b] = g.points.map(map);
        page.stroke(rgb, 0.6).rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      } else {
        page.stroke(rgb, g.kind === "bus" ? Math.max(1.5, 3 * k) : 0.6).polyline(g.points.map(map));
        if (g.kind === "bus" && g.text) page.text(map(g.points[0]).x, map(g.points[0]).y - 4, 8 * k, g.text, "start", rgb);
      }
    }
    for (const c of comps) {
      const part = getPart(c.partId);
      if (!part) continue;
      const rgb: RGB = part.kind === "part" ? [0.48, 0.12, 0.12] : [0.72, 0.1, 0.1];
      const tf = (p: Vec) => map(toWorld(p, c.sch, Boolean(c.sch.mirror)));
      for (const s of part.symbol.shapes) drawShape(page, s, tf, k, rgb);
      for (const p of part.symbol.pins) {
        const d = { left: [1, 0], right: [-1, 0], top: [0, 1], bottom: [0, -1] }[p.side];
        const end = { x: p.x + d[0] * p.length, y: p.y + d[1] * p.length };
        if (p.length) page.stroke(rgb, Math.max(0.4, k)).polyline([tf(p), tf(end)]);
        if (p.showName && (p.side === "left" || p.side === "right")) {
          const t = tf({ x: end.x + d[0] * 4, y: end.y + 2.5 });
          const leftward = (toWorld({ x: d[0], y: 0 }, { x: 0, y: 0, rot: c.sch.rot, mirror: c.sch.mirror }).x ?? 0) < 0;
          page.text(t.x, t.y, 7 * k, p.name, leftward ? "end" : "start", [0.12, 0.16, 0.22]);
        }
        if (c.noConnect?.includes(p.id)) {
          const q = tf(p);
          const r = 4 * k;
          page.stroke([0.15, 0.4, 0.9], Math.max(0.5, k)).polyline([{ x: q.x - r, y: q.y - r }, { x: q.x + r, y: q.y + r }]).polyline([{ x: q.x + r, y: q.y - r }, { x: q.x - r, y: q.y + r }]);
        }
      }
      if (part.kind === "part") {
        const rp = map({ x: c.sch.x + rotate(part.symbol.refPos, c.sch.rot).x, y: c.sch.y + rotate(part.symbol.refPos, c.sch.rot).y });
        const vp = map({ x: c.sch.x + rotate(part.symbol.valuePos, c.sch.rot).x, y: c.sch.y + rotate(part.symbol.valuePos, c.sch.rot).y });
        page.text(rp.x, rp.y, 8.5 * k, c.ref, "start", [0.12, 0.16, 0.22]);
        page.text(vp.x, vp.y, 7.5 * k, c.value + (c.dnp ? " (DNP)" : ""), "start", [0.3, 0.33, 0.38]);
      } else {
        const vp = tf(part.symbol.valuePos);
        page.text(vp.x, vp.y, 8 * k, c.value, part.kind === "power" ? "middle" : "start", rgb);
      }
    }
    titleBlock(page, design, sheet.name);
  }
}

// ---------- assembly drawing ----------

/** Top and bottom assembly drawings: outline, component outlines, references, dimensions, notes. */
export function assemblyPdf(design: Design): Uint8Array {
  const pdf = new PdfDocument();
  const outline = boardOutline(design.board);
  for (const side of ["top", "bottom"] as const) {
    const page = pdf.addPage();
    const W = design.board.width;
    const H = design.board.height;
    const availW = page.w - 60;
    const availH = page.h - 60 - 90;
    const k = Math.min(availW / W, availH / H);
    const ox = 30 + (availW - W * k) / 2;
    const oy = 30 + (availH - H * k) / 2;
    const mirror = side === "bottom";
    const map = (p: Vec) => ({ x: ox + (mirror ? W - p.x : p.x) * k, y: oy + p.y * k });
    page.stroke([0, 0, 0], 1.2).polyline([...outline, outline[0]].map(map), true);
    for (const h of design.board.cutouts ?? []) page.polyline([...h, h[0]].map(map), true);
    const parts = design.components.filter((c) => getPart(c.partId)?.footprint && c.pcb.side === side);
    for (const c of parts) {
      const r = courtyardRect(c)!;
      const fp = getPart(c.partId)!.footprint!;
      const grey: RGB = c.dnp ? [0.75, 0.75, 0.75] : [0.25, 0.25, 0.25];
      page.stroke(grey, 0.5).polyline([{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }].map(map), true);
      for (const s of fp.silk) drawShape(page, s, (p) => map(toWorld(p, c.pcb, c.pcb.side === "bottom")), k / 10, grey);
      const ctr = map({ x: c.pcb.x, y: c.pcb.y });
      const size = Math.max(4, Math.min(9, Math.min(r.x1 - r.x0, r.y1 - r.y0) * k * 0.35));
      page.text(ctr.x, ctr.y + size / 3, size, c.ref + (c.dnp ? "*" : ""), "middle", c.dnp ? [0.6, 0.6, 0.6] : [0, 0, 0]);
    }
    for (const g of design.pcbGraphics) {
      if (g.kind === "dimension" && g.points.length >= 2) {
        const [a, b] = g.points;
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        page.stroke([0.1, 0.3, 0.8], 0.6).polyline([map(a), map(b)]);
        const m = map({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        page.text(m.x, m.y - 4, 8, `${len.toFixed(2)} mm`, "middle", [0.1, 0.3, 0.8]);
      } else if (g.kind === "text" && g.points[0]) page.text(map(g.points[0]).x, map(g.points[0]).y, 9, g.text ?? "", "start");
    }
    // Overall dimensions.
    page.stroke([0.1, 0.3, 0.8], 0.6);
    const a = map({ x: 0, y: H + 2 });
    const b = map({ x: W, y: H + 2 });
    page.polyline([a, b]).text((a.x + b.x) / 2, a.y + 12, 8, `${W} mm`, "middle", [0.1, 0.3, 0.8]);
    const c1 = map({ x: mirror ? W + 2 : -2, y: 0 });
    const c2 = map({ x: mirror ? W + 2 : -2, y: H });
    page.polyline([c1, c2]).text(c1.x - 4, (c1.y + c2.y) / 2, 8, `${H} mm`, "end", [0.1, 0.3, 0.8]);
    page.text(30, page.h - 100, 9, `${side === "top" ? "Top" : "Bottom (viewed from bottom)"} assembly · ${parts.length} parts${parts.some((p) => p.dnp) ? " · * = do not populate" : ""}`);
    titleBlock(page, design, `Assembly ${side}`);
  }
  return pdf.toBytes();
}
