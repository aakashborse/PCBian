import { useMemo, useRef, useState } from "react";

/** Validated categorical order (dark surface), assigned by series position, never cycled. */
export const SERIES_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

export interface Series {
  name: string;
  values: number[];
}

interface Props {
  title: string;
  x: number[];
  series: Series[];
  xLabel: string;
  yUnit: string;
  logX?: boolean;
  height?: number;
  formatX?: (v: number) => string;
}

const W = 300;
const PAD = { l: 44, r: 10, t: 8, b: 26 };

function niceTicks(lo: number, hi: number, n = 4): number[] {
  if (!(hi > lo)) return [lo];
  const step0 = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

export const si = (v: number, unit = "") => {
  const a = Math.abs(v);
  if (a === 0) return `0${unit}`;
  const [d, p] = a >= 1e6 ? [1e6, "M"] : a >= 1e3 ? [1e3, "k"] : a >= 1 ? [1, ""] : a >= 1e-3 ? [1e-3, "m"] : a >= 1e-6 ? [1e-6, "µ"] : [1e-9, "n"];
  return `${+(v / d).toPrecision(3)}${p}${unit}`;
};

export function LineChart({ title, x, series, xLabel, yUnit, logX, height = 150, formatX }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const H = height;
  const fx = formatX ?? ((v: number) => si(v, xLabel === "time" ? "s" : "Hz"));
  const { sx, sy, yTicks, xTicks } = useMemo(() => {
    const xs = logX ? x.map(Math.log10) : x;
    const x0 = Math.min(...xs);
    const x1 = Math.max(...xs);
    const all = series.flatMap((s) => s.values).filter(Number.isFinite);
    let y0 = Math.min(...all);
    let y1 = Math.max(...all);
    if (!(y1 > y0)) (y0 -= 1), (y1 += 1);
    const pad = (y1 - y0) * 0.06;
    y0 -= pad;
    y1 += pad;
    const sx = (v: number) => PAD.l + (((logX ? Math.log10(v) : v) - x0) / (x1 - x0 || 1)) * (W - PAD.l - PAD.r);
    const sy = (v: number) => PAD.t + (1 - (v - y0) / (y1 - y0)) * (H - PAD.t - PAD.b);
    const yTicks = niceTicks(y0, y1, 4);
    const xTicks = logX ? Array.from({ length: Math.floor(x1) - Math.ceil(x0) + 1 }, (_, i) => 10 ** (Math.ceil(x0) + i)) : niceTicks(x0, x1, 4);
    return { sx, sy, yTicks, xTicks };
  }, [x, series, logX, H]);

  // Downsample long series for drawing (keeps ~600 points per series).
  const stride = Math.max(1, Math.floor(x.length / 600));
  const paths = series.map((s) => {
    let d = "";
    for (let i = 0; i < x.length; i += stride) if (Number.isFinite(s.values[i])) d += `${d ? "L" : "M"}${sx(x[i]).toFixed(1)},${sy(s.values[i]).toFixed(1)}`;
    return d;
  });

  const onMove = (e: React.PointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < x.length; i += Math.max(1, Math.floor(stride / 2))) {
      const d = Math.abs(sx(x[i]) - px);
      if (d < bd) (bd = d), (best = i);
    }
    setHover(best);
  };

  return (
    <figure className="chart">
      <figcaption>{title}</figcaption>
      {series.length > 1 && (
        <div className="chart-legend">
          {series.map((s, i) => (
            <span key={s.name}>
              <i style={{ background: SERIES_COLORS[i] }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <div style={{ position: "relative" }}>
        <svg ref={svg} viewBox={`0 0 ${W} ${H}`} width="100%" onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={title}>
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={W - PAD.r} y1={sy(t)} y2={sy(t)} stroke="#262c36" strokeWidth={1} />
              <text x={PAD.l - 4} y={sy(t) + 3} fontSize={8.5} fill="#8b93a3" textAnchor="end">
                {si(t, yUnit)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} x={sx(t)} y={H - 10} fontSize={8.5} fill="#8b93a3" textAnchor="middle">
              {fx(t)}
            </text>
          ))}
          <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} stroke="#3a4352" />
          {paths.map((d, i) => (
            <path key={series[i].name} d={d} fill="none" stroke={SERIES_COLORS[i]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {hover !== null && (
            <g pointerEvents="none">
              <line x1={sx(x[hover])} x2={sx(x[hover])} y1={PAD.t} y2={H - PAD.b} stroke="#8b93a3" strokeDasharray="3 3" />
              {series.map((s, i) => (Number.isFinite(s.values[hover]) ? <circle key={s.name} cx={sx(x[hover])} cy={sy(s.values[hover])} r={4} fill={SERIES_COLORS[i]} stroke="#12151b" strokeWidth={2} /> : null))}
            </g>
          )}
        </svg>
        {hover !== null && (
          <div className="chart-tip" style={{ left: `${Math.min(70, (sx(x[hover]) / W) * 100)}%` }}>
            <b>{fx(x[hover])}</b>
            {series.map((s, i) => (
              <div key={s.name}>
                <i style={{ background: SERIES_COLORS[i] }} />
                {s.name}: {si(s.values[hover], yUnit)}
              </div>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}
