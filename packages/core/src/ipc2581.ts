// IPC-2581 (revision C) export: one XML file with BOM, layer stack, board profile, packages,
// components, logical nets and per-layer copper/mask/paste/silk features plus drill layers.
import { boardOutline } from "./doc";
import { fabData, type Feature } from "./fabfeatures";
import { padsOf, polygonArea } from "./geometry";
import { getPart } from "./library";
import { computeNets, netByTerminal, termKey } from "./netlist";
import { copperLayers, OZ_MM, stackupOf } from "./stackup";
import type { CopperLayer, Design, Vec } from "./types";

const n = (v: number) => (Math.round(v * 1e4) / 1e4).toString();
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const LNAME = (l: CopperLayer) => (l === "top" ? "TOP" : l === "bottom" ? "BOTTOM" : `INNER${l.slice(2)}`);

export function ipc2581(design: Design): string {
  const H = design.board.height;
  const up = (p: Vec) => ({ x: p.x, y: H - p.y });
  const data = fabData(design);
  const layers = copperLayers(design.board);
  const st = stackupOf(design.board);
  const now = new Date().toISOString().slice(0, 19);
  const parts = design.components.filter((c) => getPart(c.partId)?.footprint && !c.dnp);
  const nets = computeNets(design).filter((x) => x.terminals.length);
  const netOf = netByTerminal(nets);

  // ---- dictionaries: line widths and pad primitives ----
  const lineIds = new Map<number, string>();
  const lineId = (w: number) => {
    const k = Math.round(w * 1e4) / 1e4;
    if (!lineIds.has(k)) lineIds.set(k, `LINE_${lineIds.size}`);
    return lineIds.get(k)!;
  };
  const prims = new Map<string, { id: string; xml: string }>();
  const prim = (f: Extract<Feature, { kind: "pad" }>) => {
    const key = `${f.shape}:${n(f.w)}x${n(f.h)}`;
    if (!prims.has(key)) {
      const id = `PRIM_${prims.size}`;
      const xml = f.shape === "circle" ? `<Circle diameter="${n(f.w)}"/>` : f.shape === "oval" ? `<Oval width="${n(f.w)}" height="${n(f.h)}"/>` : `<RectCenter width="${n(f.w)}" height="${n(f.h)}"/>`;
      prims.set(key, { id, xml });
    }
    return prims.get(key)!.id;
  };
  const poly = (pts: Vec[], ccw = true) => {
    let p = pts.map(up);
    if (polygonArea(p) > 0 !== ccw) p = [...p].reverse();
    return `<Polygon><PolyBegin x="${n(p[0].x)}" y="${n(p[0].y)}"/>${p
      .slice(1)
      .map((q) => `<PolyStepSegment x="${n(q.x)}" y="${n(q.y)}"/>`)
      .join("")}<PolyStepSegment x="${n(p[0].x)}" y="${n(p[0].y)}"/></Polygon>`;
  };
  // Each feature goes in its own Set so polarity (clear areas of pours, silk clipping) keeps its order.
  const featureSet = (f: Feature) => {
    const pol = f.dark ? "POSITIVE" : "NEGATIVE";
    const net = f.net ? ` net="${esc(f.net)}"` : "";
    if (f.kind === "line") {
      const segs = f.points.slice(1).map((q, i) => {
        const a = up(f.points[i]);
        const b = up(q);
        return `<Features><Line startX="${n(a.x)}" startY="${n(a.y)}" endX="${n(b.x)}" endY="${n(b.y)}"><LineDescRef id="${lineId(f.width)}"/></Line></Features>`;
      });
      return `<Set polarity="${pol}"${net}>${segs.join("")}</Set>`;
    }
    if (f.kind === "pad") {
      const at = up(f.at);
      const pin = f.ref ? `<PinRef componentRef="${esc(f.ref)}" pin="${esc(f.pin ?? "")}"/>` : "";
      return `<Set polarity="${pol}"${net}${f.ref ? ` padUsage="TERMINATION"` : ""}><Pad><Location x="${n(at.x)}" y="${n(at.y)}"/><StandardPrimitiveRef id="${prim(f)}"/>${pin}</Pad></Set>`;
    }
    const cut = (f.holes ?? []).map((h) => `<Cutout>${poly(h).replace(/^<Polygon>|<\/Polygon>$/g, "")}</Cutout>`).join("");
    return `<Set polarity="${pol}"${net}><Features><Contour>${poly(f.points)}${cut}</Contour></Features></Set>`;
  };
  const layerFeature = (ref: string, feats: Feature[]) => (feats.length ? `<LayerFeature layerRef="${ref}">${feats.map(featureSet).join("")}</LayerFeature>` : "");

  const lf: string[] = [];
  for (const c of data.copper) lf.push(layerFeature(LNAME(c.layer), c.features));
  lf.push(layerFeature("SOLDERMASK_TOP", data.mask.top), layerFeature("SOLDERMASK_BOTTOM", data.mask.bottom));
  lf.push(layerFeature("PASTE_TOP", data.paste.top), layerFeature("PASTE_BOTTOM", data.paste.bottom));
  lf.push(layerFeature("SILKSCREEN_TOP", data.silk.top), layerFeature("SILKSCREEN_BOTTOM", data.silk.bottom));
  data.drills.forEach((d, k) => {
    const holes = d.holes.map((h, i) => {
      const at = up(h.at);
      return `<Set${h.net ? ` net="${esc(h.net)}"` : ""}><Hole name="H${k}_${i}" diameter="${n(h.diameter)}" platingStatus="${h.via ? "VIA" : h.plated ? "PLATED" : "NONPLATED"}" plusTol="0" minusTol="0" x="${n(at.x)}" y="${n(at.y)}"/></Set>`;
    });
    if (holes.length) lf.push(`<LayerFeature layerRef="${d.name.toUpperCase()}">${holes.join("")}</LayerFeature>`);
  });

  // ---- packages and components ----
  const pkgs = new Map<string, string>();
  for (const c of parts) {
    const fp = getPart(c.partId)!.footprint!;
    if (pkgs.has(fp.name)) continue;
    const xs = fp.pads.flatMap((p) => [p.x - p.w / 2, p.x + p.w / 2]);
    const ys = fp.pads.flatMap((p) => [p.y - p.h / 2, p.y + p.h / 2]);
    const outline = [
      { x: Math.min(...xs), y: Math.min(...ys) },
      { x: Math.max(...xs), y: Math.min(...ys) },
      { x: Math.max(...xs), y: Math.max(...ys) },
      { x: Math.min(...xs), y: Math.max(...ys) },
    ];
    // Package geometry is local: y up, no board flip.
    const lp = (pts: Vec[]) => `<Polygon><PolyBegin x="${n(pts[0].x)}" y="${n(-pts[0].y)}"/>${pts.slice(1).map((q) => `<PolyStepSegment x="${n(q.x)}" y="${n(-q.y)}"/>`).join("")}<PolyStepSegment x="${n(pts[0].x)}" y="${n(-pts[0].y)}"/></Polygon>`;
    const pins = fp.pads.map((p) => `<Pin number="${esc(p.id)}" type="${p.drill ? "THRU" : "SURFACE"}" electricalType="ELECTRICAL"><Location x="${n(p.x)}" y="${n(-p.y)}"/><StandardPrimitiveRef id="${prim({ kind: "pad", shape: p.shape, at: { x: 0, y: 0 }, w: p.w, h: p.h, dark: true })}"/></Pin>`);
    pkgs.set(fp.name, `<Package name="${esc(fp.name)}" type="OTHER" pinOne="${esc(fp.pads[0]?.id ?? "1")}" pinOneOrientation="OTHER"><Outline>${lp(outline)}<LineDescRef id="${lineId(0.1)}"/></Outline>${pins.join("")}</Package>`);
  }
  const comps = parts.map((c) => {
    const fp = getPart(c.partId)!.footprint!;
    const at = up({ x: c.pcb.x, y: c.pcb.y });
    const smt = fp.pads.every((p) => !p.drill);
    return `<Component refDes="${esc(c.ref)}" packageRef="${esc(fp.name)}" layerRef="${c.pcb.side === "top" ? "TOP" : "BOTTOM"}" mountType="${smt ? "SMT" : "THMT"}" part="${esc(getPart(c.partId)!.mpn ?? c.partId)}"><Xform rotation="${c.pcb.rot}"${c.pcb.side === "bottom" ? ` mirror="true"` : ""}/><Location x="${n(at.x)}" y="${n(at.y)}"/></Component>`;
  });
  const logical = nets
    .map((net) => {
      const pins = net.terminals
        .map((t) => ({ t, c: parts.find((c) => c.id === t.comp) }))
        .filter((x) => x.c && padsOf(x.c).some((p) => p.id === x.t.pin))
        .map((x) => `<PinRef componentRef="${esc(x.c!.ref)}" pin="${esc(x.t.pin)}"/>`);
      return pins.length ? `<LogicalNet name="${esc(net.name)}">${pins.join("")}</LogicalNet>` : "";
    })
    .filter(Boolean);
  void netOf;
  void termKey;

  // ---- layers and stackup ----
  const layerDefs: string[] = [
    `<Layer name="SILKSCREEN_TOP" layerFunction="SILKSCREEN" side="TOP" polarity="POSITIVE"/>`,
    `<Layer name="PASTE_TOP" layerFunction="PASTEMASK" side="TOP" polarity="POSITIVE"/>`,
    `<Layer name="SOLDERMASK_TOP" layerFunction="SOLDERMASK" side="TOP" polarity="POSITIVE"/>`,
  ];
  const stackLayers: string[] = [];
  let seq = 1;
  layers.forEach((l, i) => {
    layerDefs.push(`<Layer name="${LNAME(l)}" layerFunction="SIGNAL" side="${l === "top" ? "TOP" : l === "bottom" ? "BOTTOM" : "INTERNAL"}" polarity="POSITIVE"/>`);
    stackLayers.push(`<StackupLayer layerOrGroupRef="${LNAME(l)}" thickness="${n(st.copperOz[i] * OZ_MM)}" tolPlus="0" tolMinus="0" sequence="${seq++}"/>`);
    const d = st.dielectrics[i];
    if (d) {
      layerDefs.push(`<Layer name="DIELECTRIC_${i + 1}" layerFunction="DIELCORE" side="INTERNAL" polarity="POSITIVE"/>`);
      stackLayers.push(`<StackupLayer layerOrGroupRef="DIELECTRIC_${i + 1}" thickness="${n(d.thickness)}" tolPlus="0" tolMinus="0" sequence="${seq++}"/>`);
    }
  });
  layerDefs.push(
    `<Layer name="SOLDERMASK_BOTTOM" layerFunction="SOLDERMASK" side="BOTTOM" polarity="POSITIVE"/>`,
    `<Layer name="PASTE_BOTTOM" layerFunction="PASTEMASK" side="BOTTOM" polarity="POSITIVE"/>`,
    `<Layer name="SILKSCREEN_BOTTOM" layerFunction="SILKSCREEN" side="BOTTOM" polarity="POSITIVE"/>`,
  );
  for (const d of data.drills) layerDefs.push(`<Layer name="${d.name.toUpperCase()}" layerFunction="DRILL" side="ALL" polarity="POSITIVE"><Span fromLayer="${LNAME(layers[d.from])}" toLayer="${LNAME(layers[d.to])}"/></Layer>`);

  const profile = `<Profile>${poly(boardOutline(design.board))}${(design.board.cutouts ?? []).map((h) => `<Cutout>${poly(h).replace(/^<Polygon>|<\/Polygon>$/g, "")}</Cutout>`).join("")}</Profile>`;

  // ---- BOM ----
  const groups = new Map<string, typeof parts>();
  for (const c of parts) {
    const k = `${c.partId}|${c.value}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(c);
  }
  const bomItems = [...groups.values()].map((cs) => {
    const part = getPart(cs[0].partId)!;
    const des = cs.map((c) => `<RefDes name="${esc(c.ref)}" packageRef="${esc(part.footprint!.name)}" populate="true" layerRef="${c.pcb.side === "top" ? "TOP" : "BOTTOM"}"/>`);
    return `<BomItem OEMDesignNumberRef="${esc(`${part.mpn ?? part.id}-${cs[0].value}`)}" quantity="${cs.length}" pinCount="${part.footprint!.pads.length}" category="ELECTRICAL" description="${esc(part.description)}">${des.join("")}<Characteristics category="ELECTRICAL"><Textual definitionSource="PCBian" textualCharacteristicName="Value" textualCharacteristicValue="${esc(cs[0].value)}"/></Characteristics></BomItem>`;
  });

  const dictLines = [...lineIds].map(([w, id]) => `<EntryLineDesc id="${id}"><LineDesc lineEnd="ROUND" lineWidth="${n(w)}"/></EntryLineDesc>`);
  const dictPrims = [...prims.values()].map((p) => `<EntryStandard id="${p.id}">${p.xml}</EntryStandard>`);
  const step = "board";
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<IPC-2581 revision="C" xmlns="http://webstds.ipc.org/2581" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`,
    `<Content roleRef="Owner"><FunctionMode mode="ASSEMBLY"/><StepRef name="${step}"/>${[...layerDefs.map((l) => l.match(/name="([^"]+)"/)![1])].map((l) => `<LayerRef name="${l}"/>`).join("")}<BomRef name="BOM"/>`,
    `<DictionaryLineDesc units="MILLIMETER">${dictLines.join("")}</DictionaryLineDesc>`,
    `<DictionaryStandard units="MILLIMETER">${dictPrims.join("")}</DictionaryStandard>`,
    `</Content>`,
    `<LogisticHeader><Role id="Owner" roleFunction="SENDER"/><Enterprise id="PCBian" code="NONE"/><Person name="${esc(design.titleBlock.author || "PCBian")}" enterpriseRef="PCBian" roleRef="Owner"/></LogisticHeader>`,
    `<HistoryRecord number="1" origination="${now}" software="PCBian" lastChange="${now}"><FileRevision fileRevisionId="${esc(design.titleBlock.revision || "1")}" comment="" label=""><SoftwarePackage name="PCBian" revision="0.3" vendor="PCBian"><Certification certificationStatus="SELFTEST"/></SoftwarePackage></FileRevision></HistoryRecord>`,
    `<Bom name="BOM"><BomHeader assembly="${esc(design.name)}" revision="${esc(design.titleBlock.revision || "A")}"><StepRef name="${step}"/></BomHeader>${bomItems.join("")}</Bom>`,
    `<Ecad name="${esc(design.name)}"><CadHeader units="MILLIMETER"/><CadData>`,
    layerDefs.join(""),
    `<Stackup name="PRIMARY" overallThickness="${n(design.board.thickness)}" tolPlus="0" tolMinus="0" whereMeasured="METAL" stackupStatus="PROPOSED"><StackupGroup name="GROUP_PRIMARY" thickness="${n(design.board.thickness)}" tolPlus="0" tolMinus="0">${stackLayers.join("")}</StackupGroup></Stackup>`,
    `<Step name="${step}"><Datum x="0" y="0"/>${profile}${[...pkgs.values()].join("")}${comps.join("")}${logical.join("")}${lf.join("")}</Step>`,
    `</CadData></Ecad>`,
    `</IPC-2581>`,
    "",
  ].join("\n");
}
