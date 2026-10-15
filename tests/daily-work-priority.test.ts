// A live backlog must not keep the next issue's input behind yesterday's work. Reordering must
// preserve queued request identities and leave active requests and terminal failures alone.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { currentArticlePriority, queueProcessing, sweepUnprocessed, type ArticlePriorityInput } from "@aihot/backend/jobs/content";
import { sweepUngrouped } from "@aihot/backend/jobs/events";
import { enqueue, ensureQueue, QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { dailyWorkWindow, type DailyWorkWindow } from "@aihot/backend/reports/daily-work";

const T = tag();
const SOURCE = `daily-priority-${T}`;
const SIGNAL = `daily-signal-${T}`;
const NOW = new Date("2040-06-02T12:00:00+08:00");
const WINDOW: DailyWorkWindow = {
  date: "2040-06-02", start: new Date("2040-06-01T08:00:00+08:00"), end: new Date("2040-06-02T08:00:00+08:00"),
};
const CURRENT = new Date("2040-06-02T06:00:00+08:00");
const OLD = new Date("2040-06-01T08:00:00+08:00");
const NEXT = new Date("2040-06-02T10:00:00+08:00");

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES
    (${SOURCE}, 'Daily priority fixture', 'rss', 'T1', 'editorial', '2100-01-01'),
    (${SIGNAL}, 'Daily signal fixture', 'rss', 'T2', 'hot_signal', '2100-01-01')`;
  for (const name of [QUEUES.analyze, QUEUES.extractBody, QUEUES.group]) await ensureQueue(name);
});
beforeEach(async () => {
  await sql`DELETE FROM pgboss.job WHERE data->>'articleId' IN (SELECT id FROM articles WHERE source_id IN (${SOURCE}, ${SIGNAL}))`;
  await sql`DELETE FROM articles WHERE source_id IN (${SOURCE}, ${SIGNAL})`;
  await sql`DELETE FROM reports WHERE kind = 'daily' AND key IN ('2040-06-02', '2040-06-03')`;
});
after(async () => { await stopBoss(); await closeDb(); });

interface FixtureOptions {
  discoveredAt?: Date;
  publishedAt?: Date | null;
  backfill?: boolean;
  signal?: boolean;
  state?: "new" | "analyzed" | "failed";
  groupingStatus?: "pending" | "complete" | "failed";
  createdAt?: Date;
}

async function article(at: Date, opts: FixtureOptions = {}) {
  const id = `dp-${tag()}`;
  const discoveredAt = opts.discoveredAt ?? at;
  await sql`INSERT INTO articles
    (id, source_id, identity_key, url, title, body_text, body_status, published_at, discovered_at, timeline_at,
     backfill, processing_state, grouping_status, created_at)
    VALUES (${id}, ${opts.signal ? SIGNAL : SOURCE}, ${id}, ${`https://example.org/${id}`}, 'Priority fixture', 'Fixture body.', 'ok',
      ${opts.publishedAt === undefined ? at : opts.publishedAt}, ${discoveredAt}, ${at}, ${opts.backfill ?? false},
      ${opts.state ?? "new"}, ${opts.groupingStatus ?? "pending"}, ${opts.createdAt ?? new Date(Date.now() - 600_000)})`;
  return id;
}

async function saveToday() {
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, origin)
    VALUES ('daily', ${WINDOW.date}, ${WINDOW.start}, ${WINDOW.end}, '{}', ${NOW}, 'manual')`;
}

test("the protected edition stays the same across midnight and 08:00, then advances after publication", async () => {
  assert.equal((await dailyWorkWindow(sql, new Date("2040-06-02T00:01:00+08:00"))).date, WINDOW.date);
  assert.equal((await dailyWorkWindow(sql, new Date("2040-06-02T07:59:59+08:00"))).date, WINDOW.date);
  assert.equal((await dailyWorkWindow(sql, new Date("2040-06-02T08:00:00+08:00"))).date, WINDOW.date);
  await saveToday();
  const next = await dailyWorkWindow(sql, new Date("2040-06-02T23:59:59+08:00"));
  const afterMidnight = await dailyWorkWindow(sql, new Date("2040-06-03T00:00:00+08:00"));
  assert.equal(next.date, "2040-06-03");
  assert.deepEqual(afterMidnight, next);
});

test("only editorial input in (start, end] gets daily priority; history and signals retain their order", () => {
  const input: ArticlePriorityInput = {
    backfill: false, published_at: CURRENT, discovered_at: CURRENT, timeline_at: CURRENT, participation_mode: "editorial",
  };
  assert.equal(currentArticlePriority(input, WINDOW), 2);
  assert.equal(currentArticlePriority({ ...input, timeline_at: WINDOW.start }, WINDOW), 0);
  assert.equal(currentArticlePriority({ ...input, timeline_at: WINDOW.end }, WINDOW), 2);
  assert.equal(currentArticlePriority({ ...input, timeline_at: NEXT }, WINDOW), 0);
  assert.equal(currentArticlePriority({ ...input, backfill: true }, WINDOW), 0);
  assert.equal(currentArticlePriority({ ...input, backfill: true, published_at: null }, WINDOW), -2);
  assert.equal(currentArticlePriority({ ...input, participation_mode: "hot_signal" }, WINDOW, true), -1);
});

test("new analysis and extraction jobs receive daily priority without changing the evaluation tag", async () => {
  const current = await article(CURRENT);
  const old = await article(OLD);
  const extraction = await article(CURRENT);
  const signal = await article(CURRENT, { signal: true });
  const history = await article(OLD, { backfill: true, publishedAt: null });
  const ids = [
    await queueProcessing(current, { dailyWindow: WINDOW, attemptTag: "fixture-evaluation" }),
    await queueProcessing(old, { dailyWindow: WINDOW }),
    await queueProcessing(extraction, { dailyWindow: WINDOW, step: "extract" }),
    await queueProcessing(signal, { dailyWindow: WINDOW }),
    await queueProcessing(history, { dailyWindow: WINDOW }),
  ];
  const rows = await sql<{ id: string; name: string; priority: number; data: { articleId: string; attemptTag?: string; signalOnly?: boolean } }[]>`
    SELECT id, name, priority, data FROM pgboss.job WHERE id = ANY(${ids.filter((id): id is string => id !== null)}::uuid[])`;
  const jobs = new Map(rows.map((row) => [row.data.articleId, row]));
  assert.equal(jobs.get(current)?.priority, 2);
  assert.deepEqual(jobs.get(current)?.data, { articleId: current, attemptTag: "fixture-evaluation" });
  assert.equal(jobs.get(old)?.priority, 0);
  assert.equal(jobs.get(extraction)?.name, QUEUES.extractBody);
  assert.equal(jobs.get(extraction)?.priority, 2);
  assert.equal(jobs.get(signal)?.priority, -1);
  assert.equal(jobs.get(history)?.priority, -2);
});

test("sweep reprioritizes queued and retrying jobs in place while preserving active jobs and identities", async () => {
  const current = await article(CURRENT, { state: "analyzed" });
  const old = await article(OLD, { state: "analyzed" });
  const next = await article(NEXT, { state: "analyzed" });
  const active = await article(CURRENT, { state: "analyzed" });
  const analysisId = await enqueue(QUEUES.analyze, { articleId: current, attemptTag: "keep-this-tag" }, { singletonKey: `identity-${current}`, priority: 0 });
  const extractionId = await enqueue(QUEUES.extractBody, { articleId: current }, { singletonKey: current, priority: 0 });
  const groupingId = await enqueue(QUEUES.group, { articleId: current }, { singletonKey: current, priority: 0 });
  const oldId = await enqueue(QUEUES.analyze, { articleId: old }, { singletonKey: old, priority: 2 });
  const nextId = await enqueue(QUEUES.analyze, { articleId: next }, { singletonKey: next, priority: 0 });
  const activeId = await enqueue(QUEUES.analyze, { articleId: active }, { singletonKey: active, priority: 0 });
  await sql`UPDATE pgboss.job SET state = 'retry', retry_count = 1 WHERE id = ${extractionId!}`;
  await sql`UPDATE pgboss.job SET state = 'active', started_on = now() WHERE id = ${activeId!}`;
  const snapshot = async () => sql`SELECT id, name, state, priority, data, singleton_key, retry_count, created_on, start_after
    FROM pgboss.job WHERE data->>'articleId' IN (${current}, ${old}, ${next}, ${active}) ORDER BY id`;
  const before = await snapshot();
  assert.equal((await sweepUnprocessed(NOW)).enqueued, 0);
  const after = await snapshot();
  assert.deepEqual(after.map(({ priority: _priority, ...rest }) => rest), before.map(({ priority: _priority, ...rest }) => rest));
  const priority = new Map(after.map((row) => [row.id, row.priority]));
  for (const id of [analysisId, extractionId, groupingId]) assert.equal(priority.get(id), 2);
  assert.equal(priority.get(oldId), 0, "yesterday's queued job cannot retain daily priority");
  assert.equal(priority.get(nextId), 0);
  assert.equal(priority.get(activeId), 0, "an in-flight job is never restarted or reordered");

  await saveToday();
  await sweepUnprocessed(NOW);
  const advanced = new Map((await snapshot()).map((row) => [row.id, row.priority]));
  for (const id of [analysisId, extractionId, groupingId]) assert.equal(advanced.get(id), 0);
  assert.equal(advanced.get(nextId), 2, "the next issue takes priority once today's issue is saved");
});

test("a full sweep batch cannot exclude today's input behind 500 later-discovered old articles", async () => {
  const current = await article(CURRENT, { discoveredAt: OLD });
  const rows = Array.from({ length: 500 }, (_, i) => ({
    id: `batch-${T}-${i}`, source_id: SOURCE, identity_key: `batch-${T}-${i}`, url: `https://example.org/batch-${i}`,
    title: "Old fixture", body_text: "Fixture body.", body_status: "ok", discovered_at: NEXT, timeline_at: OLD,
    published_at: OLD, created_at: new Date(Date.now() - 600_000),
  }));
  await sql`INSERT INTO articles ${sql(rows)}`;
  assert.equal((await sweepUnprocessed(NOW)).enqueued, 500);
  const [job] = await sql`SELECT priority FROM pgboss.job WHERE name = ${QUEUES.analyze} AND data->>'articleId' = ${current}`;
  assert.equal(job?.priority, 2);
});

test("group recovery prioritizes daily candidates and leaves terminal failures unqueued", async () => {
  const current = await article(CURRENT, { state: "analyzed", createdAt: new Date(Date.now() - 240_000) });
  const failed = await article(CURRENT, { state: "analyzed", groupingStatus: "failed" });
  const background: string[] = [];
  for (let i = 0; i < 100; i++) background.push(await article(OLD, { state: "analyzed" }));
  for (const id of [current, failed, ...background]) {
    await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance) VALUES (${id}, 1, 'rule', 'pass')`;
  }
  assert.equal((await sweepUngrouped(NOW)).enqueued, 100);
  const [job] = await sql`SELECT priority FROM pgboss.job WHERE name = ${QUEUES.group} AND data->>'articleId' = ${current}`;
  assert.equal(job?.priority, 2);
  assert.equal((await sql`SELECT 1 FROM pgboss.job WHERE data->>'articleId' = ${failed}`).length, 0);
});
