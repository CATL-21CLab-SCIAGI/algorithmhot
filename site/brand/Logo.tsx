// 站点的字标和圆环标记：页面用 Wordmark 画站名（size 是高度，单位像素），RingMark 是小标记，转起来就是加载动画。
// 这里用站名排字：“·”前的英文名一行，后面的中文副名一行小字；有自己的 Logo 时，把 Wordmark 换成你的 SVG（保持同样的参数）。
import { SITE } from "../site.ts";

export function Wordmark({ size = 24, className = "", title = SITE.name }: { size?: number; className?: string; title?: string }) {
  // “AlgorithmHot · 科研热点”：英文名一行，中文副名一行小字，站名较长，字号封顶，免得撑开侧栏。
  const [name, subtitle] = SITE.name.split(/\s*·\s*/);
  return (
    <span className={`inline-flex items-center font-black leading-none tracking-[-0.03em] ${className}`} style={{ fontSize: Math.min(Math.round(size * 0.92), 20) }} aria-label={title} role="img">
      <span aria-hidden="true" className="mr-[0.3em] inline-block size-[0.42em] rounded-full bg-accent" />
      <span aria-hidden="true" className="min-w-0">
        <span className="block whitespace-nowrap">{name}</span>
        {subtitle && <span className="mt-1 block text-[11px] font-medium tracking-[0.16em] text-ink-3">{subtitle}</span>}
      </span>
    </span>
  );
}

/** A ring with a dot; spinning, it is the loader. */
export function RingMark({ className = "", spinning = false }: { className?: string; spinning?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <g style={spinning ? { transformOrigin: "12px 12px", animation: "spin-slow 1.1s linear infinite" } : undefined}>
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeDasharray="42 15" />
      </g>
      <circle cx="12" cy="12" r="2.6" fill="currentColor" />
    </svg>
  );
}
