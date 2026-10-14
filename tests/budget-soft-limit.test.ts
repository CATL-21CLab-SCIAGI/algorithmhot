// The default model's limits come from the environment when set (LLM_BUDGET_*), and a day's limit holds
// back judging work but never an issue's writing (purpose report_*).
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { applyBudgetEnv, BudgetExceededError, paidRequest } from "@aihot/backend/providers/receipts";

after(async () => {
  await stopBoss();
  await closeDb();
});

const call = (purpose: string) => paidRequest(
  { service: "llm", model: "m", purpose, subject: `budget:${tag()}`, identity: { n: tag() } },
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

test("a spent day's limit makes judging wait, while an issue's writing still goes out", async () => {
  await sql`DELETE FROM receipt_attempts WHERE service = 'llm'`;
  await applyBudgetEnv({ LLM_BUDGET_PER_DAY: "2" });
  await call("score_article");
  await call("prefilter_article");
  await assert.rejects(call("score_article"), (e) => e instanceof BudgetExceededError);
  const written = await call("report_daily");
  assert.equal(written.reused, false);
});
