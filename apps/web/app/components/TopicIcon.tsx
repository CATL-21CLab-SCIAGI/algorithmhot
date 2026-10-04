import type { ReactNode } from "react";

// Local topic marks, including lettermarks for institutions. No remote image requests.
const MARKS: Record<string, { tone: string; drawing: ReactNode }> = {
  algorithm: { tone: "text-teal-700 dark:text-teal-300", drawing: <><path d="M5 18 12 5l7 13M8 13h8" /><circle cx="12" cy="5" r="2" fill="currentColor" stroke="none" /></> },
  ai4ai: { tone: "text-violet-600 dark:text-violet-300", drawing: <><path d="M6 8a7 7 0 0 1 12 0M18 16a7 7 0 0 1-12 0M6 4v4h4M18 20v-4h-4" /><path d="m12 9 1 2 2 1-2 1-1 2-1-2-2-1 2-1z" /></> },
  ai4s: { tone: "text-cyan-700 dark:text-cyan-300", drawing: <><path d="M9 3h6M10 3v7L5 18a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-8V3M8 15h8" /><circle cx="11" cy="18" r=".8" fill="currentColor" /></> },
  "data-training": { tone: "text-blue-600 dark:text-blue-300", drawing: <><path d="M4 19h16M6 15v-4M12 15V8M18 15V4M4 8l6-4 4 2 6-4" /></> },
  reasoning: { tone: "text-amber-700 dark:text-amber-300", drawing: <><path d="M4 17h4l4-10h8M5 7h3M16 17h3" /><circle cx="4" cy="17" r="2" /><circle cx="20" cy="7" r="2" /><path d="m15 4 3 3-3 3" /></> },
  agent: { tone: "text-indigo-600 dark:text-indigo-300", drawing: <><rect x="5" y="7" width="14" height="12" rx="4" /><path d="M12 3v4M2 11v4M22 11v4M9 15h6" /><circle cx="9" cy="11" r=".8" fill="currentColor" /><circle cx="15" cy="11" r=".8" fill="currentColor" /></> },
  "synthetic-data": { tone: "text-fuchsia-600 dark:text-fuchsia-300", drawing: <><ellipse cx="10" cy="6" rx="6" ry="2.5" /><path d="M4 6v11c0 3 12 3 12 0v-5M4 11c0 3 7 3 10 1" /><path d="m19 2 1 3 3 1-3 1-1 3-1-3-3-1 3-1z" fill="currentColor" stroke="none" /></> },
  materials: { tone: "text-emerald-700 dark:text-emerald-300", drawing: <><path d="m12 3 8 5v9l-8 5-8-5V8zM4 8l8 5 8-5M12 13v9M8 5.5l8 5v9" /></> },
  "computational-physics": { tone: "text-sky-600 dark:text-sky-300", drawing: <><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(35 12 12)" /><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(-35 12 12)" /><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" /></> },
  "molecular-modeling": { tone: "text-rose-600 dark:text-rose-300", drawing: <><path d="m6 7 6 5 6-6M12 12l-4 7M12 12l7 6" /><circle cx="6" cy="7" r="3" /><circle cx="18" cy="6" r="3" /><circle cx="12" cy="12" r="2" /><circle cx="8" cy="19" r="2" /><circle cx="19" cy="18" r="2.5" /></> },
  reproducibility: { tone: "text-green-700 dark:text-green-300", drawing: <><path d="M4 10a8 8 0 1 1 1 7M4 4v6h6M9 13l2 2 5-5" /></> },
  papers: { tone: "text-slate-600 dark:text-slate-300", drawing: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5" /></> },
  benchmarks: { tone: "text-orange-700 dark:text-orange-300", drawing: <><path d="M5 20V10h4v10M10 20V4h4v16M15 20v-7h4v7M3 20h18" /></> },
  "open-source": { tone: "text-teal-700 dark:text-teal-300", drawing: <><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16" /></> },
  tutorials: { tone: "text-amber-700 dark:text-amber-300", drawing: <><path d="M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1v14M6 8l3 1M15 9l3-1" /></> },
  google: { tone: "text-blue-600 dark:text-blue-300", drawing: <><path d="M12 8c-6-8-14 8-6 8 5 0 7-11 12-11 7 0 6 12 0 12-3 0-4-2-5-4" /><circle cx="19" cy="18" r="2" fill="currentColor" stroke="none" /></> },
  bair: { tone: "text-blue-900 dark:text-amber-200", drawing: <><path d="M7 20V4h6a4 4 0 0 1 0 8H7m6 0a4 4 0 0 1 0 8H7" /><path d="M4 4h3M4 20h3" stroke="#c99a32" strokeWidth="2.4" /></> },
  "hugging-face": { tone: "text-amber-600 dark:text-amber-300", drawing: <><circle cx="12" cy="10" r="7" fill="currentColor" fillOpacity=".18" /><path d="M9 10h.1M15 10h.1M9 13q3 3 6 0M3 14l4 2-2-4M21 14l-4 2 2-4M3 14c-2 5 4 8 7 5M21 14c2 5-4 8-7 5" /></> },
};

export function TopicIcon({ slug, size = 40, className = "" }: { slug: string; size?: number; className?: string }) {
  const mark = MARKS[slug] ?? MARKS.papers!;
  return <span aria-hidden="true" className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-tile ${mark.tone} ${className}`} style={{ width: size, height: size }}>
    <span className="absolute inset-0 bg-current opacity-[0.08] dark:opacity-[0.13]" />
    <svg width={size * .6} height={size * .6} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" className="relative">{mark.drawing}</svg>
  </span>;
}
