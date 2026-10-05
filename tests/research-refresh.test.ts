import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { refreshWindow, prepareRefreshRun, refreshFamilyPattern, researchFamilyDate } from "@aihot/backend/research/refresh";
import { createResearchRun } from "@aihot/backend/research/collect";
import { admittedForProcessing, chooseAdditionalAdmissions, freezeAdmissions, researchRunMetrics, type AdmissionCandidate } from "@aihot/backend/research/admission";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { ensureModelRun, getModelRun } from "@aihot/backend/providers/model-runs";
import { BudgetExceededError, paidRequest, ReceiptUnknownError } from "@aihot/backend/providers/receipts";
import { dailyWindow } from "@aihot/contracts/time";
import { composePilot } from "@aihot/backend/reports/compose";

const T = tag(), sourceId = `refresh-fixture-${T}`;
const runIds = new Set<string>(), articleIds = new Set<string>(), budgetIds = new Set<string>(), receiptIds = new Set<number>();
const reportKeys = new Set<string>();
const savedEnv = { admission: process.env.RESEARCH_ADMISSION_ENABLED, research: process.env.RESEARCH_RUN_ID, model: process.env.MODEL_RUN_ID };
before(async () => { await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${sourceId},'Refresh fixture','rss','T1','editorial')`; });
after(async () => {
  for (const [name, value] of [["RESEARCH_ADMISSION_ENABLED", savedEnv.admission], ["RESEARCH_RUN_ID", savedEnv.research], ["MODEL_RUN_ID", savedEnv.model]]) {
    if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
  }
  if (receiptIds.size) await sql`DELETE FROM receipts WHERE id=ANY(${[...receiptIds]}::bigint[])`;
  if (reportKeys.size) await sql`DELETE FROM reports WHERE kind='daily' AND key=ANY(${[...reportKeys]})`;
  if (budgetIds.size) await sql`DELETE FROM model_runs WHERE id=ANY(${[...budgetIds]})`;
  if (runIds.size) {
    await sql`DELETE FROM research_members WHERE run_id=ANY(${[...runIds]})`;
    await sql`DELETE FROM research_runs WHERE id=ANY(${[...runIds]})`;
  }
  if (articleIds.size) await sql`DELETE FROM articles WHERE id=ANY(${[...articleIds]})`;
  await sql`DELETE FROM sources WHERE id=${sourceId}`;
  await closeDb();
});

async function refresh(date: string, hour: string) {
  const id = `refresh-${date}-${hour}`;
  runIds.add(id);
  return prepareRefreshRun(id, new Date(`${date}T${hour}:30:00+08:00`));
}
async function material(runId: string, label: string, date: string) {
  const result = await upsertMaterial({ sourceId, url: `https://example.org/refresh/${T}/${label}`, title: `Refresh ${label}`,
    bodyText: `Source abstract ${label}`, bodyStatus: "ok", via: "import", publishedAt: dailyWindow(date).start,
    discoveredAt: dailyWindow(date).end, backfill: null });
  articleIds.add(result.articleId);
  await sql`INSERT INTO research_members(run_id,article_id,source_id,in_window) VALUES(${runId},${result.articleId},${sourceId},true) ON CONFLICT DO NOTHING`;
  return result.articleId;
}

test("refresh slots freeze Beijing cutoffs without changing normal 08:00 daily boundaries", () => {
  const now = new Date("2026-10-05T04:00:00Z");
  const plan = refreshWindow("refresh-2026-10-05-09", new Date("2026-10-05T02:00:00Z"), now);
  assert.equal(plan.modelRunId, "daily-2026-10-05");
  assert.equal(plan.start.toISOString(), "2026-10-04T00:00:00.000Z");
  assert.equal(plan.end.toISOString(), "2026-10-05T02:00:00.000Z");
  assert.equal(dailyWindow("2026-10-05").end.toISOString(), "2026-10-05T00:00:00.000Z");
  assert.equal(researchFamilyDate("refresh-2026-10-05-09"), "2026-10-05");
  assert.equal(researchFamilyDate("refresh-2026-02-30-09"), null);
  assert.throws(() => refreshWindow("refresh-2026-10-05-06", plan.end, now), /slot/);
  assert.throws(() => refreshWindow("refresh-2026-10-05-09", new Date("2026-10-05T03:00:00Z"), new Date("2026-10-05T01:00:00Z")), /future/);
  assert.throws(() => refreshWindow("refresh-2026-10-05-10", plan.end, now), /Invalid/);
  assert.equal(refreshWindow("refresh-2026-10-05-00", new Date("2026-10-04T16:00:00Z"), now).date, "2026-10-05");
});

test("incremental selection deducts prior identities and per-source quotas", () => {
  const make = (sourceId: string, count: number, prefix: string): AdmissionCandidate[] => Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`, canonicalKey: `${prefix}-${i}`, sourceId, publishedAt: "2026-10-05T00:00:00Z",
  }));
  const prior = make("research-arxiv-ml-ai", 20, "old");
  const pool = [...prior, ...make("research-arxiv-ml-ai", 30, "ml"), ...make("research-arxiv-physical-science", 30, "physics"),
    ...make("research-arxiv-molecular", 30, "molecular"), ...make("rss-bair", 20, "blog")];
  const next = chooseAdditionalAdmissions(pool, prior);
  assert.equal(next.length, 40);
  assert.equal(next.filter(a => a.sourceId === "research-arxiv-ml-ai").length, 0);
  assert.equal(next.filter(a => a.sourceId === "research-arxiv-physical-science").length, 15);
  assert.equal(next.filter(a => a.sourceId === "research-arxiv-molecular").length, 15);
  assert.equal(next.filter(a => a.sourceId === "rss-bair").length, 10);
  assert.deepEqual(chooseAdditionalAdmissions([...pool].reverse(), prior), next);
  assert.deepEqual(chooseAdditionalAdmissions(pool, [...prior, ...next]), []);
});

test("snapshots aggregate all prior admissions, retain failures and UNKNOWN, and share a 60-identity ceiling", async () => {
  const date = "2013-05-10", dailyId = `daily-${date}`;
  runIds.add(dailyId);
  await createResearchRun(dailyId, "daily", dailyWindow(date).end, dailyWindow(date));
  const unknown = await material(dailyId, "unknown", date), failed = await material(dailyId, "failed", date);
  assert.equal(await freezeAdmissions(dailyId), 2);
  await sql`UPDATE research_members SET state='unknown-receipt',error='held original attempt' WHERE run_id=${dailyId} AND article_id=${unknown}`;
  await sql`UPDATE research_members SET state='failed',error='unusable output' WHERE run_id=${dailyId} AND article_id=${failed}`;
  const first = await refresh(date, "09");
  assert.equal((await prepareRefreshRun(first.id, new Date(`${date}T11:59:00+08:00`))).window_end.toISOString(), first.window_end.toISOString());
  await material(first.id, "unknown", date);
  for (let i = 0; i < 62; i++) await material(first.id, `new-${i}`, date);
  assert.equal(await freezeAdmissions(first.id), 60);
  const [inheritedUnknown] = await sql`SELECT state,error FROM research_members WHERE run_id=${first.id} AND article_id=${unknown}`;
  assert.deepEqual(inheritedUnknown, { state: "unknown-receipt", error: "held original attempt" });
  const [inheritedFailed] = await sql`SELECT state,error FROM research_members WHERE run_id=${first.id} AND article_id=${failed}`;
  assert.deepEqual(inheritedFailed, { state: "failed", error: "unusable output" });
  const second = await refresh(date, "12");
  const excess = await material(second.id, "later-excess", date);
  assert.equal(await freezeAdmissions(second.id), 60);
  await assert.rejects(freezeAdmissions(first.id), /later daily snapshot/, "even a frozen older snapshot cannot resume ahead of a newer one");
  assert.equal(await freezeAdmissions(second.id), 60, "reopening the latest snapshot stays idempotent");
  const [count] = await sql`SELECT count(DISTINCT article_id)::int AS n FROM research_members WHERE run_id=ANY(${[dailyId, first.id, second.id]}) AND admitted`;
  assert.equal(count.n, 60);
  process.env.RESEARCH_ADMISSION_ENABLED = "true";
  process.env.MODEL_RUN_ID = dailyId;
  process.env.RESEARCH_RUN_ID = second.id;
  const [newMember] = await sql`SELECT article_id FROM research_members WHERE run_id=${second.id} AND admitted AND article_id NOT IN (${unknown},${failed}) LIMIT 1`;
  assert.equal(await admittedForProcessing(newMember.article_id), true, "admission uses snapshot ID while model budget remains the day ID");
  assert.equal(await admittedForProcessing(excess), false);
  delete process.env.RESEARCH_RUN_ID;
  assert.equal(await admittedForProcessing(newMember.article_id), false, "legacy daily admission is still independently frozen");
  const { metrics } = await researchRunMetrics(second.id);
  assert.equal(metrics.previouslyAdmitted, 60);
  assert.equal(metrics.newlyAdmitted, 0);
  assert.equal(metrics.duplicateRecordsExact, 0);
});

test("concurrent or out-of-order snapshots cannot create independent admission allowances", async () => {
  const date = "2013-05-11", early = await refresh(date, "09"), late = await refresh(date, "12");
  for (let i = 0; i < 40; i++) {
    await material(early.id, `race-early-${i}`, date);
    await material(late.id, `race-late-${i}`, date);
  }
  const results = await Promise.allSettled([freezeAdmissions(early.id), freezeAdmissions(late.id)]);
  assert.ok(results.some(r => r.status === "fulfilled"));
  const [row] = await sql`SELECT count(DISTINCT article_id)::int AS n FROM research_members WHERE run_id=ANY(${[early.id, late.id]}) AND admitted`;
  assert.ok(row.n <= 60);
  const older = await refresh(date, "06");
  await assert.rejects(freezeAdmissions(older.id), /later daily snapshot/);
  assert.equal((await sql`SELECT admission_frozen FROM research_runs WHERE id=${older.id}`)[0].admission_frozen, false);
});

test("slot changes keep the daily 600-call budget and an UNKNOWN receipt cannot be resent", async () => {
  const date = "2013-05-12", first = await refresh(date, "09"), second = await refresh(date, "12");
  const budgetId = `daily-${date}`, budget = { id: budgetId, maxCalls: 600, reportReserve: 20 };
  budgetIds.add(budgetId);
  await ensureModelRun(budget);
  await sql`UPDATE model_runs SET calls_used=598 WHERE id=${budgetId}`;
  let calls = 0;
  const ask = async (snapshot: string) => {
    assert.equal(researchFamilyDate(snapshot), date);
    await ensureModelRun(budget);
    const result = await paidRequest({ service: `refresh-budget-${T}`, purpose: "report_lead", identity: snapshot, modelRun: budget }, async () => { calls++; return { response: {} }; });
    receiptIds.add(result.receiptId);
    return result;
  };
  await ask(first.id); await ask(second.id);
  assert.equal((await getModelRun(budgetId))!.callsUsed, 600);
  await ask(first.id);
  await assert.rejects(ask(`refresh-${date}-15`), BudgetExceededError);
  assert.equal(calls, 2);

  // This synthetic UNKNOWN was created by an injected callback; no provider is contacted.
  const req = { service: `refresh-unknown-${T}`, purpose: "score_article", identity: `same-article-revision-${T}` };
  let attempts = 0;
  const unknown = () => paidRequest(req, async () => { attempts++; throw new Error("simulated uncertain transport"); });
  await assert.rejects(unknown, /uncertain transport/);
  const [receipt] = await sql`SELECT id FROM receipts WHERE service=${req.service}`;
  receiptIds.add(receipt.id);
  await assert.rejects(unknown, ReceiptUnknownError);
  assert.equal(attempts, 1);
});

test("a revised paper retains its admission slot but cannot inherit an obsolete terminal analysis", async () => {
  const date = "2013-05-13", first = await refresh(date, "09");
  const rows: Array<{ id: string; state: string; label: string }> = [];
  for (const state of ["pass", "block", "unknown", "unknown-receipt", "failed", "unchanged"]) {
    const label = `revision-${state}`, id = await material(first.id, label, date);
    rows.push({ id, state, label });
  }
  await freezeAdmissions(first.id);
  for (const row of rows) {
    const state = row.state === "unchanged" ? "pass" : row.state;
    await sql`UPDATE research_members SET state=${state},error=${["unknown-receipt", "failed"].includes(state) ? "held attempt" : null}
      WHERE run_id=${first.id} AND article_id=${row.id}`;
    if (["pass", "block", "unknown"].includes(state)) {
      await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance) VALUES(${row.id},1,'rule',${state})`;
      await sql`UPDATE articles SET processing_state=${state === "block" ? "blocked" : "analyzed"} WHERE id=${row.id}`;
    }
    if (row.state !== "unchanged") {
      const result = await upsertMaterial({ sourceId, url: `https://example.org/refresh/${T}/${row.label}`, title: `Refresh ${row.label}`,
        bodyText: `Substantially updated source abstract ${row.label}`, bodyStatus: "ok", via: "import", publishedAt: dailyWindow(date).start,
        discoveredAt: dailyWindow(date).end, backfill: null });
      assert.equal(result.articleId, row.id);
      assert.equal(result.revised, true);
    }
  }
  const next = await refresh(date, "12");
  assert.equal(await freezeAdmissions(next.id), 6);
  const inherited = await sql<{ article_id: string; state: string; error: string | null }[]>`SELECT article_id,state,error FROM research_members WHERE run_id=${next.id}`;
  for (const row of rows) {
    const actual = inherited.find(r => r.article_id === row.id)!;
    assert.equal(actual.state, row.state === "unchanged" ? "pass" : ["pass", "block", "unknown"].includes(row.state) ? "pending" : row.state);
    if (["unknown-receipt", "failed"].includes(row.state)) assert.equal(actual.error, "held attempt");
  }
});

test("an older slot cannot replace a later daily revision, including an empty edition", async () => {
  const date = "2013-05-14", first = await refresh(date, "09");
  reportKeys.add(date);
  await freezeAdmissions(first.id);
  await composePilot(first.id, true);
  const next = await refresh(date, "12");
  await freezeAdmissions(next.id);
  await composePilot(next.id, true);
  const before = (await sql`SELECT revision,window_end FROM reports WHERE kind='daily' AND key=${date}`)[0];
  assert.equal(before.window_end.toISOString(), next.window_end.toISOString());
  await assert.rejects(composePilot(first.id, true), /新|旧|older|later/i);
  const after = (await sql`SELECT revision,window_end FROM reports WHERE kind='daily' AND key=${date}`)[0];
  assert.deepEqual(after, before);
});

test("one explicit r1 correction requires a frozen base and inherits the same daily admission ceiling", async () => {
  const date = "2013-05-15", base = await refresh(date, "09"), correctionId = `${base.id}-r1`;
  assert.equal(researchFamilyDate(correctionId), date);
  assert.ok(new RegExp(refreshFamilyPattern(date)).test(correctionId));
  assert.equal(researchFamilyDate(`${base.id}-r2`), null);
  assert.throws(() => refreshWindow(`${base.id}-r2`, base.window_end), /Invalid/);
  await assert.rejects(prepareRefreshRun(correctionId, base.window_end), /frozen base/);
  for (let i = 0; i < 59; i++) await material(base.id, `correction-existing-${i}`, date);
  assert.equal(await freezeAdmissions(base.id), 59);
  await assert.rejects(prepareRefreshRun(correctionId, new Date(`${date}T09:00:00+08:00`)), /precede/);
  runIds.add(correctionId);
  const corrected = await prepareRefreshRun(correctionId, base.window_end);
  assert.equal(corrected.window_end.toISOString(), base.window_end.toISOString());
  assert.equal(refreshWindow(correctionId, base.window_end).modelRunId, `daily-${date}`);
  await material(correctionId, "correction-first", date); await material(correctionId, "correction-overflow", date);
  assert.equal(await freezeAdmissions(correctionId), 60);
  await assert.rejects(freezeAdmissions(base.id), /later daily snapshot/, "a correction supersedes the base even with the exact same cutoff");
  assert.equal((await sql`SELECT count(*)::int AS n FROM research_members WHERE run_id=${base.id} AND admitted`)[0].n, 59);
  const metrics = (await researchRunMetrics(correctionId)).metrics;
  assert.equal(metrics.previouslyAdmitted, 59); assert.equal(metrics.newlyAdmitted, 1);
  const next = await refresh(date, "12");
  assert.equal(await freezeAdmissions(next.id), 60);
  assert.equal((await sql`SELECT count(DISTINCT article_id)::int AS n FROM research_members WHERE run_id=ANY(${[base.id, correctionId, next.id]}) AND admitted`)[0].n, 60);
});
