import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { z } from "zod";

// One dedicated connection owns temporary copies of the real ledger tables. Other test files'
// historical UNKNOWN fixtures cannot affect this suite, and no production table is written.
process.env.DATABASE_POOL_MAX = "1";
process.env.MODEL_CALLS_ENABLED = "true";
process.env.COLLECT_ENABLED = "false";
const provider = await stub(async (_hit, req) => {
  if (req.body.includes("unknown-stage")) await new Promise(resolve => setTimeout(resolve, 100));
  return { choices: [{ message: { content: req.body.includes("invalid-stage") ? '{"ok":"invalid"}' : '{"ok":true}' } }] };
});
Object.assign(process.env, { LLM_TRANSPORT: "openai_compatible", LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "offline-fixture",
  LLM_MODEL: "offline-fixture", RESEARCH_REQUEST_ISOLATION: "true", RESEARCH_ADMISSION_ENABLED: "true" });
const { sql, closeDb } = await import("@aihot/backend/db");
const { articleRequestHold, assertResearchRequestsIdle, assertIsolatedModelRequestAllowed, processIsolatedResearchArticles,
  runIsolatedArticleStep, ResearchBatchStoppedError, ResearchRequestHeldError } = await import("@aihot/backend/research/request-isolation");
const { paidRequest, ProviderRejectedError, BudgetExceededError } = await import("@aihot/backend/providers/receipts");
const { ensureModelRun, getModelRun, withModelExecutionLock } = await import("@aihot/backend/providers/model-runs");
const { chatJson } = await import("@aihot/backend/providers/llm");
const tables = ["articles", "research_runs", "research_members", "model_runs", "receipts", "receipt_attempts", "budgets"];
let runId: string;
before(async () => {
  for (const name of tables) await sql.unsafe(`CREATE TEMP TABLE ${name} (LIKE public.${name} INCLUDING ALL)`);
});
beforeEach(async () => {
  await sql.unsafe(`TRUNCATE ${tables.join(",")}`);
  runId = `isolation-${tag()}`;
  Object.assign(process.env, { MODEL_RUN_ID: runId, RESEARCH_RUN_ID: runId, MODEL_RUN_MAX_CALLS: "600", MODEL_RUN_REPORT_RESERVE: "20" });
  await ensureModelRun({ id: runId, maxCalls: 600, reportReserve: 20 });
  await sql`INSERT INTO research_runs(id,kind,window_start,window_end,admission_frozen) VALUES(${runId},'daily',now()-interval '1 day',now(),true)`;
});
after(async () => { await provider.close(); await closeDb(); });

async function article(id: string, state = "pending", canonicalKey = id) {
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at,research)
    VALUES(${id},'fixture',${id},${`https://example.org/${id}`},${id},now(),now(),${sql.json({ canonicalKey })})`;
  await member(id, state);
  return { article_id: id, state };
}
async function member(id: string, state = "pending") {
  await sql`INSERT INTO research_members(run_id,article_id,source_id,in_window,admitted,state)
    VALUES(${runId},${id},'fixture',true,true,${state})`;
}
const budget = () => ({ id: runId, maxCalls: 600, reportReserve: 20 });
async function fixtureCall(id: string, stage: string, outcome: "ok" | "unknown" | "failed" = "ok") {
  return paidRequest({ service: "isolation-fixture", model: "fixture", purpose: stage, subject: `article:${id}@1`,
    identity: `${runId}:${id}:${stage}`, modelRun: budget() }, async () => {
    if (outcome === "unknown") throw new Error("fixture connection lost after submission");
    if (outcome === "failed") throw new ProviderRejectedError("fixture unusable response", 500, false);
    return { response: { ok: true } };
  });
}
async function ledger() { return JSON.stringify(await sql`SELECT row_to_json(r) AS receipt,(SELECT json_agg(a ORDER BY a.id) FROM receipt_attempts a WHERE a.receipt_id=r.id) AS attempts FROM receipts r ORDER BY r.id`); }

test("historical UNKNOWN and failed articles are quarantined while independent work retains the same budget", async () => {
  const rows = [await article("held-unknown", "pass"), await article("held-failed"), await article("fresh")];
  await assert.rejects(fixtureCall("held-unknown", "research_brief", "unknown"));
  await assert.rejects(fixtureCall("held-failed", "score_article", "failed"));
  const beforeLedger = await ledger();
  await sql`UPDATE model_runs SET calls_used=225 WHERE id=${runId}`;
  const calls: string[] = [];
  await processIsolatedResearchArticles(runId, rows, {
    process: async id => { calls.push(`${id}:mainflow`); await fixtureCall(id, "score_article"); return { state: "pass" }; },
    brief: async id => { calls.push(`${id}:brief`); return fixtureCall(id, "research_brief"); },
    extract: async () => { throw new Error("unexpected extraction"); }, hasBudget: async () => true,
  });
  assert.deepEqual(calls, ["fresh:mainflow", "fresh:brief"]);
  assert.equal((await getModelRun(runId))!.callsUsed, 227);
  const members = await sql`SELECT article_id,state,error FROM research_members ORDER BY article_id`;
  assert.equal(members.find(r => r.article_id === "held-unknown")!.state, "pass");
  assert.match(members.find(r => r.article_id === "held-unknown")!.error, /^held-request: status=unknown;/);
  assert.equal(members.find(r => r.article_id === "held-failed")!.state, "failed");
  const original = JSON.parse(beforeLedger) as { receipt: { id: number } }[];
  assert.deepEqual(JSON.parse(await ledger()).filter((r: { receipt: { id: number } }) => original.some(o => o.receipt.id === r.receipt.id)), original);
});

test("new UNKNOWN returned by mainflow and thrown by brief preserve receipts and continue the next article", async () => {
  const rows = [await article("main-unknown"), await article("brief-unknown"), await article("next")];
  const processed: string[] = [];
  await processIsolatedResearchArticles(runId, rows, {
    process: async id => {
      processed.push(id);
      if (id === "main-unknown") { await fixtureCall(id, "prefilter", "unknown").catch(() => {}); return { state: "unknown-receipt" }; }
      await fixtureCall(id, "score_article"); return { state: "pass" };
    },
    brief: id => fixtureCall(id, "research_brief", id === "brief-unknown" ? "unknown" : "ok"),
    extract: async () => {}, hasBudget: async () => true,
  });
  assert.deepEqual(processed, rows.map(r => r.article_id));
  const members = await sql`SELECT article_id,state,error FROM research_members`;
  assert.equal(members.find(r => r.article_id === "main-unknown")!.state, "unknown-receipt");
  assert.equal(members.find(r => r.article_id === "brief-unknown")!.state, "pass");
  assert.equal(members.find(r => r.article_id === "next")!.state, "pass");
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipt_attempts WHERE status='unknown'`)[0].n, 2);
});

test("changed day, article revision, alias, prompt or tag never releases a terminal attempt", async () => {
  await article("original", "pending", "same-paper");
  await assert.rejects(fixtureCall("original", "structure_article", "failed"));
  const baseline = await ledger();
  runId = `isolation-next-${tag()}`;
  await article("alias", "pending", "same-paper");
  await sql`UPDATE articles SET revision=2 WHERE id IN ('original','alias')`;
  await member("original");
  for (const id of ["original", "alias"]) {
    const result = await runIsolatedArticleStep(runId, id, () => { throw new Error("must not submit changed prompt/tag"); });
    assert.equal(result.state, "held");
    assert.equal((await sql`SELECT state FROM research_members WHERE run_id=${runId} AND article_id=${id}`)[0].state, "failed");
  }
  assert.equal(await ledger(), baseline);
});

test("a historical UNKNOWN attempt remains held even when its logical receipt status changed", async () => {
  await article("history"); await assert.rejects(fixtureCall("history", "research_roadmap", "unknown"));
  await sql`UPDATE receipts SET status='completed'`;
  assert.equal((await articleRequestHold("history"))!.status, "unknown");
  await assert.rejects(assertIsolatedModelRequestAllowed("article:history@9"), ResearchRequestHeldError);
});

test("global pending and the shared execution lock stop all new work regardless of model run", async () => {
  await article("busy"); await fixtureCall("busy", "score_article");
  await sql`UPDATE receipt_attempts SET status='pending',model_run_id='another-day'`;
  await assert.rejects(assertResearchRequestsIdle(), /pending/);
  await sql`UPDATE receipt_attempts SET status='received'`;
  await withModelExecutionLock(async () => { await assert.rejects(assertResearchRequestsIdle(), /active/); });
  await assertResearchRequestsIdle();
});

test("known report/probe UNKNOWN is isolated; an unrecognized UNKNOWN subject stops conservatively", async () => {
  await article("independent"); await assert.rejects(fixtureCall("independent", "prefilter", "unknown"));
  await sql`UPDATE receipts SET subject='probe:stable-probe',purpose='probe_prefilter'`;
  await assertIsolatedModelRequestAllowed("article:independent@1");
  await assert.rejects(assertIsolatedModelRequestAllowed("probe:stable-probe"), /isolatable/);
  await sql`UPDATE receipts SET subject='report:daily:2013-05-15',purpose='report_lead'`;
  await assertIsolatedModelRequestAllowed("article:independent@1");
  await assert.rejects(assertIsolatedModelRequestAllowed("report:daily:2013-05-15"), /ruleOnly/);
  await sql`UPDATE receipts SET subject='unrecognized'`;
  await assert.rejects(assertResearchRequestsIdle(), /no isolatable/);
});

test("account errors stop later articles and future slots, even after the diagnostic log truncation boundary", async () => {
  const rows = [await article("account"), await article("untouched")];
  let count = 0;
  await assert.rejects(processIsolatedResearchArticles(runId, rows, {
    process: async () => { count++; throw new Error(`${"diagnostic ".repeat(300)} HTTP 429`); },
    brief: async () => {}, extract: async () => {}, hasBudget: async () => true,
  }), ResearchBatchStoppedError);
  assert.equal(count, 1);
  assert.match((await sql`SELECT error FROM research_members WHERE article_id='account'`)[0].error, /^account-blocked:/);
  await assert.rejects(assertIsolatedModelRequestAllowed("article:untouched@1"), /confirmed recovery/);
  await sql`UPDATE research_members SET error=NULL`;
  for (const message of ["HTTP 401", "status:403 Forbidden", "token-expired"]) {
    await assert.rejects(runIsolatedArticleStep(runId, "account", async () => { throw new Error(message); }), ResearchBatchStoppedError);
    await sql`UPDATE research_members SET error=NULL`;
  }
});

test("held receipt numbers 401, 403 and 429 are not account status codes", async () => {
  await article("numbers");
  const result = await runIsolatedArticleStep(runId, "numbers", async () => { throw new ResearchRequestHeldError("held-request: status=unknown; receipt=429; attempt=403; prior=401"); });
  assert.equal(result.state, "held");
  await assertResearchRequestsIdle();
});

test("the model mutex rechecks isolation after a queued stage becomes UNKNOWN, then admits another article", async () => {
  await article("queued"); await article("separate");
  const hits = provider.hits();
  const ask = (id: string, stage: string, timeoutMs = 2000) => chatJson({ model: "default", purpose: stage, subject: `article:${id}@1`,
    user: stage, system: "fixture", promptVersion: "fixture-v1", schema: z.object({ ok: z.boolean() }), timeoutMs });
  const first = ask("queued", "unknown-stage", 25);
  const second = ask("queued", "queued-score");
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(outcomes[0].status, "rejected");
  assert.equal(outcomes[1].status, "rejected");
  if (outcomes[1].status === "rejected") assert.ok(outcomes[1].reason instanceof ResearchRequestHeldError);
  assert.deepEqual((await ask("separate", "separate-score")).data, { ok: true });
  assert.equal(provider.hits() - hits, 2, "queued score for the held article never reached the local provider");
  assert.equal((await getModelRun(runId))!.callsUsed, 2);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipt_attempts WHERE status='unknown'`)[0].n, 1);
});

test("budget exhaustion stops the batch without resetting allowances or creating another attempt", async () => {
  await article("budget"); await sql`UPDATE model_runs SET calls_used=580 WHERE id=${runId}`;
  await assert.rejects(runIsolatedArticleStep(runId, "budget", () => fixtureCall("budget", "score_article")), BudgetExceededError);
  assert.equal((await getModelRun(runId))!.callsUsed, 580);
  assert.equal((await sql`SELECT count(*)::int AS n FROM receipt_attempts`)[0].n, 0);
});

test("identical inputs from different article identities cannot retry a failed logical request", async () => {
  await article("same-input-a"); await article("same-input-b");
  const ask = (id: string) => chatJson({ model: "default", purpose: "research_brief", subject: `article:${id}@1`,
    user: "invalid-stage", system: "fixture", promptVersion: "fixture-v1", schema: z.object({ ok: z.boolean() }) });
  const hits = provider.hits();
  await assert.rejects(ask("same-input-a"));
  const baseline = await ledger();
  const held = await runIsolatedArticleStep(runId, "same-input-b", () => ask("same-input-b"));
  assert.equal(held.state, "held");
  if (held.state === "held") { assert.equal(held.hold.status, "failed"); assert.ok(held.hold.receiptId); }
  assert.equal(provider.hits() - hits, 1);
  assert.equal(await ledger(), baseline);
  assert.equal((await getModelRun(runId))!.callsUsed, 1);
});
