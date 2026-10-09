import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { createResearchRun } from "@aihot/backend/research/collect";
import { freezeAdmissions } from "@aihot/backend/research/admission";
import { composeResearchDailyDate } from "@aihot/backend/reports/compose";
import { BudgetExceededError, paidRequest, ReceiptUnknownError, type CallOutcome, type ReceiptRequest } from "@aihot/backend/providers/receipts";
import { ensureModelRun, getModelRun, type ModelRunConfig } from "@aihot/backend/providers/model-runs";
import { RESEARCH_MODEL_PROFILES } from "@aihot/backend/providers/research-model";
import { DATE_BACKFILL_CAMPAIGN, DATE_BACKFILL_DATES, authorizedDateBackfill, dateBackfillRunId } from "@aihot/contracts/date-backfill";
import { dailyWindow } from "@aihot/contracts/time";

const T = tag(), sourceId = `date-authorization-${T}`, ordinaryId = `date-ordinary-${T}`;
const ids = DATE_BACKFILL_DATES.map(dateBackfillRunId);
const articleIds: string[] = [];
const subjects = new Map<string, string>();
const profile = RESEARCH_MODEL_PROFILES["codex-gpt-6-astra"];
const originalDataDir = config.dataDir;
let dataDir: string | undefined, owned = false;
let savedBudget: { per_minute: number; per_hour: number; per_day: number; note: string | null } | undefined;
let savedSettings: { key: string; value: unknown }[] = [];
const settingKeys = ["research.model_profile", "research.model_validation"];

async function restoreBudget() {
  if (!savedBudget) return;
  await sql`INSERT INTO budgets(service,per_minute,per_hour,per_day,note)
    VALUES('codex_cli',${savedBudget.per_minute},${savedBudget.per_hour},${savedBudget.per_day},${savedBudget.note})
    ON CONFLICT(service) DO UPDATE SET per_minute=excluded.per_minute,per_hour=excluded.per_hour,per_day=excluded.per_day,note=excluded.note`;
}

async function counts() {
  const [row] = await sql<{ minute: number; hour: number; ordinary: number }[]>`SELECT
    count(*) FILTER(WHERE started_at>now()-interval '1 minute')::int AS minute,
    count(*) FILTER(WHERE started_at>now()-interval '1 hour')::int AS hour,
    count(*) FILTER(WHERE model_run_id IS NULL OR NOT(model_run_id=ANY(${ids})))::int AS ordinary
    FROM receipt_attempts WHERE service='codex_cli' AND origin='live' AND started_at>now()-interval '1 day'`;
  return row!;
}

async function generousBudget() {
  const c = await counts();
  await sql`UPDATE budgets SET per_minute=${c.minute + 1000},per_hour=${c.hour + 1000},per_day=${c.ordinary + 1000} WHERE service='codex_cli'`;
}

const allowance = (id: string): ModelRunConfig => ({ id, maxCalls: 600, reportReserve: 20, callCeiling: 580 });
function request(id: string, label: string, overrides: Partial<ReceiptRequest> = {}): ReceiptRequest {
  return { service: "codex_cli", model: profile.model, purpose: "research_brief", subject: subjects.get(id) ?? subjects.get(ids[0]!),
    identity: `${T}:${label}`, modelRun: allowance(id), ...overrides };
}
const ask = (req: ReceiptRequest, callback: () => Promise<CallOutcome> = async () => ({ response: { ok: true } })) => paidRequest(req, callback);
const fixtureRequest = (id: string, label: string, overrides: Partial<ReceiptRequest> = {}) => request(id, label, { requestSummary: { fixture: T }, ...overrides });

/** Seed old attempts, not fake provider calls; minute/hour limits are independently exercised below. */
async function seedDayAttempts(n: number, modelRunId: string | null, status: "received" | "unknown" = "received") {
  if (n < 1) return;
  const [receipt] = await sql<{ id: number }[]>`INSERT INTO receipts(logical_key,service,model,purpose,subject,status,request,attempts)
    VALUES(${`${T}:seed:${tag()}`},'codex_cli',${profile.model},'fixture',${`probe:${T}`},${status},${sql.json({ fixture: T })},${n}) RETURNING id`;
  await sql`INSERT INTO receipt_attempts(receipt_id,attempt,service,model,status,model_run_id,started_at)
    SELECT ${receipt!.id},n,'codex_cli',${profile.model},${status},${modelRunId},now()-interval '2 hours' FROM generate_series(1,${n}) n`;
}

async function material(runId: string | null, date: string, suffix: string, publish = false) {
  const id = `da-${T}-${suffix}`, { start } = dailyWindow(date), at = new Date(start.getTime() + 3600_000);
  const research = { canonicalKey: id, arxivId: null, originalPublishedAt: at.toISOString(), signalOnly: false, evidenceBasis: "abstract" };
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,published_at,discovered_at,timeline_at,research)
    VALUES(${id},${sourceId},${id},${`https://example.test/${id}`},'Research fixture',${at},${at},${at},${sql.json(research)})`;
  articleIds.push(id);
  if (runId) {
    await sql`INSERT INTO research_members(run_id,article_id,source_id,in_window,signal_only) VALUES(${runId},${id},${sourceId},true,false)`;
    subjects.set(runId, `article:${id}@1`);
  }
  if (publish) {
    const brief = { methodChange: "作者报告方法变化。", applicableTasks: "模拟任务", comparisonConditions: "仅摘要比较。", limitations: "未独立复现。",
      evidenceBasis: "abstract", sourceRevision: 1, promptVersion: "fixture", generatedAt: at.toISOString() };
    await sql`INSERT INTO publications(article_id,title,summary,source_id,channel,url,published_at,discovered_at,timeline_at,sort_at,
      eligible,selected,visible_after,visibility,category,score,research,research_brief)
      VALUES(${id},'研究方法','作者报告模拟结果。',${sourceId},'news',${`https://example.test/${id}`},${at},${at},${at},${at},
        true,true,${at},'public','algorithm',90,${sql.json(research)},${sql.json(brief)})`;
    const figure = { itemId: id, sourceRevision: 1, imageOrigin: "remote", imageUrl: `https://example.test/${id}.png`,
      sourceUrl: `https://example.test/${id}#fig1`, figureLabel: "Figure 1", caption: "Method overview", attribution: "Fixture authors",
      licenseName: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", verifiedAt: at.toISOString(),
      width: 800, height: 400, contentType: "image/png", sha256: "b".repeat(64) };
    await writeFile(path.join(dataDir!, "research-figures", `${id}-r1.json`), JSON.stringify({ schemaVersion: 1, itemId: id,
      sourceRevision: 1, inputHash: "a".repeat(64), checkedAt: at.toISOString(), status: "verified", reason: "Offline source-bound fixture",
      verificationBasis: "source-caption", figure, candidate: null }));
  }
  return id;
}

before(async () => {
  // Fixed campaign names cannot be randomized. Refuse collisions instead of deleting another fixture.
  assert.equal((await sql`SELECT id FROM research_runs WHERE id=ANY(${ids}) UNION SELECT id FROM model_runs WHERE id=ANY(${[...ids, ordinaryId]})`).length, 0);
  assert.equal((await sql`SELECT id FROM reports WHERE kind='daily' AND key=ANY(${[...DATE_BACKFILL_DATES]})`).length, 0);
  [savedBudget] = await sql`SELECT per_minute,per_hour,per_day,note FROM budgets WHERE service='codex_cli'`;
  assert.ok(savedBudget, "migration must seed the shared Codex service guard");
  savedSettings = await sql`SELECT key,value FROM settings WHERE key=ANY(${settingKeys})`;
  owned = true;
  await sql`DELETE FROM settings WHERE key=ANY(${settingKeys})`;
  await sql`INSERT INTO settings(key,value) VALUES('research.model_profile',${sql.json({ profileId: profile.profileId, reasoningEffort: profile.reasoningEffort, revision: 1 })})`;
  dataDir = await mkdtemp(path.join(tmpdir(), "algorithmhot-date-authorization-"));
  config.dataDir = dataDir;
  await mkdir(path.join(dataDir, "research-figures"));
  await sql`INSERT INTO sources(id,name,kind,participation_mode) VALUES(${sourceId},'Offline date authorization','rss','editorial')`;
  for (const date of DATE_BACKFILL_DATES) {
    const id = dateBackfillRunId(date), window = dailyWindow(date);
    const run = await createResearchRun(id, "pilot", new Date("2026-10-09T08:00:00Z"), window,
      { admissionPolicy: "all-in-window", modelCallCeiling: 580, modelBudgetId: id });
    assert.equal(run.model_budget_id, id);
    await ensureModelRun(allowance(id));
    await material(id, date, date, date === DATE_BACKFILL_DATES[0]);
    await freezeAdmissions(id);
    await sql`UPDATE research_members SET state='pass' WHERE run_id=${id}`;
  }
  await ensureModelRun(allowance(ordinaryId));
  await material(null, DATE_BACKFILL_DATES[0], "outside-run", true);
});

beforeEach(async () => {
  if (!owned) return;
  await sql`DELETE FROM receipts WHERE request->>'fixture'=${T}`;
  await sql`UPDATE model_runs SET calls_used=0 WHERE id=ANY(${[...ids, ordinaryId]})`;
  await restoreBudget();
  await generousBudget();
});

after(async () => {
  try {
    if (owned) {
      await sql`DELETE FROM receipts WHERE request->>'fixture'=${T}`;
      await sql`DELETE FROM research_members WHERE run_id=ANY(${ids})`;
      await sql`DELETE FROM research_fetches WHERE run_id=ANY(${ids})`;
      await sql`DELETE FROM research_runs WHERE id=ANY(${ids})`;
      await sql`DELETE FROM model_runs WHERE id=ANY(${[...ids, ordinaryId]})`;
      await sql`DELETE FROM reports WHERE kind='daily' AND key=ANY(${[...DATE_BACKFILL_DATES]})`;
      if (articleIds.length) await sql`DELETE FROM articles WHERE id=ANY(${articleIds})`;
      await sql`DELETE FROM sources WHERE id=${sourceId}`;
      await restoreBudget();
      await sql`DELETE FROM settings WHERE key=ANY(${settingKeys})`;
      for (const row of savedSettings) await sql`INSERT INTO settings(key,value) VALUES(${row.key},${sql.json(row.value as never)})`;
    }
  } finally {
    config.dataDir = originalDataDir;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    await closeDb();
  }
});

test("only the three exact issue windows and matching extra budgets satisfy the authorization contract and database constraint", async () => {
  for (const date of DATE_BACKFILL_DATES) {
    const id = dateBackfillRunId(date), window = dailyWindow(date);
    assert.equal(authorizedDateBackfill(id, id, "pilot", window, 580), true);
    for (const [runId, budgetId, kind, range, ceiling] of [
      [id, ids.find(other => other !== id)!, "pilot", window, 580],
      [`${id}-r1`, `${id}-r1`, "pilot", window, 580],
      [id, id, "daily", window, 580], [id, id, "pilot", window, 600],
      [id, id, "pilot", { start: new Date(window.start.getTime() + 1), end: window.end }, 580],
    ] as const) assert.equal(authorizedDateBackfill(runId, budgetId, kind, range, ceiling), false);
    await assert.rejects(sql`UPDATE research_runs SET window_end=window_end+interval '1 second' WHERE id=${id}`);
    await assert.rejects(sql`UPDATE research_runs SET model_budget_id=NULL WHERE id=${id}`);
    await assert.rejects(sql`UPDATE research_runs SET model_budget_id='daily-2026-10-09' WHERE id=${id}`);
    await assert.rejects(sql`UPDATE research_runs SET model_budget_id=${ids.find(other => other !== id)!} WHERE id=${id}`);
    await assert.rejects(sql`UPDATE research_runs SET model_call_ceiling=NULL WHERE id=${id}`);
  }
  assert.throws(() => dateBackfillRunId("2026-10-08"));
  const alternate = `${DATE_BACKFILL_CAMPAIGN}-2026-10-08`;
  await assert.rejects(createResearchRun(alternate, "pilot", new Date("2026-10-09T08:00:00Z"), dailyWindow("2026-10-08"),
    { admissionPolicy: "all-in-window", modelCallCeiling: 580, modelBudgetId: alternate }));
  assert.equal((await sql`SELECT id FROM research_runs WHERE id=${alternate}`).length, 0);
  for (const budgetId of [null, "daily-2026-10-09", alternate]) await assert.rejects(sql`INSERT INTO research_runs(id,kind,window_start,window_end,model_budget_id)
    VALUES(${alternate},'pilot','2026-10-07T01:00:00Z','2026-10-08T01:00:00Z',${budgetId})`);
  const frozen = await createResearchRun(ids[0]!, "pilot", new Date("2026-10-10T08:00:00Z"));
  assert.equal(frozen.window_end.toISOString(), dailyWindow(DATE_BACKFILL_DATES[0]).end.toISOString(), "resuming the ID preserves its original window");
});

test("date reports retain the new run denominator, explicitly count older verified reuse, and reject stale prepared revisions", async () => {
  const date = DATE_BACKFILL_DATES[0], runId = ids[0]!;
  const beforeAttempts = Number((await sql`SELECT count(*) AS n FROM receipt_attempts`)[0]!.n);
  const result = await composeResearchDailyDate(date, { revise: true, sourceRunId: runId, expectedRevision: 0 });
  assert.equal(result.entries, 2);
  const [first] = await sql<{ id: number; revision: number; content: { run: { id: string; metrics: Record<string, number> }; metrics: Record<string, number> } }[]>`
    SELECT id,revision,content FROM reports WHERE kind='daily' AND key=${date}`;
  assert.equal(first!.content.run.id, runId);
  assert.equal(first!.content.run.metrics.admitted, 1);
  assert.equal(first!.content.run.metrics.selected, 1);
  assert.equal(first!.content.metrics.selected, 2);
  assert.equal(first!.content.metrics.published, 2);
  assert.equal(first!.content.metrics.outsideRunCandidates, 1);
  assert.equal(first!.content.metrics.outsideRunReused, 1);
  await assert.rejects(composeResearchDailyDate(date, { revise: true, sourceRunId: runId, expectedRevision: 0 }), /revision|修订/i);
  assert.deepEqual((await sql`SELECT revision,content FROM reports WHERE id=${first!.id}`)[0], { revision: first!.revision, content: first!.content });
  await assert.rejects(composeResearchDailyDate(date, { revise: true, sourceRunId: ids[1]!, expectedRevision: 1 }), /authorized|exact|date/i);
  await composeResearchDailyDate(date, { revise: true, sourceRunId: runId, expectedRevision: 1 });
  assert.equal((await sql`SELECT revision FROM reports WHERE id=${first!.id}`)[0]!.revision, 2);
  assert.deepEqual((await sql`SELECT content FROM report_revisions WHERE report_id=${first!.id} AND revision=1`)[0]!.content, first!.content);
  assert.equal(Number((await sql`SELECT count(*) AS n FROM receipt_attempts`)[0]!.n), beforeAttempts, "cache-only composition buys no requests");
});

test("the extra allowance works at the ordinary daily limit without excluding NULL-batch attempts", async () => {
  const baseline = await counts(), dayLimit = Math.max(600, baseline.ordinary + 1);
  await seedDayAttempts(dayLimit - baseline.ordinary, null, "unknown");
  await sql`UPDATE budgets SET per_day=${dayLimit} WHERE service='codex_cli'`;
  let calls = 0;
  const callback = async () => { calls++; return { response: {} }; };
  await assert.rejects(ask(fixtureRequest(ordinaryId, "ordinary-full"), callback), BudgetExceededError);
  await ask(fixtureRequest(ids[0]!, "extra-with-full-ordinary"), callback);
  assert.equal(calls, 1);
  assert.equal((await getModelRun(ordinaryId))!.callsUsed, 0);
  assert.equal((await getModelRun(ids[0]!))!.callsUsed, 1);
});

test("extra attempts do not consume the ordinary daily allowance, while ordinary attempts still stop at its boundary", async () => {
  const baseline = await counts(), dayLimit = Math.max(600, baseline.ordinary + 2);
  await seedDayAttempts(dayLimit - baseline.ordinary - 1, null);
  await seedDayAttempts(12, ids[0]!, "unknown");
  await sql`UPDATE budgets SET per_day=${dayLimit} WHERE service='codex_cli'`;
  let calls = 0;
  const callback = async () => { calls++; return { response: {} }; };
  await ask(fixtureRequest(ordinaryId, "ordinary-last"), callback);
  await assert.rejects(ask(fixtureRequest(ordinaryId, "ordinary-overflow"), callback), BudgetExceededError);
  assert.equal(calls, 1);
  assert.equal((await getModelRun(ordinaryId))!.callsUsed, 1);
});

test("claiming an extra ID with the wrong service, model, limits or admitted subject fails before reserving any attempt", async () => {
  const id = ids[0]!, memberId = subjects.get(id)!.slice(8).split("@")[0]!;
  const invalid: Partial<ReceiptRequest>[] = [
    { service: "unbudgeted-fixture" }, { model: "unregistered-model" }, { modelRun: { ...allowance(id), maxCalls: 599 } },
    { modelRun: { ...allowance(id), reportReserve: 0 } }, { modelRun: { ...allowance(id), callCeiling: 600 } },
    { modelRun: { id, maxCalls: 600, reportReserve: 20 } }, { subject: `article:da-${T}-outside-run@1` },
    { subject: `report:daily:${DATE_BACKFILL_DATES[0]}` },
  ];
  let calls = 0;
  const callback = async () => { calls++; return { response: {} }; };
  for (const [index, override] of invalid.entries()) await assert.rejects(ask(fixtureRequest(id, `invalid-${index}`, override), callback));
  await sql`UPDATE research_runs SET admission_frozen=false WHERE id=${id}`;
  try { await assert.rejects(ask(fixtureRequest(id, "unfrozen"), callback)); }
  finally { await sql`UPDATE research_runs SET admission_frozen=true WHERE id=${id}`; }
  for (const flags of [{ admitted: false, in_window: true, signal_only: false }, { admitted: true, in_window: false, signal_only: false }, { admitted: true, in_window: true, signal_only: true }]) {
    await sql`UPDATE research_members SET ${sql(flags)} WHERE run_id=${id} AND article_id=${memberId}`;
    try { await assert.rejects(ask(fixtureRequest(id, `invalid-member-${tag()}`), callback)); }
    finally { await sql`UPDATE research_members SET admitted=true,in_window=true,signal_only=false WHERE run_id=${id} AND article_id=${memberId}`; }
  }
  await sql`DELETE FROM budgets WHERE service='codex_cli'`;
  try { await assert.rejects(ask(fixtureRequest(id, "missing-service-guard"), callback)); }
  finally { await restoreBudget(); }
  assert.equal(calls, 0);
  assert.equal((await getModelRun(id))!.callsUsed, 0);
  assert.equal((await sql`SELECT id FROM receipts WHERE request->>'fixture'=${T}`).length, 0, "a denied authorization must not leave a billable or failed placeholder");
});

test("extra and ordinary requests still share service minute/hour locks and every stopped guard", async () => {
  let calls = 0;
  const callback = async () => { calls++; return { response: {} }; };
  let current = await counts();
  await sql`UPDATE budgets SET per_minute=${current.minute + 1} WHERE service='codex_cli'`;
  const minute = await Promise.allSettled([ask(fixtureRequest(ordinaryId, "minute-ordinary"), callback), ask(fixtureRequest(ids[0]!, "minute-extra"), callback)]);
  assert.equal(minute.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(calls, 1);
  await generousBudget(); current = await counts();
  await sql`UPDATE budgets SET per_hour=${current.hour + 1} WHERE service='codex_cli'`;
  const hour = await Promise.allSettled([ask(fixtureRequest(ids[0]!, "hour-extra-1"), callback), ask(fixtureRequest(ids[1]!, "hour-extra-2"), callback)]);
  assert.equal(hour.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(calls, 2);
  for (const field of ["per_minute", "per_hour", "per_day"] as const) {
    await generousBudget(); await sql`UPDATE budgets SET ${sql({ [field]: 0 })} WHERE service='codex_cli'`;
    await assert.rejects(ask(fixtureRequest(ids[0]!, `stopped-${field}`), callback), BudgetExceededError);
  }
  assert.equal(calls, 2);
});

test("the campaign ceiling is atomic at 579 and reused responses or old UNKNOWN outcomes never spend another call", async () => {
  const id = ids[0]!;
  await sql`UPDATE model_runs SET calls_used=579 WHERE id=${id}`;
  let calls = 0;
  const callback = async () => { calls++; return { response: { ok: true } }; };
  const requests = [fixtureRequest(id, "ceiling-1"), fixtureRequest(id, "ceiling-2")];
  const result = await Promise.allSettled(requests.map(req => ask(req, callback)));
  assert.equal(result.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(calls, 1);
  assert.equal((await getModelRun(id))!.callsUsed, 580);
  assert.equal((await sql`SELECT id FROM receipt_attempts WHERE model_run_id=${id}`).length, 1);
  const successful = requests[result.findIndex(item => item.status === "fulfilled")]!;
  assert.equal((await ask(successful, callback)).reused, true);
  assert.equal(calls, 1);
  const lost = fixtureRequest(ordinaryId, "old-unknown"), lostCallback = async () => { calls++; throw new Error("Fixture lost response"); };
  await assert.rejects(ask(lost, lostCallback), /lost response/);
  await assert.rejects(ask({ ...lost, modelRun: allowance(ids[1]!) }, lostCallback), ReceiptUnknownError);
  assert.equal(calls, 2);
  assert.equal((await getModelRun(ids[1]!))!.callsUsed, 0);
  assert.equal((await getModelRun(ordinaryId))!.callsUsed, 1);
});
