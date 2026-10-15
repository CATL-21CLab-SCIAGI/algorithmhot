// The listing and works parsers, on fixed fixtures (no network, no database).
import assert from "node:assert/strict";
import { test } from "node:test";
import { arxivNotes, parseListing } from "../arxiv.ts";
import { crossrefNotes, licenseLabel, parseWorks } from "../crossref.ts";
import { Feeds } from "../feeds.ts";

const pair = (id: string, title = "A source method", abstract = "An abstract that describes the reported method.", extra = "") => `<dt><a name="item1">[1]</a><a href ="/abs/${id}" title="Abstract" id="${id}">arXiv:${id}</a>${extra}<a href="/pdf/${id}">pdf</a></dt>
  <dd><div class="meta"><div class="list-title mathjax"><span class="descriptor">Title:</span> ${title}</div>
  <div class="list-authors"><a href="/a">Alice Example</a>, <a href="/b">Bob Example</a></div>
  <div class="list-subjects"><span class="descriptor">Subjects:</span>Machine Learning (cs.LG); Artificial Intelligence (cs.AI)</div>
  <p class="mathjax">${abstract}</p></div></dd>`;
export const listing = (sections: { new?: string; cross?: string; replaced?: string }, heading = "Monday, 12 October 2026", total = 3) =>
  `<div id="dlpage"><h3>Showing new listings for ${heading}</h3><small>Total of ${total} entries</small>
  <h3>New submissions (showing 2 of 2 entries)</h3><dl>${sections.new ?? ""}</dl>
  <h3>Cross submissions (showing 1 of 1 entries)</h3><dl>${sections.cross ?? ""}</dl>
  <h3>Replacement submissions (showing 1 of 1 entries)</h3><dl>${sections.replaced ?? ""}</dl></div>`;

test("a listing gives its announcement day and only its new submissions, with their abstracts", () => {
  const html = listing({
    new: pair("2610.01234") + pair("2610.01235", "Second paper"),
    cross: pair("2610.09999", "Cross-listed", undefined, " (cross-list from stat.ML)"),
    replaced: pair("2609.00001v2", "Replaced", undefined, " (replaced)"),
  });
  const got = parseListing(html);
  assert.equal(got.day, "2026-10-12");
  assert.equal(got.total, 3);
  assert.deepEqual(got.papers.map((p) => p.id), ["2610.01234", "2610.01235"]);
  assert.equal(got.papers[0]!.title, "A source method");
  assert.equal(got.papers[0]!.authors, "Alice Example, Bob Example");
  assert.match(got.papers[0]!.abstractText, /reported method/);
  assert.deepEqual(got.papers[0]!.categories, ["cs.LG", "cs.AI"]);
  assert.deepEqual(arxivNotes(got.papers[0]!, got.day).map((n) => `${n.label}:${n.value}`), ["arXiv:2610.01234", "公告:2026-10-12", "全文:PDF", "配图:待补"]);
});

test("a page that is not a listing, or a heading whose weekday is wrong, fails instead of reading nothing", () => {
  assert.throws(() => parseListing("<html><body>Service unavailable</body></html>"), /no #dlpage/);
  assert.throws(() => parseListing(listing({ new: pair("2610.01234") }, "Tuesday, 12 October 2026")), /no announcement day/);
});

test("a category without new papers that day is an empty listing of that day, not a broken page", () => {
  const got = parseListing(`<div id="dlpage"><h3>Showing new listings for Thursday, 15 October 2026</h3><p>No updates today.</p></div>`);
  assert.deepEqual([got.day, got.total, got.papers.length], ["2026-10-15", 0, 0]);
});

test("an entry without its abstract is left out", () => {
  const got = parseListing(listing({ new: pair("2610.01234", "Title only", "") + pair("2610.01235") }));
  assert.deepEqual(got.papers.map((p) => p.id), ["2610.01235"]);
});

const feed = Feeds.parse({ crossref: [{ id: "crossref-nature", name: "Nature", issn: ["0028-0836"], doiPattern: "^10\\.1038/s41586-", tier: "T1_5", keywords: ["battery", "electrolyte"] }] }).crossref[0]!;
const work = (over: Record<string, unknown>) => ({
  DOI: "10.1038/s41586-026-01234-5", type: "journal-article", title: ["A solid electrolyte for lithium batteries"],
  abstract: "<jats:title>Abstract</jats:title><jats:p>We report a <jats:italic>solid</jats:italic> electrolyte.</jats:p>",
  author: [{ given: "Ada", family: "Lovelace" }], "container-title": ["Nature"],
  "published-online": { "date-parts": [[2026, 10, 9]] },
  license: [{ URL: "http://creativecommons.org/licenses/by/4.0/" }], ...over,
});

test("works keep research articles on the feed's subjects, with their first online day and licence", () => {
  const got = parseWorks({ message: { items: [
    work({}),
    work({ DOI: "10.1038/d41586-026-00001-1" }), // news: not a research DOI
    work({ DOI: "10.1038/s41586-026-07777-7", title: ["Galaxy formation"], abstract: "<jats:p>Stars.</jats:p>" }), // off subject
    work({ DOI: "10.1038/s41586-026-08888-8", type: "peer-review" }),
    work({ DOI: "10.1038/s41586-026-09999-9", "published-online": { "date-parts": [[2026, 10]] }, license: [] }),
  ] } }, feed);
  assert.deepEqual(got.map((a) => a.doi), ["10.1038/s41586-026-01234-5", "10.1038/s41586-026-09999-9"]);
  assert.equal(got[0]!.onlineDay, "2026-10-09");
  assert.equal(got[0]!.abstractText, "We report a solid electrolyte.", "the JATS section title is not part of the abstract");
  assert.equal(got[0]!.authors, "Ada Lovelace");
  assert.equal(licenseLabel(got[0]!.license!), "CC BY 4.0");
  // A month alone is not a first online day: the site falls back to when it found the article.
  assert.equal(got[1]!.onlineDay, null);
  assert.deepEqual(crossrefNotes(got[1]!).map((n) => n.label), ["DOI", "上线日期", "配图"]);
  assert.throws(() => parseWorks({ status: "error" }, feed), /no message.items/);
});
