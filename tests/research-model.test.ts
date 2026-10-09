import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import Fastify from "fastify";
import type { ResearchModelOverview } from "@aihot/contracts/research-model";

// Temporary tables isolate these settings and snapshots from every other suite. No provider is called.
process.env.DATABASE_POOL_MAX = "1";
const { config } = await import("@aihot/backend/config");
const { sql, closeDb } = await import("@aihot/backend/db");
const { researchModelOverview, switchResearchModel } = await import("@aihot/backend/admin/research-model");
const { assertResearchModelUsable, researchModelForRun, selectedResearchModel, RESEARCH_MODEL_SETTING } = await import("@aihot/backend/providers/research-model");
const { createResearchRun } = await import("@aihot/backend/research/collect");
const { ensureModelRun, getModelRun } = await import("@aihot/backend/providers/model-runs");
const { safeReturn } = await import("@aihot/backend/admin/auth");
const { registerAdmin } = await import("../apps/api/src/routes/admin.ts");
const app = Fastify({ logger: false });
registerAdmin(app);
const originalConfig = { dev: config.devAdmin, environment: config.environmentName };
const keys = ["LLM_TRANSPORT", "CODEX_MODEL", "CODEX_REASONING_EFFORT", "CODEX_BIN", "AWS_BEARER_TOKEN_BEDROCK"];
const originalEnv = new Map(keys.map(key => [key, process.env[key]]));
const tables = ["settings", "audit_log", "research_runs", "model_runs", "receipts", "receipt_attempts"];
const fixtureToken = "synthetic-bedrock-secret-not-for-network";
const select = (profileId: string, expectedRevision = 0) => ({ profileId, expectedRevision, reason: "测试下一批次的模型选择" });

before(async () => {
  for (const name of tables) await sql.unsafe(`CREATE TEMP TABLE ${name} (LIKE public.${name} INCLUDING ALL)`);
});
beforeEach(async () => {
  await sql.unsafe(`TRUNCATE ${tables.join(",")}`);
  Object.assign(process.env, { LLM_TRANSPORT: "codex_cli", CODEX_MODEL: "gpt-6-astra", CODEX_REASONING_EFFORT: "medium", CODEX_BIN: process.execPath });
  delete process.env.AWS_BEARER_TOKEN_BEDROCK;
  config.devAdmin = { displayName: "Research settings fixture" };
  config.environmentName = "development";
});
after(async () => {
  config.devAdmin = originalConfig.dev; config.environmentName = originalConfig.environment;
  for (const [key, value] of originalEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await app.close(); await closeDb();
});

async function getOverview() {
  const response = await app.inject("/api/admin/research-model");
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "no-store");
  return response.json<ResearchModelOverview>();
}
async function update(payload: Record<string, unknown>, csrf = "dev") {
  return app.inject({ method: "PUT", url: "/api/admin/research-model", headers: { "x-csrf-token": csrf }, payload });
}

test("administrator reads report configuration readiness without claiming a successful model test", async () => {
  const overview = await getOverview();
  assert.equal(overview.selectedProfileId, "codex-gpt-6-astra");
  assert.equal(overview.source, "environment");
  assert.equal(overview.revision, 0);
  assert.equal(overview.appliesTo, "new_research_runs");
  assert.deepEqual(overview.choices.map(choice => choice.id), ["codex-gpt-6-astra", "codex-gpt-6.1-sol", "bedrock-gpt-6-astra"]);
  assert.ok(overview.choices.filter(choice => choice.transport === "codex_cli").every(choice => choice.available && choice.availability === "untested" && choice.checkedAt === null));
  assert.equal(overview.choices.find(choice => choice.transport === "bedrock_converse")!.available, false);
  process.env.AWS_BEARER_TOKEN_BEDROCK = fixtureToken;
  const ready = await getOverview();
  const bedrock = ready.choices.find(choice => choice.transport === "bedrock_converse")!;
  assert.equal(bedrock.available, true);
  assert.equal(bedrock.availability, "untested");
  assert.equal(bedrock.reasoningEffort, null);
  assert.equal(bedrock.region, "us-east-1");
  assert.ok(!JSON.stringify(ready).includes(fixtureToken));
  assert.ok(!JSON.stringify(ready).includes(process.execPath));
});

test("real admin routes enforce session, CSRF, allowlisted fields and optimistic revision", async () => {
  config.devAdmin = null;
  assert.equal((await app.inject("/api/admin/research-model")).statusCode, 401);
  assert.equal((await update(select("codex-gpt-6.1-sol"))).statusCode, 401);
  config.devAdmin = { displayName: "Research settings fixture" };
  assert.equal((await update(select("codex-gpt-6.1-sol"), "stale")).statusCode, 403);
  for (const payload of [select("arbitrary-model"), { ...select("codex-gpt-6.1-sol"), reason: " " },
    { ...select("codex-gpt-6.1-sol"), apiToken: fixtureToken }, { ...select("codex-gpt-6.1-sol"), expectedRevision: -1 }]) {
    assert.equal((await update(payload)).statusCode, 400);
  }
  const response = await update(select("codex-gpt-6.1-sol"));
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().selectedProfileId, "codex-gpt-6.1-sol");
  assert.equal(response.json().revision, 1);
  assert.equal((await update(select("codex-gpt-6-astra"))).statusCode, 409);
  const entries = await sql`SELECT actor,action,before,after FROM audit_log`;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, "research-model.switch");
  assert.equal(entries[0].before.profile.model, "gpt-6-astra");
  assert.equal(entries[0].after.profile.model, "gpt-6.1-sol");
  assert.equal((await sql`SELECT 1 FROM receipts`).length, 0);
  assert.equal((await sql`SELECT 1 FROM receipt_attempts`).length, 0);
});

test("a switch freezes only new batches and does not reset the shared daily call allowance", async () => {
  const originalRun = `model-frozen-${tag()}`, newRun = `model-new-${tag()}`;
  await createResearchRun(originalRun);
  const before = await researchModelForRun(originalRun);
  assert.equal(before!.model, "gpt-6-astra");
  await ensureModelRun({ id: "daily-model-profile-fixture", maxCalls: 600, reportReserve: 20 });
  await sql`UPDATE model_runs SET calls_used=227 WHERE id='daily-model-profile-fixture'`;
  await switchResearchModel(select("codex-gpt-6.1-sol"), "fixture");
  await createResearchRun(originalRun);
  await createResearchRun(newRun);
  assert.deepEqual(await researchModelForRun(originalRun), before);
  assert.equal((await researchModelForRun(newRun))!.model, "gpt-6.1-sol");
  assert.equal((await getModelRun("daily-model-profile-fixture"))!.callsUsed, 227);
  assert.equal((await getModelRun("daily-model-profile-fixture"))!.maxCalls, 600);
  const overview = await researchModelOverview();
  assert.ok(overview.currentRuns.some(run => run.runId === originalRun && run.profile?.model === "gpt-6-astra"));
});

test("historical NULL snapshots and compatible deployments never inherit a new administrator selection", async () => {
  const legacy = `model-legacy-${tag()}`;
  await sql`INSERT INTO research_runs(id,kind,window_start,window_end) VALUES(${legacy},'daily',now()-interval '1 day',now())`;
  await switchResearchModel(select("codex-gpt-6.1-sol"), "fixture");
  await createResearchRun(legacy);
  assert.equal(await researchModelForRun(legacy), null);
  await sql`DELETE FROM settings WHERE key=${RESEARCH_MODEL_SETTING}`;
  process.env.LLM_TRANSPORT = "openai_compatible";
  assert.equal(await selectedResearchModel(), null);
  const compatible = `model-compatible-${tag()}`;
  await createResearchRun(compatible);
  assert.equal(await researchModelForRun(compatible), null);
  await assert.rejects(researchModelForRun("model-missing"), /does not exist/);
});

test("Ultra selection persists, freezes new batches, and preserves prior Medium results and allowance", async () => {
  await switchResearchModel(select("codex-gpt-6-astra"), "fixture");
  const oldRun = `model-medium-${tag()}`, newRun = `model-ultra-${tag()}`;
  await createResearchRun(oldRun);
  const original = await researchModelForRun(oldRun);
  assert.equal(original!.reasoningEffort, "medium");
  await ensureModelRun({ id: "daily-ultra-fixture", maxCalls: 600, reportReserve: 20 });
  await sql`UPDATE model_runs SET calls_used=282 WHERE id='daily-ultra-fixture'`;
  const response = await update({ ...select("codex-gpt-6-astra", 1), reasoningEffort: "ultra" });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await getOverview()).selectedProfile!.reasoningEffort, "ultra");
  await createResearchRun(newRun);
  await createResearchRun(oldRun);
  assert.equal((await researchModelForRun(newRun))!.reasoningEffort, "ultra");
  assert.deepEqual(await researchModelForRun(oldRun), original);
  const [entry] = await sql`SELECT before,after FROM audit_log ORDER BY id DESC LIMIT 1`;
  assert.equal(entry.before.profile.reasoningEffort, "medium");
  assert.equal(entry.after.profile.reasoningEffort, "ultra");
  await switchResearchModel(select("codex-gpt-6-astra", 2), "fixture");
  assert.equal((await getOverview()).selectedProfile!.reasoningEffort, "ultra", "same-profile save preserves explicit effort");
  assert.equal((await getModelRun("daily-ultra-fixture"))!.callsUsed, 282);
  assert.equal((await sql`SELECT 1 FROM receipts`).length, 0);
  assert.equal((await sql`SELECT 1 FROM receipt_attempts`).length, 0);
});

test("invalid or Bedrock reasoning overrides are rejected without saving or submitting", async () => {
  process.env.AWS_BEARER_TOKEN_BEDROCK = fixtureToken;
  for (const payload of [{ ...select("codex-gpt-6-astra"), reasoningEffort: "unlimited" },
    { ...select("bedrock-gpt-6-astra"), reasoningEffort: "ultra" }]) {
    assert.equal((await update(payload)).statusCode, 400);
  }
  assert.equal((await sql`SELECT 1 FROM settings WHERE key=${RESEARCH_MODEL_SETTING}`).length, 0);
  assert.equal((await sql`SELECT 1 FROM audit_log`).length, 0);
  assert.equal((await sql`SELECT 1 FROM receipt_attempts`).length, 0);
});

test("saving the same profile preserves reasoning from a compatible existing environment", async () => {
  for (const reasoningEffort of ["none", "minimal"]) {
    await sql`DELETE FROM settings WHERE key=${RESEARCH_MODEL_SETTING}`;
    process.env.CODEX_REASONING_EFFORT = reasoningEffort;
    const response = await update(select("codex-gpt-6-astra"));
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await getOverview()).selectedProfile!.reasoningEffort, reasoningEffort);
  }
  assert.equal((await sql`SELECT 1 FROM receipt_attempts`).length, 0);
});

test("provider rejection evidence disables only the matching profile and rejects writes before changing state", async () => {
  process.env.AWS_BEARER_TOKEN_BEDROCK = fixtureToken;
  const diagnostic = { model: "global.openai.gpt-6-astra", region: "us-east-1", status: "unavailable", checkedAt: "2026-10-06T07:00:00.000Z", reason: "当前 Bedrock 调用因供应商地域限制被拒绝" };
  await sql`INSERT INTO settings(key,value) VALUES('research.model_validation',${sql.json({ profiles: { "bedrock-gpt-6-astra": diagnostic } })})`;
  const unavailable = (await getOverview()).choices.find(choice => choice.id === "bedrock-gpt-6-astra")!;
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.availability, "unavailable");
  assert.equal(unavailable.checkedAt, diagnostic.checkedAt);
  assert.equal(unavailable.unavailableReason, diagnostic.reason);
  const response = await update(select("bedrock-gpt-6-astra"));
  assert.equal(response.statusCode, 400);
  assert.equal((await sql`SELECT 1 FROM settings WHERE key=${RESEARCH_MODEL_SETTING}`).length, 0);
  assert.equal((await sql`SELECT 1 FROM audit_log`).length, 0);
  await sql`UPDATE settings SET value=${sql.json({ profiles: { "bedrock-gpt-6-astra": { ...diagnostic, region: "us-west-2" } } })} WHERE key='research.model_validation'`;
  assert.equal((await getOverview()).choices.find(choice => choice.id === "bedrock-gpt-6-astra")!.availability, "untested", "another region's result does not validate or reject this one");
});

test("new Bedrock selection is frozen with provider-default reasoning and never stores its credential", async () => {
  process.env.AWS_BEARER_TOKEN_BEDROCK = fixtureToken;
  assert.equal((await update(select("bedrock-gpt-6-astra"))).statusCode, 200);
  const runId = `model-bedrock-${tag()}`;
  await createResearchRun(runId);
  assert.deepEqual(await researchModelForRun(runId), { version: 1, profileId: "bedrock-gpt-6-astra", transport: "bedrock_converse",
    model: "global.openai.gpt-6-astra", reasoningEffort: null, region: "us-east-1" });
  const stored = JSON.stringify({ settings: await sql`SELECT value FROM settings`, audit: await sql`SELECT before,after FROM audit_log`, runs: await sql`SELECT model_profile FROM research_runs` });
  assert.ok(!stored.includes(fixtureToken));
});

test("a later trusted rejection blocks new batches and use of old snapshots without rewriting either", async () => {
  process.env.AWS_BEARER_TOKEN_BEDROCK = fixtureToken;
  await switchResearchModel(select("bedrock-gpt-6-astra"), "fixture");
  const oldRun = `model-now-blocked-${tag()}`, newRun = `model-blocked-new-${tag()}`;
  await createResearchRun(oldRun);
  const frozen = await researchModelForRun(oldRun);
  const diagnostic = { model: "global.openai.gpt-6-astra", region: "us-east-1", status: "unavailable", checkedAt: "2026-10-06T07:00:00.000Z", reason: "当前 Bedrock 调用因供应商地域限制被拒绝" };
  await sql`INSERT INTO settings(key,value) VALUES('research.model_validation',${sql.json({ profiles: { "bedrock-gpt-6-astra": diagnostic } })})`;
  await assert.rejects(createResearchRun(newRun), /地域限制/);
  assert.equal((await sql`SELECT 1 FROM research_runs WHERE id=${newRun}`).length, 0);
  await createResearchRun(oldRun);
  assert.deepEqual(await researchModelForRun(oldRun), frozen);
  await assert.rejects(assertResearchModelUsable(frozen!), /地域限制/);
  assert.equal((await sql`SELECT 1 FROM receipt_attempts`).length, 0);
  assert.equal((await researchModelOverview()).selectedProfileId, "bedrock-gpt-6-astra", "diagnostics do not silently select a different provider");
});

test("corrupt stored model snapshots fail closed instead of silently changing transport", async () => {
  const runId = `model-corrupt-${tag()}`;
  await createResearchRun(runId);
  await sql`UPDATE research_runs SET model_profile=jsonb_set(model_profile,'{model}','"unregistered-model"') WHERE id=${runId}`;
  await assert.rejects(researchModelForRun(runId), /does not match/);
});

test("Agent sign-in return permits only the exact new local destination", () => {
  assert.equal(safeReturn("/agent"), "/agent");
  for (const path of ["/agent/", "/agent?next=https://example.org", "//example.org/agent", "https://example.org/agent", "/agent-evil", "/%61gent"]) {
    assert.equal(safeReturn(path), "/admin");
  }
  assert.equal(safeReturn("/admin/models"), "/admin/models");
});
