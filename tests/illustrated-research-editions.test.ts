import assert from "node:assert/strict";
import test from "node:test";
import {
  dueResearchEditions, illustratedResearchLead, ILLUSTRATED_RESEARCH_VERSION, isIllustratedResearchReport,
  researchEditionDay, researchSourceInWindow, selectIllustratedResearch, submissionInWindow, type IllustratedCandidate,
} from "@aihot/backend/reports/compose";
import type { ResearchFigureResult } from "@aihot/backend/research/figures";
import { editionRequests } from "../scripts/research-editions.ts";

function candidate(id: string, category = "algorithm"): IllustratedCandidate {
  return {
    itemId: id, factId: null, factKey: id, storyPublicId: null, title: `研究 ${id} 改善模拟预测`, originalTitle: `Research ${id}`,
    summary: "作者在模拟数据上比较，尚无真实系统验证。", category, sourceName: "arXiv", sourceUrl: `https://example.org/${id}`,
    sourceId: "fixture", firstParty: false, role: "研究论文", score: 90, publishedAt: "2026-10-07T12:00:00Z",
    research: { canonicalKey: `arxiv:${id}`, arxivId: id, arxivVersion: "v1", arxivVersions: ["v1"], doi: null,
      announcedOn: "2026-09-30", originalPublishedAt: "2026-09-29T04:00:00Z", revisedAt: null, communitySelectedAt: null,
      observedAt: "2026-10-07T12:00:00Z", evidenceBasis: "abstract", signalOnly: false, links: [] },
    researchBrief: { methodChange: "作者改变了预测方法。", applicableTasks: "模拟数据", comparisonConditions: "仅作者报告模拟比较。", limitations: "真实系统效果未知。",
      evidenceBasis: "abstract", sourceRevision: 3, promptVersion: "fixture", generatedAt: "2026-10-07T12:00:00Z" },
  };
}
function result(entry: IllustratedCandidate, status: ResearchFigureResult["status"] = "verified"): ResearchFigureResult {
  return {
    schemaVersion: 1, itemId: entry.itemId, sourceRevision: entry.researchBrief!.sourceRevision, inputHash: "a".repeat(64),
    checkedAt: "2026-10-08T00:00:00Z", status, reason: "fixture", verificationBasis: status === "verified" ? "source-caption" : null, candidate: null,
    figure: status === "verified" ? { itemId: entry.itemId, sourceRevision: entry.researchBrief!.sourceRevision, imageOrigin: "remote",
      imageUrl: `https://example.org/${entry.itemId}.png`, sourceUrl: `https://example.org/${entry.itemId}#figure1`, figureLabel: "原文图 1",
      caption: "模型方法总览。", attribution: "Fixture authors", licenseName: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      verifiedAt: "2026-10-08T00:00:00Z", width: 1200, height: 400, contentType: "image/png", sha256: "b".repeat(64) } : null,
  };
}

test("research period dates use original submission and never substitute announcement or community dates", () => {
  const paper = candidate("one");
  assert.equal(researchEditionDay(paper), "2026-09-29");
  assert.equal(researchEditionDay({ ...paper, research: { ...paper.research!, originalPublishedAt: null, announcedOn: "2026-09-30" } }), "2026-10-07");
  assert.equal(researchEditionDay({ ...paper, publishedAt: "", research: { ...paper.research!, announcedOn: null, originalPublishedAt: null, communitySelectedAt: "2026-09-30T00:00:00Z" } }), null);
});

test("daily submission window excludes an old paper announced today", () => {
  const start = new Date("2026-10-05T01:00:00Z"); // 10/5 09:00 Beijing
  const end = new Date("2026-10-06T01:00:00Z"); // 10/6 09:00 Beijing
  assert.equal(submissionInWindow(candidate("old"), start, end), false);
  assert.equal(submissionInWindow({ ...candidate("fresh"), research: { ...candidate("fresh").research!, originalPublishedAt: "2026-10-05T01:00:00Z" } }, start, end), true);
});

test("historical research editions use source publication dates for ordinary items", () => {
  const start = new Date("2026-10-07T01:00:00Z");
  const end = new Date("2026-10-08T01:00:00Z");
  const oldOrdinary = { ...candidate("ordinary-old"), research: null, publishedAt: "2026-09-30T15:03:07.000Z" };
  const freshOrdinary = { ...candidate("ordinary-fresh"), research: null, publishedAt: "2026-10-07T12:00:00.000Z" };
  assert.equal(researchSourceInWindow(oldOrdinary, start, end), false);
  assert.equal(researchSourceInWindow(freshOrdinary, start, end), true);
  const ordinaryWithResearchMetadata = { ...freshOrdinary, research: { ...candidate("ordinary-meta").research!, arxivId: null, originalPublishedAt: "2026-09-30T15:03:07.000Z" } };
  assert.equal(researchSourceInWindow(ordinaryWithResearchMetadata, start, end), true);
  assert.equal(researchSourceInWindow({ ...freshOrdinary, publishedAt: "" }, start, end), false);
});

test("the original figure gate skips review and missing results, fills from later candidates, and binds exact source revision", async () => {
  const a = candidate("one"), b = candidate("two"), c = candidate("three"), d = candidate("four"), e = candidate("five", "ai4s");
  const checked: string[] = [];
  const selected = await selectIllustratedResearch([a, b, c, d, e], 1, async entry => {
    checked.push(entry.itemId);
    return result(entry, entry === a ? "review_required" : entry === b ? "missing" : "verified");
  });
  assert.deepEqual(checked, ["one", "two", "three", "five"]);
  assert.deepEqual(selected.sections.flatMap(section => section.items.map(entry => entry.itemId)), ["three", "five"]);
  assert.equal(selected.metrics.figureChecks, 4);
  assert.equal(selected.metrics.figureReviewRequired, 1);
  assert.equal(selected.metrics.figureMissing, 1);
  assert.equal(selected.metrics.figureCandidatesUninspected, 1);
  assert.equal(selected.metrics.verifiedFigures, 2);
  assert.ok(selected.sections.every(section => section.items.every(entry => entry.paperFigure?.sourceRevision === 3)));
  await assert.rejects(selectIllustratedResearch([c], 1, async entry => ({ ...result(entry), sourceRevision: 2 })), /revision/);
  await assert.rejects(selectIllustratedResearch([c], 1, async entry => ({ ...result(entry), figure: { ...result(entry).figure!, sourceRevision: 2 } })), /revision binding/);
});

test("one research identity is included once and unready briefs never trigger figure acquisition", async () => {
  const paper = candidate("one"), duplicate = { ...candidate("two"), research: { ...paper.research! } }, unready = { ...candidate("three"), researchBrief: null };
  let checked = 0;
  const selected = await selectIllustratedResearch([paper, duplicate, unready], 5, async entry => { checked++; return result(entry); });
  assert.equal(checked, 1);
  assert.equal(selected.metrics.figureCandidates, 1);
  assert.equal(selected.sections[0]!.items.length, 1);
});

test("editorial copy is deterministic source text and retains scientific limits without operational narration", () => {
  const paper = candidate("one"), lead = illustratedResearchLead([paper, candidate("two")]);
  assert.equal(lead.lead.title, paper.title);
  assert.match(lead.lead.leadParagraph, /作者在模拟数据上比较，尚无真实系统验证/);
  assert.doesNotMatch(lead.lead.leadParagraph, /部分结果|准入|调用|处理范围/);
  assert.equal(lead.receiptId, null);
  assert.deepEqual(illustratedResearchLead([paper, candidate("two")]), lead);
});

test("automatic reuse requires the new format and a verified figure binding for every article", async () => {
  const selected = await selectIllustratedResearch([candidate("one")], 5, async entry => result(entry));
  const content = { generator: { version: ILLUSTRATED_RESEARCH_VERSION }, sections: selected.sections };
  assert.equal(isIllustratedResearchReport(content), true);
  assert.equal(isIllustratedResearchReport({ ...content, generator: { version: "legacy" } }), false);
  assert.equal(isIllustratedResearchReport({ ...content, sections: [] }), false);
  assert.equal(isIllustratedResearchReport({ ...content, sections: [{ items: [candidate("one")] }] }), false);
  selected.sections[0]!.items[0]!.paperFigure!.sourceRevision = 2;
  assert.equal(isIllustratedResearchReport(content), false);
});

test("weekly and monthly deadlines use Beijing 09:00 and choose only the latest due period", () => {
  assert.equal(dueResearchEditions(new Date("2026-10-05T08:59:59+08:00")).weekly, "2026-W39");
  assert.equal(dueResearchEditions(new Date("2026-10-05T09:00:00+08:00")).weekly, "2026-W40");
  assert.equal(dueResearchEditions(new Date("2026-10-08T21:00:00+08:00")).weekly, "2026-W40");
  assert.equal(dueResearchEditions(new Date("2026-10-01T08:59:59+08:00")).monthly, "2026-08");
  assert.equal(dueResearchEditions(new Date("2026-10-01T09:00:00+08:00")).monthly, "2026-09");
  assert.equal(dueResearchEditions(new Date("2027-01-01T09:00:00+08:00")).monthly, "2026-12");
});

test("edition CLI accepts explicit bootstrap periods or one due pair and rejects mixed or invalid windows", () => {
  assert.deepEqual(editionRequests(["--weekly=2026-W40", "--monthly=2026-09"]).requests, [
    { kind: "weekly", key: "2026-W40" }, { kind: "monthly", key: "2026-09" },
  ]);
  assert.deepEqual(editionRequests(["--due", "--now=2026-10-08T09:00:00+08:00"]).requests, [
    { kind: "weekly", key: "2026-W40" }, { kind: "monthly", key: "2026-09" },
  ]);
  for (const args of [[], ["--due", "--monthly=2026-09"], ["--monthly=2026-13"], ["--weekly=2026-W99"], ["--due", "--now="], ["--due", "--now=2026-10-08"]]) assert.throws(() => editionRequests(args));
});
