import type { Vec } from "@pcbian/core";
import { useCallback, useEffect, useRef, useState } from "react";

/** Screen = world * k + (x, y). */
export interface View {
  x: number;
  y: number;
  k: number;
}

export function useViewport(initial: View, minK: number, maxK: number) {
  const [view, setViewState] = useState(initial);
  const viewRef = useRef(view);
  const svgRef = useRef<SVGSVGElement>(null);
  const setView = useCallback((v: View) => {
    viewRef.current = v;
    setViewState(v);
  }, []);

  const toWorld = useCallback((clientX: number, clientY: number): Vec => {
    const r = svgRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: (clientX - r.left - v.x) / v.k, y: (clientY - r.top - v.y) / v.k };
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const v = viewRef.current;
      // Wheel and pinch both zoom around the cursor.
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      const k = Math.min(maxK, Math.max(minK, v.k * factor));
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      setView({ k, x: sx - ((sx - v.x) * k) / v.k, y: sy - ((sy - v.y) * k) / v.k });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [minK, maxK, setView]);

  const fit = useCallback(
    (b: { x0: number; y0: number; x1: number; y1: number }, pad = 40) => {
      const svg = svgRef.current;
      if (!svg) return;
      const r = svg.getBoundingClientRect();
      if (r.width === 0) return;
      const w = Math.max(b.x1 - b.x0, 1e-3);
      const h = Math.max(b.y1 - b.y0, 1e-3);
      const k = Math.min(maxK, Math.max(minK, Math.min((r.width - pad * 2) / w, (r.height - pad * 2) / h)));
      setView({ k, x: r.width / 2 - ((b.x0 + b.x1) / 2) * k, y: r.height / 2 - ((b.y0 + b.y1) / 2) * k });
    },
    [minK, maxK, setView],
  );

  return { view, viewRef, setView, svgRef, toWorld, fit };
}

/** Starts a pan gesture from a pointer event; call from onPointerDown. */
export function beginPan(e: React.PointerEvent, viewRef: React.RefObject<View>, setView: (v: View) => void) {
  const start = { x: e.clientX, y: e.clientY, v: viewRef.current };
  const target = e.currentTarget as Element;
  target.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => setView({ ...start.v, x: start.v.x + ev.clientX - start.x, y: start.v.y + ev.clientY - start.y });
  const up = () => {
    target.removeEventListener("pointermove", move as EventListener);
    target.removeEventListener("pointerup", up);
  };
  target.addEventListener("pointermove", move as EventListener);
  target.addEventListener("pointerup", up);
}
