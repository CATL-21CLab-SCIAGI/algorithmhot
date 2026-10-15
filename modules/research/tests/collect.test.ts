// Feeds into the material entrance and the daily hold (needs the test database: npm test).
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { beijingDate } from "@aihot/contracts/time";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectArxivFeed, collectCrossrefFeed } from "../collect.ts";
import { feeds } from "../feeds.ts";
import research from "../server.ts";

after(async () => {
  await stopBoss();
  await closeDb();
});

const file = path.join(mkdtempSync(path.join(tmpdir(), "research-feeds-")), "feeds.json");
writeFileSync(file, JSON.stringify({
  arxiv: [{ id: "arxiv-test", name: "arXiv · test", categories: ["cs.LG", "cs.AI"], tier: "T1_5", tags: ["论文"] }],
  crossref: [{ id: "crossref-test", name: "Test Journal", issn: ["1234-5678"], tier: "T1_5" }],
}));
const { arxiv: [arxivFeed], crossref: [journal] } = feeds(file);

const entry = (id: string) => `<dt><a href="/abs/${id}">arXiv:${id}</a></dt><dd><div class="list-title"><span class="descriptor">Title:</span> Paper ${id}</div>
  <div class="list-authors">Alice</div><div class="list-subjects">(cs.LG)</div><p class="mathjax">Abstract of ${id}.</p></dd>`;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** The latest Beijing weekday whose 08:00 has passed, and the Sunday before it. */
function announcement(): { day: string; heading: string; sunday: string } {
  // 08:00 Beijing is 00:00 UTC: the UTC date is the latest Beijing day whose 08:00 has passed.
  let t = Date.now();
  let day = new Date(t).toISOString().slice(0, 10);
  while (![1, 2, 3, 4, 5].includes(new Date(`${day}T00:00:00Z`).getUTCDay())) day = new Date((t -= 86_400_000)).toISOString().slice(0, 10);
  const d = new Date(`${day}T00:00:00Z`);
  const sunday = new Date(d.getTime() - d.getUTCDay() * 86_400_000).toISOString().slice(0, 10);
  return { day, heading: `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`, sunday };
}
const page = (day: string, ids: string[]) => `<div id="dlpage"><h3>Showing new listings for ${day}</h3><small>Total of ${ids.length} entries</small>
  <h3>New submissions</h3><dl>${ids.map(entry).join("")}</dl></div>`;

test("an announcement goes online at 08:00 Beijing on its day; a paper listed in two categories is one material", async () => {
  process.env.COLLECT_ENABLED = "true";
  const hold = research.reports!.dailyHold!;
  const window = (date: string) => ({ date, start: new Date(`${date}T00:00:00Z`), end: new Date(`${date}T00:00:00Z`), now: new Date() });
  // A weekday's daily waits until the feed has read that day's listing.
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES ('arxiv-test', 'arXiv · test', 'external', 'T1_5') ON CONFLICT DO NOTHING`;
  const a = announcement();
  assert.match(String(await hold(window(a.day))), /arxiv-test/);
  assert.equal(await hold(window(a.sunday)), null, "Sunday: no announcement to wait for");

  const pages: Record<string, string> = {
    cs_LG: page(a.heading, ["2610.00001", "2610.00002"]),
    cs_AI: page(a.heading, ["2610.00002", "2610.00003"]),
  };
  const run = await collectArxivFeed(arxivFeed!, async (url) => pages[/list\/([^/]+)\//.exec(url)![1]!.replace(".", "_")]!);
  assert.deepEqual([run.status, run.found, run.created], ["ok", 4, 3]);
  const rows = await sql<{ identity_key: string; timeline_at: Date; backfill: boolean; notes: Array<{ label: string; value?: string }> }[]>`
    SELECT identity_key, timeline_at, backfill, raw->'notes' AS notes FROM articles WHERE source_id = 'arxiv-test' ORDER BY identity_key`;
  assert.deepEqual(rows.map((r) => r.identity_key), ["arxiv:2610.00001", "arxiv:2610.00002", "arxiv:2610.00003"]);
  // Collected after the announcement: its minute is 08:00 Beijing, the last minute of that morning's daily window.
  for (const r of rows) assert.equal(r.timeline_at.toISOString(), `${a.day}T00:00:00.000Z`);
  assert.ok(rows[0]!.notes.some((n) => n.label === "配图" && n.value === "待补"));
  assert.equal(await hold(window(a.day)), null);

  // A failed listing never moves the cursor and marks the source.
  const failed = await collectArxivFeed(arxivFeed!, async () => "<html>maintenance</html>");
  assert.equal(failed.status, "failed");
  const [s] = await sql<{ health: string; listing_day: string }[]>`SELECT health, cursor->>'listingDay' AS listing_day FROM sources WHERE id = 'arxiv-test'`;
  assert.deepEqual([s!.health, s!.listing_day], ["degraded", a.day]);
});

test("a journal article keeps its first online day; without one it goes online when it was found", async () => {
  // The cursor is a Beijing day, whatever the clock of the machine running the test.
  const today = beijingDate(new Date());
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const [y, m, d] = yesterday.split("-").map(Number);
  const urls: string[] = [];
  const run = await collectCrossrefFeed(journal!, async (url) => {
    urls.push(url);
    return { message: { items: [
      { DOI: "10.1/a", type: "journal-article", title: ["Dated"], "published-online": { "date-parts": [[y, m, d]] } },
      { DOI: "10.1/b", type: "journal-article", title: ["Undated"] },
    ] } };
  });
  assert.equal(run.status, "ok");
  assert.match(urls[0]!, /from-created-date%3A\d{4}-\d{2}-\d{2}%2Ctype%3Ajournal-article/);
  const rows = await sql<{ identity_key: string; published_at: Date; timeline_at: Date; discovered_at: Date; backfill: boolean }[]>`
    SELECT identity_key, published_at, timeline_at, discovered_at, backfill FROM articles WHERE source_id = 'crossref-test' ORDER BY identity_key`;
  const [dated, undated] = rows;
  assert.equal(dated!.published_at.toISOString(), `${yesterday}T00:00:00.000Z`);
  // A day alone: on that Beijing day (until its end), never after the site found it.
  assert.ok(dated!.timeline_at.getTime() <= dated!.discovered_at.getTime());
  assert.equal(dated!.backfill, false);
  assert.equal(undated!.timeline_at.toISOString(), undated!.discovered_at.toISOString());
  assert.equal(undated!.backfill, false);
  const [cursor] = await sql<{ since: string }[]>`SELECT cursor->>'since' AS since FROM sources WHERE id = 'crossref-test'`;
  assert.equal(cursor!.since, today);
});
