// A manual day-allowance reset preserves the paid ledger and short-window limits. All requests use
// in-process fixtures; no model or production database is contacted by this test file.
import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { closeDb, sql } from "@aihot/backend/db";
import { getBudgetStatus, resetBudgetUsage } from "@aihot/backend/providers/budgets";
import { BudgetExceededError, paidRequest, ProviderRejectedError, ReceiptUnknownError, type ReceiptRequest } from "@aihot/backend/providers/receipts";

after(closeDb);

async function service(limits: { minute?: number; hour?: number; day?: number } = {}) {
  const name = `reset-fixture-${tag()}`;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day)
    VALUES (${name}, ${limits.minute ?? 100}, ${limits.hour ?? 100}, ${limits.day ?? 10})`;
  return name;
}

const request = (name: string): ReceiptRequest => ({
  service: name, model: "fixture-model", purpose: "reset_fixture", subject: `fixture:${tag()}`, identity: { nonce: tag() },
});
const answer = async () => ({ response: { saved: true }, usage: { total_tokens: 1 } });
const reset = (name: string, operationId = `reset-${tag()}`) => resetBudgetUsage(name,
  { operationId, reason: "Explicit isolated test allowance reset" }, "test-budget-reset");
const isBudget = (window: string) => (error: unknown) =>
  error instanceof BudgetExceededError && error.message.includes(`(${window})`);

async function ledger(name: string) {
  return {
    receipts: [...await sql`SELECT * FROM receipts WHERE service = ${name} ORDER BY id`],
    attempts: [...await sql`SELECT * FROM receipt_attempts WHERE service = ${name} ORDER BY id`],
  };
}

test("a day reset grants allowance without rewriting limits, receipts, attempts or an unknown outcome", async () => {
  const name = await service({ day: 2 });
  const known = request(name);
  const unknown = request(name);
  let sent = 0;
  const received = await paidRequest(known, async () => { sent += 1; return answer(); });
  await assert.rejects(paidRequest(unknown, async () => {
    sent += 1;
    throw new Error("fixture transport lost its answer");
  }), ReceiptUnknownError);
  const before = await ledger(name);
  const limits = [...await sql`SELECT * FROM budgets WHERE service = ${name}`];
  const used = await getBudgetStatus(name);
  assert.equal(used!.usedDay, 2);
  const operationId = `preserve-${tag()}`;
  const result = await reset(name, operationId);
  assert.equal(result.alreadyReset, false);
  assert.deepEqual(await ledger(name), before, "a new allowance is not a ledger rewrite");
  assert.deepEqual([...await sql`SELECT * FROM budgets WHERE service = ${name}`], limits);
  const afterReset = await getBudgetStatus(name);
  assert.equal(afterReset!.usedDay, 0);
  assert.equal(afterReset!.used24h, 2, "actual rolling usage remains visible");
  assert.equal(afterReset!.usedMinute, 2);
  assert.equal(afterReset!.usedHour, 2);
  assert.equal(afterReset!.resetAttemptId, result.afterAttemptId);
  assert.equal(afterReset!.resetAt!.toISOString(), result.resetAt);
  assert.equal(afterReset!.asOf.getTime() - afterReset!.dayStart.getTime(), 24 * 3600_000);
  const neverSend = async () => { sent += 1; return answer(); };
  assert.equal((await paidRequest(known, neverSend)).receiptId, received.receiptId);
  await assert.rejects(paidRequest(unknown, neverSend), ReceiptUnknownError);
  assert.equal(sent, 2, "reset neither buys a saved answer again nor releases an unknown request");
  assert.deepEqual(await ledger(name), before);
  const events = await sql`SELECT actor, action, subject, request_id FROM audit_log
    WHERE subject = ${`budget:${name}`} AND action = 'budget.day.reset'`;
  assert.deepEqual(events.map((row) => ({ ...row })), [{ actor: "test-budget-reset", action: "budget.day.reset", subject: `budget:${name}`, request_id: operationId }]);
});

test("a new attempt of a failed receipt is charged to the new allowance", async () => {
  const name = await service({ day: 1 });
  const req = request(name);
  await assert.rejects(paidRequest(req, async () => {
    throw new ProviderRejectedError("fixture HTTP 503", 503, true);
  }), ProviderRejectedError);
  const [original] = await sql<{ id: number }[]>`SELECT id FROM receipts WHERE service = ${name}`;
  await assert.rejects(paidRequest(req, answer), isBudget("day"));
  const boundary = await reset(name);
  const retried = await paidRequest(req, answer);
  assert.equal(retried.receiptId, original!.id);
  assert.equal(retried.reused, false);
  const rows = await sql<{ id: number; attempt: number; status: string }[]>`
    SELECT id, attempt, status FROM receipt_attempts WHERE receipt_id = ${original!.id} ORDER BY attempt`;
  assert.deepEqual(rows.map(({ attempt, status }) => ({ attempt, status })), [
    { attempt: 1, status: "failed" }, { attempt: 2, status: "received" },
  ]);
  assert.ok(rows[0]!.id <= boundary.afterAttemptId);
  assert.ok(rows[1]!.id > boundary.afterAttemptId);
  const status = await getBudgetStatus(name);
  assert.equal(status!.usedDay, 1);
  assert.equal(status!.used24h, 2);
  await assert.rejects(paidRequest(request(name), answer), isBudget("day"));
});

test("resetting the day allowance does not clear the minute or hour circuit breaker", async () => {
  for (const window of ["minute", "hour"] as const) {
    const name = await service(window === "minute" ? { minute: 1 } : { hour: 1 });
    await paidRequest(request(name), answer);
    await reset(name);
    const status = await getBudgetStatus(name);
    assert.equal(status!.usedDay, 0);
    assert.equal(status!.usedMinute, 1);
    assert.equal(status!.usedHour, 1);
    let sent = 0;
    await assert.rejects(paidRequest(request(name), async () => { sent += 1; return answer(); }), isBudget(window));
    assert.equal(sent, 0);
    assert.equal((await ledger(name)).attempts.length, 1);
  }
});

test("operation IDs remain idempotent across A, B, A and never restore an older watermark", async () => {
  const name = await service();
  const operationA = `reset-a-${tag()}`;
  const operationB = `reset-b-${tag()}`;
  await paidRequest(request(name), answer);
  const a = await reset(name, operationA);
  const repeatedA = await reset(name, operationA);
  assert.equal(repeatedA.alreadyReset, true);
  assert.equal(repeatedA.afterAttemptId, a.afterAttemptId);
  await paidRequest(request(name), answer);
  const b = await reset(name, operationB);
  assert.ok(b.afterAttemptId > a.afterAttemptId);
  await paidRequest(request(name), answer);
  const before = await getBudgetStatus(name);
  const lateA = await reset(name, operationA);
  assert.equal(lateA.alreadyReset, true);
  assert.equal(lateA.afterAttemptId, a.afterAttemptId, "the response identifies the original completed operation");
  const afterReset = await getBudgetStatus(name);
  assert.equal(afterReset!.resetAttemptId, b.afterAttemptId, "replaying A must not overwrite the later B reset");
  assert.equal(afterReset!.resetAt!.toISOString(), b.resetAt);
  assert.equal(afterReset!.usedDay, before!.usedDay);
  assert.equal(afterReset!.usedDay, 1);
  assert.equal(afterReset!.used24h, 3);
  const events = await sql`SELECT request_id FROM audit_log
    WHERE action = 'budget.day.reset' AND subject = ${`budget:${name}`} ORDER BY id`;
  assert.deepEqual(events.map((row) => row.request_id), [operationA, operationB]);
});

test("the llm background allowance resets while its 20 percent share and total cap stay fixed", async () => {
  await sql`DELETE FROM settings WHERE key = 'budget.day.reset.llm'`;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day) VALUES ('llm', 1000, 1000, 10)
    ON CONFLICT (service) DO UPDATE SET per_minute = 1000, per_hour = 1000, per_day = 10`;
  const background = () => ({ ...request("llm"), purpose: "story_digest", subject: `story:${tag()}` });
  for (let i = 0; i < 2; i++) await paidRequest(background(), answer);
  await assert.rejects(paidRequest(background(), answer), isBudget("background"));
  const before = await ledger("llm");
  await reset("llm");
  assert.deepEqual(await ledger("llm"), before);
  assert.equal((await getBudgetStatus("llm"))!.usedDay, 0);
  for (let i = 0; i < 2; i++) await paidRequest(background(), answer);
  await assert.rejects(paidRequest(background(), answer), isBudget("background"));
  const status = await getBudgetStatus("llm");
  assert.equal(status!.per_day, 10);
  assert.equal(status!.usedDay, 2);
  assert.equal(status!.used24h, 4);
  assert.equal(status!.usedMinute, 4);
});

test("a paid request already waiting behind a reset is timestamped and counted after that reset", async () => {
  const name = await service();
  await paidRequest(request(name), answer);
  const locked = gate();
  const release = gate();
  const blocker = sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`budget:${name}`}))`;
    locked.open();
    await release.promise;
  });
  await locked.promise;
  const waitForBlocked = async (expected: number) => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const waiting = await sql`SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND state = 'active'
          AND query LIKE '%pg_advisory_xact_lock%'`;
      if (waiting.length === expected) return;
      assert.ok(Date.now() < deadline, `expected ${expected} lock waiters, saw ${waiting.length}`);
      await delay(10);
    }
  };
  let resetting: ReturnType<typeof reset> | undefined;
  let pending: ReturnType<typeof paidRequest> | undefined;
  try {
    resetting = reset(name);
    await waitForBlocked(1);
    pending = paidRequest(request(name), answer);
    await waitForBlocked(2);
    // This request's transaction began before the reset; its admitted timestamp must not use now().
    await delay(20);
  } finally {
    release.open();
    await blocker;
  }
  const [boundary, result] = await Promise.all([resetting, pending]);
  const [attempt] = await sql<{ id: number; started_at: Date }[]>`
    SELECT id, started_at FROM receipt_attempts WHERE receipt_id = ${result.receiptId}`;
  assert.ok(attempt!.id > boundary.afterAttemptId);
  assert.ok(attempt!.started_at.getTime() >= Date.parse(boundary.resetAt), "use the post-lock admission time, not the earlier transaction time");
  const status = await getBudgetStatus(name);
  assert.equal(status!.usedDay, 1);
  assert.equal(status!.used24h, 2);
});
