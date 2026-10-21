import { boardOutline, copperLayers, enclosure, getPart, modelPlacement, padsOf, type ComponentData, type CopperLayer } from "@pcbian/core";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { useEditor } from "./context";
import { modelMeshes, type ModelMesh } from "../lib/models";

interface BodyStyle {
  h: number;
  color: number;
  shape?: "box" | "cylinder";
  pins?: number;
  scale?: number;
}

/** Rough 3D body for a footprint, from its name. Heights in mm. */
function bodyStyle(c: ComponentData): BodyStyle {
  const part = getPart(c.partId)!;
  const name = part.footprint!.name;
  const id = c.partId;
  if (id.startsWith("led")) {
    const v = c.value.toLowerCase();
    const color = /green/.test(v) ? 0x22c55e : /blue/.test(v) ? 0x3b82f6 : /white/.test(v) ? 0xf8fafc : /yellow|amber|orange/.test(v) ? 0xf59e0b : 0xef4444;
    return { h: 0.6, color, scale: 0.7 };
  }
  if (/^0402|^0603|^0805|^1206/.test(name)) return { h: name === "0402" ? 0.35 : name === "0603" ? 0.45 : 0.6, color: id.startsWith("resistor") ? 0x1f2937 : id.startsWith("capacitor") ? 0xc8a165 : 0x4b5563, scale: 0.72 };
  if (name.startsWith("SOD")) return { h: 1.1, color: 0x111827, scale: 0.65 };
  if (name.startsWith("SOT-23")) return { h: 1.0, color: 0x111827, scale: 0.55 };
  if (name.startsWith("SOT-223")) return { h: 1.7, color: 0x111827, scale: 0.6 };
  if (name.startsWith("SOIC")) return { h: 1.6, color: 0x111827, scale: 0.62 };
  if (name.startsWith("TQFP")) return { h: 1.2, color: 0x111827, scale: 0.72 };
  if (name.startsWith("DIP")) return { h: 3.5, color: 0x111827, scale: 0.62 };
  if (name.startsWith("PinHeader")) return { h: 2.5, color: 0x111111, pins: 6, scale: 0.85 };
  if (name.startsWith("CP_Radial")) return { h: 11, color: 0x1e3a8a, shape: "cylinder", scale: 0.95 };
  if (name.startsWith("SW_PUSH")) return { h: 3.5, color: 0x27272a, scale: 0.72 };
  if (name.startsWith("Crystal")) return { h: 3.5, color: 0xd1d5db, scale: 0.8 };
  if (name.startsWith("USB")) return { h: 3.2, color: 0xc0c7d1, scale: 0.92 };
  return { h: 1.5, color: 0x1f2937, scale: 0.75 };
}

const DEFAULT_MODEL_COLOR: [number, number, number] = [0.55, 0.57, 0.6];

/** Three.js meshes (geometry + materials, shared by every part using the model) for a STEP model. */
function modelObjects(meshes: ModelMesh[]): { geometry: THREE.BufferGeometry; materials: THREE.Material[] }[] {
  return meshes.map((m) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(m.index, 1));
    if (m.normals && m.normals.length === m.positions.length) geometry.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
    else geometry.computeVertexNormals();
    const key = (c: [number, number, number] | null) => (c ?? m.color ?? DEFAULT_MODEL_COLOR).map((v) => v.toFixed(3)).join(",");
    const colors = [...new Set(m.faces.length ? m.faces.map((f) => key(f.color)) : [key(null)])];
    const materials = colors.map((k) => {
      const [r, g, b] = k.split(",").map(Number);
      return new THREE.MeshStandardMaterial({ color: new THREE.Color(r, g, b), roughness: 0.55, metalness: r > 0.7 && g > 0.6 ? 0.6 : 0.1, side: THREE.DoubleSide });
    });
    if (m.faces.length) for (const f of m.faces) geometry.addGroup(f.first * 3, (f.last - f.first + 1) * 3, colors.indexOf(key(f.color)));
    else geometry.addGroup(0, m.index.length, 0);
    return { geometry, materials };
  });
}

export function Board3D() {
  const { design, toast } = useEditor();
  /** Loaded models by file id (null while loading or after a failure). */
  const models = useRef(new Map<string, ReturnType<typeof modelObjects> | null>());
  const [modelsLoaded, setModelsLoaded] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const three = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; group: THREE.Group } | null>(null);
  const [error, setError] = useState("");

  // Set up the renderer once.
  useEffect(() => {
    const el = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    } catch {
      setError("WebGL is not available in this browser.");
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x12151b);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(40, 80, 60);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    const group = new THREE.Group();
    scene.add(group);
    three.current = { renderer, scene, camera, controls, group };

    const resize = () => {
      const r = el.getBoundingClientRect();
      renderer.setSize(r.width, r.height);
      camera.aspect = r.width / Math.max(1, r.height);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    let raf = 0;
    const loop = () => {
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      el.removeChild(renderer.domElement);
      three.current = null;
    };
  }, []);

  // Frame the camera on the board when it first appears or changes size.
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    const { width: W, height: H } = design.board;
    t.controls.target.set(W / 2, 0, H / 2);
    const span = Math.max(W, H);
    t.camera.position.set(W / 2 + span * 0.2, span * 1.25, H / 2 + span * 1.25);
    t.controls.update();
  }, [design.board.width, design.board.height]);

  // Rebuild the model whenever the design changes.
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    const g = t.group;
    for (const child of [...g.children]) {
      g.remove(child);
      child.traverse((o) => {
        if (o instanceof THREE.Mesh && !o.userData.shared) {
          o.geometry.dispose();
          (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
        }
      });
    }
    const { thickness: T } = design.board;
    const mat = (color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05, ...extra });
    const gold = mat(0xd4a64a, { metalness: 0.85, roughness: 0.3 });
    const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      mesh.position.set(x, y, z);
      g.add(mesh);
      return mesh;
    };

    // Board (FR-4 core with green soldermask).
    // Extruded from the real outline so shaped boards and cutouts show correctly.
    const v2 = (pts: { x: number; y: number }[]) => pts.map((p) => new THREE.Vector2(p.x, p.y));
    const boardShape = new THREE.Shape(v2(boardOutline(design.board)));
    for (const c of design.board.cutouts ?? []) if (c.length >= 3) boardShape.holes.push(new THREE.Path(v2(c)));
    const boardMesh = new THREE.Mesh(new THREE.ExtrudeGeometry(boardShape, { depth: T, bevelEnabled: false, curveSegments: 4 }), mat(0x0f5132, { roughness: 0.45 }));
    // Shape XY maps to world XZ; the extrusion runs from y=0 down to y=-T.
    boardMesh.rotation.x = Math.PI / 2;
    g.add(boardMesh);

    // Copper pours and traces show through the mask as slightly lighter green.
    const layers = copperLayers(design.board);
    const surfaceY = (l: CopperLayer) => (l === "top" ? 0.012 : l === "bottom" ? -T - 0.012 : null);
    const pourMat = mat(0x1a6b45, { roughness: 0.4, side: THREE.DoubleSide });
    for (const z of design.zones) {
      const y = surfaceY(z.layer);
      if (y === null || !layers.includes(z.layer)) continue;
      const shape = new THREE.Shape(z.points.map((p) => new THREE.Vector2(p.x, p.y)));
      const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), pourMat);
      mesh.rotation.x = Math.PI / 2;
      mesh.position.y = y;
      g.add(mesh);
    }
    const traceMat = mat(0x22874f, { roughness: 0.35 });
    for (const tr of design.traces) {
      const y = surfaceY(tr.layer);
      if (y === null) continue;
      for (let i = 1; i < tr.points.length; i++) {
        const a = tr.points[i - 1];
        const b = tr.points[i];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const seg = box(len + tr.width, 0.03, tr.width, traceMat, (a.x + b.x) / 2, y + 0.005, (a.y + b.y) / 2);
        seg.rotation.y = -Math.atan2(b.y - a.y, b.x - a.x);
      }
    }
    const holeMat = mat(0x050505);
    for (const v of design.vias) {
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(v.diameter / 2, v.diameter / 2, T + 0.06, 16), gold);
      ring.position.set(v.x, -T / 2, v.y);
      g.add(ring);
      const hole = new THREE.Mesh(new THREE.CylinderGeometry(v.drill / 2, v.drill / 2, T + 0.08, 12), holeMat);
      hole.position.set(v.x, -T / 2, v.y);
      g.add(hole);
    }

    // Pads and component bodies.
    for (const c of design.components) {
      const part = getPart(c.partId);
      if (!part?.footprint) continue;
      for (const p of padsOf(c)) {
        if (p.drill) {
          const cyl = new THREE.Mesh(new THREE.CylinderGeometry(Math.min(p.ww, p.wh) / 2, Math.min(p.ww, p.wh) / 2, T + 0.08, 20), gold);
          cyl.position.set(p.world.x, -T / 2, p.world.y);
          g.add(cyl);
          const hole = new THREE.Mesh(new THREE.CylinderGeometry(p.drill / 2, p.drill / 2, T + 0.1, 12), holeMat);
          hole.position.set(p.world.x, -T / 2, p.world.y);
          g.add(hole);
        } else {
          const y = c.pcb.side === "top" ? 0.025 : -T - 0.025;
          box(p.ww, 0.05, p.wh, gold, p.world.x, y, p.world.y).rotation.y = (-p.angle * Math.PI) / 180;
        }
      }
      if (c.dnp) continue;
      // An uploaded STEP model replaces the generic body once it has loaded.
      const model = part.footprint.model;
      if (model?.file) {
        const loaded = models.current.get(model.file);
        if (loaded === undefined) {
          models.current.set(model.file, null);
          modelMeshes(model.file).then(
            (ms) => {
              models.current.set(model.file, modelObjects(ms));
              setModelsLoaded((n) => n + 1);
            },
            (e) => toast(`3D model ${model.name}: ${(e as Error).message}`),
          );
        }
        if (loaded) {
          const a = modelPlacement(c, model, design.board, "view");
          const m4 = new THREE.Matrix4().set(a.x[0], a.y[0], a.z[0], a.t[0], a.x[1], a.y[1], a.z[1], a.t[1], a.x[2], a.y[2], a.z[2], a.t[2], 0, 0, 0, 1);
          for (const { geometry, materials } of loaded) {
            const mesh = new THREE.Mesh(geometry, materials);
            mesh.userData.shared = true;
            mesh.matrixAutoUpdate = false;
            mesh.matrix.copy(m4);
            g.add(mesh);
          }
          continue;
        }
      }
      const st = bodyStyle(c);
      // Bodies are built in the footprint frame and turned with the part (any angle).
      const cw = part.footprint.courtyard.w * (st.scale ?? 0.75);
      const ch = part.footprint.courtyard.h * (st.scale ?? 0.75);
      const dir = c.pcb.side === "top" ? 1 : -1;
      const base = c.pcb.side === "top" ? 0.05 : -T - 0.05;
      const bodyMat = mat(st.color, c.partId.startsWith("led") ? { transparent: true, opacity: 0.85, emissive: st.color, emissiveIntensity: 0.25 } : st.color === 0xc0c7d1 || st.color === 0xd1d5db ? { metalness: 0.8, roughness: 0.3 } : {});
      if (st.shape === "cylinder") {
        const r = Math.min(cw, ch) / 2;
        const cyl = new THREE.Mesh(new THREE.CylinderGeometry(r, r, st.h, 32), bodyMat);
        cyl.position.set(c.pcb.x, base + (dir * st.h) / 2, c.pcb.y);
        g.add(cyl);
      } else {
        box(cw, st.h, ch, bodyMat, c.pcb.x, base + (dir * st.h) / 2, c.pcb.y).rotation.y = (-c.pcb.rot * Math.PI) / 180;
      }
      if (st.pins) {
        for (const p of padsOf(c)) box(0.64, st.pins, 0.64, gold, p.world.x, base + dir * (st.h + st.pins / 2 - 0.5), p.world.y);
      }
      if (c.partId.startsWith("button")) {
        const cap = new THREE.Mesh(new THREE.CylinderGeometry(1.75, 1.75, 1.5, 24), mat(0x6b7280));
        cap.position.set(c.pcb.x, base + dir * (st.h + 0.75), c.pcb.y);
        g.add(cap);
      }
    }

    // The enclosure, when shown: see-through so the board stays visible. Its solids are in the STEP
    // frame (y up, board bottom at z = 0); the view has y up from the top surface and z = board y.
    if (design.enclosure?.show) {
      const e = enclosure(design, design.enclosure);
      const toView = (z0: number) => new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, z0 - T, 0, -1, 0, design.board.height, 0, 0, 0, 1);
      const baseMat = mat(0xc4c9d1, { transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
      const lidMat = mat(0x9aa3ad, { transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide });
      for (const [solids, m] of [
        [e.base, baseMat],
        [e.lid, lidMat],
      ] as const)
        for (const sd of solids) {
          const shape = new THREE.Shape(sd.outer.map((p) => new THREE.Vector2(p.x, p.y)));
          for (const h of sd.holes ?? []) shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p.x, p.y))));
          const mesh = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: sd.z1 - sd.z0, bevelEnabled: false, curveSegments: 12 }), m);
          mesh.matrixAutoUpdate = false;
          mesh.matrix.copy(toView(sd.z0));
          g.add(mesh);
        }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design, modelsLoaded]);

  return (
    <>
      <div ref={host} style={{ position: "absolute", inset: 0 }} />
      {error && <div className="hint">{error}</div>}
      {!error && <div className="hint">Drag to orbit · right-drag to pan · scroll to zoom</div>}
    </>
  );
}
