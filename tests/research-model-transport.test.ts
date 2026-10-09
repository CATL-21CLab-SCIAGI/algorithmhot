import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

const savedEnv = { ...process.env };
const { tag } = await import("./setup.ts"); // Refuses databases outside *_test / *_ci.
const savedFetch = globalThis.fetch;
process.env.DATABASE_POOL_MAX = "1";
process.env.COLLECT_ENABLED = "false";
const { config } = await import("@aihot/backend/config");
const savedModelCalls = config.modelCallsEnabled;
config.modelCallsEnabled = true;
const { sql, closeDb } = await import("@aihot/backend/db");
const { chatJson, ModelOutputError } = await import("@aihot/backend/providers/llm");
const { ensureModelRun, getModelRun } = await import("@aihot/backend/providers/model-runs");
const { BudgetExceededError, ProviderRejectedError, ReceiptUnknownError } = await import("@aihot/backend/providers/receipts");
const { RESEARCH_MODEL_PROFILES, RESEARCH_MODEL_SETTING } = await import("@aihot/backend/providers/research-model");
const { articleRequestHold, processIsolatedResearchArticles, runIsolatedArticleStep, ResearchBatchStoppedError, ResearchRequestHeldError } = await import("@aihot/backend/research/request-isolation");

const directory = await mkdtemp(path.join(tmpdir(), "algorithmhot-model-transport-"));
const bin = path.join(directory, "codex-fixture.mjs"), invocations = path.join(directory, "invocations.jsonl");
const tables = ["articles", "research_runs", "research_members", "model_runs", "receipts", "receipt_attempts", "budgets", "settings"];
let runId: string, hits: number;
let answer: typeof fetch = async () => { throw new Error("No offline response configured; real network is forbidden"); };
globalThis.fetch = async (...args) => { hits++; return answer(...args); };

before(async () => {
  // A single pool connection owns temporary copies, so other suites' historical failures cannot
  // trigger this suite's global account/UNKNOWN gates. Public data and schemas are never changed.
  for (const table of tables) await sql.unsafe(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
  // Allows this targeted test on a retained pre-0051 test DB; fresh full-check databases already
  // have the actual migration. This ALTER is explicitly limited to the temporary table.
  await sql`ALTER TABLE pg_temp.research_runs ADD COLUMN IF NOT EXISTS model_profile jsonb`;
  await writeFile(bin, `#!${process.execPath}\n
    import fs from "node:fs";
    const args = process.argv.slice(2);
    for await (const chunk of process.stdin) {}
    const model = args[args.indexOf("--model") + 1];
    const effort = args.find(arg => arg.startsWith("model_reasoning_effort="));
    fs.appendFileSync(${JSON.stringify(invocations)}, JSON.stringify({ model, effort }) + "\\n");
    fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({ content: JSON.stringify({ ok: true, model, effort }) }));
    console.log(JSON.stringify({ type: "thread.started", thread_id: "transport-fixture-thread" }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }));
  `, { mode: 0o700 });
});
beforeEach(async () => {
  await sql.unsafe(`TRUNCATE ${tables.join(",")}`);
  runId = `transport-${tag()}`;
  hits = 0;
  answer = async () => { throw new Error("No offline response configured; real network is forbidden"); };
  Object.assign(process.env, {
    MODEL_RUN_ID: runId, RESEARCH_RUN_ID: runId, MODEL_RUN_MAX_CALLS: "600", MODEL_RUN_REPORT_RESERVE: "20",
    RESEARCH_REQUEST_ISOLATION: "true", RESEARCH_ADMISSION_ENABLED: "true", LLM_TRANSPORT: "codex_cli",
    CODEX_BIN: bin, CODEX_MODEL: "gpt-6-astra", CODEX_REASONING_EFFORT: "high", CODEX_EVIDENCE_DIR: path.join(directory, "evidence"),
    AWS_BEARER_TOKEN_BEDROCK: "offline-transport-token", AWS_REGION: "us-west-2", BEDROCK_MODEL_ID: "us.openai.gpt-6-astra",
    LLM_BASE_URL: "https://offline-only.invalid", LLM_API_KEY: "offline-key", LLM_MODEL: "offline-model",
  });
  await writeFile(invocations, "");
  await ensureModelRun({ id: runId, maxCalls: 600, reportReserve: 20 });
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day) VALUES('bedrock_converse',60,600,600),('codex_cli',60,600,600)`;
  await sql`INSERT INTO research_runs(id,kind,window_start,window_end,admission_frozen,model_profile)
    VALUES(${runId},'daily',now()-interval '1 day',now(),true,${sql.json({ ...RESEARCH_MODEL_PROFILES["bedrock-gpt-6-astra"] })})`;
});
after(async () => {
  try { await closeDb(); await rm(directory, { recursive: true, force: true }); }
  finally {
    globalThis.fetch = savedFetch;
    config.modelCallsEnabled = savedModelCalls;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    for (const [key, value] of Object.entries(savedEnv)) if (value !== undefined) process.env[key] = value;
  }
});

async function article(id: string) {
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,research)
    VALUES(${id},'fixture',${id},${`https://example.org/${id}`},${id},now(),now(),${sql.json({ canonicalKey: id })})`;
  await sql`INSERT INTO research_members(run_id,article_id,source_id,in_window,admitted,state) VALUES(${runId},${id},'fixture',true,true,'pending')`;
}
function ask(id: string) {
  return chatJson({ model: "default", purpose: "research_brief", subject: `article:${id}@1`, user: `source ${id}`, system: "Use the supplied source.",
    promptVersion: "transport-fixture-v1", schema: z.object({ ok: z.boolean() }), maxTokens: 512, timeoutMs: 3000 });
}
const native = (content = '{"ok":true}', stopReason = "end_turn") => ({ output: { message: { role: "assistant", content: [{ text: content }] } },
  stopReason, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, metrics: { latencyMs: 9 } });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { "content-type": "application/json", "x-amzn-requestid": "offline-bedrock-request" } });
async function receiptFor(id: string) {
  const [row] = await sql`SELECT r.*,a.status AS attempt_status,a.response AS attempt_response,a.error AS attempt_error,a.request_id AS attempt_request_id
    FROM receipts r JOIN receipt_attempts a ON a.receipt_id=r.id WHERE r.subject=${`article:${id}@1`} ORDER BY a.id DESC LIMIT 1`;
  assert.ok(row, "expected a persisted receipt and attempt");
  return row;
}

test("a frozen Bedrock profile overrides Codex/model/region environment and reuses the same input without a second call", async () => {
  await article("bedrock-snapshot");
  const raw = native();
  answer = async (url, init) => {
    assert.equal(String(url), "https://bedrock-runtime.us-east-1.amazonaws.com/model/global.openai.gpt-6-astra/converse");
    assert.deepEqual(JSON.parse(String(init?.body)).inferenceConfig, { maxTokens: 512 });
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer offline-transport-token");
    return reply(raw);
  };
  const first = await ask("bedrock-snapshot");
  assert.deepEqual(first.data, { ok: true }); assert.equal(first.reused, false);
  const receipt = await receiptFor("bedrock-snapshot");
  assert.equal(receipt.service, "bedrock_converse"); assert.equal(receipt.model, "global.openai.gpt-6-astra");
  assert.equal(receipt.status, "received"); assert.equal(receipt.attempt_status, "received");
  assert.equal(receipt.request.researchModelProfileId, "bedrock-gpt-6-astra");
  assert.equal(receipt.request.region, "us-east-1"); assert.equal(receipt.request.reasoningEffort, null);
  assert.equal(receipt.request.temperature, null); assert.equal(receipt.request.maxTokensEnforcement, "provider");
  assert.equal(receipt.response._bedrock.rawBody, JSON.stringify(raw));
  assert.deepEqual(receipt.attempt_response, receipt.response);
  assert.equal(receipt.request_id, "offline-bedrock-request"); assert.equal(receipt.attempt_request_id, "offline-bedrock-request");
  assert.equal(receipt.usage.prompt_tokens, 10); assert.equal(receipt.usage.completion_tokens, 5);
  assert.ok(!JSON.stringify(receipt).includes("offline-transport-token"));
  const baseline = JSON.stringify(receipt);
  await sql`INSERT INTO settings(key,value) VALUES(${RESEARCH_MODEL_SETTING},${sql.json({ profileId: "codex-gpt-6.1-sol", revision: 1 })})`;
  process.env.CODEX_MODEL = "gpt-6.1-sol"; process.env.AWS_REGION = "eu-west-1";
  const reused = await ask("bedrock-snapshot");
  assert.equal(reused.receiptId, first.receiptId); assert.equal(reused.reused, true);
  assert.equal(hits, 1); assert.equal((await getModelRun(runId))!.callsUsed, 1);
  assert.equal(JSON.stringify(await receiptFor("bedrock-snapshot")), baseline);
  assert.equal(await readFile(invocations, "utf8"), "", "the environment's Codex executable was never selected");
});

test("a frozen Codex 6.1 Sol profile selects the exact CLI model and effort even when the environment selects Bedrock", async () => {
  await article("codex-snapshot");
  await sql`UPDATE research_runs SET model_profile=${sql.json({ ...RESEARCH_MODEL_PROFILES["codex-gpt-6.1-sol"] })} WHERE id=${runId}`;
  process.env.LLM_TRANSPORT = "bedrock_converse";
  delete process.env.AWS_BEARER_TOKEN_BEDROCK;
  const result = await chatJson({ model: "default", purpose: "research_brief", subject: "article:codex-snapshot@1", user: "offline source", system: "fixture",
    promptVersion: "transport-fixture-v1", schema: z.object({ ok: z.boolean(), model: z.string(), effort: z.string() }), maxTokens: 512, timeoutMs: 3000 });
  assert.deepEqual(result.data, { ok: true, model: "gpt-6.1-sol", effort: 'model_reasoning_effort="medium"' });
  assert.equal(hits, 0);
  const invoked = (await readFile(invocations, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(invoked, [{ model: "gpt-6.1-sol", effort: 'model_reasoning_effort="medium"' }]);
  const receipt = await receiptFor("codex-snapshot");
  assert.equal(receipt.service, "codex_cli"); assert.equal(receipt.model, "gpt-6.1-sol");
  assert.equal(receipt.request.researchModelProfileId, "codex-gpt-6.1-sol");
  assert.equal(receipt.request.reasoningEffort, "medium");
  assert.equal((await getModelRun(runId))!.callsUsed, 1);
});

test("an exhausted frozen allowance rejects before fetch without adding receipts or attempts", async () => {
  await article("budget-exhausted");
  await sql`UPDATE model_runs SET calls_used=580 WHERE id=${runId}`;
  await assert.rejects(ask("budget-exhausted"), BudgetExceededError);
  assert.equal(hits, 0); assert.equal((await getModelRun(runId))!.callsUsed, 580);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0].n, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipt_attempts`)[0].n, 0);
});

test("a trusted rejection for the frozen model and region blocks before any new receipt or budget charge", async () => {
  await article("known-unavailable");
  const profile = RESEARCH_MODEL_PROFILES["bedrock-gpt-6-astra"];
  const originalSnapshot = (await sql`SELECT model_profile FROM research_runs WHERE id=${runId}`)[0].model_profile;
  await sql`INSERT INTO settings(key,value) VALUES('research.model_validation',${sql.json({ profiles: {
    "bedrock-gpt-6-astra": { model: profile.model, region: profile.region, status: "unavailable", checkedAt: "2026-10-06T00:00:00.000Z", reason: "Provider region access remains unavailable" },
  } })})`;
  await assert.rejects(ask("known-unavailable"), error => {
    assert.equal((error as { code?: string }).code, "research_model_unavailable"); return true;
  });
  assert.equal(hits, 0); assert.equal((await getModelRun(runId))!.callsUsed, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipts`)[0].n, 0);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipt_attempts`)[0].n, 0);
  assert.deepEqual((await sql`SELECT model_profile FROM research_runs WHERE id=${runId}`)[0].model_profile, originalSnapshot);
});

test("a known provider rejection stops the batch without turning unsubmitted articles into permanent holds", async () => {
  await article("preflight-first"); await article("preflight-next");
  const rows = await sql<{ article_id: string; state: string }[]>`SELECT article_id,state FROM research_members ORDER BY article_id`;
  const membersBefore = JSON.stringify(await sql`SELECT * FROM research_members ORDER BY article_id`);
  const profile = RESEARCH_MODEL_PROFILES["bedrock-gpt-6-astra"];
  await sql`INSERT INTO settings(key,value) VALUES('research.model_validation',${sql.json({ profiles: {
    "bedrock-gpt-6-astra": { model: profile.model, region: profile.region, status: "unavailable", checkedAt: "2026-10-06T00:00:00.000Z", reason: "Provider forbidden: confirmed region restriction" },
  } })})`;
  const processed: string[] = [];
  await assert.rejects(processIsolatedResearchArticles(runId, rows, {
    process: async id => { processed.push(id); await ask(id); return { state: "pass" }; },
    brief: async () => { throw new Error("brief must not run after a batch preflight stop"); },
    extract: async () => { throw new Error("extraction must not run after a batch preflight stop"); },
    hasBudget: async () => true,
  }), error => {
    assert.ok(error instanceof ResearchBatchStoppedError);
    assert.equal((error as { code?: string }).code, "research_model_unavailable");
    return true;
  });
  assert.deepEqual(processed, ["preflight-first"], "the batch stops before visiting the next article");
  assert.equal(hits, 0); assert.equal((await getModelRun(runId))!.callsUsed, 0);
  assert.equal((await sql`SELECT 1 FROM receipts`).length, 0);
  assert.equal((await sql`SELECT 1 FROM receipt_attempts`).length, 0);
  assert.equal(JSON.stringify(await sql`SELECT * FROM research_members ORDER BY article_id`), membersBefore);
  for (const row of rows) assert.equal(await articleRequestHold(row.article_id), null, "unsubmitted articles remain eligible after provider recovery");
});

test("a provider rejection recorded while waiting for the execution lock is checked again before submission", async () => {
  await article("queued-preflight");
  const membersBefore = JSON.stringify(await sql`SELECT * FROM research_members`);
  const profileBefore = (await sql`SELECT model_profile FROM research_runs WHERE id=${runId}`)[0].model_profile;
  answer = async () => reply(native()); // A missing lock-time check would wrongly make this request succeed.
  await sql`SELECT pg_advisory_lock(hashtext('algorithmhot:model-execution'))`;
  const pending = runIsolatedArticleStep(runId, "queued-preflight", () => ask("queued-preflight"))
    .then(value => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
  let setupError: unknown;
  try {
    // Observe the real second connection waiting on our session lock. This establishes that the
    // initial validation passed before adding the rejection, without relying on a fixed sleep.
    const deadline = Date.now() + 5000;
    let queued = false;
    while (Date.now() < deadline) {
      const [waiting] = await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE pid<>pg_backend_pid() AND wait_event='advisory' AND query LIKE '%algorithmhot:model-execution%') AS queued`;
      if (waiting.queued) { queued = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(queued, true, "the request must have passed its initial preflight and reached the execution lock");
    const profile = RESEARCH_MODEL_PROFILES["bedrock-gpt-6-astra"];
    await sql`INSERT INTO settings(key,value) VALUES('research.model_validation',${sql.json({ profiles: {
      "bedrock-gpt-6-astra": { model: profile.model, region: profile.region, status: "unavailable", checkedAt: "2026-10-06T00:00:00.000Z", reason: "Provider forbidden: newly confirmed region restriction" },
    } })})`;
  } catch (error) {
    setupError = error;
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext('algorithmhot:model-execution'))`;
  }
  const outcome = await pending;
  if (setupError) throw setupError;
  assert.ok(outcome.error instanceof ResearchBatchStoppedError);
  assert.equal(outcome.value, null);
  assert.equal(hits, 0); assert.equal((await getModelRun(runId))!.callsUsed, 0);
  assert.equal((await sql`SELECT 1 FROM receipts`).length, 0);
  assert.equal((await sql`SELECT 1 FROM receipt_attempts`).length, 0);
  assert.equal(JSON.stringify(await sql`SELECT * FROM research_members`), membersBefore);
  assert.equal(await articleRequestHold("queued-preflight"), null);
  assert.deepEqual((await sql`SELECT model_profile FROM research_runs WHERE id=${runId}`)[0].model_profile, profileBefore);
});

test("a regional-access HTTP 400 retains raw evidence and persists a global forbidden gate before the next article", async () => {
  await article("regional-denial"); await article("other-article");
  const raw = { message: "Access to OpenAI models is not allowed from unsupported countries, regions, or territories.", evidence: "private-fixture-detail" };
  answer = async () => reply(raw, 400);
  await assert.rejects(ask("regional-denial"), error => {
    assert.ok(error instanceof ProviderRejectedError); assert.equal(error.status, 400);
    assert.match(error.message, /forbidden/); assert.ok(!error.message.includes("private-fixture-detail")); return true;
  });
  const receipt = await receiptFor("regional-denial");
  assert.equal(receipt.status, "failed"); assert.equal(receipt.attempt_status, "failed");
  assert.match(receipt.error, /forbidden/); assert.match(receipt.attempt_error, /forbidden/);
  assert.equal(receipt.response._bedrock.rawBody, JSON.stringify(raw));
  assert.deepEqual(receipt.attempt_response, receipt.response);
  assert.equal(receipt.request_id, "offline-bedrock-request");
  assert.match((await sql`SELECT error FROM research_members WHERE article_id='regional-denial'`)[0].error, /^account-blocked:/);
  await assert.rejects(ask("regional-denial"), ResearchBatchStoppedError);
  await assert.rejects(ask("other-article"), ResearchBatchStoppedError);
  assert.equal(hits, 1); assert.equal((await getModelRun(runId))!.callsUsed, 1);
});

test("HTTP 503, 408 and 424 keep raw UNKNOWN attempts and cannot be resent", async () => {
  for (const status of [503, 408, 424]) {
    const id = `unknown-${status}`;
    await article(id);
    const raw = { message: `upstream processing failure ${status}` };
    answer = async () => reply(raw, status);
    const beforeHits = hits, beforeUsed = (await getModelRun(runId))!.callsUsed;
    await assert.rejects(ask(id), ReceiptUnknownError);
    const receipt = await receiptFor(id);
    assert.equal(receipt.status, "unknown"); assert.equal(receipt.attempt_status, "unknown");
    assert.equal(receipt.response._bedrock.rawBody, JSON.stringify(raw));
    assert.deepEqual(receipt.attempt_response, receipt.response);
    assert.equal(receipt.request_id, "offline-bedrock-request");
    const baseline = JSON.stringify(receipt);
    await assert.rejects(ask(id), ResearchRequestHeldError);
    assert.equal(hits, beforeHits + 1); assert.equal((await getModelRun(runId))!.callsUsed, beforeUsed + 1);
    assert.equal(JSON.stringify(await receiptFor(id)), baseline);
  }
});

test("truncated and schema-invalid answers remain failed with their original responses, without a fresh model attempt", async () => {
  for (const [id, raw] of [["truncated", native('{"ok":true}', "max_tokens")], ["invalid-schema", native('{"ok":"not boolean"}')]] as const) {
    await article(id);
    answer = async () => reply(raw);
    const beforeHits = hits;
    await assert.rejects(ask(id), ModelOutputError);
    const receipt = await receiptFor(id);
    assert.equal(receipt.status, "failed"); assert.equal(receipt.attempt_status, "failed");
    assert.match(receipt.error, /unusable output/);
    assert.equal(receipt.response._bedrock.rawBody, JSON.stringify(raw));
    assert.deepEqual(receipt.attempt_response, receipt.response);
    await assert.rejects(ask(id), ResearchRequestHeldError);
    assert.equal(hits, beforeHits + 1);
  }
  assert.equal((await getModelRun(runId))!.callsUsed, 2);
});
