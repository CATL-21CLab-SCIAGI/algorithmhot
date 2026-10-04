import { useMemo, useState } from "react";
import type { HeatPoint } from "@aihot/contracts/site";
import { monthDayTime } from "../../lib/format";
import { useEntrance } from "../../lib/hydration";

const HOUR = 3600 * 1000;
const W = 742;
const H = 280;
const PAD = { l: 44, r: 16, t: 12, b: 44 };

function niceStep(max: number): number {
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw || 1));
  return ([1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw) || 1;
}

/**
 * Hourly heat of one story over its comparable range. Hours that were not fully observed leave a gap
 * instead of being drawn as zero; with fewer than three observed hours there is no chart.
 */
export function HeatChart({ points }: { points: HeatPoint[] }) {
  const [active, setActive] = useState<number | null>(null);
  const entrance = useEntrance();
  const series = useMemo(() => {
    if (points.length === 0) return [];
    const byHour = new Map(points.map((p) => [Date.parse(p.hour), p]));
    const start = Date.parse(points[0]!.hour);
    const end = Date.parse(points[points.length - 1]!.hour);
    const out: Array<{ t: number; p: HeatPoint | null }> = [];
    for (let t = start; t <= end; t += HOUR) out.push({ t, p: byHour.get(t) ?? null });
    return out;
  }, [points]);
  const geometry = useMemo(() => {
    const seen = series.filter((s) => s.p);
    if (seen.length < 3) return null;
  
    const last = seen[seen.length - 1]!;
    const peak = seen.reduce((a, b) => (b.p!.heat > a.p!.heat ? b : a));
    const dayAgo = series.find((s) => s.t === last.t - 24 * HOUR)?.p;
    const change = dayAgo && dayAgo.heat > 0 ? Math.round(((last.p!.heat - dayAgo.heat) / dayAgo.heat) * 100) : null;
  
    const step = niceStep(peak.p!.heat);
    const top = Math.max(step, Math.ceil(peak.p!.heat / step) * step);
    const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
    const t0 = series[0]!.t;
    const span = Math.max(HOUR, series[series.length - 1]!.t - t0);
    const x = (t: number) => PAD.l + ((t - t0) / span) * (W - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + (1 - v / top) * (H - PAD.t - PAD.b);
    const base = H - PAD.b;
  
    // Runs of consecutive observed hours become separate line and area pieces.
    const runs: Array<Array<{ t: number; p: HeatPoint }>> = [];
    let run: Array<{ t: number; p: HeatPoint }> = [];
    for (const s of series) {
      if (s.p) run.push({ t: s.t, p: s.p });
      else if (run.length) {
        runs.push(run);
        run = [];
      }
    }
    if (run.length) runs.push(run);
    const line = runs.map((r) => r.map((s, i) => `${i ? "L" : "M"}${x(s.t).toFixed(1)} ${y(s.p.heat).toFixed(1)}`).join(" ")).join(" ");
    const area = runs
      .map((r) => {
        const a = r.map((s, i) => `${i ? "L" : "M"}${x(s.t).toFixed(1)} ${y(s.p.heat).toFixed(1)}`).join(" ");
        if (r.length === 1) return "";
        return `${a} L${x(r[r.length - 1]!.t).toFixed(1)} ${base} L${x(r[0]!.t).toFixed(1)} ${base} Z`;
      })
      .join(" ");
    const labels = [0, 1 / 3, 2 / 3, 1].map((f) => t0 + Math.round((f * span) / HOUR) * HOUR);
    return { seen, last, peak, change, ticks, x, y, base, line, area, labels };
  }, [series]);
  if (!geometry) {
    return <p className="rounded-tile bg-bg-sunk px-4 py-8 text-center text-[13px] text-ink-4">还没有足够的连续观测数据，暂不绘制趋势。</p>;
  }
  const { seen, last, peak, change, ticks, x, y, base, line, area, labels } = geometry;
  const cur = active !== null ? seen[active] : null;
  const pick = (clientX: number, rect: DOMRect) => {
    const px = ((clientX - rect.left) / rect.width) * W;
    let best = 0;
    seen.forEach((s, i) => {
      if (Math.abs(x(s.t) - px) < Math.abs(x(seen[best]!.t) - px)) best = i;
    });
    setActive(best);
  };

  return (
    <div>
      <p className="text-[12.5px] text-ink-3">
        当前热度 <b className="num font-semibold text-ink">{Math.round(last.p!.heat)}</b>
        <span className="mx-1.5 text-ink-4">·</span>
        可比范围峰值 <b className="num font-semibold text-ink">{Math.round(peak.p!.heat)}</b>
        <span className="num text-ink-4">（{monthDayTime(new Date(peak.t).toISOString())}）</span>
        <span className="mx-1.5 text-ink-4">·</span>
        近 24 小时可比范围变化{" "}
        <b className={`num font-semibold ${change === null ? "text-ink-4" : change > 0 ? "text-hot" : "text-ink"}`}>
          {change === null ? "–" : `${change > 0 ? "+" : ""}${change}%`}
        </b>
      </p>
      <div className="relative mt-4">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full touch-pan-y select-none outline-none"
          role="img"
          aria-label={`热度走势：当前 ${Math.round(last.p!.heat)}，峰值 ${Math.round(peak.p!.heat)}`}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") setActive((a) => Math.min(seen.length - 1, a === null ? seen.length - 1 : a + 1));
            else if (e.key === "ArrowLeft") setActive((a) => Math.max(0, a === null ? seen.length - 1 : a - 1));
            else if (e.key === "Escape") setActive(null);
            else return;
            e.preventDefault();
          }}
          onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
          onPointerDown={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
          onPointerLeave={(e) => e.pointerType === "mouse" && setActive(null)}
          onBlur={() => setActive(null)}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--line-soft)" strokeWidth={v === 0 ? 1.2 : 1} />
              <text x={PAD.l - 9} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--ink-4)" className="mono">
                {v}
              </text>
            </g>
          ))}
          <path d={area} fill="var(--note)" fillOpacity={0.1} className={entrance ? "anim-fade-in" : ""} style={entrance ? { animationDuration: "500ms", animationDelay: "300ms" } : undefined} />
          <path
            d={line}
            fill="none"
            stroke="var(--note)"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            pathLength={1}
            className={entrance ? "anim-draw" : ""}
          />
          {!cur && (
            <g>
              <circle cx={x(last.t)} cy={y(last.p!.heat)} r="5" fill="var(--surface)" stroke="var(--note)" strokeWidth="2" />
              <circle cx={x(last.t)} cy={y(last.p!.heat)} r="2" fill="var(--note)" />
            </g>
          )}
          {cur && (
            <g>
              <line x1={x(cur.t)} x2={x(cur.t)} y1={PAD.t} y2={base} stroke="var(--line-strong)" strokeDasharray="3 3" />
              <circle cx={x(cur.t)} cy={y(cur.p!.heat)} r="5" fill="var(--surface)" stroke="var(--accent)" strokeWidth="2" />
            </g>
          )}
          {labels.map((t, i) => {
            const [d, hm] = monthDayTime(new Date(t).toISOString()).split(" ");
            return (
              <text key={t} x={x(t)} y={base + 18} textAnchor={i === 0 ? "start" : i === labels.length - 1 ? "end" : "middle"} fontSize="11" fill="var(--ink-4)" className="mono">
                <tspan x={x(t)}>{d}</tspan>
                <tspan x={x(t)} dy="14">
                  {hm}
                </tspan>
              </text>
            );
          })}
        </svg>
        {cur && (
          <div
            className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 whitespace-nowrap rounded-control border border-line bg-raised px-2.5 py-1.5 text-[12px] shadow-[var(--shadow-pop)]"
            style={{ left: `${Math.min(88, Math.max(12, (x(cur.t) / W) * 100))}%` }}
          >
            <div className="num text-ink-4">{monthDayTime(new Date(cur.t).toISOString())}</div>
            <div className="text-ink-2">
              热度 <b className="num font-semibold text-ink">{cur.p!.heat.toFixed(1)}</b>
              <span className="mx-1 text-ink-4">·</span>
              <span className="num">{cur.p!.participants}</span> 位参与者
            </div>
          </div>
        )}
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-ink-4">
        趋势仅比较持续完整观测到的相同主体，范围可能小于当前热度统计。移动指针或点击图表查看每小时热度；键盘可用左右方向键切换。
      </p>
    </div>
  );
}
