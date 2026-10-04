// The small 24-hour heat line beside a hot-list entry. Hours without a comparable snapshot break the
// line rather than being drawn as zero; with fewer than three observed hours nothing is drawn. `area`
// lays a faint wash of the line's colour under it (the lead card); the size comes from the class, and
// `stretch` lets the line fill any box (the end dot is drawn as a round cap so it stays round).
export function Sparkline({ values, className = "h-6 w-[88px]", area = false, stretch = false }: { values: Array<number | null>; className?: string; area?: boolean; stretch?: boolean }) {
  const W = 104;
  const H = 32;
  const pad = 3;
  const seen = values.filter((v): v is number => v !== null);
  if (seen.length < 3) return <span className={`block ${className}`} aria-hidden="true" />;
  // Scaled from zero, so a small wobble on a steady story stays a small wobble.
  const max = Math.max(...seen) || 1;
  const step = (W - pad * 2) / Math.max(1, values.length - 1);
  const x = (i: number) => pad + i * step;
  const y = (v: number) => pad + (1 - v / max) * (H - pad * 2);
  const runs: string[] = [];
  let run: string[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (run.length) runs.push(run.join(" "));
      run = [];
    } else run.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  });
  if (run.length) runs.push(run.join(" "));
  let last = values.length - 1;
  while (last >= 0 && values[last] === null) last--;
  const gaps = seen.length < values.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio={stretch ? "none" : undefined} className={`overflow-visible ${className}`} role="img" aria-label={`近 24 小时热度走势${gaps ? "，部分时段缺少可比数据" : ""}`}>
      {area &&
        runs.map((pts) => {
          const xs = pts.split(" ").map((p) => p.split(",")[0]);
          return <polygon key={`a${pts}`} points={`${xs[0]},${H} ${pts} ${xs[xs.length - 1]},${H}`} fill="currentColor" opacity="0.08" />;
        })}
      {runs.map((pts) => (
        <polyline key={pts} points={pts} fill="none" stroke="currentColor" strokeWidth={stretch ? 2 : 1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      ))}
      {stretch ? (
        <>
          <path d={`M${x(last)} ${y(values[last]!)}h0`} stroke="currentColor" strokeWidth="8" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          <path d={`M${x(last)} ${y(values[last]!)}h0`} stroke="var(--surface)" strokeWidth="4" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </>
      ) : (
        <circle cx={x(last)} cy={y(values[last]!)} r="2.5" fill="var(--surface)" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      )}
    </svg>
  );
}
