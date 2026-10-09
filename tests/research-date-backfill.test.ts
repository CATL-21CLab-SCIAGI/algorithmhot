import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { DATE_BACKFILL_CAMPAIGN, DATE_BACKFILL_DATES, dateBackfillRunId } from "@aihot/contracts/date-backfill";
import { computeResearchHeat, type ResearchHeatInput } from "@aihot/contracts/research-heat";
import { dateBackfillOptions, dateBackfillHash, newDateBackfillPlan, validateDateBackfillPlan, originalDateBackfillTime,
  dateBackfillQueue, ensureDateBackfillReport, isDateBackfillBudgetStop, dateBackfillProjectionIds, waitDateBackfillRelease,
  type DateBackfillSourceRow, type DateBackfillReport, type DateBackfillProjectionCandidate } from "../scripts/research-date-backfill.ts";
import { visitBackfillArticle } from "../scripts/research-backfill.ts";

const model = { version: 1 as const, profileId: "codex-gpt-6.1-sol" as const, transport: "codex_cli" as const,
  model: "gpt-6.1-sol", reasoningEffort: "medium" as const, region: null };
const sourceIds = ["research-arxiv-ml-ai", "research-arxiv-molecular", "research-arxiv-physical-science", "research-hf-daily-papers", "rss-bair", "rss-google-deepmind"];
const sources = sourceIds.map(id => ({ id, kind: id === "research-hf-daily-papers" ? "json_list" : "rss", sha256: "a".repeat(64) }));
const now = new Date("2026-10-09T02:00:00.000Z");
const plan = () => newDateBackfillPlan(model, sources, ["already-public"], now);
const candidate = (articleId: string, originalPublishedAt = "2026-10-04T10:00:00.000Z"): DateBackfillSourceRow => ({
  articleId, canonicalKey: `arxiv:${articleId}`, sourceId: "research-arxiv-ml-ai", arxivId: articleId,
  originalPublishedAt, publishedAt: "2026-10-09T00:00:00.000Z", signalOnly: false,
});

test("date recollection is read-only by default and has no flags to mint dates, campaigns or allowance", () => {
  assert.deepEqual(dateBackfillOptions([]), { run: false, collectOnly: false, resume: false });
  assert.deepEqual(dateBackfillOptions(["--status"]), { run: false, collectOnly: false, resume: false });
  assert.deepEqual(dateBackfillOptions(["--run", "--collect-only", "--resume"]), { run: true, collectOnly: true, resume: true });
  for (const args of [["--resume"], ["--collect-only"], ["--run", "--status"], ["--run", "--run"], ["--run", "--date=2026-10-08"],
    ["--run", "--calls=1800"], ["--run", "--campaign=other"], ["--run", "--reset"], ["--run", "--retry-failed"]]) assert.throws(() => dateBackfillOptions(args));
});

test("the fixed three grants are independent from today's daily run and use exact half-open 09:00 windows", () => {
  const value = plan();
  assert.equal(value.campaign, "recollect-20261009-oct05-07-v1");
  assert.equal(DATE_BACKFILL_CAMPAIGN, value.campaign);
  assert.deepEqual(value.windows.map(window => window.date), ["2026-10-05", "2026-10-06", "2026-10-07"]);
  assert.deepEqual(value.windows.map(window => [window.start, window.end]), [
    ["2026-10-04T01:00:00.000Z", "2026-10-05T01:00:00.000Z"],
    ["2026-10-05T01:00:00.000Z", "2026-10-06T01:00:00.000Z"],
    ["2026-10-06T01:00:00.000Z", "2026-10-07T01:00:00.000Z"],
  ]);
  for (const window of value.windows) {
    assert.equal(window.budgetId, window.runId); assert.equal(window.runId, dateBackfillRunId(window.date));
    assert.equal(window.maxCalls, 600); assert.equal(window.reportReserve, 20); assert.equal(window.callCeiling, 580);
    assert.ok(!window.budgetId.startsWith("daily-")); assert.ok(!window.runId.startsWith("refresh-"));
  }
  assert.equal(value.windows.reduce((sum, window) => sum + window.maxCalls, 0), 1800);
  assert.equal(value.windows.reduce((sum, window) => sum + window.callCeiling, 0), 1740);
  assert.throws(() => newDateBackfillPlan(model, sources, [], new Date("2026-10-06T23:00:00.000Z")), /closed/);
  assert.throws(() => newDateBackfillPlan({ ...model, transport: "bedrock_converse" }, sources, [], now), /Codex subscription/);
  assert.throws(() => newDateBackfillPlan(model, sources.slice(1), [], now), /six registered/);
});

test("service throttles propagate with the queue checkpoint intact; only this window's own budget can finish it", async () => {
  const budgetId = plan().windows[0]!.budgetId;
  assert.equal(isDateBackfillBudgetStop(`model-run:${budgetId}`, budgetId), true);
  for (const service of ["codex_cli", "bedrock_converse", "model-run:daily-2026-10-09", `model-run:${plan().windows[1]!.budgetId}`]) {
    assert.equal(isDateBackfillBudgetStop(service, budgetId), false);
    const error = Object.assign(new Error("service minute/hour/day limit"), { service });
    await assert.rejects(visitBackfillArticle(async () => { throw error; }, async () => true,
      caught => caught === error && isDateBackfillBudgetStop(error.service, budgetId)), /minute\/hour\/day/);
  }
  let checks = 0;
  assert.equal(await visitBackfillArticle(async hasBudget => { assert.equal(await hasBudget(), true); assert.equal(await hasBudget(), false); },
    async () => ++checks === 1, () => false), "budget-stopped", "mainflow success followed by silent brief deferral cannot advance the cursor");
});

test("resume rejects allowance, date, campaign and queue drift instead of resetting earlier usage", () => {
  const value = plan(), window = value.windows[0]!;
  window.collected = true; window.frozen = true; window.callsObserved = 143;
  window.queue = dateBackfillQueue([candidate("2610.00001"), candidate("2610.00002")], window);
  window.queueHash = dateBackfillHash(window.queue); window.cursor = 1;
  assert.deepEqual(validateDateBackfillPlan(structuredClone(value)), value);
  const mutations = [
    (p: typeof value) => { p.campaign = "new-campaign"; },
    (p: typeof value) => { p.windows[0]!.budgetId = "daily-2026-10-09"; },
    (p: typeof value) => { p.windows[0]!.runId += "-r1"; },
    (p: typeof value) => { p.windows[0]!.start = "2026-10-04T16:00:00.000Z"; },
    (p: typeof value) => { p.windows[0]!.callCeiling = 600; },
    (p: typeof value) => { p.windows[0]!.reportReserve = 0; },
    (p: typeof value) => { p.windows[0]!.callsObserved = 601; },
    (p: typeof value) => { p.windows[0]!.cursor = 3; },
    (p: typeof value) => { p.windows[0]!.queue!.reverse(); },
    (p: typeof value) => { p.windows[0]!.queue![0]!.sourceDate = "2026-10-09T00:00:00.000Z"; },
  ];
  for (const mutate of mutations) { const changed = structuredClone(value); mutate(changed); assert.throws(() => validateDateBackfillPlan(changed)); }
});

test("canonical JSON hashing tolerates database key order while retaining array and value differences", () => {
  assert.equal(dateBackfillHash({ z: [3, { b: 1, a: 2 }], a: true }), dateBackfillHash({ a: true, z: [3, { a: 2, b: 1 }] }));
  assert.notEqual(dateBackfillHash([1, 2]), dateBackfillHash([2, 1]));
  assert.notEqual(dateBackfillHash({ count: 600 }), dateBackfillHash({ count: 601 }));
});

test("arXiv original time cannot be filled from publication, announcement or collection time", () => {
  const row = { ...candidate("2610.00001"), originalPublishedAt: null, announcedOn: "2026-10-04", discoveredAt: "2026-10-04T20:00:00.000Z" };
  assert.equal(originalDateBackfillTime(row), null);
  assert.equal(originalDateBackfillTime({ ...row, originalPublishedAt: "2026-02-30T12:00:00Z" }), null);
  assert.equal(originalDateBackfillTime({ ...row, originalPublishedAt: "2026-10-04T12:00:00" }), null);
  assert.equal(originalDateBackfillTime({ ...row, originalPublishedAt: "2026-10-04T09:00:00+08:00" }), "2026-10-04T01:00:00.000Z");
  assert.equal(originalDateBackfillTime({ ...row, arxivId: null, publishedAt: "2026-10-04T12:00:00Z" }), "2026-10-04T12:00:00.000Z");
});

test("source queue admits the lower boundary and rejects upper boundary or unknown dates without dropping rows", () => {
  const window = plan().windows[0]!;
  const rows = [candidate("2610.00001", window.start), { ...candidate("2610.00002", "2026-10-04T22:59:00.000Z"), announcedOn: "2026-10-09" }];
  assert.deepEqual(dateBackfillQueue(rows, window).map(row => row.articleId), ["2610.00002", "2610.00001"]);
  for (const row of [candidate("2610.00003", window.end), candidate("2610.00003", "2026-10-04T00:59:59.999Z"),
    { ...candidate("2610.00003"), originalPublishedAt: null }, { ...candidate("2610.00003"), signalOnly: true },
    { ...candidate("2610.00003"), sourceId: "research-hf-daily-papers" }]) assert.throws(() => dateBackfillQueue([...rows, row], window), /preserve all observations/);
  assert.throws(() => dateBackfillQueue([rows[0]!, rows[0]!], window), /repeated canonical/);
  assert.deepEqual(dateBackfillQueue([], window), []);
});

test("HF projection refresh includes related public papers outside admission but never unreviewed or private material", () => {
  const base: DateBackfillProjectionCandidate = { articleId: "in-run", publicEligible: true, currentPass: true, signalOnly: false, inRun: true, linkedHf: false };
  const rows = [base, { ...base }, { ...base, articleId: "old-hf-paper", inRun: false, linkedHf: true },
    { ...base, articleId: "unrelated", inRun: false }, { ...base, articleId: "failed-or-unknown", currentPass: false },
    { ...base, articleId: "private-or-ineligible", publicEligible: false }, { ...base, articleId: "hf-signal", signalOnly: true }];
  assert.deepEqual(dateBackfillProjectionIds(rows), ["in-run", "old-hf-paper"]);
  const published: ResearchHeatInput = { id: "old-hf-paper", title: "Previously reviewed paper", sourceName: "arXiv",
    sourceUrl: "https://arxiv.org/abs/2610.00001", publishedAt: "2026-10-03T02:00:00.000Z", research: {
      arxivId: "2610.00001", doi: null, originalPublishedAt: "2026-10-03T02:00:00.000Z", communitySelectedAt: null,
    } };
  assert.equal(computeResearchHeat([published], now.toISOString()).qualifyingResearch, 0, "the old public projection has no independent HF signal");
  for (const id of dateBackfillProjectionIds(rows)) if (id === published.id) published.research!.communitySelectedAt = "2026-10-06T08:00:00.000Z";
  const refreshed = computeResearchHeat([published], now.toISOString());
  assert.equal(refreshed.qualifyingResearch, 1); assert.equal(refreshed.entries[0]!.sourceCount, 2);
  assert.equal(published.research!.originalPublishedAt, "2026-10-03T02:00:00.000Z", "refreshing a signal does not change the old publication date");
});

test("historical edition waits until the database release gate and polls in interruptible intervals", async () => {
  const start = now.getTime(), releaseAt = start + 180_000; let clock = start;
  const waits: number[] = [], controller = new AbortController();
  const result = await waitDateBackfillRelease({ signal: controller.signal, now: () => clock,
    read: async () => ({ at: new Date(clock).toISOString(), pending: clock < releaseAt ? [{ articleId: "last-selected", visibleAfter: new Date(releaseAt).toISOString() }] : [] }),
    wait: async ms => { waits.push(ms); clock += ms; },
  });
  assert.ok(clock >= releaseAt); assert.equal(result.waitedMs, 180_000); assert.equal(result.checks, 7);
  assert.equal(waits.length, 6); assert.ok(waits.every(ms => ms <= 30_000));
  const window = plan().windows[0]!; let current: DateBackfillReport | null = null;
  await ensureDateBackfillReport(window, { read: async () => current, persist: async () => {}, compose: async () => {
    assert.ok(clock >= releaseAt); current = { revision: 1, runId: window.runId, contentHash: "includes-last-released-paper" };
  } });
  assert.equal(window.report?.state, "saved");
});

test("unknown or distant release gates stop before a report checkpoint can become permanently saved", async () => {
  const window = plan().windows[0]!, controller = new AbortController();
  for (const visibleAfter of [null, "invalid", new Date(now.getTime() + 300_001).toISOString()]) {
    await assert.rejects(waitDateBackfillRelease({ signal: controller.signal, now: () => now.getTime(),
      read: async () => ({ at: now.toISOString(), pending: [{ articleId: "late-selected", visibleAfter }] }),
      wait: async () => { throw new Error("must stop without waiting or composing"); },
    }), /unknown release gate|exceeds the bounded wait/);
  }
  assert.equal(window.report, undefined); assert.equal(window.figureMetrics, undefined);
});

test("interrupting release wait preserves report state and a later resume can observe the open gate", async () => {
  const controller = new AbortController(), window = plan().windows[0]!;
  await assert.rejects(waitDateBackfillRelease({ signal: controller.signal, now: () => now.getTime(),
    read: async () => ({ at: now.toISOString(), pending: [{ articleId: "last-selected", visibleAfter: new Date(now.getTime() + 60_000).toISOString() }] }),
    wait: async (_ms, signal) => { controller.abort(); signal.throwIfAborted(); },
  }), error => error instanceof Error && error.name === "AbortError");
  assert.equal(window.report, undefined);
  const resumed = await waitDateBackfillRelease({ signal: new AbortController().signal, now: () => now.getTime() + 70_000,
    read: async () => ({ at: new Date(now.getTime() + 70_000).toISOString(), pending: [] }),
    wait: async () => { throw new Error("already released"); },
  });
  assert.equal(resumed.checks, 1); assert.equal(resumed.waitedMs, 0);
});

test("release waits cannot be prolonged indefinitely by a changing selected set", async () => {
  let clock = now.getTime(), waits = 0;
  await assert.rejects(waitDateBackfillRelease({ signal: new AbortController().signal, now: () => clock,
    read: async () => ({ at: new Date(clock).toISOString(), pending: [{ articleId: "moving-release", visibleAfter: new Date(clock + 45_000).toISOString() }] }),
    wait: async ms => { waits++; clock += ms; },
  }, 60_000), /bounded wait/);
  assert.equal(waits, 1);
});

test("report commit records the previous revision first and binds the new run exactly once", async () => {
  const window = plan().windows[0]!;
  let current: DateBackfillReport | null = { revision: 4, runId: "old-run", contentHash: "old-content" }, compositions = 0;
  const states: unknown[] = [];
  const io = { read: async () => current, persist: async () => { states.push(structuredClone(window.report)); }, compose: async () => {
    assert.equal(window.report?.state, "prepared"); assert.equal(window.report?.expectedRevision, 4);
    assert.equal(states.length, 1, "prepare is durably saved before report mutation");
    compositions++; current = { revision: 5, runId: window.runId, contentHash: "new-content" };
  } };
  assert.equal(await ensureDateBackfillReport(window, io), "saved");
  assert.equal(window.report?.saved?.revision, 5);
  assert.equal(await ensureDateBackfillReport(window, io), "reused");
  assert.equal(compositions, 1);
});

test("report recovery recognizes a database commit after a crash and does not compose again", async () => {
  const window = plan().windows[0]!;
  let current: DateBackfillReport | null = null, compositions = 0;
  const io = { read: async () => current, persist: async () => {}, compose: async () => {
    compositions++; current = { revision: 1, runId: window.runId, contentHash: "saved-before-crash" }; throw new Error("simulated process loss after commit");
  } };
  await assert.rejects(ensureDateBackfillReport(window, io), /process loss/);
  assert.equal(window.report?.state, "prepared");
  assert.equal(await ensureDateBackfillReport(window, io), "reused");
  assert.equal(window.report?.state, "saved"); assert.equal(compositions, 1);
});

test("a source-run finalization crash is repaired from a saved report without rewriting that report", async () => {
  const window = plan().windows[0]!;
  let current: DateBackfillReport | null = null, compositions = 0, finalizations = 0, sourceRunFinished = false;
  const io = { read: async () => current, persist: async () => {}, compose: async () => {
    compositions++; current = { revision: 1, runId: window.runId, contentHash: "committed" };
  }, finish: async () => {
    if (++finalizations === 1) throw new Error("source-run update interrupted");
    sourceRunFinished = true;
  } };
  await assert.rejects(ensureDateBackfillReport(window, io), /update interrupted/);
  assert.equal(window.report?.state, "saved"); assert.equal(sourceRunFinished, false);
  assert.equal(await ensureDateBackfillReport(window, io), "reused");
  assert.equal(sourceRunFinished, true); assert.equal(compositions, 1); assert.equal(finalizations, 2);
});

test("concurrent report changes, missing prepare and wrong run bindings fail without a second revision", async () => {
  const window = plan().windows[0]!;
  window.report = { state: "prepared", expectedRevision: 2, previousHash: "prior" };
  let calls = 0;
  await assert.rejects(ensureDateBackfillReport(window, { read: async () => ({ revision: 3, runId: "unrelated", contentHash: "changed" }),
    persist: async () => {}, compose: async () => { calls++; } }), /concurrent revision/);
  assert.equal(calls, 0);
  delete window.report;
  await assert.rejects(ensureDateBackfillReport(window, { read: async () => ({ revision: 3, runId: window.runId, contentHash: "changed" }),
    persist: async () => {}, compose: async () => { calls++; } }), /without its prepare/);
  assert.equal(calls, 0);
  let current: DateBackfillReport | null = null;
  await assert.rejects(ensureDateBackfillReport(window, { read: async () => current, persist: async () => {},
    compose: async () => { current = { revision: 1, runId: "old-run", contentHash: "wrong" }; } }), /exact new run/);
});

test("saved report verification detects later replacement even if its new content reuses the run id", async () => {
  const window = plan().windows[0]!;
  window.report = { state: "saved", expectedRevision: 0, previousHash: null, saved: { revision: 1, runId: window.runId, contentHash: "saved" } };
  await assert.rejects(ensureDateBackfillReport(window, { read: async () => ({ revision: 2, runId: window.runId, contentHash: "edited" }),
    persist: async () => {}, compose: async () => { throw new Error("must never compose"); } }), /changed after its checkpoint/);
});

test("default status opens neither a database nor network and creates no state directory", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "date-backfill-readonly-"));
  try {
    const marker = path.join(temporary, "retain-me.txt"); await writeFile(marker, "preserved");
    const result = spawnSync(process.execPath, ["scripts/research-date-backfill.ts"], {
      cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 15000,
      env: { ...process.env, AIHOT_DATA_DIR: temporary, DATABASE_URL: "postgres://127.0.0.1:1/unavailable",
        COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false", FEISHU_CONTENT_PUSH_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false" },
    });
    assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.equal(value.state, "not-started"); assert.equal(value.dates.length, DATE_BACKFILL_DATES.length);
    assert.equal(value.maxCalls, 1800); assert.match(value.note, /no database/);
    assert.deepEqual(await readdir(temporary), ["retain-me.txt"]); assert.equal(await readFile(marker, "utf8"), "preserved");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
