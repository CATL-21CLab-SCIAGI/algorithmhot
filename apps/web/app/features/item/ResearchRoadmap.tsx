import type { ResearchRoadmap as Roadmap } from "@aihot/contracts/research";
import { EVIDENCE_LABELS } from "./research";

const STAGES = { input: "研究输入", method: "核心方法", output: "研究输出", validation: "作者验证" };
const GROUPS = ["input", "method", "output", "validation"] as const;
const COLORS = {
  input: "border-sky-500/25 bg-sky-500/5 text-sky-700 dark:text-sky-300",
  method: "border-teal-500/30 bg-teal-500/5 text-teal-700 dark:text-teal-300",
  output: "border-violet-500/25 bg-violet-500/5 text-violet-700 dark:text-violet-300",
  validation: "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300",
};

/** Method groups describe source content without imposing a causal or chronological graph. */
export function ResearchRoadmap({ roadmap }: { roadmap?: Roadmap | null }) {
  if (!roadmap) return null;
  const groups = GROUPS.map(stage => ({ stage, nodes: roadmap.nodes.filter(node => node.stage === stage) }))
    .filter(group => group.nodes.length > 0);
  return <figure aria-label={`关键路线图：${roadmap.title}`} className="@container my-5 overflow-hidden rounded-xl border border-line bg-surface">
    <figcaption className="border-b border-line px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold tracking-wide text-accent">
        <span>重点论文 · 关键路线图</span>
        <span className="rounded-full border border-current/20 px-2 py-0.5">{EVIDENCE_LABELS[roadmap.evidenceBasis]}</span>
      </div>
      <h4 className="mt-2 text-[16px] font-semibold leading-snug text-ink">{roadmap.title}</h4>
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-4">根据原文整理的路线示意，非论文原图。以下按方法要点分组归纳，不代表执行先后；分支方法和验证环节分别阅读。</p>
      {roadmap.evidenceBasis === "fulltext" && <p className="mt-1 text-[11px] leading-relaxed text-ink-4">依据当前获取的正文文本，原文图表未核阅。</p>}
    </figcaption>
    <div className={`grid grid-cols-1 gap-4 px-4 py-5 sm:px-5 ${groups.length === 3 ? "@[720px]:grid-cols-3" : "@[720px]:grid-cols-4"}`}>
      {groups.map(({ stage, nodes }) => <section key={stage} aria-label={STAGES[stage]} className="min-w-0">
        <h5 className="mb-2 flex items-center justify-between gap-2 text-[11px] font-semibold tracking-wide text-ink-3">
          <span>{STAGES[stage]}</span><span className="font-normal text-ink-4">{nodes.length} 项</span>
        </h5>
        <ul className="space-y-2">
          {nodes.map((node, i) => <li key={`${i}:${node.label}`} className={`rounded-lg border px-3 py-3 ${COLORS[stage]}`}>
            <h6 className="text-[13px] font-semibold leading-snug text-ink">{node.label}</h6>
            <p className="mt-2 break-words text-[12px] leading-relaxed text-ink-3">{node.detail}</p>
          </li>)}
        </ul>
      </section>)}
    </div>
    <div className="border-t border-line bg-bg-sunk px-4 py-3 sm:px-5">
      <p className="text-[12px] leading-relaxed text-ink-3"><strong className="font-medium text-ink-2">证据边界：</strong>{roadmap.limitations}</p>
      <p className="mt-1.5 text-[11px] text-ink-4">作者报告与独立复现分别看待；本站未独立复现实验。</p>
      <details className="mt-3 text-[11px] text-ink-3">
        <summary className="cursor-pointer font-medium text-accent">查看各节点的原文依据</summary>
        <ol className="mt-3 space-y-3">
          {roadmap.nodes.map((node, i) => <li key={i}><span className="font-medium">{i + 1}. {node.label}</span><blockquote className="mt-1 break-words border-l-2 border-accent/30 pl-3 leading-relaxed">{node.evidenceSnippet}</blockquote></li>)}
        </ol>
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-ink-4">
          <a href={roadmap.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">核对原始来源 ↗</a>
          <span>资料版本 {roadmap.sourceRevision}</span>
          <time dateTime={roadmap.generatedAt}>{new Date(roadmap.generatedAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })} 整理</time>
        </div>
      </details>
    </div>
  </figure>;
}
