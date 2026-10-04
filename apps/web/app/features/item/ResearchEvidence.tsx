import { RESEARCH_BRIEF_LABELS, type ResearchBrief, type ResearchMetadata } from "@aihot/contracts/research";
import { EVIDENCE_LABELS, RESEARCH_LINK_LABELS, publicResearchLinks, researchDates } from "./research";

/** Display source provenance without treating publication, attention or code access as validation. */
export function ResearchEvidence({ research, researchBrief, compact = false }: { research?: ResearchMetadata | null; researchBrief?: ResearchBrief | null; compact?: boolean }) {
  if (!research) return null;
  const links = publicResearchLinks(research);
  const content = <>
    {researchBrief?.editorialReview && <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
      <span className="font-semibold text-accent">已按原文复核修订</span>：{researchBrief.editorialReview.note}
    </p>}
    {researchBrief ? <dl className="mt-3 space-y-3 text-[13px] leading-relaxed">
      {Object.entries(RESEARCH_BRIEF_LABELS).map(([key, label]) => <div key={key}>
        <dt className="font-semibold text-ink-2">{label}</dt>
        <dd className="mt-1 whitespace-pre-line text-ink-3">{researchBrief[key as keyof typeof RESEARCH_BRIEF_LABELS]}</dd>
      </div>)}
    </dl> : <p className="mt-3 text-[12px] text-ink-4">结构化研究解读待补充。</p>}
    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-[12px]">
      {researchDates(research).map(date => <div key={date.label}>
        <dt className="text-ink-4">{date.label}</dt>
        <dd className="mt-0.5 text-ink-2">{date.iso ? <time dateTime={date.iso}>{date.value}</time> : date.value}</dd>
      </div>)}
    </dl>
    <p className="mt-2 text-[11px] text-ink-4">时间以北京时间显示；四类日期分别记录。</p>
    {links.length > 0 && <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-[12.5px]">
      {links.map(link => <a key={`${link.kind}:${link.url}`} href={link.url} target="_blank" rel="noopener noreferrer" title={`资料链接来源：${link.sourceUrl}`} className="font-medium text-accent hover:underline">{RESEARCH_LINK_LABELS[link.kind]} ↗</a>)}
    </div>}
    <p className="mt-3 text-[12px] text-ink-4">{!links.some(link => link.kind === "code") && "代码：未知，当前资料未提供入口。"}{!links.some(link => link.kind === "weights") && " 权重：未知，当前资料未提供入口。"}</p>
    <p className="mt-2 text-[12px] text-ink-4">筛选评分尚未经过用户标注集校准。</p>
    <p className="mt-3 text-[12px] leading-relaxed text-ink-3">研究结果按作者报告呈现；资料入口与社区关注不代表独立复现。</p>
  </>;
  const heading = <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
    <span className="font-semibold text-accent">{EVIDENCE_LABELS[research.evidenceBasis]}</span>
    {research.arxivId && <span className="mono text-ink-3">arXiv:{research.arxivId}{research.arxivVersion ?? ""}</span>}
    {research.signalOnly && <span className="text-ink-4">社区信号</span>}
  </span>;
  if (compact) return <details className="mt-3 rounded-control border border-line px-3 py-2 text-[12px]">
    <summary className="cursor-pointer list-none">{heading}<span className="mt-1 block text-ink-4">研究解读、日期与资料入口</span></summary>
    {content}
  </details>;
  return <section aria-label="研究依据与资料" className="mt-6 rounded-control border border-line bg-bg-sunk px-4 py-4 text-[13px]">
    {heading}{content}
  </section>;
}
