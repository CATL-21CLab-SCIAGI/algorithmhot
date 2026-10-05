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
import { collectArxivAnnouncements, parseArxivAnnouncementPage, announcementInWindow } from "@aihot/backend/research/arxiv-announcements";
import { createResearchRun } from "@aihot/backend/research/collect";
import { researchRunMetrics } from "@aihot/backend/research/admission";
import type { GuardedResponse } from "@aihot/backend/lib/http-fetch";
import type { SourceRow } from "@aihot/backend/sources/types";

const T = tag(), sourceId = `announcements-${T}`, rateKey = "fetch.arxiv.startedAt";
const observed = new Date("2026-10-05T02:00:00Z"), submitted = "2026-10-01T01:00:00Z";
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
});

test("empty, malformed, and missing-date announcement pages cannot be confused", () => {
  const url = "https://arxiv.org/list/cs.AI/recent";
  assert.deepEqual(parseArxivAnnouncementPage('<div id="dlpage">No new submissions</div>', url), { entries: [], total: 0, nextOffset: null, oldestDay: null });
  assert.throws(() => parseArxivAnnouncementPage('<div id="dlpage">Total of 2 entries<h3>Mon, 5 Oct 2026</h3></div>', url), /Nonempty/);
  assert.throws(() => parseArxivAnnouncementPage('<div id="dlpage">Total of 1 entries<dl><dt><a href="/abs/2610.10001">paper</a></dt></dl></div>', url), /source date/);
  assert.throws(() => parseArxivAnnouncementPage("<html>Access denied</html>", url), /Missing/);
});

test("announcement collection retains original submission, stores raw receipts, and reuses frozen responses", async () => {
  const batch = await run("healthy"), id = nextPaper(), outside = nextPaper();
  const html = listing(2, [{ day: "Mon, 5 Oct 2026", ids: [id] }, { day: "Fri, 2 Oct 2026", ids: [outside] }]);
  const requests: string[] = [];
  const fetcher = async (url: string) => {
    requests.push(url);
    if (url.startsWith("https://arxiv.org/list/cs.AI/recent?")) return response(url, html);
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://export.arxiv.org");
    assert.equal(parsed.searchParams.get("id_list"), id);
    assert.equal(parsed.searchParams.has("search_query"), false);
    return response(url, atom([id]));
  };
  await collectArxivAnnouncements(batch.id, batch, source, ["cs.AI"], fetcher);
  assert.equal(requests.length, 2);
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
  assert.deepEqual(receipts.map(row => [row.status, row.returned_count, row.parsed_count, row.truncated]), [["ok", 0, 0, false], ["ok", 1, 1, false]]);
  for (const [index, receipt] of receipts.entries()) {
    const bytes = await readFile(receipt.response_path);
    const metadata = JSON.parse(await readFile(`${receipt.response_path}.json`, "utf8"));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), receipt.response_sha256);
    assert.equal(metadata.sha256, receipt.response_sha256);
    assert.equal(metadata.evidence, index === 0 ? "announcement-index" : "original-paper-metadata");
  }
  await collectArxivAnnouncements(batch.id, batch, source, ["cs.AI"], fetcher);
  assert.equal(requests.length, 2, "a resumed snapshot re-parses its retained bytes without new HTTP");
  assert.equal((await sql`SELECT count(*)::int AS n FROM research_fetches WHERE run_id=${batch.id}`)[0].n, 2);
  assert.equal((await sql`SELECT count(*)::int AS n FROM research_members WHERE run_id=${batch.id}`)[0].n, 1);
});

test("a nonempty listing parsed as zero is failed, with raw evidence retained and no healthy-empty claim", async () => {
  const batch = await run("malformed"), html = '<div id="dlpage">Total of 3 entries<h3>Mon, 5 Oct 2026</h3><p>Unexpected markup</p></div>';
  let requests = 0;
  await collectArxivAnnouncements(batch.id, batch, source, ["cs.AI"], async url => { requests++; return response(url, html); });
  assert.equal(requests, 1);
  const [receipt] = await sql`SELECT * FROM research_fetches WHERE run_id=${batch.id}`;
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
    return response(url, url.startsWith("https://arxiv.org/list/") ? listing(2, [{ day: "Mon, 5 Oct 2026", ids: [first, missing] }]) : atom([first]));
  });
  assert.equal(requests, 3, "incomplete API metadata also tries the official abstract listing once");
  const [metadata] = await sql`SELECT status,returned_count,parsed_count,truncated FROM research_fetches WHERE run_id=${batch.id} AND url LIKE 'https://export.arxiv.org/%'`;
  assert.deepEqual(metadata, { status: "ok", returned_count: 1, parsed_count: 1, truncated: true });
  const { metrics, gaps } = await researchRunMetrics(batch.id);
  assert.equal(metrics.stored, 1); assert.equal(metrics.sourcesFailed, 1); assert.equal(metrics.truncatedRequests, 1);
  assert.equal(metrics.healthyEmptySources, 0);
  assert.ok(gaps.some(gap => gap.includes("采集尚不完整")));
  assert.ok(gaps.some(gap => gap.includes("截断")));
});

test("API outage falls back to official batch abstracts, retaining failures and excluded replacement denominators", async () => {
  const batch = await run("html-fallback"), first = nextPaper(), replacement = nextPaper();
  const requests: string[] = [];
  const html = `<div id="dlpage"><h3>Showing new listings for Monday, 5 October 2026</h3><small>Total of 2 entries</small><dl>${[first, replacement].map(id =>
    `<dt><a href="/abs/${id}">arXiv:${id}</a></dt><dd><div class="meta"><div class="list-title"><span class="descriptor">Title:</span>Actual source title ${id}</div><div class="list-authors">Source Author</div><p class="mathjax">This is the original author abstract with a described method, measured observations, and explicit limitations.</p></div></dd>`).join("")}</dl></div>`;
  const fetcher = async (url: string): Promise<GuardedResponse> => {
    requests.push(url);
    if (url.includes("/recent?")) return response(url, listing(1, [{ day: "Mon, 5 Oct 2026", ids: [first] }]));
    if (url.includes("/new?")) return response(url, html);
    return { ...response(url, "Rate exceeded."), status: 429 };
  };
  await collectArxivAnnouncements(batch.id, batch, source, ["cs.AI"], fetcher);
  assert.equal(requests.length, 5);
  const [article] = await sql`SELECT a.* FROM articles a JOIN research_members m ON m.article_id=a.id WHERE m.run_id=${batch.id}`;
  assert.equal(article.research.arxivId, first);
  assert.equal(article.research.announcedOn, "2026-10-05");
  assert.equal(article.research.originalPublishedAt, null);
  assert.equal(article.published_at, null);
  assert.equal(article.research.evidenceBasis, "abstract");
  assert.match(article.body_text, /original author abstract/);
  const { metrics } = await researchRunMetrics(batch.id);
  assert.equal(metrics.stored, 1);
  assert.equal(metrics.returned, 2);
  assert.equal(metrics.parsed, 2);
  assert.equal(metrics.excludedSourceRecords, 1);
  assert.equal(metrics.duplicateRecords, 0);
  assert.equal(metrics.failedRequests, 3);
  assert.equal(metrics.sourcesFailed, 1);
  const coverage = JSON.parse(await readFile(path.join(folder, "research", batch.id, `${source.id}-announcement-coverage.json`), "utf8"));
  assert.deepEqual(coverage.announcedIdentities, [first]);
  assert.deepEqual(coverage.metadataObtained, [first]);
  assert.deepEqual(coverage.missingMetadata, []);
  await collectArxivAnnouncements(batch.id, batch, source, ["cs.AI"], fetcher);
  assert.equal(requests.length, 5, "same snapshot does not repeat exhausted API or successful HTML calls");
});
