import assert from "node:assert/strict";
import { test } from "node:test";
import { parseResearchCoverage } from "@aihot/backend/publication/research-coverage";

function record() {
  return { date: "2026-10-03", timezone: "Asia/Shanghai", checkedAt: "2026-10-05T09:00:00.000Z", status: "checked-empty", articleCount: 0, signalCount: 0, note: "Only the six configured sources were checked.",
    sources: ["research-arxiv-ml-ai", "research-arxiv-physical-science", "research-arxiv-molecular", "research-hf-daily-papers", "rss-google-deepmind", "rss-bair"].map(id => ({ id, name: id, observedAt: "2026-10-05T09:00:00.000Z", status: "checked-empty", articleCount: 0, signalCount: 0, urls: ["https://arxiv.org/list/cs.AI/recent"], note: "No records for this date." })) };
}

test("coverage distinguishes a checked empty day from missing or duplicate sources", () => {
  assert.equal(parseResearchCoverage([record()])[0]?.date, "2026-10-03");
  const missing = record(); missing.sources.pop();
  assert.throws(() => parseResearchCoverage([missing]));
  const duplicate = record(); duplicate.sources[5] = duplicate.sources[0]!;
  assert.throws(() => parseResearchCoverage([duplicate]));
});

test("failed or nonzero source checks cannot be published as an empty complete day", () => {
  const failed = record(); failed.sources[0]!.status = "unavailable";
  assert.throws(() => parseResearchCoverage([failed]));
  const nonzero = record(); nonzero.sources[0]!.articleCount = 1;
  assert.throws(() => parseResearchCoverage([nonzero]));
  failed.status = "partial";
  assert.equal(parseResearchCoverage([failed])[0]?.status, "partial");
});

test("public coverage excludes private files, credentials, raw evidence and malformed dates", () => {
  for (const url of ["http://127.0.0.1/", "https://user:secret@arxiv.org/", "file:///tmp/receipt.json", "https://example.com/"]) {
    const bad = record(); bad.sources[0]!.urls = [url];
    assert.throws(() => parseResearchCoverage([bad]));
  }
  assert.throws(() => parseResearchCoverage([{ ...record(), date: "2026-02-30" }]));
  assert.throws(() => parseResearchCoverage([{ ...record(), rawResponse: "private" }]));
  assert.throws(() => parseResearchCoverage([record(), record()]));
});
