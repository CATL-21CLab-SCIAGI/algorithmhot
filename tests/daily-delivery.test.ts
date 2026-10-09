import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deliverDaily, deliveryDate, dueDaily, currentRefreshSlot, currentReviewSlot, validateRefreshSlot, readReceipt, recoverDeliveryLock, withDeliveryLock, DeliveryInterruptedError, type DailyInspection, type DeliveryDependencies, type Stage } from "../scripts/daily-delivery/core.ts";
import { publicDestination, safeSiteOrigin } from "../scripts/daily-delivery.ts";

const now = new Date("2026-10-04T01:00:00Z");
const options = { now, siteBase: "https://pkucy2016.github.io/algorithmhot/", repo: "PKUCY2016/algorithmhot" };
const complete: DailyInspection = { executionBusy: false, pendingRequests: 0, unknownRequests: 0, callsUsed: 20, report: { status: "complete", published: 3, gaps: 0, revision: 1 } };
async function harness(fn: (stateDir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "algorithmhot-delivery-test-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
function dependencies(stateDir: string) {
  const executed: Stage[] = [];
  let generated = false;
  const deps = {
    stateDir, now: () => now, assertIdle: async () => {}, log: () => {},
    inspect: async (): Promise<DailyInspection> => ({ ...complete, report: generated ? complete.report : null }),
    execute: async (stage: Stage) => { executed.push(stage); if (stage === "generate") generated = true; },
  };
  return { executed, deps };
}

test("daily delivery uses the last closed Beijing 09:00 window and validates explicit dates", () => {
  assert.equal(dueDaily(new Date("2026-10-03T23:59:59.999Z")), "2026-10-03");
  assert.equal(dueDaily(now), "2026-10-04");
  assert.equal(dueDaily(new Date("2026-10-04T23:59:59Z")), "2026-10-04");
  assert.equal(dueDaily(new Date("2027-01-01T00:00:00Z")), "2026-12-31");
  assert.throws(() => deliveryDate("2026-10-05", now), /has not closed/);
  assert.throws(() => deliveryDate("2026-02-30", now), /Invalid/);
});

test("twice-daily reviews use 09:00 and 21:00 without replaying yesterday before 09:00", () => {
  for (const [local, expected] of [["08:59:59", null], ["09:00:00", "09"], ["20:59:59", "09"], ["21:00:00", "21"], ["23:59:59", "21"]] as const) {
    assert.equal(currentReviewSlot(new Date(`2026-10-08T${local}+08:00`), "twice-daily"), expected && `2026-10-08-${expected}`);
  }
  assert.equal(currentReviewSlot(new Date("2026-10-09T00:00:00+08:00")), null);
});

test("current schedule includes the afternoon boundary without creating missed slots", () => {
  for (const [local, expected] of [["08:59:59", null], ["09:00:00", "09"], ["14:59:59", "09"], ["15:00:00", "15"], ["20:59:59", "15"], ["21:00:00", "21"]] as const) {
    assert.equal(currentReviewSlot(new Date(`2026-10-09T${local}+08:00`)), expected && `2026-10-09-${expected}`);
  }
});

test("afternoon delivery freezes its window and policy while keeping an earlier morning receipt", async () => harness(async dir => {
  const morning = dependencies(dir);
  const morningOptions = { ...options, now: new Date("2026-10-09T10:00:00+08:00"), refreshSlot: "2026-10-09-09", reviewPolicy: "twice-daily" as const };
  await deliverDaily(morningOptions, { ...morning.deps, prepareEditions: async () => {} });
  const before = await readReceipt(dir, morningOptions.refreshSlot);
  const afternoon = dependencies(dir);
  let editions = 0;
  const requested = { ...options, now: new Date("2026-10-09T16:00:00+08:00"), refreshSlot: "2026-10-09-15", reviewPolicy: "three-times-daily" as const };
  const deps = { ...afternoon.deps, prepareEditions: async () => { editions++; } };
  const result = await deliverDaily(requested, deps);
  assert.equal(result.reviewPolicy, "three-times-daily");
  assert.equal(result.runId, "refresh-2026-10-09-15");
  assert.equal(result.windowStart, "2026-10-08T01:00:00.000Z");
  assert.equal(result.windowEnd, "2026-10-09T01:00:00.000Z");
  assert.equal(result.collectionCutoff, "2026-10-09T08:00:00.000Z");
  assert.equal(editions, 1);
  assert.deepEqual(afternoon.executed, ["database", "readers", "generate", "export", "publish", "verify"]);
  await deliverDaily(requested, deps);
  assert.equal(afternoon.executed.length, 6);
  assert.deepEqual(await readReceipt(dir, morningOptions.refreshSlot), before);
  const restored = await deliverDaily({ ...morningOptions, now: requested.now, reviewPolicy: "three-times-daily" }, deps);
  assert.deepEqual(restored, before, "existing two-review policy is not rewritten");
  await assert.rejects(deliverDaily({ ...requested, refreshSlot: "2026-10-08-15" }, deps), /current 09:00, 15:00 or 21:00/);
}));

test("new review freezes its policy and completes due editions before public stages", async () => harness(async dir => {
  const clock = new Date("2026-10-08T19:00:00+08:00"), { deps } = dependencies(dir);
  const calls: string[] = [];
  const original = deps.execute;
  const reviewDeps = { ...deps, execute: async (stage: Stage, _date: string, _end: string, policy?: "twice-daily" | "three-times-daily") => {
    calls.push(stage); assert.equal(policy, "twice-daily"); await original(stage);
  }, prepareEditions: async (date: string, end: string) => {
    calls.push("editions"); assert.equal(date, "2026-10-08-09"); assert.equal(end, "2026-10-08T01:00:00.000Z");
    await assert.rejects(withDeliveryLock(dir, async () => {}), /locked/, "editions retain the project delivery lock");
  } };
  const requested = { ...options, now: clock, refreshSlot: "2026-10-08-09", reviewPolicy: "twice-daily" as const };
  const result = await deliverDaily(requested, reviewDeps);
  assert.equal(result.reviewPolicy, "twice-daily");
  assert.equal(result.collectionCutoff, clock.toISOString());
  assert.equal(result.windowStart, "2026-10-07T01:00:00.000Z");
  assert.equal(result.windowEnd, "2026-10-08T01:00:00.000Z");
  assert.deepEqual(calls, ["database", "readers", "generate", "editions", "export", "publish", "verify"]);
  await deliverDaily(requested, reviewDeps);
  assert.equal(calls.length, 7);
  await assert.rejects(deliverDaily({ ...requested, refreshSlot: "2026-10-08-18" }, reviewDeps), /current 09:00 or 21:00/);
  await assert.rejects(deliverDaily({ ...requested, refreshSlot: "2026-10-07-21" }, reviewDeps), /current 09:00 or 21:00/);
}));

test("due-edition failure holds publication and resumes it without resending daily model work", async () => harness(async dir => {
  const clock = new Date("2026-10-08T21:00:00+08:00"), { deps, executed } = dependencies(dir);
  let editionCalls = 0;
  const reviewDeps = { ...deps, prepareEditions: async () => { if (++editionCalls === 1) throw new Error("Mock source figure failure"); } };
  const requested = { ...options, now: clock, refreshSlot: "2026-10-08-21", reviewPolicy: "twice-daily" as const };
  await assert.rejects(deliverDaily(requested, reviewDeps), /figure failure/);
  assert.equal(executed.includes("export"), false);
  assert.equal((await readReceipt(dir, requested.refreshSlot))!.stages.generate!.status, "failed");
  await deliverDaily({ ...requested, resume: true }, reviewDeps);
  assert.equal(editionCalls, 2);
  assert.equal(executed.filter(stage => stage === "generate").length, 1);
  assert.equal(executed.includes("publish"), true);
}));

test("legacy slot recovery preserves its original policy and does not require period generation", async () => harness(async dir => {
  const { deps } = dependencies(dir);
  const original = await deliverDaily({ ...options, refreshSlot: "2026-10-04-06" }, deps);
  const restored = await deliverDaily({ ...options, now: new Date("2026-10-08T22:00:00+08:00"), refreshSlot: original.date, reviewPolicy: "twice-daily" }, deps);
  assert.equal(restored.reviewPolicy, undefined);
  assert.equal(restored.windowEnd, original.windowEnd);
}));

test("delivery serializes six stages and repeats the verified day without generating or publishing again", async () => harness(async dir => {
  const { deps, executed } = dependencies(dir);
  const result = await deliverDaily(options, deps);
  assert.equal(result.runId, "daily-2026-10-04");
  assert.equal(result.windowStart, "2026-10-03T01:00:00.000Z");
  assert.equal(result.windowEnd, "2026-10-04T01:00:00.000Z");
  assert.equal(result.status, "complete");
  assert.deepEqual(executed, ["database", "readers", "generate", "export", "publish", "verify"]);
  await deliverDaily(options, deps);
  assert.equal(executed.length, 6);
}));

test("generation failure holds export and publish, retains same ID, and requires explicit recovery", async () => harness(async dir => {
  const { deps, executed } = dependencies(dir);
  const execute = deps.execute;
  deps.execute = async stage => { await execute(stage); if (stage === "generate") throw new Error("Mock provider failure"); };
  await assert.rejects(deliverDaily(options, deps), /Mock provider/);
  assert.deepEqual(executed, ["database", "readers", "generate"]);
  const receipt = await readReceipt(dir, "2026-10-04");
  assert.equal(receipt?.status, "failed");
  assert.equal(receipt?.stages.generate?.status, "failed");
  await assert.rejects(deliverDaily(options, deps), /--resume/);
  assert.equal(executed.length, 3);
  deps.execute = execute;
  await deliverDaily({ ...options, resume: true }, deps);
  assert.equal((await readReceipt(dir, "2026-10-04"))?.stages.generate?.reused, true);
  assert.equal(executed.filter(stage => stage === "generate").length, 1);
}));

test("publication failure resumes publication while successful generation and export remain untouched", async () => harness(async dir => {
  const { deps, executed } = dependencies(dir);
  const execute = deps.execute;
  deps.execute = async stage => { await execute(stage); if (stage === "publish") throw new Error("Mock publication failure"); };
  await assert.rejects(deliverDaily(options, deps), /publication failure/);
  deps.execute = execute;
  await deliverDaily({ ...options, resume: true }, deps);
  assert.equal(executed.filter(stage => stage === "generate").length, 1);
  assert.equal(executed.filter(stage => stage === "export").length, 1);
  assert.equal(executed.filter(stage => stage === "publish").length, 2);
  assert.equal((await readReceipt(dir, "2026-10-04"))?.stages.publish?.attempts, 2);
  assert.equal(executed.filter(stage => stage === "database").length, 1);
  assert.equal(executed.filter(stage => stage === "readers").length, 1);
}));

test("existing complete/partial reports are reused, preserving unknown and gap counts", async () => harness(async dir => {
  const { deps, executed } = dependencies(dir);
  deps.inspect = async () => ({ ...complete, unknownRequests: 2, report: { status: "partial", published: 7, gaps: 2, revision: 1 } });
  const result = await deliverDaily(options, deps);
  assert.equal(result.inspection?.report?.status, "partial");
  assert.equal(result.inspection?.unknownRequests, 2);
  assert.equal(result.inspection?.report?.published, 7);
  assert.equal(executed.includes("generate"), false);
  assert.equal(executed.includes("publish"), true);
}));

test("explicit public refresh re-exports and re-publishes but never reruns generation", async () => harness(async dir => {
  const { deps, executed } = dependencies(dir);
  await assert.rejects(deliverDaily({ ...options, refreshPublic: true }, deps), /completed generation/);
  await deliverDaily(options, deps);
  await deliverDaily({ ...options, refreshPublic: true }, deps);
  assert.equal(executed.filter(stage => stage === "generate").length, 1);
  assert.equal(executed.filter(stage => stage === "export").length, 2);
  assert.equal(executed.filter(stage => stage === "publish").length, 2);
}));

test("same-day and cross-day concurrent deliveries cannot share the mutable public export", async () => harness(async dir => {
  const { deps } = dependencies(dir);
  let release!: () => void;
  let entered!: () => void;
  const active = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  deps.assertIdle = async () => { entered(); await wait; };
  const first = deliverDaily(options, deps);
  await active;
  await assert.rejects(deliverDaily(options, deps), /locked/);
  await assert.rejects(deliverDaily({ ...options, date: "2026-10-03" }, deps), /locked/);
  release(); await first;
}));

test("pending or in-flight model requests prevent generation and publication", async () => harness(async dir => {
  const { deps, executed } = dependencies(dir);
  deps.inspect = async () => ({ ...complete, report: null, pendingRequests: 1 });
  await assert.rejects(deliverDaily(options, deps), /unresolved pending/);
  assert.deepEqual(executed, ["database", "readers"]);
  deps.inspect = async () => ({ ...complete, report: null, executionBusy: true });
  await assert.rejects(deliverDaily({ ...options, resume: true }, deps), /still running/);
  assert.equal(executed.includes("generate"), false);
}));

test("a successful command without a persisted report is not permission to publish", async () => harness(async dir => {
  const { deps, executed } = dependencies(dir);
  deps.inspect = async () => ({ ...complete, report: null });
  await assert.rejects(deliverDaily(options, deps), /without a persisted/);
  assert.equal(executed.includes("export"), false);
}));

test("stale delivery locks require explicit recovery and live owners retain their locks", async () => harness(async dir => {
  await writeFile(path.join(dir, "active.lock"), JSON.stringify({ pid: 12345, token: "dead-owner" }));
  await assert.rejects(withDeliveryLock(dir, async () => {}), /locked/);
  await assert.rejects(recoverDeliveryLock(dir, () => true), /still alive/);
  assert.equal(JSON.parse(await readFile(path.join(dir, "active.lock"), "utf8")).token, "dead-owner");
  await recoverDeliveryLock(dir, () => false);
  await withDeliveryLock(dir, async () => {});
}));

test("local origin and public destination reject credentials or unintended hosts", () => {
  assert.equal(safeSiteOrigin("http://127.0.0.1:3102"), "http://127.0.0.1:3102");
  assert.throws(() => safeSiteOrigin("https://example.com"));
  assert.throws(() => safeSiteOrigin("http://user:secret@localhost:3102"));
  assert.throws(() => safeSiteOrigin("http://127.0.0.1:3102/?secret=abc"));
  assert.equal(publicDestination(options.siteBase, options.repo), options.siteBase);
  assert.throws(() => publicDestination("https://other.github.io/algorithmhot/", options.repo));
  assert.throws(() => publicDestination(options.siteBase, "PKUCY2016/other"));
});

test("destination is frozen per daily receipt", async () => harness(async dir => {
  const { deps } = dependencies(dir);
  await deliverDaily(options, deps);
  await assert.rejects(deliverDaily({ ...options, repo: "other/algorithmhot" }, deps), /destination differs/);
}));


test("intraday slots freeze cutoff and reuse the same slot, while later slots ingest again", async () => harness(async dir => {
  const clock = new Date("2026-10-05T02:30:00Z");
  assert.equal(currentRefreshSlot(clock), "2026-10-05-09");
  assert.equal(currentRefreshSlot(new Date("2026-10-04T16:01:00Z")), "2026-10-05-00");
  assert.throws(() => validateRefreshSlot("2026-10-05-12", clock), /future/);
  const { deps, executed } = dependencies(dir);
  // Inspect each snapshot independently, just as the DB report identity does.
  const completed = new Set<string>();
  deps.inspect = async () => ({ ...complete, report: null });
  let active = "";
  const richer = { ...deps, now: () => clock,
    inspect: async (id: string) => { active = id; return { ...complete, report: completed.has(id) ? complete.report : null }; },
    execute: async (stage: Stage) => { executed.push(stage); if (stage === "generate") completed.add(active); },
  };
  const first = await deliverDaily({ ...options, now: clock, refreshSlot: currentRefreshSlot(clock) }, richer);
  assert.equal(first.runId, "refresh-2026-10-05-09");
  assert.equal(first.windowEnd, clock.toISOString());
  await deliverDaily({ ...options, now: new Date("2026-10-05T03:59:00Z"), refreshSlot: "2026-10-05-09" }, richer);
  assert.equal(executed.filter(s => s === "generate").length, 1);
  await deliverDaily({ ...options, now: new Date("2026-10-05T04:01:00Z"), refreshSlot: "2026-10-05-12" }, richer);
  assert.equal(executed.filter(s => s === "generate").length, 2);
}));

test("new snapshot isolates shared daily UNKNOWN and publishes confirmed partial results", async () => harness(async dir => {
  const { deps, executed } = dependencies(dir);
  deps.inspect = async () => ({ ...complete, unknownRequests: 1, callsUsed: executed.includes("generate") ? 25 : 20,
    report: executed.includes("generate") ? { status: "partial", published: 4, gaps: 1, revision: 1 } : null });
  const result = await deliverDaily({ ...options, refreshSlot: "2026-10-04-06" }, deps);
  assert.equal(executed.filter(stage => stage === "generate").length, 1);
  assert.equal(executed.includes("publish"), true);
  assert.equal(result.inspection?.unknownRequests, 1);
  assert.equal(result.inspection?.report?.status, "partial");
  assert.equal(result.inspection?.callsUsed, 25);
}));

test("UNKNOWN isolation never permits a simultaneous pending request", async () => harness(async dir => {
  const { deps, executed } = dependencies(dir);
  deps.inspect = async () => ({ ...complete, unknownRequests: 1, pendingRequests: 1, report: null });
  await assert.rejects(deliverDaily(options, deps), /unresolved pending/);
  assert.equal(executed.includes("generate"), false);
}));


test("explicit reconciliation has one stable receipt and never changes the shared date", async () => harness(async dir => {
  const clock = new Date("2026-10-05T03:00:00Z");
  assert.equal(validateRefreshSlot("2026-10-05-09-r1", clock), "2026-10-05-09-r1");
  assert.throws(() => validateRefreshSlot("2026-10-05-09-r2", clock), /Invalid/);
  const { deps, executed } = dependencies(dir);
  const optionsForSlot = { ...options, now: clock, refreshSlot: "2026-10-05-09-r1" };
  const receipt = await deliverDaily(optionsForSlot, deps);
  assert.equal(receipt.runId, "refresh-2026-10-05-09-r1");
  assert.equal((await readReceipt(dir, "2026-10-05-09-r1"))?.windowEnd, clock.toISOString());
  await deliverDaily(optionsForSlot, deps);
  assert.equal(executed.filter(stage => stage === "generate").length, 1);
}));

test("a legacy complete receipt gains only verification and then becomes reusable", async () => harness(async dir => {
  const { deps, executed } = dependencies(dir);
  const original = await deliverDaily(options, deps);
  delete original.stages.verify;
  delete original.publicRecoveryCount;
  await writeFile(path.join(dir, "2026-10-04.json"), JSON.stringify(original));
  executed.length = 0;
  const result = await deliverDaily({ ...options, autoRecoverPublic: true }, deps);
  assert.deepEqual(executed, ["verify"]);
  assert.equal(result.status, "complete");
  assert.equal(result.stages.verify?.status, "complete");
  assert.equal(result.publicRecoveryCount, 0);
  assert.deepEqual(result.inspection, original.inspection);
  await deliverDaily(options, deps);
  assert.deepEqual(executed, ["verify"]);
}));

test("verification failure cannot produce a complete delivery; manual recovery preserves the failure", async () => harness(async dir => {
  const { deps, executed } = dependencies(dir);
  const execute = deps.execute;
  deps.execute = async stage => { await execute(stage); if (stage === "verify") throw new Error("Mock public hash mismatch"); };
  await assert.rejects(deliverDaily(options, deps), /hash mismatch/);
  const failed = await readReceipt(dir, "2026-10-04");
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.stages.publish?.status, "complete");
  assert.equal(failed?.stages.verify?.status, "failed");
  executed.length = 0;
  deps.execute = execute;
  const result = await deliverDaily({ ...options, resume: true }, deps);
  assert.deepEqual(executed, ["verify"]);
  assert.equal(result.status, "complete");
  assert.equal(result.publicRecoveryCount, 1);
  assert.equal(result.publicRecoveries?.[0]?.mode, "manual");
  assert.deepEqual(result.publicRecoveries?.[0]?.priorStage, failed?.stages.verify);
}));

for (const failingStage of ["export", "publish", "verify"] as const) {
  test(`automatic ${failingStage} recovery is claimed once before execution without restarting earlier stages`, async () => harness(async dir => {
    const { deps, executed } = dependencies(dir);
    const execute = deps.execute;
    let failed = false;
    deps.execute = async stage => {
      await execute(stage);
      if (stage !== failingStage) return;
      if (!failed) { failed = true; throw new Error("Mock transient public failure"); }
      const during = await readReceipt(dir, "2026-10-04");
      assert.equal(during?.status, "running");
      assert.equal(during?.publicRecoveryCount, 1);
      assert.equal(during?.publicRecoveries?.[0]?.stage, failingStage);
      assert.equal(during?.publicRecoveries?.[0]?.priorStage?.status, "failed");
      assert.equal(during?.publicRecoveries?.[0]?.priorStage?.attempts, 1);
    };
    const result = await deliverDaily({ ...options, autoRecoverPublic: true }, deps);
    assert.equal(result.status, "complete");
    assert.equal(result.publicRecoveries?.length, 1);
    assert.equal(result.publicRecoveries?.[0]?.mode, "automatic");
    assert.equal(result.publicRecoveryCount, 1);
    assert.equal(executed.filter(stage => stage === failingStage).length, 2);
    for (const stage of ["database", "readers", "generate"] as const) assert.equal(executed.filter(entry => entry === stage).length, 1);
    assert.equal(result.inspection?.callsUsed, complete.callsUsed);
    assert.equal(result.windowEnd, options.now.toISOString());
  }));
}

test("a later invocation recovers the original public checkpoint and cutoff, not a fresh generation", async () => harness(async dir => {
  const { deps, executed } = dependencies(dir);
  const execute = deps.execute;
  deps.execute = async stage => { await execute(stage); if (stage === "publish") throw new Error("Mock interrupted publish"); };
  const slotOptions = { ...options, refreshSlot: "2026-10-04-06" };
  await assert.rejects(deliverDaily(slotOptions, deps), /interrupted/);
  const receipt = (await readReceipt(dir, slotOptions.refreshSlot))!;
  receipt.status = "running";
  receipt.stages.publish!.status = "running";
  delete receipt.stages.publish!.endedAt;
  delete receipt.stages.publish!.error;
  await writeFile(path.join(dir, `${slotOptions.refreshSlot}.json`), JSON.stringify(receipt));
  deps.execute = execute;
  executed.length = 0;
  const result = await deliverDaily({ ...slotOptions, now: new Date("2026-10-04T00:30:00Z"), autoRecoverPublic: true }, deps);
  assert.deepEqual(executed, ["publish", "verify"]);
  assert.equal(result.runId, receipt.runId);
  assert.equal(result.windowEnd, receipt.windowEnd);
  assert.equal(result.publicRecoveries?.[0]?.priorStage?.status, "running");
}));

test("public retries keep the same receipt across stages and back off instead of busy looping", async () => harness(async dir => {
  const { deps, executed } = dependencies(dir);
  const execute = deps.execute;
  let exportFailed = false;
  deps.execute = async stage => {
    await execute(stage);
    if (stage === "export" && !exportFailed) { exportFailed = true; throw new Error("Mock export failure"); }
    if (stage === "publish") throw new Error("Mock persistent publish failure");
  };
  await assert.rejects(deliverDaily({ ...options, autoRecoverPublic: true }, deps), /persistent publish/);
  const failed = await readReceipt(dir, "2026-10-04");
  assert.equal(failed?.publicRecoveryCount, 1);
  assert.equal(failed?.publicRecoveries?.[0]?.stage, "export");
  assert.equal(failed?.publicRecoveries?.[0]?.priorStage?.status, "failed");
  const attempts = executed.length;
  await assert.rejects(deliverDaily({ ...options, autoRecoverPublic: true }, deps), /backoff/);
  assert.equal(executed.length, attempts);
  const held = await readReceipt(dir, "2026-10-04");
  assert.equal(held?.publicNextRetryAt !== undefined, true);
  assert.equal(held?.publicRetryStage, "publish");
  // An explicit operator resume may continue immediately; it still uses the same receipt.
  await assert.rejects(deliverDaily({ ...options, resume: true }, deps), /persistent publish/);
  assert.equal((await readReceipt(dir, "2026-10-04"))?.publicRecoveryCount, 2);
  assert.equal(executed.includes("verify"), false);
}));

test("the next invocation resumes an eligible backoff without regenerating the report", async () => harness(async dir => {
  let clock = now;
  const { deps, executed } = dependencies(dir);
  deps.now = () => clock;
  const execute = deps.execute;
  let failures = 2;
  deps.execute = async stage => { await execute(stage); if (stage === "publish" && failures-- > 0) throw new Error("temporary remote outage"); };
  await assert.rejects(deliverDaily({ ...options, autoRecoverPublic: true }, deps), /temporary remote outage/);
  const held = (await readReceipt(dir, "2026-10-04"))!;
  assert.ok(held.publicNextRetryAt);
  clock = new Date(held.publicNextRetryAt!);
  const result = await deliverDaily({ ...options, autoRecoverPublic: true }, deps);
  assert.equal(result.status, "complete");
  assert.equal(executed.filter(stage => stage === "generate").length, 1);
  assert.equal(result.publicRecoveryCount, 2);
}));

test("manual public recovery can continue after a transient public failure", async () => harness(async dir => {
  const { deps, executed } = dependencies(dir);
  const execute = deps.execute;
  deps.execute = async stage => { await execute(stage); if (stage === "export") throw new Error("Mock export still broken"); };
  await assert.rejects(deliverDaily(options, deps), /still broken/);
  await assert.rejects(deliverDaily({ ...options, resume: true, autoRecoverPublic: true }, deps), /still broken/);
  assert.equal(executed.filter(stage => stage === "export").length, 2);
  const failed = await readReceipt(dir, "2026-10-04");
  assert.equal(failed?.publicRecoveries?.[0]?.mode, "manual");
  await assert.rejects(deliverDaily({ ...options, autoRecoverPublic: true }, deps), /backoff/);
  assert.equal(executed.filter(stage => stage === "export").length, 2);
}));

test("public refresh preserves the receipt while allowing another recovery", async () => harness(async dir => {
  const { deps, executed } = dependencies(dir);
  const execute = deps.execute;
  let fail = true;
  deps.execute = async stage => {
    await execute(stage);
    if (stage === "export" && fail) { fail = false; throw new Error("Mock export failure"); }
  };
  const recovered = await deliverDaily({ ...options, autoRecoverPublic: true }, deps);
  fail = true;
  executed.length = 0;
  await assert.rejects(deliverDaily({ ...options, refreshPublic: true, autoRecoverPublic: true }, deps), /export failure/);
  assert.deepEqual(executed, ["export"]);
  const failed = await readReceipt(dir, "2026-10-04");
  assert.equal(failed?.publicRecoveryCount, 1);
  assert.deepEqual(failed?.publicRecoveries, recovered.publicRecoveries);
  await deliverDaily({ ...options, resume: true }, deps);
  assert.equal((await readReceipt(dir, "2026-10-04"))?.publicRecoveryCount, 2);
}));

test("public recovery holds for active processes, pending requests, or missing or revised reports", async () => harness(async dir => {
  const { deps, executed } = dependencies(dir);
  const execute = deps.execute;
  deps.execute = async stage => { await execute(stage); if (stage === "publish") throw new Error("Mock publish failure"); };
  await assert.rejects(deliverDaily(options, deps), /publish failure/);
  const failed = await readReceipt(dir, "2026-10-04");
  const attempts = executed.length;
  const inspect = deps.inspect;
  deps.assertIdle = async () => { throw new Error("Mock active project batch"); };
  await assert.rejects(deliverDaily({ ...options, autoRecoverPublic: true }, deps), /active project/);
  deps.assertIdle = async () => {};
  for (const inspection of [
    { ...complete, executionBusy: true }, { ...complete, pendingRequests: 1 }, { ...complete, report: null },
    { ...complete, report: { ...complete.report!, revision: 2 } },
  ]) {
    deps.inspect = async () => inspection;
    await assert.rejects(deliverDaily({ ...options, autoRecoverPublic: true }, deps), /public recovery was held/);
    assert.deepEqual(await readReceipt(dir, "2026-10-04"), failed);
  }
  assert.equal(executed.length, attempts);
  deps.inspect = inspect;
  deps.execute = execute;
  const result = await deliverDaily({ ...options, autoRecoverPublic: true }, deps);
  assert.equal(result.publicRecoveryCount, 1);
}));

test("classified validation or security failures are held and never auto-retried", async () => harness(async dir => {
  const { deps, executed } = dependencies(dir);
  const execute = deps.execute;
  deps.execute = async stage => { await execute(stage); if (stage === "export") throw new Error("unsafe manifest mismatch"); };
  (deps as DeliveryDependencies).classifyPublicError = () => "hold";
  await assert.rejects(deliverDaily({ ...options, autoRecoverPublic: true }, deps), /unsafe manifest/);
  assert.equal(executed.filter(stage => stage === "export").length, 1);
  const receipt = await readReceipt(dir, "2026-10-04");
  assert.equal(receipt?.publicRecoveryCount ?? 0, 0);
  assert.equal(receipt?.publicNextRetryAt, undefined);
}));

for (const failingStage of ["database", "readers", "generate"] as const) {
  test(`automatic public recovery never retries a ${failingStage} failure`, async () => harness(async dir => {
    const { deps, executed } = dependencies(dir);
    const execute = deps.execute;
    deps.execute = async stage => { await execute(stage); if (stage === failingStage) throw new Error("Mock non-public failure"); };
    await assert.rejects(deliverDaily({ ...options, autoRecoverPublic: true }, deps), /non-public failure/);
    const attempts = executed.length;
    await assert.rejects(deliverDaily({ ...options, autoRecoverPublic: true }, deps), /--resume/);
    assert.equal(executed.length, attempts);
    assert.equal((await readReceipt(dir, "2026-10-04"))?.publicRecoveries?.length ?? 0, 0);
  }));
}

test("legacy public stage attempt counts do not impose a permanent recovery cap", async () => harness(async dir => {
  const { deps, executed } = dependencies(dir);
  const execute = deps.execute;
  deps.execute = async stage => { await execute(stage); if (stage === "publish") throw new Error("Mock legacy failure"); };
  await assert.rejects(deliverDaily(options, deps), /legacy failure/);
  const failed = (await readReceipt(dir, "2026-10-04"))!;
  delete failed.publicRecoveryCount;
  failed.stages.publish!.attempts = 2;
  await writeFile(path.join(dir, "2026-10-04.json"), JSON.stringify(failed));
  const attempts = executed.length;
  await assert.rejects(deliverDaily({ ...options, autoRecoverPublic: true }, deps), /legacy failure/);
  assert.ok(executed.length > attempts);
  assert.equal((await readReceipt(dir, "2026-10-04"))?.publicRecoveryCount, 2);
}));

test("active cancellation checkpoints public failure without immediately spending the recovery", async () => {
  for (const interruptedStage of ["publish", "verify"] as const) await harness(async dir => {
    const { deps, executed } = dependencies(dir);
    const execute = deps.execute;
    deps.execute = async stage => { await execute(stage); if (stage === interruptedStage) throw new DeliveryInterruptedError("Mock SIGTERM"); };
    await assert.rejects(deliverDaily({ ...options, autoRecoverPublic: true }, deps), DeliveryInterruptedError);
    assert.equal(executed.filter(stage => stage === interruptedStage).length, 1);
    const stopped = await readReceipt(dir, "2026-10-04");
    assert.equal(stopped?.status, "failed");
    assert.equal(stopped?.stages[interruptedStage]?.status, "failed");
    assert.equal(stopped?.publicRecoveryCount, 0);
    assert.equal(stopped?.publicRecoveries?.length ?? 0, 0);
    deps.execute = execute;
    const resumed = await deliverDaily({ ...options, resume: true }, deps);
    assert.equal(resumed.status, "complete");
    assert.equal(resumed.publicRecoveryCount, 1);
    assert.equal(resumed.publicRecoveries?.[0]?.mode, "manual");
  });
});
