// Reserve the daily's input-processing allowance without buying calls, forgiving old spend or
// releasing unknown receipts. Every provider below is an in-process callback, not a network client.
import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { addDays, beijingAt } from "@aihot/contracts/time";
import { EDITION_TIMES } from "@aihot/site";
import { closeDb, sql } from "@aihot/backend/db";
import { BudgetExceededError, logicalKeyFor, paidRequest, ReceiptUnknownError, type ReceiptRequest } from "@aihot/backend/providers/receipts";
import { dailyWorkWindow, type DailyWorkWindow } from "@aihot/backend/reports/daily-work";

const SOURCE = `daily-budget-${tag()}`;
const SIGNAL_SOURCE = `daily-signal-${tag()}`;
before(async () => {
  await sql`INSERT INTO sources (id, name, kind, participation_mode) VALUES
    (${SOURCE}, 'Daily budget fixture', 'rss', 'editorial'),
    (${SIGNAL_SOURCE}, 'Signal budget fixture', 'rss', 'hot_signal')`;
});
beforeEach(async () => {
  // This file owns its disposable database copy (tests/databases.ts).
  await sql`DELETE FROM receipts WHERE service = 'llm'`;
  await sql`DELETE FROM reports WHERE kind = 'daily'`;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES ('llm', 1000, 1000, 10)
    ON CONFLICT (service) DO UPDATE SET per_minute = 1000, per_hour = 1000, per_day = 10`;
});
after(closeDb);

async function article(at: Date, opts: { backfill?: boolean; signal?: boolean } = {}) {
  const id = `daily-${tag()}`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, backfill)
    VALUES (${id}, ${opts.signal ? SIGNAL_SOURCE : SOURCE}, ${id}, ${`https://example.test/${id}`},
      'Daily budget fixture', now(), ${at}, ${opts.backfill ?? false})`;
  return id;
}

const request = (purpose: string, subject?: string, service = "llm"): ReceiptRequest => ({
  service, model: "fixture-model", purpose, subject, identity: { fixture: tag() },
});
const answer = async () => ({ response: { ok: true } });
const isBudget = (window: string) => (error: unknown) =>
  error instanceof BudgetExceededError && error.message.includes(`(${window})`);

async function issue(window: DailyWorkWindow) {
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at)
    VALUES ('daily', ${window.date}, ${window.start}, ${window.end}, '{}'::jsonb, now())`;
}

async function seedAttempt(req: ReceiptRequest, status: "received" | "failed" | "unknown", ageMs = 0, origin = "live") {
  const at = new Date(Date.now() - ageMs);
  const [receipt] = await sql<{ id: number }[]>`
    INSERT INTO receipts (logical_key, service, model, purpose, subject, status, attempts, created_at, updated_at)
    VALUES (${logicalKeyFor(req)}, ${req.service}, ${req.model ?? null}, ${req.purpose}, ${req.subject ?? null},
      ${status}, 1, ${at}, ${at}) RETURNING id`;
  await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, model, origin, status, started_at, finished_at)
    VALUES (${receipt!.id}, 1, ${req.service}, ${req.model ?? null}, ${origin}, ${status}, ${at}, ${at})`;
  return receipt!.id;
}

async function attempts() {
  return (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipt_attempts WHERE service = 'llm' AND origin = 'live'`)[0]!.n;
}

test("today stays protected after the deadline until its issue exists, then the next window is selected", async () => {
  const now = new Date("2035-06-02T15:00:00+08:00");
  const current = await dailyWorkWindow(sql, now);
  assert.equal(current.date, "2035-06-02");
  assert.deepEqual(current.start, beijingAt("2035-06-01", EDITION_TIMES.daily));
  assert.deepEqual(current.end, beijingAt("2035-06-02", EDITION_TIMES.daily));
  await issue(current);
  const next = await dailyWorkWindow(sql, now);
  assert.equal(next.date, "2035-06-03");
  assert.deepEqual(next.start, current.end);
  assert.deepEqual(next.end, beijingAt("2035-06-03", EDITION_TIMES.daily));
  assert.equal((await dailyWorkWindow(sql, new Date("2035-06-03T00:00:00+08:00"))).date, "2035-06-03");
});

test("background stops at 20 percent while all eight necessary article stages can use the remaining total", async () => {
  const window = await dailyWorkWindow();
  const older = await article(new Date(window.start.getTime() - 1));
  const current = await article(window.end);
  for (let i = 0; i < 2; i++) await paidRequest(request("prefilter_article", `article:${older}@1`), answer);
  await assert.rejects(paidRequest(request("score_article", `article:${older}@1`), answer), isBudget("background"));
  for (const purpose of ["prefilter_article", "score_article", "structure_article", "understand_article", "summarize_article", "mend_wording", "group_article", "group_review"]) {
    const subject = purpose.startsWith("group_") ? `article:${current}:fact:fixture` : `article:${current}@1`;
    await paidRequest(request(purpose, subject), answer);
  }
  assert.equal(await attempts(), 10);
  await assert.rejects(paidRequest(request("prefilter_article", `article:${current}@1`), answer), isBudget("day"));
  await assert.rejects(paidRequest(request("report_daily", `article:${current}@1`), answer), isBudget("day"));
  assert.equal(await attempts(), 10);
});

test("the start boundary, backfills, signals and auxiliary purposes cannot consume the daily reserve", async () => {
  const window = await dailyWorkWindow();
  const current = await article(window.end);
  const start = await article(window.start);
  const afterEnd = await article(new Date(window.end.getTime() + 1));
  const backfill = await article(window.end, { backfill: true });
  const signal = await article(window.end, { signal: true });
  for (let i = 0; i < 2; i++) await paidRequest(request("story_digest", `story:fixture-${tag()}`), answer);
  const background = [
    ...[start, afterEnd, backfill, signal].map((id) => request("prefilter_article", `article:${id}@1`)),
    request("prefilter_article", "article:missing@1"), request("score_article"),
    ...["translate_body", "story_digest", "report_daily", "report_weekly", "report_monthly", "report_lead"].map((purpose) => request(purpose, `article:${current}@1`)),
  ];
  for (const req of background) await assert.rejects(paidRequest(req, answer), isBudget("background"));
  assert.equal(await attempts(), 2);
  await paidRequest(request("prefilter_article", `article:${current}@1`), answer);
  assert.equal(await attempts(), 3, "the end boundary belongs to the protected window");
});

test("fractional background shares round down and named providers retain their full existing cap", async () => {
  await sql`UPDATE budgets SET per_day = 9 WHERE service = 'llm'`;
  await paidRequest(request("story_digest", "story:one"), answer);
  await assert.rejects(paidRequest(request("story_digest", "story:two"), answer), isBudget("background"));
  const service = `daily-named-${tag()}`;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES (${service}, 100, 100, 5)`;
  for (let i = 0; i < 5; i++) await paidRequest(request("story_digest", `story:${i}`, service), answer);
  await assert.rejects(paidRequest(request("report_weekly", "report:fixture", service), answer), isBudget("day"));
});

test("failed and unknown background attempts count until the rolling 24-hour window expires", async () => {
  const beforeExpiry = 24 * 3600_000 - 60_000;
  const failed = await seedAttempt(request("story_digest", "story:failed"), "failed", beforeExpiry);
  const unknown = await seedAttempt(request("story_digest", "story:unknown"), "unknown", beforeExpiry);
  await seedAttempt(request("story_digest", "story:replay"), "received", 0, "replay");
  let sent = 0;
  const send = async () => { sent += 1; return answer(); };
  const req = request("story_digest", "story:later");
  await assert.rejects(paidRequest(req, send), isBudget("background"));
  assert.equal(sent, 0);
  await sql`UPDATE receipt_attempts SET started_at = now() - interval '25 hours' WHERE receipt_id IN (${failed}, ${unknown})`;
  await paidRequest(req, send);
  assert.equal(sent, 1, "expired failed/unknown attempts release allowance; replay attempts never consume it");
  assert.equal((await sql`SELECT status FROM receipts WHERE id = ${unknown}`)[0]!.status, "unknown", "aging budget records does not release unknown outcomes");
});

test("the total remains rolling even for protected work and expires without resetting receipts", async () => {
  const window = await dailyWorkWindow();
  const current = await article(window.end);
  const seeded: number[] = [];
  for (let i = 0; i < 10; i++) seeded.push(await seedAttempt(request("score_article", `article:${current}@1`), "received", 2 * 3600_000));
  const req = request("score_article", `article:${current}@1`);
  let sent = 0;
  const send = async () => { sent += 1; return answer(); };
  await assert.rejects(paidRequest(req, send), isBudget("day"));
  assert.equal(sent, 0);
  await sql`UPDATE receipt_attempts SET started_at = now() - interval '25 hours' WHERE receipt_id = ${seeded[0]!}`;
  await paidRequest(req, send);
  assert.equal(sent, 1);
  await assert.rejects(paidRequest(request("score_article", `article:${current}@1`), send), isBudget("day"));
  assert.equal(sent, 1, "only the single expired slot becomes available");
});

test("saving an edition reclassifies its previous spend without resetting either allowance", async () => {
  const window = await dailyWorkWindow();
  const previous = await article(window.end);
  const next = await article(beijingAt(addDays(window.date, 1), EDITION_TIMES.daily));
  for (let i = 0; i < 2; i++) await paidRequest(request("score_article", `article:${previous}@1`), answer);
  await issue(window);
  await assert.rejects(paidRequest(request("score_article", `article:${previous}@1`), answer), isBudget("background"));
  await assert.rejects(paidRequest(request("story_digest", "story:after-edition"), answer), isBudget("background"));
  await paidRequest(request("score_article", `article:${next}@1`), answer);
  assert.equal(await attempts(), 3, "old daily spend now occupies background; the new daily still has reserved capacity");
});

test("received answers are reused at the cap, while unknown receipts never invoke the callback or change state", async () => {
  const window = await dailyWorkWindow();
  const current = await article(window.end);
  const received = request("prefilter_article", `article:${current}@1`);
  let sent = 0;
  const send = async () => { sent += 1; return answer(); };
  const original = await paidRequest(received, send);
  const unknown = request("score_article", `article:${current}@1`);
  const unknownId = await seedAttempt(unknown, "unknown");
  const [before] = await sql`SELECT status, attempts, updated_at FROM receipts WHERE id = ${unknownId}`;
  await assert.rejects(paidRequest(unknown, send), ReceiptUnknownError);
  await sql`UPDATE budgets SET per_day = 2 WHERE service = 'llm'`;
  assert.equal((await paidRequest(received, send)).receiptId, original.receiptId);
  assert.equal((await paidRequest(received, send)).reused, true);
  await assert.rejects(paidRequest(unknown, send), ReceiptUnknownError);
  assert.equal(sent, 1);
  assert.equal(await attempts(), 2);
  const [after] = await sql`SELECT status, attempts, updated_at FROM receipts WHERE id = ${unknownId}`;
  assert.deepEqual(after, before);
  assert.equal((await sql`SELECT 1 FROM audit_log WHERE action = 'receipt.release' AND subject = ${`receipt:${unknownId}`}`).length, 0);
});

async function competing(requests: [ReceiptRequest, ReceiptRequest], send: typeof answer) {
  const locked = gate();
  const release = gate();
  const blocker = sql.begin(async (tx) => {
    await tx`LOCK TABLE receipt_attempts IN SHARE MODE`;
    locked.open();
    await release.promise;
  });
  await locked.promise;
  const outcomes: Promise<PromiseSettledResult<unknown>>[] = [];
  const waitForBlocked = async (count: number) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const rows = await sql`SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'`;
      if (rows.length === count) return;
      assert.ok(Date.now() < deadline, `expected ${count} blocked contenders, saw ${rows.length}`);
      await delay(10);
    }
  };
  try {
    for (const req of requests) {
      outcomes.push(paidRequest(req, send).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      ));
      await waitForBlocked(outcomes.length);
    }
  } finally {
    release.open();
    await blocker;
  }
  return Promise.all(outcomes);
}

test("concurrent background requests cannot both spend its final allowed slot", async () => {
  await paidRequest(request("story_digest", "story:first"), answer);
  let sent = 0;
  const results = await competing([request("story_digest", "story:a"), request("story_digest", "story:b")], async () => {
    sent += 1;
    return answer();
  });
  assert.equal(sent, 1);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.ok(results.some((result) => result.status === "rejected" && isBudget("background")(result.reason)));
  assert.equal(await attempts(), 2);
});

test("protected and background requests cannot both spend the final total slot", async () => {
  const window = await dailyWorkWindow();
  const current = await article(window.end);
  for (let i = 0; i < 9; i++) await seedAttempt(request("score_article", `article:${current}@1`), "received");
  let sent = 0;
  const results = await competing([request("score_article", `article:${current}@1`), request("story_digest", "story:last")], async () => {
    sent += 1;
    return answer();
  });
  assert.equal(sent, 1);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.ok(results.some((result) => result.status === "rejected" && isBudget("day")(result.reason)));
  assert.equal(await attempts(), 10);
});
