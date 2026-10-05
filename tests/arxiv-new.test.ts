import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArxivNewPage } from "@aihot/backend/research/arxiv-new";
import type { SourceRow } from "@aihot/backend/sources/types";

const url = "https://arxiv.org/list/cs.AI/new?skip=0&show=500";
const observed = new Date("2026-10-05T03:00:00Z");
const source: SourceRow = { id: "research-arxiv-ml-ai", name: "arXiv AI", kind: "rss", tier: "T1_5", participation_mode: "editorial",
  first_party: false, interval_minutes: 180, enabled: false, cursor: null, fail_count: 0, config: { researchSourceKind: "arxiv" } };
const pair = (id = "2610.02260", title = "A source method", abstract = "An explicit source abstract describes the reported method and its constraints.") => `<dt><a name="item1">[1]</a><a href="/abs/${id}">arXiv:${id}</a><a href="/pdf/${id}">pdf</a></dt>
  <dd><div class="meta"><div class="list-title mathjax"><span class="descriptor">Title:</span>${title}</div>
  <div class="list-authors"><a href="/search/author">Alice Example</a>, <a href="/search/author">Bob Example</a></div>
  <div class="list-subjects"><span class="descriptor">Subjects:</span>Artificial Intelligence (cs.AI); Machine Learning (cs.LG)</div>
  <p class="mathjax">${abstract}</p></div></dd>`;
const page = (entries: string, total = 1, heading = "Monday, 5 October 2026") => `<div id="dlpage"><h3>Showing new listings for ${heading}</h3><small>Total of ${total} entries</small><h3>New submissions</h3><dl>${entries}</dl></div>`;

test("official new-listing rows bind explicit abstracts to the adjacent identity and keep submission dates unknown", () => {
  const result = parseArxivNewPage(page(pair()), url, source, observed);
  assert.equal(result.day, "2026-10-05"); assert.equal(result.total, 1); assert.equal(result.nextOffset, null);
  const candidate = result.candidates[0]!;
  assert.equal(candidate.identityKey, "arxiv:2610.02260");
  assert.equal(candidate.url, "https://arxiv.org/abs/2610.02260");
  assert.equal(candidate.title, "A source method");
  assert.equal(candidate.author, "Alice Example, Bob Example");
  assert.equal(candidate.bodyStatus, "ok");
  assert.match(candidate.bodyText!, /explicit source abstract/);
  assert.equal(candidate.excerpt, candidate.bodyText);
  assert.equal(candidate.publishedAt, null); assert.equal(candidate.sourceUpdatedAt, null);
  assert.equal(candidate.research!.originalPublishedAt, null); assert.equal(candidate.research!.revisedAt, null);
  assert.equal(candidate.research!.observedAt, observed.toISOString());
  assert.equal(candidate.research!.announcedOn, "2026-10-05");
  assert.equal(candidate.research!.evidenceBasis, "abstract");
  assert.deepEqual(candidate.categories, ["cs.AI", "cs.LG"]);
  assert.equal((candidate.raw as { entryOffset: number }).entryOffset, 0);
});

test("new, cross, and replacement sections are all returned while pagination counts dt entries only", () => {
  const html = page(pair("2610.02260"), 5);
  const threeSections = html.replace("</dl></div>", `</dl><h3>Cross submissions</h3><dl>${pair("2610.02261")}</dl><h3>Replacement submissions</h3><dl>${pair("2610.02262v2")}</dl></div>`);
  const result = parseArxivNewPage(threeSections, url, source, observed);
  assert.equal(result.candidates.length, 3); assert.equal(result.nextOffset, 3);
  assert.equal(result.candidates[2]!.research!.arxivVersion, "v2");
  assert.equal(result.candidates[2]!.url, "https://arxiv.org/abs/2610.02262v2");
  const next = parseArxivNewPage(page(pair("2610.02263") + pair("2610.02264"), 5), url.replace("skip=0", "skip=3"), source, observed);
  assert.equal(next.nextOffset, null);
  assert.equal((next.candidates[0]!.raw as { entryOffset: number }).entryOffset, 3);
});

test("source project/code links keep their listing provenance and abstract HTML is sanitized", () => {
  const html = page(pair("2610.02260", "Source &amp; method", String.raw`The method uses $x &lt; y$. Project page: https://example.org/method.
    Code: <a href="https://github.com/lab/method" onclick="bad()">source code</a>.
    <script>do not retain this instruction</script><a href="javascript:bad()">unsafe URL</a>`));
  const candidate = parseArxivNewPage(html, url, source, observed).candidates[0]!;
  assert.equal(candidate.title, "Source & method");
  assert.match(candidate.bodyText!, /\$x < y\$/);
  assert.doesNotMatch(candidate.bodyHtml!, /script|onclick|javascript:/);
  assert.doesNotMatch(candidate.bodyText!, /do not retain/);
  assert.ok(candidate.research!.links.some(link => link.kind === "project" && link.url === "https://example.org/method"));
  assert.ok(candidate.research!.links.some(link => link.kind === "code" && link.url === "https://github.com/lab/method"));
  assert.ok(candidate.research!.links.every(link => link.sourceUrl === url));
});

test("missing or malformed identity, adjacent description, title, or abstract cannot become a healthy empty source", () => {
  const valid = pair();
  const malformed = [
    valid.replace('/abs/2610.02260', '/abs/not-an-id'),
    valid.replace("</dt>", "</dt><div>unexpected separator</div>"),
    valid.replace("list-title mathjax", "not-a-title"),
    valid.replace('<p class="mathjax">', '<p class="not-an-abstract">'),
    pair("2610.02260", "A source method", ""),
    pair("2610.02260", "A source method", "A source method"),
  ];
  for (const entry of malformed) assert.throws(() => parseArxivNewPage(page(entry), url, source, observed), /arXiv/i);
  assert.throws(() => parseArxivNewPage(page("", 2), url, source, observed), /Nonempty/);
  assert.throws(() => parseArxivNewPage(page(pair() + pair("2610.02261"), 1), url, source, observed), /denominator/);
});

test("announcement dates and denominators require explicit valid headings", () => {
  for (const heading of ["Tuesday, 5 October 2026", "Monday, 30 February 2026", "5 October 2026", "Monday, 5 Oct 2026"]) {
    assert.throws(() => parseArxivNewPage(page(pair(), 1, heading), url, source, observed), /day/);
  }
  assert.throws(() => parseArxivNewPage(page(pair()).replace(/<h3>Showing.*?<\/h3>/, ""), url, source, observed), /day/);
  assert.throws(() => parseArxivNewPage(page(pair()).replace("Total of 1 entries", "Unknown total"), url, source, observed), /denominator/);
  assert.throws(() => parseArxivNewPage(page("", 0).replace("Total of 0 entries", "No new submissions"), url, source, observed), /denominator/);
  assert.throws(() => parseArxivNewPage(page(pair()), url.replace("skip=0", "skip=bad"), source, observed), /offset/);
  assert.throws(() => parseArxivNewPage(page(pair()), "https://example.org/list/cs.AI/new", source, observed), /official/);
  const empty = parseArxivNewPage(page("", 0), url, source, observed);
  assert.deepEqual(empty, { day: "2026-10-05", total: 0, nextOffset: null, candidates: [] });
});
