// Offline source fixtures only. The production arXiv limiter still serializes these injected calls.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { collectArxivAnnouncements, parseArxivAnnouncementPage, announcementInWindow, submissionInWindow, parseArxivAbstractPage } from "@aihot/backend/research/arxiv-announcements";
import { createResearchRun } from "@aihot/backend/research/collect";
import { researchRunMetrics } from "@aihot/backend/research/admission";
import type { GuardedResponse } from "@aihot/backend/lib/http-fetch";
import type { SourceRow } from "@aihot/backend/sources/types";

const T = tag(), sourceId = `announcements-${T}`, rateKey = "fetch.arxiv.startedAt";
const observed = new Date("2026-10-05T02:00:00Z"), submitted = "2026-10-04T01:00:00Z";
const window = { start: new Date("2026-10-04T00:00:00Z"), end: observed };
const originalDataDir = config.dataDir;
const runIds: string[] = [];
let folder: string;
let previousRate: { value: unknown; updated_by: string | null; updated_at: Date } | undefined;
let paperSequence = Date.now() % 80000 + 10000;
const nextPaper = () => `2610.${String(paperSequence++).padStart(5, "0")}`;
const source: SourceRow = {
  id: sourceId, name: "arXiv announcement fixture", kind: "rss", tier: "T1_5", participation_mode: "editorial", first_party: false,
  interval_minutes: 180, enabled: false, cursor: null, fail_count: 0,
  config: { feedUrl: "https://rss.arxiv.org/rss/cs.AI", researchSourceKind: "arxiv", summaryIsBody: true },
};

before(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "algorithmhot-announcements-"));
  config.dataDir = folder;
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,config) VALUES(${source.id},${source.name},${source.kind},${source.tier},${source.participation_mode},${sql.json(source.config)})`;
  [previousRate] = await sql<typeof previousRate[]>`SELECT value,updated_by,updated_at FROM settings WHERE key=${rateKey}`;
  await sql`DELETE FROM settings WHERE key=${rateKey}`;
  mock.timers.enable({ apis: ["Date"], now: observed });
});
after(async () => {
  mock.timers.reset();
  config.dataDir = originalDataDir;
  if (runIds.length) {
    await sql`DELETE FROM research_fetches WHERE run_id=ANY(${runIds})`;
    await sql`DELETE FROM research_members WHERE run_id=ANY(${runIds})`;
    await sql`DELETE FROM research_runs WHERE id=ANY(${runIds})`;
  }
  await sql`DELETE FROM articles WHERE source_id=${sourceId}`;
  await sql`DELETE FROM sources WHERE id=${sourceId}`;
  if (previousRate) await sql`INSERT INTO settings(key,value,updated_by,updated_at) VALUES(${rateKey},${sql.json(previousRate.value as never)},${previousRate.updated_by},${previousRate.updated_at})
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at`;
  else await sql`DELETE FROM settings WHERE key=${rateKey}`;
  await closeDb();
  if (folder) await rm(folder, { recursive: true, force: true });
});

const listing = (total: number, groups: Array<{ day: string; ids: string[] }>) => `<html><body><div id="dlpage"><small>Total of ${total} entries</small>${groups.map(group =>
  `<h3>${group.day}</h3><dl>${group.ids.map(id => `<dt><span><a href="/abs/${id}">arXiv:${id}</a></span></dt><dd>Source list entry</dd>`).join("")}</dl>`).join("")}</div></body></html>`;
const atom = (ids: string[]) => `<feed xmlns="http://www.w3.org/2005/Atom">${ids.map(id => `<entry><id>https://arxiv.org/abs/${id}v1</id><title>Source paper ${id}</title><link href="https://arxiv.org/abs/${id}v1"/>
  <summary>Original source abstract with an author-reported method.</summary><published>${submitted}</published><updated>${submitted}</updated></entry>`).join("")}</feed>`;
const newListing = (ids: string[], day = "Monday, 5 October 2026") => `<div id="dlpage"><h3>Showing new listings for ${day}</h3><small>Total of ${ids.length} entries</small><dl>${ids.map(id =>
  `<dt><a href="/abs/${id}">arXiv:${id}</a></dt><dd><div class="meta"><div class="list-title"><span class="descriptor">Title:</span>Source paper ${id}</div><div class="list-authors">Source Author</div><p class="mathjax">Original source abstract with an author-reported method.</p></div></dd>`).join("")}</dl></div>`;
const absPage = (id: string, timestamp = "Sun, 4 Oct 2026 01:00:00 UTC") => `<html><head><meta name="citation_arxiv_id" content="${id}"><meta name="citation_date" content="2026/10/05"></head><body>
  <h1 class="title"><span class="descriptor">Title:</span>Source paper ${id}</h1><div class="authors"><a>Source Author</a></div>
  <blockquote class="abstract"><span class="descriptor">Abstract:</span>Original source abstract with an author-reported method.</blockquote>
  <div class="submission-history"><h2>Submission history</h2><strong>[v1]</strong> ${timestamp} (123 KB)</div></body></html>`;
const response = (url: string, value: string): GuardedResponse => {
  const body = Buffer.from(value);
  return { status: 200, url, body, headers: new Headers({ "content-type": value.startsWith("<feed") ? "application/atom+xml" : "text/html" }), text: () => body.toString("utf8") };
};
async function run(label: string) {
  const id = `announcement-${T}-${label}`;
  runIds.push(id);
  return createResearchRun(id, "daily", observed, window);
}

test("official day groups remain attached to identities across pagination boundaries", () => {
  const first = parseArxivAnnouncementPage(listing(4, [{ day: "Mon, 5 Oct 2026", ids: ["2610.10001", "2610.10002v2"] }]), "https://arxiv.org/list/cs.AI/recent?skip=0&show=2");
  assert.deepEqual(first, { entries: [{ id: "2610.10001", announcedOn: "2026-10-05" }, { id: "2610.10002", announcedOn: "2026-10-05" }], total: 4, nextOffset: 2, oldestDay: "2026-10-05" });
  const next = parseArxivAnnouncementPage(listing(4, [{ day: "Mon, 5 Oct 2026", ids: ["2610.10003"] }, { day: "Fri, 2 Oct 2026", ids: ["2610.10004"] }]), "https://arxiv.org/list/cs.AI/recent?skip=2&show=2");
  assert.equal(next.nextOffset, null);
  assert.deepEqual(next.entries.map(entry => entry.announcedOn), ["2026-10-05", "2026-10-02"]);
  assert.equal(next.oldestDay, "2026-10-02");
  assert.equal(announcementInWindow("2026-10-05", window.start, window.end), true);
  assert.equal(announcementInWindow("2026-10-04", window.start, window.end), true);
  for (const day of ["2026-10-02", "2026-10-06", "invalid", "2026-02-30"]) assert.equal(announcementInWindow(day, window.start, window.end), false);
  assert.equal(submissionInWindow(submitted, window.start, window.end), true);
  assert.equal(submissionInWindow("2021-01-06T00:29:00Z", window.start, window.end), false);
});

test("empty, malformed, and missing-date announcement pages cannot be confused", () => {
  const url = "https://arxiv.org/list/cs.AI/recent";
  assert.deepEqual(parseArxivAnnouncementPage('<div id="dlpage">No new submissions</div>', url), { entries: [], total: 0, nextOffset: null, oldestDay: null });
  assert.throws(() => parseArxivAnnouncementPage('<div id="dlpage">Total of 2 entries<h3>Mon, 5 Oct 2026</h3></div>', url), /Nonempty/);
  assert.throws(() => parseArxivAnnouncementPage('<div id="dlpage">Total of 1 entries<dl><dt><a href="/abs/2610.10001">paper</a></dt></dl></div>', url), /source date/);
  assert.throws(() => parseArxivAnnouncementPage("<html>Access denied</html>", url), /Missing/);
});

test("abstract metadata preserves the precise v1 timestamp separately from later revisions", () => {
  const id = "2610.10001", url = `https://arxiv.org/abs/${id}`;
  const html = absPage(id).replace("(123 KB)</div>", "(123 KB)<br><strong>[v2]</strong> Mon, 5 Oct 2026 01:00:00 UTC (124 KB)</div>");
  const candidate = parseArxivAbstractPage(html, url, source, observed);
  assert.equal(candidate.research?.originalPublishedAt, "2026-10-04T01:00:00.000Z");
  assert.equal(candidate.research?.revisedAt, "2026-10-05T01:00:00.000Z");
  assert.equal(candidate.research?.arxivVersion, "v2");
  assert.equal(candidate.research?.announcedOn, null);
  assert.equal(candidate.publishedAt?.toISOString(), "2026-10-04T01:00:00.000Z");
  const daily = { start: new Date("2026-10-04T01:00:00Z"), end: new Date("2026-10-05T01:00:00Z") };
  assert.equal(submissionInWindow(candidate.research?.originalPublishedAt, daily.start, daily.end), true);
  assert.equal(submissionInWindow(candidate.research?.revisedAt, daily.start, daily.end), false);
});

test("date-only, wrong-identity and impossible abstract metadata cannot qualify a daily candidate", () => {
  const id = "2610.10001", url = `https://arxiv.org/abs/${id}`;
  assert.throws(() => parseArxivAbstractPage(absPage("2610.10002"), url, source, observed), /identity mismatch/);
  assert.throws(() => parseArxivAbstractPage(absPage(id, "4 Oct 2026"), url, source, observed), /precise/);
  assert.throws(() => parseArxivAbstractPage(absPage(id, "Tue, 31 Feb 2026 01:00:00 UTC"), url, source, observed), /Invalid/);
  assert.throws(() => parseArxivAbstractPage(absPage(id, "Tue, 6 Oct 2026 01:00:00 UTC"), url, source, observed), /Invalid/);
  assert.throws(() => parseArxivAbstractPage(absPage(id), url.replace("arxiv.org", "example.org"), source, observed), /official/);
});

test("announcement collection retains original submission, stores raw receipts, and reuses frozen responses", async () => {
  const batch = await run("healthy"), id = nextPaper(), outside = nextPaper();
  const html = listing(2, [{ day: "Mon, 5 Oct 2026", ids: [id] }, { day: "Fri, 2 Oct 2026", ids: [outside] }]);
  const requests: string[] = [];
  const fetcher = async (url: string) => {
    requests.push(url);
    if (url.startsWith("https://arxiv.org/list/cs.AI/recent?")) return response(url, html);
    if (url.includes("/new?")) return response(url, newListing([]));
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://export.arxiv.org");
    assert.equal(parsed.searchParams.get("id_list"), id);
    assert.equal(parsed.searchParams.has("search_query"), false);
    return response(url, atom([id]));
  };
  await collectArxivAnnouncements(batch.id, batch, source, ["cs.AI"], fetcher);
  assert.equal(requests.length, 3);
  const members = await sql`SELECT m.in_window,a.published_at,a.timeline_at,a.discovered_at,a.backfill,a.research FROM research_members m JOIN articles a ON a.id=m.article_id WHERE m.run_id=${batch.id}`;
  assert.equal(members.length, 1);
  const member = members[0];
  assert.equal(member.in_window, true); assert.equal(member.backfill, false);
  assert.equal(member.published_at.toISOString(), new Date(submitted).toISOString());
  assert.equal(member.research.originalPublishedAt, new Date(submitted).toISOString());
  assert.equal(member.research.announcedOn, "2026-10-05");
  assert.equal(member.discovered_at.toISOString(), observed.toISOString());
  assert.equal(member.timeline_at.toISOString(), observed.toISOString());
  const receipts = await sql`SELECT * FROM research_fetches WHERE run_id=${batch.id} ORDER BY id`;
  assert.deepEqual(receipts.map(row => [row.status, row.returned_count, row.parsed_count, row.truncated]), [["ok", 0, 0, false], ["ok", 0, 0, false], ["ok", 1, 1, false]]);
  for (const [index, receipt] of receipts.entries()) {
    const bytes = await readFile(receipt.response_path);
    const metadata = JSON.parse(await readFile(`${receipt.response_path}.json`, "utf8"));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), receipt.response_sha256);
    assert.equal(metadata.sha256, receipt.response_sha256);
    assert.equal(metadata.evidence, index === 0 ? "announcement-index" : "original-paper-metadata");
  }
  await collectArxivAnnouncements(batch.id, batch, source, ["cs.AI"], fetcher);
  assert.equal(requests.length, 3, "a resumed snapshot re-parses its retained bytes without new HTTP");
  assert.equal((await sql`SELECT count(*)::int AS n FROM research_fetches WHERE run_id=${batch.id}`)[0].n, 3);
  assert.equal((await sql`SELECT count(*)::int AS n FROM research_members WHERE run_id=${batch.id}`)[0].n, 1);
});

test("a nonempty listing parsed as zero is failed, with raw evidence retained and no healthy-empty claim", async () => {
  const batch = await run("malformed"), html = '<div id="dlpage">Total of 3 entries<h3>Mon, 5 Oct 2026</h3><p>Unexpected markup</p></div>';
  let requests = 0;
  await collectArxivAnnouncements(batch.id, batch, source, ["cs.AI"], async url => { requests++; return response(url, url.includes("/new?") ? newListing([]) : html); });
  assert.equal(requests, 2);
  const [receipt] = await sql`SELECT * FROM research_fetches WHERE run_id=${batch.id} ORDER BY id`;
  assert.equal(receipt.status, "failed"); assert.equal(receipt.http_status, 200);
  assert.match(receipt.error, /Nonempty/);
  assert.equal(await readFile(receipt.response_path, "utf8"), html);
  const { metrics, gaps } = await researchRunMetrics(batch.id);
  assert.equal(metrics.stored, 0); assert.equal(metrics.sourcesFailed, 1); assert.equal(metrics.healthyEmptySources, 0);
  assert.ok(gaps.some(gap => gap.includes("采集尚不完整")));
});

test("missing API identities make source coverage truncated instead of silently shrinking the denominator", async () => {
  const batch = await run("missing-id"), first = nextPaper(), missing = nextPaper();
  let requests = 0;
  await collectArxivAnnouncements(batch.id, batch, source, ["cs.AI"], async url => {
    requests++;
    if (url.includes("/new?")) return response(url, newListing([]));
    if (url.includes("/abs/")) return response(url, "<html>Missing submission history</html>");
    return response(url, url.includes("/recent?") ? listing(2, [{ day: "Mon, 5 Oct 2026", ids: [first, missing] }]) : atom([first]));
  });
  assert.equal(requests, 4, "incomplete API metadata also tries the official abstract page once");
  const [metadata] = await sql`SELECT status,returned_count,parsed_count,truncated FROM research_fetches WHERE run_id=${batch.id} AND url LIKE 'https://export.arxiv.org/%'`;
  assert.deepEqual(metadata, { status: "ok", returned_count: 1, parsed_count: 1, truncated: true });
  const { metrics, gaps } = await researchRunMetrics(batch.id);
  assert.equal(metrics.stored, 1); assert.equal(metrics.sourcesFailed, 1); assert.equal(metrics.truncatedRequests, 1);
  assert.equal(metrics.healthyEmptySources, 0);
  assert.ok(gaps.some(gap => gap.includes("采集尚不完整")));
  assert.ok(gaps.some(gap => gap.includes("截断")));
});

test("API outage completes original submission dates from official abstract pages, preserving network failures", async () => {
  const batch = await run("html-fallback"), first = nextPaper(), replacement = nextPaper();
  const requests: string[] = [];
  const html = newListing([first, replacement]);
  const fetcher = async (url: string): Promise<GuardedResponse> => {
    requests.push(url);
    if (url.includes("/recent?")) return response(url, listing(1, [{ day: "Mon, 5 Oct 2026", ids: [first] }]));
    if (url.includes("/new?")) return response(url, html);
    if (url.endsWith(`/abs/${first}`)) return response(url, absPage(first));
    if (url.endsWith(`/abs/${replacement}`)) return response(url, absPage(replacement, "Fri, 2 Oct 2026 01:00:00 UTC"));
    return { ...response(url, "Rate exceeded."), status: 429 };
  };
  await collectArxivAnnouncements(batch.id, batch, source, ["cs.AI"], fetcher);
  assert.equal(requests.length, 7);
  const [article] = await sql`SELECT a.* FROM articles a JOIN research_members m ON m.article_id=a.id WHERE m.run_id=${batch.id} AND a.research->>'arxivId'=${first}`;
  assert.equal(article.research.arxivId, first);
  assert.equal(article.research.announcedOn, "2026-10-05");
  assert.equal(article.research.originalPublishedAt, new Date(submitted).toISOString());
  assert.equal(article.published_at.toISOString(), new Date(submitted).toISOString());
  const members = await sql`SELECT m.in_window,a.research->>'arxivId' AS arxiv_id FROM research_members m JOIN articles a ON a.id=m.article_id WHERE m.run_id=${batch.id}`;
  assert.equal(members.find(row => row.arxiv_id === first)?.in_window, true);
  assert.equal(members.find(row => row.arxiv_id === replacement)?.in_window, false);
  assert.equal(article.research.evidenceBasis, "abstract");
  assert.match(article.body_text, /Original source abstract/);
  const { metrics } = await researchRunMetrics(batch.id);
  assert.equal(metrics.stored, 2);
  assert.equal(metrics.returned, 4);
  assert.equal(metrics.parsed, 4);
  assert.equal(metrics.excludedSourceRecords, 0);
  assert.equal(metrics.duplicateRecords, 2);
  assert.equal(metrics.failedRequests, 3);
  assert.equal(metrics.sourcesFailed, 1);
  const coverage = JSON.parse(await readFile(path.join(folder, "research", batch.id, `${source.id}-announcement-coverage.json`), "utf8"));
  assert.deepEqual(coverage.announcedIdentities, [first, replacement].sort());
  assert.deepEqual(coverage.metadataObtained, [first, replacement].sort());
  assert.deepEqual(coverage.missingMetadata, []);
  await collectArxivAnnouncements(batch.id, batch, source, ["cs.AI"], fetcher);
  assert.equal(requests.length, 7, "same snapshot does not repeat exhausted API or successful HTML calls");
});

test("newer official new-listing identities are discovered even when the recent index is older", async () => {
  const batch = await run("newer-list"), old = nextPaper(), fresh = nextPaper();
  const requests: string[] = [];
  await collectArxivAnnouncements(batch.id, batch, source, ["cs.AI"], async url => {
    requests.push(url);
    if (url.includes("/recent?")) return response(url, listing(1, [{ day: "Fri, 2 Oct 2026", ids: [old] }]));
    if (url.includes("/new?")) return { ...response(url, newListing([fresh])), headers: new Headers({ date: observed.toUTCString(), age: "0", "last-modified": "Mon, 05 Oct 2026 00:00:00 GMT" }) };
    assert.equal(new URL(url).searchParams.get("id_list"), fresh);
    return response(url, atom([fresh]));
  });
  assert.equal(requests.length, 3);
  const [member] = await sql`SELECT m.in_window,a.research FROM research_members m JOIN articles a ON a.id=m.article_id WHERE m.run_id=${batch.id}`;
  assert.equal(member.research.arxivId, fresh);
  assert.equal(member.in_window, true);
  const [receipt] = await sql`SELECT response_path FROM research_fetches WHERE run_id=${batch.id} AND url LIKE '%/new?%'`;
  const saved = JSON.parse(await readFile(`${receipt.response_path}.json`, "utf8"));
  assert.deepEqual(saved.headers, { contentType: null, date: observed.toUTCString(), age: "0", lastModified: "Mon, 05 Oct 2026 00:00:00 GMT" });
});

test("missing submission timestamps remain incomplete, can be repaired on resume, and never reopen a frozen run", async () => {
  const batch = await run("missing-time"), id = nextPaper();
  const requests: string[] = [];
  let precise = false;
  const fetcher = async (url: string) => {
    requests.push(url);
    if (url.includes("/recent?")) return response(url, listing(1, [{ day: "Mon, 5 Oct 2026", ids: [id] }]));
    if (url.includes("/new?")) return response(url, newListing([id]));
    if (url.includes("/abs/")) return response(url, precise ? absPage(id) : absPage(id, "4 Oct 2026"));
    return response(url, "<feed></feed>");
  };
  await collectArxivAnnouncements(batch.id, batch, source, ["cs.AI"], fetcher);
  assert.equal(requests.length, 4);
  const coveragePath = path.join(folder, "research", batch.id, `${source.id}-announcement-coverage.json`);
  const incomplete = JSON.parse(await readFile(coveragePath, "utf8"));
  assert.deepEqual(incomplete.metadataObtained, []);
  assert.deepEqual(incomplete.missingMetadata, [id]);
  assert.equal((await sql`SELECT in_window FROM research_members WHERE run_id=${batch.id}`)[0].in_window, false);
  precise = true;
  await collectArxivAnnouncements(batch.id, batch, source, ["cs.AI"], fetcher);
  assert.equal(requests.length, 5, "resume uses saved listing and retries only the incomplete abstract page");
  assert.equal(requests.filter(url => url.startsWith("https://export.arxiv.org/api/")).length, 1, "HTTP 200 API parse failures do not receive a fresh request budget on resume");
  const receipts = await sql`SELECT status,http_status,attempt_number FROM research_fetches
    WHERE run_id=${batch.id} AND url=${`https://arxiv.org/abs/${id}`} ORDER BY attempt_number`;
  assert.deepEqual(receipts.map(row => [row.status, row.http_status, row.attempt_number]), [["failed", 200, 1], ["ok", 200, 2]]);
  assert.equal((await sql`SELECT count(*)::int AS n FROM research_fetches WHERE run_id=${batch.id} AND url LIKE 'https://export.arxiv.org/api/%' AND status='failed' AND http_status=200`)[0].n, 1);
  assert.equal((await sql`SELECT in_window FROM research_members WHERE run_id=${batch.id}`)[0].in_window, true);
  assert.deepEqual(JSON.parse(await readFile(coveragePath, "utf8")).missingMetadata, []);
  await sql`UPDATE research_runs SET admission_frozen=true WHERE id=${batch.id}`;
  await collectArxivAnnouncements(batch.id, batch, source, ["cs.AI"], async () => { throw new Error("frozen run attempted HTTP"); });
  assert.equal(requests.length, 5);
});

test("current discoveries reuse complete original metadata from earlier runs without redating old papers", async () => {
  const batch = await run("reuse-article"), fresh = nextPaper(), old = nextPaper();
  for (const [paperId, at] of [[fresh, "Sun, 4 Oct 2026 01:00:00 UTC"], [old, "Fri, 2 Oct 2026 01:00:00 UTC"]]) {
    const candidate = parseArxivAbstractPage(absPage(paperId, at), `https://arxiv.org/abs/${paperId}`, source, observed);
    await upsertMaterial({ ...candidate, sourceId, via: "import", discoveredAt: observed });
  }
  const requests: string[] = [];
  await collectArxivAnnouncements(batch.id, batch, source, ["cs.AI"], async url => {
    requests.push(url);
    if (url.includes("/recent?")) return response(url, listing(2, [{ day: "Mon, 5 Oct 2026", ids: [fresh, old] }]));
    if (url.includes("/new?")) return response(url, newListing([fresh, old]));
    throw new Error("complete original metadata must not be fetched again");
  });
  assert.equal(requests.length, 2);
  const members = await sql`SELECT m.in_window,a.research->>'arxivId' AS arxiv_id,a.published_at FROM research_members m JOIN articles a ON a.id=m.article_id WHERE m.run_id=${batch.id}`;
  assert.equal(members.find(row => row.arxiv_id === fresh)?.in_window, true);
  assert.equal(members.find(row => row.arxiv_id === old)?.in_window, false);
  assert.equal(members.find(row => row.arxiv_id === old)?.published_at.toISOString(), "2026-10-02T01:00:00.000Z");
});

test("an HF signal with the same arXiv identity cannot stand in for the original paper", async () => {
  const batch = await run("signal-not-paper"), paperId = nextPaper();
  const signal = parseArxivAbstractPage(absPage(paperId), `https://arxiv.org/abs/${paperId}`, source, observed);
  signal.identityKey = `hf:${paperId}`;
  signal.research!.signalOnly = true;
  await upsertMaterial({ ...signal, sourceId, via: "import", discoveredAt: observed });
  const requests: string[] = [];
  await collectArxivAnnouncements(batch.id, batch, source, ["cs.AI"], async url => {
    requests.push(url);
    if (url.includes("/recent?")) return response(url, listing(1, [{ day: "Mon, 5 Oct 2026", ids: [paperId] }]));
    if (url.includes("/new?")) return response(url, newListing([]));
    assert.equal(new URL(url).searchParams.get("id_list"), paperId);
    return response(url, atom([paperId]));
  });
  assert.equal(requests.length, 3);
  const members = await sql`SELECT a.identity_key,m.signal_only FROM research_members m JOIN articles a ON a.id=m.article_id WHERE m.run_id=${batch.id}`;
  assert.deepEqual(members.map(row => [row.identity_key, row.signal_only]), [[`arxiv:${paperId}`, false]]);
});
