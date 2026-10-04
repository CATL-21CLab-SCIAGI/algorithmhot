import type { ResearchMetadata } from "@aihot/contracts/research";
import { fullDateTime } from "../../lib/format.ts";

export const EVIDENCE_LABELS: Record<ResearchMetadata["evidenceBasis"], string> = {
  abstract: "基于摘要", fulltext: "基于来源全文", source_summary: "基于来源摘要", unknown: "材料依据未知",
};
export const RESEARCH_LINK_LABELS: Record<ResearchMetadata["links"][number]["kind"], string> = {
  paper: "论文", project: "项目", code: "代码", weights: "权重",
};
export function researchDates(research: ResearchMetadata) {
  return [
    ["原始发表", research.originalPublishedAt], ["修订", research.revisedAt],
    ["社区入选", research.communitySelectedAt], ["本站观测", research.observedAt],
  ].map(([label, value]) => ({ label: label!, value: value && Number.isFinite(Date.parse(value)) ? fullDateTime(value) : "未知", iso: value && Number.isFinite(Date.parse(value)) ? value : null }));
}
export function publicResearchLinks(research: ResearchMetadata) {
  const seen = new Set<string>();
  return research.links.filter(link => {
    const key = `${link.kind}:${link.url}`;
    if (seen.has(key)) return false;
    try { if (!["https:", "http:"].includes(new URL(link.url).protocol)) return false; } catch { return false; }
    seen.add(key);
    return true;
  });
}
