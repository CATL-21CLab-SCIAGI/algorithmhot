import assert from "node:assert/strict";
import { test } from "node:test";
import { readable, researchAfterExtraction } from "@aihot/backend/content/extract";
import { makeResearchMetadata, parseArxivIdentity } from "@aihot/backend/sources/research";

const url = "https://bair.berkeley.edu/blog/research/";
const html = `<html><head><title>Research</title></head><body><article><h1>Research</h1><p>${"The authors explain their method and the conditions in which they evaluated it. ".repeat(12)}</p><p>Code: <a href="https://github.com/lab/method">source code</a></p></article></body></html>`;

test("successful institution extraction upgrades its basis and preserves source dates and link provenance", () => {
  const previous = makeResearchMetadata({ evidenceBasis: "source_summary", originalPublishedAt: "2026-10-01", observedAt: "2026-10-03", links: [{ kind: "paper", url: "https://arxiv.org/abs/2609.12345", sourceUrl: url }] });
  const body = readable(html, url)!;
  assert.ok(body);
  const next = researchAfterExtraction(previous, "institution", url, body)!;
  assert.equal(next.evidenceBasis, "fulltext");
  assert.equal(next.originalPublishedAt, previous.originalPublishedAt);
  assert.equal(next.observedAt, previous.observedAt);
  assert.deepEqual(next.links, [...previous.links, { kind: "code", url: "https://github.com/lab/method", sourceUrl: url }]);
  assert.equal(previous.evidenceBasis, "source_summary", "input metadata remains immutable");
});

test("arXiv landing pages, unrelated redirects, signals and legacy rows never become institution full text", () => {
  const paper = makeResearchMetadata({ identity: parseArxivIdentity("2609.12345"), evidenceBasis: "abstract" });
  const arxiv = "https://arxiv.org/abs/2609.12345";
  const arxivBody = readable(html, arxiv)!;
  assert.equal(researchAfterExtraction(paper, "arxiv", arxiv, arxivBody), paper);
  assert.equal(researchAfterExtraction(paper, "institution", arxiv, arxivBody), paper);
  const summary = makeResearchMetadata({ evidenceBasis: "source_summary" });
  assert.equal(researchAfterExtraction(summary, "institution", url, arxivBody), summary);
  assert.equal(researchAfterExtraction(summary, "institution", url, readable(html, "https://example.org/login")!), summary);
  assert.equal(researchAfterExtraction(null, "institution", url, readable(html, url)!), null);
  const signal = { ...summary, signalOnly: true };
  assert.equal(researchAfterExtraction(signal, "institution", url, readable(html, url)!), signal);
});
