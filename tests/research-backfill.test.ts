import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { backfillOptions, backfillInvocationCeiling, newBackfillPlan, validateBackfillPlan, findBackfillPlan, backfillOrder, backfillReaderDate, auditBackfillQueue,
  repairBackfillQueue, assertBackfillQueueAudited, visitBackfillArticle, backfillCursorRecovery, withBackfillBatchLock,
  type BackfillCandidate, type BackfillDatedCandidate, type BackfillBriefCheckpoint } from "../scripts/research-backfill.ts";
import { saveJson } from "../scripts/daily-delivery/core.ts";

const now = new Date("2026-10-08T08:00:00+08:00");
const plan = () => newBackfillPlan("2026-09", 140, 70, now);

test("historical CLI requires explicit bounded allowance and distinguishes collect from process", () => {
  assert.deepEqual(backfillOptions(["--month=2026-09", "--calls=140"]), { month: "2026-09", calls: 140, mode: "all" });
  assert.equal(backfillOptions(["--month=2026-09", "--calls=140", "--collect-only"]).mode, "collect");
  assert.equal(backfillOptions(["--month=2026-09", "--calls=140", "--process-only"]).mode, "process");
  assert.equal(backfillOptions(["--month=2026-09", "--calls=140", "--repair-queue"]).mode, "repair");
  for (const args of [[], ["--month=2026-09"], ["--month=2026-13", "--calls=140"], ["--month=2026-09", "--calls=291"],
    ["--month=2026-09", "--calls=0"], ["--month=2026-09", "--calls=1.5"], ["--month=2026-09", "--calls=140", "--collect-only", "--process-only"],
    ["--month=2026-09", "--calls=140", "--calls=140"], ["--month=2026-09", "--calls=140", "--repair-queue", "--process-only"]]) assert.throws(() => backfillOptions(args));
});

test("a lower invocation stop is explicit, bounded and available only for process-only", () => {
  const args = ["--month=2026-09", "--calls=140"];
  assert.deepEqual(backfillOptions([...args, "--process-only", "--stop-at-calls=40"]), { month: "2026-09", calls: 140, mode: "process", stopAtCalls: 40 });
  for (const extra of [["--stop-at-calls=40"], ["--collect-only", "--stop-at-calls=40"], ["--repair-queue", "--stop-at-calls=40"],
    ["--process-only", "--stop-at-calls=0"], ["--process-only", "--stop-at-calls=291"], ["--process-only", "--stop-at-calls=1.5"],
    ["--process-only", "--stop-at-calls=40", "--stop-at-calls=40"]]) assert.throws(() => backfillOptions([...args, ...extra]));
});

test("invocation stop neither enlarges the frozen allowance nor resets calls already used", () => {
  const value = newBackfillPlan("2026-09", 140, 0, now), frozen = structuredClone(value);
  assert.equal(backfillInvocationCeiling(value, 0, 40), 40);
  assert.equal(backfillInvocationCeiling(value, 40, 40), 40, "equal current usage grants no new headroom");
  assert.equal(backfillInvocationCeiling(value, 40, 60), 60, "a later invocation can use only remaining frozen headroom");
  assert.equal(backfillInvocationCeiling(value, 40), 140);
  assert.throws(() => backfillInvocationCeiling(value, 41, 40), /current shared calls/);
  assert.throws(() => backfillInvocationCeiling(value, 0, 141), /frozen plan ceiling/);
  assert.deepEqual(value, frozen, "requestedCalls, startCalls, ceiling, budget identity and checkpoint stay untouched");
});

test("month is split into four exact nonoverlapping Beijing windows including its last day", () => {
  const value = plan();
  assert.equal(value.budgetId, "daily-2026-10-08");
  assert.equal(value.callCeiling, 210);
  assert.equal(value.windows.length, 4);
  assert.equal(value.windows[0]!.start, "2026-08-31T16:00:00.000Z");
  assert.equal(value.windows[0]!.end, "2026-09-07T16:00:00.000Z");
  assert.equal(value.windows[3]!.start, "2026-09-21T16:00:00.000Z");
  assert.equal(value.windows[3]!.end, "2026-09-30T16:00:00.000Z");
  for (let i = 1; i < 4; i++) assert.equal(value.windows[i]!.start, value.windows[i - 1]!.end);
  assert.equal(new Set(value.windows.map(window => window.runId)).size, 4);
  assert.deepEqual(plan(), value, "same explicit plan has stable historical run identities");
  assert.equal(newBackfillPlan("2024-02", 140, 0, now).windows[3]!.end, "2024-02-29T16:00:00.000Z");
  assert.equal(newBackfillPlan("2025-02", 140, 0, now).windows[3]!.end, "2025-02-28T16:00:00.000Z");
  assert.throws(() => newBackfillPlan("2026-10", 140, 0, now), /closed/);
});

test("plan limits are cumulative shared calls and never allocate another per-window budget", () => {
  assert.equal(newBackfillPlan("2026-09", 140, 240, now).callCeiling, 290);
  assert.equal(newBackfillPlan("2026-09", 140, 320, now).callCeiling, 290, "a previously exhausted morning allowance grants zero new headroom");
  const value = plan();
  assert.deepEqual(validateBackfillPlan(value, "2026-09", 140), value);
  assert.throws(() => validateBackfillPlan({ ...value, callCeiling: 290 }, "2026-09", 140), /frozen/);
  assert.throws(() => validateBackfillPlan(value, "2026-09", 200), /reset or enlarged/);
  assert.throws(() => validateBackfillPlan({ ...value, budgetId: "daily-2026-10-09" }, "2026-09", 140), /frozen/);
  const changed = structuredClone(value); changed.windows[0]!.end = changed.windows[1]!.end;
  assert.throws(() => validateBackfillPlan(changed, "2026-09", 140), /windows changed/);
});

const sources = ["research-arxiv-ml-ai", "research-arxiv-physical-science", "research-arxiv-molecular", "rss-bair"];
function candidate(week: number, group: number, index: number): BackfillCandidate {
  return { week, runId: `history-week-${week}`, sourceId: sources[group]!, articleId: `${week}:${group}:${index}`,
    canonicalKey: `${week}:${group}:${index}`, sortDate: index === 0 ? "2026-09-05" : "2026-09-04" };
}

test("processing alternates all four weeks and then all four source groups, newest within each group", () => {
  const rows = [1, 2, 3, 4].flatMap(week => [0, 1, 2, 3].flatMap(group => [candidate(week, group, 1), candidate(week, group, 0)]));
  const ordered = backfillOrder(rows);
  assert.deepEqual(ordered.slice(0, 4).map(row => row.articleId), ["1:0:0", "2:0:0", "3:0:0", "4:0:0"]);
  assert.deepEqual(ordered.slice(4, 8).map(row => row.articleId), ["1:1:0", "2:1:0", "3:1:0", "4:1:0"]);
  assert.deepEqual(ordered.slice(12, 16).map(row => row.articleId), ["1:3:0", "2:3:0", "3:3:0", "4:3:0"]);
  assert.deepEqual(ordered.slice(16, 20).map(row => row.articleId), ["1:0:1", "2:0:1", "3:0:1", "4:0:1"]);
  assert.deepEqual(backfillOrder([...rows].reverse()), ordered);
});

test("empty source groups or weeks do not block others, and duplicate research is not reviewed twice", () => {
  const rows = [candidate(1, 0, 0), candidate(1, 0, 1), candidate(4, 3, 0),
    { ...candidate(2, 2, 0), canonicalKey: "1:0:0" }];
  const ordered = backfillOrder(rows);
  assert.deepEqual(ordered.map(row => row.articleId), ["1:0:0", "4:3:0", "1:0:1"]);
  assert.deepEqual(backfillOrder([]), []);
  assert.throws(() => backfillOrder([{ ...candidate(1, 0, 0), sourceId: "huggingface-signal" }]), /Unexpected/);
});

function dated(week: number, id: string, announcedOn: string | null, originalPublishedAt = "2026-09-05T08:00:00.000Z"): BackfillDatedCandidate {
  return { ...candidate(week, 0, 0), articleId: id, canonicalKey: `arxiv:${id}`, runId: plan().windows[week - 1]!.runId,
    arxivId: id, announcedOn, originalPublishedAt };
}

test("historical queue excludes October announcements even when original and arrival dates are September", () => {
  const future = { ...dated(1, "2610.02214", "2026-10-05"), observedAt: "2026-09-05T08:00:00.000Z" };
  const { queue, queueAudit } = auditBackfillQueue([future, dated(1, "2609.01000", "2026-09-07")], plan().windows, now);
  assert.deepEqual(queue.map(row => [row.articleId, row.sortDate]), [["2609.01000", "2026-09-07"]]);
  assert.equal(queueAudit.admittedRows, 2, "raw admission denominator remains recorded");
  assert.equal(queueAudit.excluded.length, 1);
  assert.equal(queueAudit.excluded[0]!.readerDate, "2026-10-05");
  assert.equal(queueAudit.excluded[0]!.reason, "outside-window");
  assert.equal(future.originalPublishedAt, "2026-09-05T08:00:00.000Z");
});

test("reader dates prefer valid arXiv announcements and otherwise use original publication in Beijing", () => {
  assert.equal(backfillReaderDate(dated(1, "2609.1", "2026-09-07", "2026-10-01T00:00:00Z")), "2026-09-07");
  assert.equal(backfillReaderDate(dated(1, "2609.1", "2026-02-30", "2026-09-07T16:00:00Z")), "2026-09-08");
  assert.equal(backfillReaderDate({ ...dated(1, "2609.1", "2026-10-05"), arxivId: null }), "2026-09-05", "a blog cannot acquire an arXiv announcement date");
  assert.equal(backfillReaderDate({ ...dated(1, "2609.1", null), originalPublishedAt: null }), null);
  assert.equal(backfillReaderDate(dated(1, "2609.1", null, "2026-02-30T00:00:00Z")), null);
  assert.equal(backfillReaderDate(dated(1, "2609.1", null, "2026-09-07T16:00:00")), null, "timezone-free source timestamps are ambiguous");
  const rows = [dated(1, "start", null, "2026-08-31T16:00:00Z"), dated(1, "end", null, "2026-09-07T16:00:00Z"),
    dated(2, "next-start", null, "2026-09-07T16:00:00Z"), { ...dated(4, "missing", null), originalPublishedAt: null }];
  const { queue, queueAudit } = auditBackfillQueue(rows, plan().windows, now);
  assert.deepEqual(queue.map(row => row.articleId), ["start", "next-start"]);
  assert.deepEqual(queueAudit.excluded.map(row => row.reason), ["outside-window", "missing-reader-date"]);
});

test("legacy queue cannot process until explicit audited repair, and started plans cannot reset", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "algorithmhot-backfill-repair-"));
  try {
    const value = plan(), file = path.join(dir, "plan.json");
    value.windows.forEach(window => { window.collected = true; window.frozen = true; });
    value.status = "collected";
    value.queue = [{ ...candidate(1, 0, 0), runId: value.windows[0]!.runId, sortDate: "2026-10-05" }];
    await saveJson(file, value);
    const original = await readFile(file, "utf8"), rows = [dated(1, "outside", "2026-10-05"), dated(1, "inside", "2026-09-07")];
    assert.throws(() => assertBackfillQueueAudited(value), /lacks the reader-date audit/);
    await assert.rejects(repairBackfillQueue(file, { ...value, cursor: 1 }, rows, 0, now), /cursor=0/);
    await assert.rejects(repairBackfillQueue(file, value, rows, 1, now), /no model attempts/);
    assert.equal(await readFile(file, "utf8"), original, "rejected repairs preserve the original file");
    const repaired = await repairBackfillQueue(file, value, rows, 0, now);
    assertBackfillQueueAudited(repaired);
    assert.equal(repaired.queue![0]!.articleId, "inside");
    assert.equal(repaired.queueAudit!.admittedRows, 2);
    assert.equal(repaired.queueAudit!.previousQueueRows, 1);
    assert.equal(repaired.queueAudit!.originalPlan!.sha256, createHash("sha256").update(original).digest("hex"));
    assert.equal(await readFile(path.join(dir, repaired.queueAudit!.originalPlan!.file), "utf8"), original);
    for (const key of ["budgetId", "budgetDate", "requestedCalls", "startCalls", "callCeiling", "createdAt", "windows", "cursor"] as const) assert.deepEqual(repaired[key], value[key], `${key} stays frozen`);
    assert.equal(value.queue![0]!.sortDate, "2026-10-05", "repair does not mutate the supplied legacy object");
    await assert.rejects(repairBackfillQueue(file, repaired, rows, 0, now), /unaudited/);
    const tampered = structuredClone(repaired); tampered.queue![0]!.sortDate = "2026-10-05";
    assert.throws(() => assertBackfillQueueAudited(tampered), /outside its frozen window/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a normal executor return after mainflow exhausts the budget keeps the article unfinished", async () => {
  let used = 39, state = "pending", briefs = 0;
  const outcome = await visitBackfillArticle(async hasBudget => {
    if (!await hasBudget()) return;
    used++; state = "pass";
    if (!await hasBudget()) return; // The shared executor's normal early return, not an exception.
    briefs++;
  }, async () => used < 40, () => false);
  assert.equal(outcome, "budget-stopped");
  assert.equal(state, "pass");
  assert.equal(used, 40);
  assert.equal(briefs, 0);
});

test("completed last-call briefs and held outcomes advance while thrown budget stops remain pending", async () => {
  let used = 39, briefs = 0;
  assert.equal(await visitBackfillArticle(async hasBudget => {
    if (!await hasBudget()) return;
    briefs++; used++; // Successful brief consumed the final allowed call.
  }, async () => used < 40, () => false), "visited");
  assert.equal(briefs, 1);
  assert.equal(await visitBackfillArticle(async () => {}, async () => false, () => false), "visited", "held/terminal executor rows do not ask for another model call");
  const exhausted = new Error("test budget exhausted");
  assert.equal(await visitBackfillArticle(async () => { throw exhausted; }, async () => true, error => error === exhausted), "budget-stopped");
  await assert.rejects(visitBackfillArticle(async () => { throw new Error("unexpected failure"); }, async () => true, () => false), /unexpected failure/);
});

test("legacy cursor11 recovers its last pass without a committed brief, preserving all other checkpoint fields", async () => {
  const value = plan(); value.queue = Array.from({ length: 15 }, (_, index) => candidate(1, 0, index)); value.cursor = 11;
  const frozen = structuredClone(value), complete: BackfillBriefCheckpoint = { state: "pass", error: null, briefEligible: true, hasCurrentBrief: true, held: false };
  const recovery = await backfillCursorRecovery(value, async entry => ({ ...complete, hasCurrentBrief: entry.articleId !== value.queue![10]!.articleId }), now);
  assert.deepEqual(recovery, { checkedAt: now.toISOString(), from: 11, to: 10, inspected: 11, articleIds: [value.queue[10]!.articleId] });
  assert.deepEqual(value, frozen, "finding a repair does not mutate the plan or its frozen queue and allowance");
  assert.equal(await backfillCursorRecovery(value, async () => complete, now), null);
});

test("bounded recovery excludes failed, UNKNOWN, held, ineligible and error-marked articles", async () => {
  const value = plan(); value.queue = Array.from({ length: 45 }, (_, index) => candidate(1, 0, index)); value.cursor = 40;
  const inspected: string[] = [], missing: BackfillBriefCheckpoint = { state: "pass", error: null, briefEligible: true, hasCurrentBrief: false, held: false };
  const states = new Map<number, BackfillBriefCheckpoint>([[8, { ...missing, state: "failed" }], [9, { ...missing, state: "unknown" }],
    [10, { ...missing, state: "unknown-receipt" }], [11, { ...missing, held: true }], [12, { ...missing, error: "held-request: status=unknown" }],
    [13, { ...missing, briefEligible: false }], [15, missing]]);
  const recovery = await backfillCursorRecovery(value, async entry => {
    inspected.push(entry.articleId);
    return states.get(Number(entry.articleId.split(":").at(-1))) ?? { ...missing, hasCurrentBrief: true };
  }, now);
  assert.equal(inspected.length, 32);
  assert.equal(inspected[0], value.queue[8]!.articleId);
  assert.equal(inspected.at(-1), value.queue[39]!.articleId);
  assert.equal(recovery?.to, 15);
  assert.deepEqual(recovery?.articleIds, [value.queue[15]!.articleId]);
  assert.equal(value.cursor, 40);
});

test("a frozen monthly plan is reused across days rather than granting a fresh allowance", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "algorithmhot-backfill-plan-"));
  try {
    assert.equal(await findBackfillPlan(dir, "2026-09", 140), null);
    const value = plan(), directory = path.join(dir, "2026-09-2026-10-08"), file = path.join(directory, "plan.json");
    await mkdir(directory); await saveJson(file, value);
    const resumed = await findBackfillPlan(dir, "2026-09", 140);
    assert.equal(resumed?.file, file);
    assert.deepEqual(resumed?.plan, value);
    await assert.rejects(findBackfillPlan(dir, "2026-09", 141), /reset or enlarged/);
    await mkdir(path.join(dir, "2026-09-2026-10-09"));
    await assert.rejects(findBackfillPlan(dir, "2026-09", 140), /Multiple historical plans/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("backfill retains active batch locks and removes only its own lock after success or failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "algorithmhot-backfill-lock-"));
  try {
    await withBackfillBatchLock(dir, async () => {
      const owner = JSON.parse(await readFile(path.join(dir, "batch.lock/owner.json"), "utf8"));
      assert.equal(owner.pid, process.pid);
      await assert.rejects(withBackfillBatchLock(dir, async () => {}, "fixture"), /lock exists/);
      assert.deepEqual(JSON.parse(await readFile(path.join(dir, "batch.lock/owner.json"), "utf8")), owner);
    }, "fixture");
    await assert.rejects(withBackfillBatchLock(dir, async () => { throw new Error("fixture stopped"); }, "fixture"), /fixture stopped/);
    await withBackfillBatchLock(dir, async () => {}, "fixture");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
