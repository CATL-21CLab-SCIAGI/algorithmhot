import assert from "node:assert/strict";
import { test } from "node:test";
import { computeResearchHeat, type ResearchHeatInput } from "@aihot/contracts/research-heat";
import { createExport } from "../scripts/static-site.ts";
import { sanitizeItem, sanitizeResearchCoverage, validateSnapshot, type Snapshot } from "../scripts/static-site/model.ts";
import { load } from "cheerio";
import { assertResearchCoverage } from "../scripts/static-site/ssr.ts";

const cutoff = "2026-10-05T00:00:00.000Z";
const paper = (id = "paper_a"): ResearchHeatInput => ({ id, title: "来源核对的研究", sourceName: "arXiv · AI", sourceUrl: "https://arxiv.org/abs/2610.00001v1", publishedAt: "2026-10-04T00:00:00.000Z", research: { arxivId: "2610.00001", doi: null, originalPublishedAt: "2026-10-04T00:00:00.000Z", communitySelectedAt: cutoff } });

test("research attention keeps upstream decay, exact identity and source deduplication", () => {
  const original = paper(), duplicate = { ...paper("paper_b"), sourceName: "arXiv · 材料", sourceUrl: "https://arxiv.org/abs/2610.00001v2" };
  const rank = computeResearchHeat([original, duplicate], cutoff);
  assert.equal(rank.qualifyingResearch, 1);
  assert.equal(rank.recent48hResearch, 1);
  assert.equal(rank.entries[0]!.sourceCount, 2);
  assert.equal(rank.entries[0]!.heat, 15, "10 × (one-day-old publication 0.5 + current community inclusion 1)");
  assert.deepEqual(rank, computeResearchHeat([duplicate, original], cutoff), "input order and cross-category duplicates do not change rank or heat");
});

test("seven-day adaptation preserves real 48h zero; unknown or collection dates add no heat", () => {
  const old = paper(); old.research!.originalPublishedAt = "2026-10-01T00:00:00.000Z"; old.research!.communitySelectedAt = "2026-10-02T00:00:00.000Z";
  const rank = computeResearchHeat([old], cutoff);
  assert.equal(rank.qualifyingResearch, 1); assert.equal(rank.recent48hResearch, 0); assert.equal(rank.entries[0]!.heat, 1.9);
  old.research!.originalPublishedAt = null; old.publishedAt = null;
  assert.equal(computeResearchHeat([old], cutoff).qualifyingResearch, 0);
  old.research!.originalPublishedAt = "2026-09-28T00:00:00.000Z";
  assert.equal(computeResearchHeat([old], cutoff).qualifyingResearch, 0, "exact 7-day boundary is outside the window");
  old.research!.originalPublishedAt = "2026-10-06T00:00:00.000Z";
  assert.equal(computeResearchHeat([old], cutoff).qualifyingResearch, 0, "future events cannot add heat");
});

test("day-only announcements retain precision; a channel is never counted twice", () => {
  const input = paper(); input.research!.announcedOn = "2026-10-05";
  const result = computeResearchHeat([input], cutoff).entries[0]!;
  assert.equal(result.sourceCount, 2); assert.equal(result.heat, 20);
  assert.equal(result.signals.find(s => s.source === "arXiv")!.precision, "day");
  input.research!.communitySelectedAt = null;
  assert.equal(computeResearchHeat([input], cutoff).entries.length, 0, "a publication plus its announcement is one channel");
});

test("mismatched arXiv identifiers cannot join a publication to another paper's community signal", () => {
  const input = paper(); input.sourceUrl = "https://arxiv.org/abs/2610.99999v1";
  assert.equal(computeResearchHeat([input], cutoff).qualifyingResearch, 0);
  input.sourceUrl = "https://arxiv.org/pdf/2610.00001v2.pdf";
  assert.equal(computeResearchHeat([input], cutoff).qualifyingResearch, 1);
});

test("heat export is derived only from pool items and rejects a fabricated or stale ranking", () => {
  const p = paper();
  const item = sanitizeItem({ ...p, source: { name: p.sourceName }, links: { original: p.sourceUrl }, selected: true });
  const snapshot: Snapshot = { schemaVersion: 1, generatedAt: cutoff, publicBaseUrl: "https://pkucy2016.github.io/algorithmhot/", mode: "static-snapshot", scope: "published pool", items: [item], poolItemIds: [item.id], topics: [], reports: [], researchAttention: computeResearchHeat([item], cutoff) };
  const { files } = createExport(snapshot);
  const $ = load(files.get("hot/index.html")!);
  assert.equal($("[data-item-id]").length, 1);
  assert.match($.text(), /关注指数 15.0/);
  assert.match($.text(), /48 小时多源研究 1 项/);
  assert.ok($('a[href="https://huggingface.co/papers/2610.00001"]').length);
  snapshot.researchAttention!.entries[0]!.heat = 99;
  assert.throws(() => validateSnapshot(snapshot), /differs from public snapshot evidence/);
});

test("day coverage export whitelists fields and preserves unavailable as partial", () => {
  const ids = ["research-arxiv-ml-ai", "research-arxiv-physical-science", "research-arxiv-molecular", "research-hf-daily-papers", "rss-google-deepmind", "rss-bair"];
  const day = { date: "2026-10-04", timezone: "Asia/Shanghai", checkedAt: cutoff, status: "checked-empty", articleCount: 0, signalCount: 0, note: "六来源未检出", privatePath: "/private/receipt", sources: ids.map(id => ({ id, name: id, observedAt: cutoff, status: "checked-empty", articleCount: 0, signalCount: 0, urls: ["https://arxiv.org/list/cs.AI/new"], note: "来源已核对", raw: "PRIVATE RESPONSE" })) };
  const clean = sanitizeResearchCoverage([day]);
  const renderCoverage = (value: unknown) => { const $ = load('<section aria-label="历史日期补查"></section>'); $('section').attr('data-research-coverage', JSON.stringify(value)); return $; };
  assert.doesNotThrow(() => assertResearchCoverage(renderCoverage(clean), clean));
  const changed = structuredClone(clean); changed[0]!.status = "partial"; changed[0]!.note = "Same date, corrected source evidence";
  assert.throws(() => assertResearchCoverage(renderCoverage(changed), clean), /differs from public snapshot/);
  assert.doesNotMatch(JSON.stringify(clean), /privatePath|PRIVATE RESPONSE|raw/);
  day.sources[0]!.status = "unavailable";
  assert.throws(() => sanitizeResearchCoverage([day]), /six successful/);
  day.status = "partial";
  assert.equal(sanitizeResearchCoverage([day])[0]!.status, "partial");
});
