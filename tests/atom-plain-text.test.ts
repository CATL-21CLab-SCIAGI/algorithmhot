import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "cheerio";
import { parseRss } from "@aihot/backend/sources/rss";
import type { SourceRow } from "@aihot/backend/sources/types";
import { collapseWhitespace, escapeXml } from "@aihot/backend/lib/text";

const source: SourceRow = {
  id: "atom-text-fixture", name: "Atom fixture", kind: "rss", tier: "T1", participation_mode: "editorial", first_party: true,
  interval_minutes: 60, enabled: true, cursor: null, fail_count: 0,
  config: { feedUrl: "https://export.arxiv.org/api/query", summaryIsBody: true, researchSourceKind: "arxiv" },
};
const feed = (fields: string) => `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>https://arxiv.org/abs/2610.02258v1</id>
  <link href="https://arxiv.org/abs/2610.02258v1"/><published>2026-10-02T00:00:00Z</published>${fields}</entry></feed>`;
const parse = (fields: string, summaryIsBody = true) => parseRss(feed(fields), { ...source, config: { ...source.config, summaryIsBody } })[0]!;

test("default and text Atom summaries preserve LaTeX inequalities and every following paragraph", () => {
  const abstract = String.raw`We study a family of equations with $1<p\le2$ and $q>2$.

The complete second paragraph includes a result, its assumptions, and the limitations.

The final paragraph remains available as source evidence.`;
  for (const type of ["", ' type="text"', ' type="text/plain"']) {
    const item = parse(`<title${type}>${escapeXml(String.raw`Bounds for $1<p\le2$ and $q>2$`)}</title><summary${type}>${escapeXml(abstract)}</summary>`);
    assert.equal(item.title, String.raw`Bounds for $1<p\le2$ and $q>2$`);
    assert.equal(item.bodyStatus, "ok");
    assert.equal(item.bodyText, collapseWhitespace(abstract));
    assert.equal(item.excerpt, collapseWhitespace(abstract));
    const $ = load(item.bodyHtml!, null, false);
    assert.equal(collapseWhitespace($("p").map((_i, p) => $(p).text()).get().join("\n")), collapseWhitespace(abstract));
    assert.match(item.bodyHtml!, /\$1&lt;p\\le2\$/);
    assert.equal(item.research!.evidenceBasis, "abstract");
  }
});

test("plain content takes precedence over summary and keeps literal markup as inert text", () => {
  const literal = '<script>alert(1)</script> <img src="https://example.org/track.png" onerror="alert(1)"> &lt;still literal&gt;';
  const item = parse(`<title type="text">${escapeXml(literal)}</title><summary type="text">Short summary.</summary><content type="text">${escapeXml(literal)}</content>`);
  assert.equal(item.title, literal);
  assert.equal(item.bodyText, literal);
  assert.equal(item.excerpt, "Short summary.");
  const $ = load(item.bodyHtml!, null, false);
  assert.equal($.text(), literal);
  assert.equal($("script,img").length, 0);
  assert.deepEqual(item.media, []);
  assert.ok(item.bodyHtml!.includes("&amp;lt;still literal&amp;gt;"), "entity-looking plain text is not decoded a second time");
});

test("default-type CDATA remains plain text and summaryIsBody keeps its existing admission rules", () => {
  const literal = String.raw`A bound $1<p\le2$, then <b>literal text</b> and the conclusion.`;
  const summary = `<title>Paper</title><summary><![CDATA[${literal}]]></summary>`;
  assert.equal(parse(summary).bodyText, literal);
  const pending = parse(summary, false);
  assert.equal(pending.excerpt, literal);
  assert.equal(pending.bodyStatus, "pending");
  assert.equal(pending.bodyHtml, null);
  assert.equal(pending.bodyText, null);
  const long = `${literal} ${"Further complete evidence. ".repeat(20)}`.trim();
  assert.equal(parse(`<title>Paper</title><content>${escapeXml(long)}</content>`, false).bodyText, long);
  assert.equal(parse(`<title>Paper</title><content>${escapeXml(literal)}</content>`, false).bodyStatus, "pending");
});

test("explicit HTML and XHTML still keep labels and formatting while removing executable markup", () => {
  const markup = '<p>Before <strong>important</strong>, after.</p><script>alert(1)</script><p><a href="javascript:alert(1)" onclick="alert(1)">Label</a></p>';
  const values = [
    { type: "html", title: escapeXml("A <em>formatted</em> title"), body: escapeXml(markup) },
    { type: "xhtml", title: '<div xmlns="http://www.w3.org/1999/xhtml">A <em>formatted</em> title</div>', body: `<div xmlns="http://www.w3.org/1999/xhtml">${markup}</div>` },
  ];
  for (const value of values) {
    const item = parse(`<title type="${value.type}">${value.title}</title><summary type="${value.type}">${value.body}</summary><content type="${value.type}">${value.body}</content>`);
    assert.equal(item.title, "A formatted title");
    assert.equal(item.bodyText, "Before important , after. Label");
    assert.equal(item.excerpt, "Before important , after. Label");
    assert.match(item.bodyHtml!, /<strong>important<\/strong>/);
    assert.doesNotMatch(item.bodyHtml!, /<script|javascript:|onclick=/);
  }
});
