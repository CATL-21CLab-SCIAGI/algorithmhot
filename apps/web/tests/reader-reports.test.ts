import assert from "node:assert/strict";
import test from "node:test";
import type { ReportCitation, ReportDetail } from "@aihot/contracts/site";
import { ABOUT, SITE } from "@aihot/industry/site";
import { announcementDay, readerDateKnown, readerTimelineAt } from "../app/features/feed/research-date.ts";
import { isRunNarrative, reportReaderCopy, reportLeadCitation, readerArchiveTitle } from "../app/features/report/reader-copy.ts";
import { EDITION, KINDS, metricItems } from "../app/features/report/format.ts";

const citation: ReportCitation = {
  itemId: "paper", title: "反事实跟踪降低在线控制的带宽成本", summary: "作者在模拟控制任务中比较策略，但尚无真实机器人实验。",
  sourceName: "arXiv", sourceUrl: "https://example.org/paper", sourceId: null, sourceIconUrl: null,
  firstParty: false, role: null, storyPublicId: null, publishedAt: "2026-10-07T00:00:00Z", available: true,
};
const report: ReportDetail = {
  kind: "daily", key: "2026-10-07", issueNumber: 4, title: "科研日报", windowStart: "2026-10-06T01:00:00Z", windowEnd: "2026-10-07T13:00:00Z",
  generatedAt: "2026-10-07T13:00:00Z", revision: 2, lead: { title: "本期部分结果：已整理 14 项研究", leadParagraph: "本期刊载 14 条资料，尚有处理缺口：1 条资料处理失败。" },
  overview: null, highlights: [citation], sections: [{ label: "算法", summary: null, items: [citation] }], stories: [{ ...citation, label: "算法" }], flashes: [],
  cover: null, metrics: { totalEvents: 1, sourcesCount: 1 }, readingMinutes: 3, prev: null, next: null,
};

test("period mastheads count published research once and omit internal selection totals", () => {
  assert.deepEqual(metricItems({ totalEvents: 14, totalStories: 14, sourcesCount: 4, selectedCount: 28, reportsCovered: 1 }), [
    { value: 14, unit: "件大事" }, { value: 4, unit: "个来源" },
  ]);
});

test("legacy operational leads become source-backed reading copy without dropping scientific limits", () => {
  assert.deepEqual(reportReaderCopy(report), { title: citation.title, paragraph: citation.summary });
  assert.equal(reportLeadCitation(report)?.itemId, "paper");
  assert.equal(isRunNarrative(citation.summary), false);
  assert.equal(readerArchiveTitle(report.lead?.title, report.kind, report.key), "科研日报 · 2026-10-07");
});

test("edited period leads remain intact and a withdrawn highlight is not promoted", () => {
  const edited: ReportDetail = { ...report, kind: "weekly", key: "2026-W40", lead: { title: "从表示学习到分子设计：本周方法进展", leadParagraph: "多项工作尝试改善小数据条件下的泛化能力。" }, highlights: [{ ...citation, available: false }] };
  assert.deepEqual(reportReaderCopy(edited), { title: edited.lead!.title, paragraph: edited.lead!.leadParagraph });
  assert.equal(reportLeadCitation(edited)?.available, true);
});

test("arXiv original submission takes precedence while announcement remains secondary evidence", () => {
  const item = { research: { arxivId: "2610.00001", announcedOn: "2026-10-07", originalPublishedAt: "2021-01-04T03:00:00Z" }, timelineAt: "2026-10-06T13:00:00Z" };
  assert.equal(announcementDay(item), "2026-10-07");
  assert.equal(readerTimelineAt(item), "2021-01-04T03:00:00Z");
  assert.equal(readerDateKnown(item), true);
  assert.equal(readerTimelineAt({ ...item, research: null }), item.timelineAt);
  assert.equal(announcementDay({ research: { arxivId: "2610.00001", announcedOn: "not-a-date" } }), null);
});

test("reader editions expose only day, week and month with the agreed Beijing schedule", () => {
  assert.deepEqual(KINDS, ["daily", "weekly", "monthly"]);
  assert.equal(EDITION.daily, "每天 09:00 · 15:00 · 21:00 更新");
  assert.equal(SITE.footerNote, EDITION.daily);
  assert.match(ABOUT.steps.publish, /09:00.*15:00.*21:00/);
  assert.equal(EDITION.weekly, "每周一 09:00 出刊");
  assert.equal(EDITION.monthly, "每月 1 日 09:00 出刊");
});
