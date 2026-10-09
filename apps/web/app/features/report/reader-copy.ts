import type { ReportCitation, ReportDetail, ReportKind } from "@aihot/contracts/site";

/** Older editions retain their receipts; their reading copy comes from the cited research. */
export function isRunNarrative(value: string | null | undefined): boolean {
  return !!value && /本期部分结果|已整理\s*\d+\s*项研究|本期暂未刊载|本期处理范围|处理缺口|资料处理失败|历史失败|未自动重试|准入|调用预算|\b(?:PARTIAL|UNKNOWN)\b/i.test(value);
}

export function reportLeadCitation(report: ReportDetail): ReportCitation | null {
  return report.highlights.find(citation => citation.available)
    ?? report.sections.flatMap(section => section.items).find(citation => citation.available)
    ?? null;
}

export function reportReaderCopy(report: ReportDetail) {
  const citation = reportLeadCitation(report);
  const title = report.lead?.title && !isRunNarrative(report.lead.title)
    ? report.lead.title : citation?.title ?? "科研进展";
  const paragraph = report.lead?.leadParagraph && !isRunNarrative(report.lead.leadParagraph)
    ? report.lead.leadParagraph
    : citation?.summary ?? (report.overview && !isRunNarrative(report.overview) ? report.overview : null);
  return { title, paragraph };
}

export function readerArchiveTitle(title: string | null | undefined, kind: ReportKind, key: string): string {
  return title && !isRunNarrative(title) ? title : `${kind === "weekly" ? "科研周报" : kind === "monthly" ? "科研月报" : "科研日报"} · ${key}`;
}
