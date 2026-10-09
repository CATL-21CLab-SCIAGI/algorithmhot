import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDb, sql } from "@aihot/backend/db";
import { chatJson, ModelOutputError } from "@aihot/backend/providers/llm";
import { ensureModelRun, getModelRun, modelRunFromEnv, withModelExecutionLock } from "@aihot/backend/providers/model-runs";
import { BudgetExceededError, paidRequest, ReceiptUnknownError } from "@aihot/backend/providers/receipts";

after(closeDb);

test("batch budget is persistent, cached receipts are free, and the final allowance is reserved for reports", async () => {
  const run = { id: `budget-${tag()}`, maxCalls: 3, reportReserve: 1 };
  let hits = 0;
  const ask = (identity: string, purpose = "score_article") => paidRequest({ service: "model-run-fixture", purpose, identity, modelRun: run }, async () => { hits++; return { response: { ok: true } }; });
  const first = await ask(`${run.id}:a`);
  assert.equal((await ask(`${run.id}:a`)).receiptId, first.receiptId);
  assert.equal(hits, 1);
  await ask(`${run.id}:b`);
  assert.equal((await ensureModelRun(run)).callsUsed, 2, "restart/open does not reset the counter");
  await assert.rejects(ask(`${run.id}:c`), BudgetExceededError);
  assert.equal(hits, 2);
  await ask(`${run.id}:report`, "report_trial");
  await assert.rejects(ask(`${run.id}:extra-report`, "report_trial"), BudgetExceededError);
  assert.deepEqual(await getModelRun(run.id), { ...run, callsUsed: 3, remaining: 0 });
  await assert.rejects(ensureModelRun({ ...run, maxCalls: 4 }), /different frozen limits/);
  const [attempts] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM receipt_attempts WHERE model_run_id = ${run.id}`;
  assert.equal(attempts!.count, 3);
});

test("concurrent application calls cannot overshoot the frozen allowance", async () => {
  const run = { id: `race-${tag()}`, maxCalls: 3, reportReserve: 1 };
  let hits = 0;
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => paidRequest({ service: `race-fixture-${i}`, purpose: "score_article", identity: `${run.id}:${i}`, modelRun: run }, async () => { hits++; return { response: {} }; })));
  assert.equal(hits, 2);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 2);
  assert.equal((await getModelRun(run.id))!.callsUsed, 2);
});

test("review call ceilings preserve the daily budget and evening allowance without failed attempts", async () => {
  const daily = { id: `review-${tag()}`, maxCalls: 600, reportReserve: 20 };
  const morning = { ...daily, callCeiling: 290 }, afternoon = { ...daily, callCeiling: 435 }, evening = { ...daily, callCeiling: 580 };
  await ensureModelRun(daily);
  await sql`UPDATE model_runs SET calls_used=289 WHERE id=${daily.id}`;
  let hits = 0;
  const service = `review-budget-fixture-${daily.id}`;
  const ask = (run: typeof morning, identity: string) => paidRequest({ service, purpose: "score_article", identity: `${daily.id}:${identity}`, modelRun: run },
    async () => { hits++; return { response: { ok: true } }; });
  const first = await ask(morning, "first");
  await assert.rejects(ask(morning, "next-stage"), BudgetExceededError);
  assert.equal(hits, 1);
  assert.equal((await getModelRun(daily.id))!.callsUsed, 290);
  assert.equal((await sql`SELECT id FROM receipts WHERE service=${service} AND status IN ('unknown','failed')`).length, 0);
  const [attempts] = await sql`SELECT count(*)::int AS n FROM receipt_attempts WHERE model_run_id=${daily.id}`;
  assert.equal(attempts.n, 1, "no attempt or spent unit exists for a call stopped by the morning ceiling");
  assert.equal((await ask(afternoon, "first")).receiptId, first.receiptId);
  await ask(afternoon, "next-stage");
  assert.equal(hits, 2);
  assert.equal((await getModelRun(daily.id))!.callsUsed, 291);
  await sql`UPDATE model_runs SET calls_used=434 WHERE id=${daily.id}`;
  const lastAfternoon = await ask(afternoon, "last-afternoon");
  await assert.rejects(ask(afternoon, "afternoon-overflow"), BudgetExceededError);
  assert.equal((await getModelRun(daily.id))!.callsUsed, 435);
  assert.equal((await ask(evening, "last-afternoon")).receiptId, lastAfternoon.receiptId);
  assert.equal((await sql`SELECT id FROM receipts WHERE service=${service} AND status IN ('unknown','failed')`).length, 0);
  await sql`UPDATE model_runs SET calls_used=579 WHERE id=${daily.id}`;
  await ask(evening, "last-article");
  await assert.rejects(ask(evening, "overflow"), BudgetExceededError);
  assert.deepEqual(await getModelRun(daily.id), { ...daily, callsUsed: 580, remaining: 20 });
});

test("invalid process ceilings cannot enlarge or reset the model allowance", () => {
  const saved = { ...process.env };
  try {
    process.env.MODEL_RUN_ID = "ceiling-fixture";
    process.env.MODEL_RUN_MAX_CALLS = "600";
    process.env.MODEL_RUN_REPORT_RESERVE = "20";
    for (const value of ["0", "601", "290.5", "NaN"]) {
      process.env.MODEL_RUN_CALL_CEILING = value;
      assert.throws(() => modelRunFromEnv(true), /CALL_CEILING/);
    }
    process.env.MODEL_RUN_CALL_CEILING = "290";
    assert.equal(modelRunFromEnv(true)!.callCeiling, 290);
  } finally {
    for (const key of ["MODEL_RUN_ID", "MODEL_RUN_MAX_CALLS", "MODEL_RUN_REPORT_RESERVE", "MODEL_RUN_CALL_CEILING"]) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});

test("model execution lock serializes work while receipt storage remains usable", async () => {
  let active = 0;
  let maxActive = 0;
  await Promise.all(Array.from({ length: 3 }, () => withModelExecutionLock(async () => {
    active++; maxActive = Math.max(maxActive, active);
    await sql`SELECT pg_sleep(0.02)`;
    active--;
  })));
  assert.equal(maxActive, 1);
  await withModelExecutionLock(async () => {
    const [row] = await sql<{ available: boolean }[]>`SELECT pg_try_advisory_lock(hashtext('algorithmhot:model-execution')) AS available`;
    assert.equal(row!.available, false, "another database connection cannot acquire the execution lock");
  });
});

test("Codex business schemas, cached answers, failed raw responses and timeout receipts use the same ledger", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "algorithmhot-ledger-test-"));
  const bin = path.join(dir, "fixture.mjs");
  await writeFile(bin, `#!${process.execPath}\n
    import fs from "node:fs";
    const args = process.argv.slice(2);
    let input = ""; for await (const chunk of process.stdin) input += chunk;
    if (input.includes("test-timeout")) { setInterval(() => {}, 1000); }
    else {
      const content = JSON.stringify({ ok: input.includes("test-malformed") ? "bad" : true });
      fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({ content }));
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 8, output_tokens: 3 } }));
    }
  `, { mode: 0o700 });
  const env = { ...process.env };
  const run = { id: `codex-${tag()}`, maxCalls: 10, reportReserve: 1 };
  Object.assign(process.env, { LLM_TRANSPORT: "codex_cli", CODEX_BIN: bin, MODEL_RUN_ID: run.id, MODEL_RUN_MAX_CALLS: "10", MODEL_RUN_REPORT_RESERVE: "1" });
  const ask = (input: string, timeoutMs = 10_000) => chatJson({ model: "default", purpose: "score_article", subject: `${run.id}:${input}`, user: `${run.id}:${input}`, system: "fixture", promptVersion: "fixture-v1", schema: z.object({ ok: z.boolean() }), timeoutMs });
  try {
    const first = await ask("valid");
    assert.deepEqual(first.data, { ok: true });
    assert.equal((await ask("valid")).reused, true);
    await assert.rejects(ask("test-malformed"), ModelOutputError);
    await assert.rejects(ask("test-timeout", 80));
    await assert.rejects(ask("test-timeout", 80), ReceiptUnknownError);
    assert.equal((await getModelRun(run.id))!.callsUsed, 3);
    const attempts = await sql<{ response: unknown; status: string }[]>`SELECT response, status FROM receipt_attempts WHERE model_run_id = ${run.id} ORDER BY id`;
    assert.equal(attempts.length, 3);
    assert.ok(attempts[1]!.response, "malformed raw response is retained on its own attempt");
    assert.equal(attempts[2]!.status, "unknown");
  } finally {
    for (const key of ["LLM_TRANSPORT", "CODEX_BIN", "MODEL_RUN_ID", "MODEL_RUN_MAX_CALLS", "MODEL_RUN_REPORT_RESERVE"]) {
      if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("API compatibility preserves custom parsing, counts malformed replies and holds timeouts", async () => {
  let answer = "ok:true";
  let wait = 0;
  const provider = await stub(async () => { if (wait) await new Promise((resolve) => setTimeout(resolve, wait)); return { choices: [{ message: { content: answer } }], usage: { total_tokens: 7 } }; });
  const env = { ...process.env };
  const run = { id: `api-${tag()}`, maxCalls: 10, reportReserve: 1 };
  Object.assign(process.env, { LLM_TRANSPORT: "openai_compatible", LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "fixture", LLM_MODEL: "fixture-model", MODEL_RUN_ID: run.id, MODEL_RUN_MAX_CALLS: "10", MODEL_RUN_REPORT_RESERVE: "1" });
  const ask = (user: string, timeoutMs = 1000) => chatJson({ model: "default", purpose: "score_article", subject: user, user, system: "fixture", promptVersion: "fixture-v1", schema: z.object({ ok: z.boolean() }), json: false, parse: (text) => ({ ok: text === "ok:true" ? true : text }), timeoutMs });
  try {
    assert.deepEqual((await ask("valid")).data, { ok: true });
    assert.equal((await ask("valid")).reused, true);
    answer = "malformed";
    await assert.rejects(ask("invalid"), ModelOutputError);
    assert.equal((await getModelRun(run.id))!.callsUsed, 2);
    wait = 80;
    await assert.rejects(ask("timeout", 20));
    await assert.rejects(ask("timeout", 20), ReceiptUnknownError);
    assert.equal((await getModelRun(run.id))!.callsUsed, 3);
    assert.equal(provider.hits(), 3);
  } finally {
    for (const key of ["LLM_TRANSPORT", "LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "MODEL_RUN_ID", "MODEL_RUN_MAX_CALLS", "MODEL_RUN_REPORT_RESERVE"]) {
      if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
    }
    await provider.close();
  }
});
