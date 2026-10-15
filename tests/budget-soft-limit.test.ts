// Environment settings preserve the configured limits; every paid purpose respects the total cap.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { applyBudgetEnv, BudgetExceededError, paidRequest } from "@aihot/backend/providers/receipts";
import { dailyWorkWindow } from "@aihot/backend/reports/daily-work";

after(async () => {
  await stopBoss();
  await closeDb();
});

const call = (purpose: string, subject = `budget:${tag()}`) => paidRequest(
  { service: "llm", model: "m", purpose, subject, identity: { n: tag() } },
  async () => ({ response: { ok: true }, requestId: null, usage: null, cost: null }),
);

test("environment limits are written to the budgets table; unset ones keep the table's", async () => {
  const [before] = await sql<{ per_minute: number }[]>`SELECT per_minute FROM budgets WHERE service = 'llm'`;
  await applyBudgetEnv({ LLM_BUDGET_PER_DAY: "2", LLM_BUDGET_PER_HOUR: "100" });
  const [row] = await sql<{ per_minute: number; per_hour: number; per_day: number }[]>`SELECT per_minute, per_hour, per_day FROM budgets WHERE service = 'llm'`;
  assert.deepEqual([row!.per_minute, row!.per_hour, row!.per_day], [before!.per_minute, 100, 2]);
  await assert.rejects(applyBudgetEnv({ LLM_BUDGET_PER_DAY: "lots" }), /non-negative integer/);
  await applyBudgetEnv({}); // nothing set: nothing changes
  assert.equal((await sql<{ per_day: number }[]>`SELECT per_day FROM budgets WHERE service = 'llm'`)[0]!.per_day, 2);
});

test("a spent day's total limit also stops report writing before another attempt is reserved", async () => {
  await sql`DELETE FROM receipt_attempts WHERE service = 'llm'`;
  await applyBudgetEnv({ LLM_BUDGET_PER_DAY: "2" });
  const id = `budget-${tag()}`;
  const window = await dailyWorkWindow();
  await sql`INSERT INTO sources (id, name, kind, participation_mode)
    VALUES (${id}, 'Budget fixture', 'rss', 'editorial')`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
    VALUES (${id}, ${id}, ${id}, ${`https://example.test/${id}`}, 'Budget fixture', now(), ${window.end})`;
  const subject = `article:${id}@1`;
  await call("score_article", subject);
  await call("prefilter_article", subject);
  for (const purpose of ["score_article", "report_daily", "report_weekly", "report_monthly", "report_lead"]) {
    await assert.rejects(call(purpose, subject), (e) => e instanceof BudgetExceededError && e.message.includes("(day)"));
  }
  const [attempts] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipt_attempts WHERE service = 'llm'`;
  assert.equal(attempts!.n, 2, "report writing cannot reserve an extra paid attempt above the total cap");
});
