import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResearchMetadata } from "@aihot/contracts/research";
import { researchDates, publicResearchLinks } from "../app/features/item/research.ts";
import { kindFromPath, archiveGroups, periodGrid, KIND_LABEL, EDITION } from "../app/features/report/format.ts";

const metadata: ResearchMetadata = {
  canonicalKey: null, arxivId: null, arxivVersion: null, arxivVersions: [], doi: null,
  originalPublishedAt: null, revisedAt: null, communitySelectedAt: "2026-10-01T00:00:00Z", observedAt: "2026-10-03T00:00:00Z", evidenceBasis: "unknown", signalOnly: true,
  links: [
    { kind: "paper", url: "https://example.org/paper", sourceUrl: "https://example.org/feed" },
    { kind: "paper", url: "https://example.org/paper", sourceUrl: "https://example.org/duplicate" },
    { kind: "code", url: "javascript:alert(1)", sourceUrl: "https://example.org/feed" },
    { kind: "weights", url: "not-a-url", sourceUrl: "https://example.org/feed" },
  ],
};
test("unknown paper dates do not inherit community selection or observation timestamps", () => {
  assert.deepEqual(researchDates(metadata).map(d => [d.label, d.value]), [
    ["原始发表", "未知"], ["修订", "未知"], ["社区入选", "2026-10-01 08:00"], ["本站观测", "2026-10-03 08:00"],
  ]);
  assert.equal(researchDates({ ...metadata, originalPublishedAt: "invalid-date" })[0]!.value, "未知");
});
test("research links exclude unsafe schemes and duplicates without manufacturing destinations", () => {
  assert.deepEqual(publicResearchLinks(metadata), [metadata.links[0]]);
});
test("pilot format does not infer a daily schedule or calendar from its identifier", () => {
  assert.equal(kindFromPath("/pilot/2026-10-03"), "pilot");
  assert.equal(KIND_LABEL.pilot, "试刊");
  assert.doesNotMatch(EDITION.pilot, /08:00|每天/);
  const index = [{ key: "2026-10-03", issueNumber: 1 }];
  assert.equal(archiveGroups("pilot", index)[0]!.label, "研究试刊");
  assert.deepEqual(periodGrid("pilot", "2026-10-03", index, 1).cells.map(c => c.key), ["2026-10-03"]);
});
