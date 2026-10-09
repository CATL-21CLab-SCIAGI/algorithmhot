import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { loadPool } from "@aihot/backend/publication/pool";
import { loadTimeline } from "@aihot/backend/publication/timeline";
import { v1Items } from "@aihot/backend/publication/v1";
import { loadTopicPage } from "@aihot/backend/publication/topics";
import { loadGroupReports } from "@aihot/backend/publication/groups";
import { encodeCursor, queryBinding } from "@aihot/backend/lib/cursor";

const T = tag(), source = `reader-dates-${T}`;
const now = new Date("2026-10-08T12:00:00+08:00");
const filters = { channel: "all" as const, category: null, tag: T, topic: null, now };
const rows: Array<{ id: string; raw: Date; expected: Date }> = [];
const ids: string[] = [];
const facts: number[] = [];

async function add(suffix: string, timeline: string, day: string | null, originalPublishedAt: string | null = null, arxivId: string | null = "2610.12345", factId: number | null = null, itemTag = T) {
  const id = `${T}-${suffix}`, at = new Date(timeline);
  const research = { arxivId, announcedOn: day, originalPublishedAt };
  ids.push(id);
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at)
    VALUES(${id},${source},${id},'https://example.test/research','Reader fixture',${at},${at})`;
  await sql`INSERT INTO publications(article_id,title,source_id,channel,url,discovered_at,timeline_at,sort_at,eligible,selected,visible_after,visibility,tags,research,fact_id,search_text)
    VALUES(${id},'Reader fixture',${source},'news','https://example.test/research',${at},${at},${at},true,true,${new Date("2026-10-01T00:00:00Z")},'public',${[itemTag]},${sql.json(research)},${factId},'reader fixture')`;
  await sql`INSERT INTO pool_search(article_id,direct,body) VALUES(${id},'reader fixture','')`;
  if (factId) await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${factId},${id},'report')`;
  return { id, raw: at };
}

before(async () => {
  await sql`INSERT INTO sources(id,name,kind,tier) VALUES(${source},'Reader date test','rss','T1')`;
  await sql`INSERT INTO topics(slug,name,grp,tags,definition,related,position) VALUES(${`reader-${T}`},'Reader dates','field',${[T]},'Test',${[]},0)`;
  const fixture = async (suffix: string, raw: string, day: string | null, expected: string, originalPublishedAt: string | null, arxivId: string | null = "2610.12345") => {
    rows.push({ ...await add(suffix, raw, day, originalPublishedAt, arxivId), expected: new Date(expected) });
  };
  for (let i = 0; i < 42; i++) await fixture(`tied-${String(i).padStart(2, "0")}`, "2026-10-06T19:00:00+08:00", "2026-10-07", "2026-10-06T11:00:00+08:00", "2026-10-06T11:00:00+08:00");
  await fixture("late-discovery", "2026-10-08T10:00:00+08:00", "2026-10-06", "2026-10-02T03:00:00Z", "2026-10-02T03:00:00Z");
  await fixture("today-announcement", "2026-10-07T22:00:00+08:00", "2026-10-08", "2026-10-07T02:00:00+08:00", "2026-10-07T02:00:00+08:00");
  await fixture("future-announcement", "2026-10-07T22:00:00+08:00", "2026-10-09", "2026-10-06T02:00:00+08:00", "2026-10-06T02:00:00+08:00");
  await fixture("unknown-date", "2026-10-05T20:00:00+08:00", "2026-10-05", "2026-10-05T20:00:00+08:00", null);
  await fixture("invalid-date", "2026-10-05T18:00:00+08:00", "2026-02-30", "2026-10-05T01:00:00+08:00", "2026-10-05T01:00:00+08:00");
  await fixture("not-arxiv", "2026-10-05T16:00:00+08:00", "2026-10-08", "2026-10-05T00:00:00+08:00", "2026-10-05T00:00:00+08:00", null);
  rows.sort((a, b) => b.expected.getTime() - a.expected.getTime() || (a.id < b.id ? 1 : -1));
});
after(async () => {
  if (ids.length) await sql`DELETE FROM articles WHERE id IN ${sql(ids)}`;
  if (facts.length) await sql`DELETE FROM facts WHERE id IN ${sql(facts)}`;
  await sql`DELETE FROM topics WHERE slug=${`reader-${T}`}`;
  await sql`DELETE FROM sources WHERE id=${source}`;
  await closeDb();
});

test("v1 cursor windows follow reader dates while explicit published ordering keeps original timestamps", async () => {
  for (const mode of ["all", "selected"] as const) {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await v1Items({ mode, window: "7d", by: "timeline", category: null, q: "reader", limit: 7, cursor }, now);
      seen.push(...page.items.map(item => item.id));
      cursor = page.page.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, rows.filter(row => row.expected <= now).map(row => row.id));
  }
  const published = await v1Items({ mode: "all", window: "7d", by: "published", category: null, q: "reader", limit: 80, cursor: null }, now);
  assert.deepEqual(published.items.map(item => item.id), [...rows].sort((a, b) => b.raw.getTime() - a.raw.getTime() || (a.id < b.id ? 1 : -1)).map(row => row.id));
});

test("topic pages and latest metadata follow the same original publication dates", async () => {
  const seen: string[] = [];
  for (let page = 1; page <= 3; page++) {
    const result = await loadTopicPage(`reader-${T}`, page, now);
    assert.ok(result);
    assert.equal(result.topic.latestAt, rows[0]!.expected.toISOString());
    assert.equal(result.topic.total, rows.length);
    seen.push(...result.items.map(item => item.id));
  }
  assert.deepEqual(seen, rows.map(row => row.id));
});

test("pool and both search tabs share original publication order across numeric pages", async () => {
  for (const search of [{}, { q: "reader", tab: "time" as const }, { q: "reader", tab: "relevance" as const }]) {
    const first = await loadPool({ ...filters, ...search, page: 1 });
    const second = await loadPool({ ...filters, ...search, page: 2 });
    assert.equal(first.total, rows.length);
    assert.equal(first.pageCount, 2);
    assert.equal(first.todayCount, 0, "announcement dates do not make an older original publication today's item");
    assert.deepEqual([...first.items, ...second.items].map(item => item.id), rows.map(row => row.id));
    assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, rows.length);
    for (const item of [...first.items, ...second.items]) assert.equal(item.timelineAt, rows.find(row => row.id === item.id)!.raw.toISOString(), "raw timeline remains an audit field");
  }
});

test("selected cursor order, day counts and anchors use the same original date", async () => {
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await loadTimeline({ ...filters, limit: 7, cursor });
    const expected = rows.slice(seen.length, seen.length + 7);
    assert.deepEqual(page.cards.map(card => card.item.id), expected.map(row => row.id));
    assert.deepEqual(page.cards.map(card => card.anchorAt), expected.map(row => row.expected.toISOString()));
    if (expected.some(row => row.expected.toISOString() === "2026-10-06T03:00:00.000Z")) assert.equal(page.dayCounts["2026-10-06"], 43);
    seen.push(...page.cards.map(card => card.item.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen, rows.map(row => row.id));
  const oldBinding = queryBinding({ c: filters.channel, k: filters.category, t: filters.tag, p: filters.topic });
  const oldCursor = encodeCursor("tl1", { a: rows[0]!.raw.getTime(), g: `a${rows[0]!.id}`, b: oldBinding });
  await assert.rejects(loadTimeline({ ...filters, cursor: oldCursor }), /cursor does not match/);
  const persisted = await sql<{ article_id: string; timeline_at: Date; sort_at: Date }[]>`SELECT article_id,timeline_at,sort_at FROM publications WHERE article_id IN ${sql(rows.map(row => row.id))}`;
  for (const row of persisted) {
    assert.equal(row.timeline_at.toISOString(), rows.find(item => item.id === row.article_id)!.raw.toISOString());
    assert.equal(row.sort_at.toISOString(), row.timeline_at.toISOString());
  }
});

test("a selected research group is anchored by original publication while normal groups retain their development times", async () => {
  const groupTag = `${T}-group`;
  for (const [index, announced] of ["2026-10-07", null].entries()) {
    const [fact] = await sql<{ id: number }[]>`INSERT INTO facts(public_id,title) VALUES(${`reader-date-${T}-${index}`},'Reader fact') RETURNING id`;
    facts.push(fact!.id);
    await add(`group-${index}-a`, "2026-10-05T10:00:00+08:00", announced, announced ? "2026-10-07T01:00:00+08:00" : null, announced ? "2610.12345" : null, fact!.id, groupTag);
    await add(`group-${index}-b`, "2026-10-05T11:00:00+08:00", announced, announced ? "2026-10-07T02:00:00+08:00" : null, announced ? "2610.12345" : null, fact!.id, groupTag);
  }
  const page = await loadTimeline({ ...filters, tag: groupTag });
  assert.deepEqual(page.cards.map(card => card.anchorAt), ["2026-10-06T18:00:00.000Z", "2026-10-05T03:00:00.000Z"]);
  assert.deepEqual(page.dayCounts, { "2026-10-07": 1, "2026-10-05": 1 });
  assert.ok(page.cards.every(card => card.group?.reportCount === 2));
  const expansion = await loadGroupReports({ factPublicId: `reader-date-${T}-0`, channel: "all", category: null, tag: groupTag, topicTags: null, cursor: null, take: 5, revision: null }, now);
  assert.equal(expansion.kind, "ok");
    if (expansion.kind === "ok") assert.deepEqual(expansion.body.reports.map(report => report.id), [`${T}-group-0-b`, `${T}-group-0-a`], "original dates use the same deterministic expansion order");
});
