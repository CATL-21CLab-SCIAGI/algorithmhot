import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deliverDaily, deliveryDate, dueDaily, currentRefreshSlot, validateRefreshSlot, readReceipt, recoverDeliveryLock, withDeliveryLock, type DailyInspection, type Stage } from "../scripts/daily-delivery/core.ts";
import { publicDestination, safeSiteOrigin } from "../scripts/daily-delivery.ts";

const now = new Date("2026-10-04T00:00:00Z");
const options = { now, siteBase: "https://pkucy2016.github.io/algorithmhot/", repo: "PKUCY2016/algorithmhot" };
const complete: DailyInspection = { executionBusy: false, pendingRequests: 0, unknownRequests: 0, callsUsed: 20, report: { status: "complete", published: 3, gaps: 0, revision: 1 } };
async function harness(fn: (stateDir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "algorithmhot-delivery-test-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
function dependencies(stateDir: string) {
  const executed: Stage[] = [];
  let generated = false;
  return {
    executed,
    deps: {
      stateDir, now: () => now, assertIdle: async () => {}, log: () => {},
      inspect: async (): Promise<DailyInspection> => ({ ...complete, report: generated ? complete.report : null }),
      execute: async (stage: Stage) => { executed.push(stage); if (stage === "generate") generated = true; },
    },
  };
}

test("daily delivery uses the last closed Beijing 08:00 window and validates explicit dates", () => {
  assert.equal(dueDaily(new Date("2026-10-03T23:59:59.999Z")), "2026-10-03");
  assert.equal(dueDaily(now), "2026-10-04");
  assert.equal(dueDaily(new Date("2026-10-04T23:59:59Z")), "2026-10-04");
  assert.equal(dueDaily(new Date("2027-01-01T00:00:00Z")), "2027-01-01");
  assert.throws(() => deliveryDate("2026-10-05", now), /has not closed/);
  assert.throws(() => deliveryDate("2026-02-30", now), /Invalid/);
});

test("delivery serializes five stages and repeats the completed day without generating or publishing again", async () => harness(async dir => {
  const { deps, executed } = dependencies(dir);
  const result = await deliverDaily(options, deps);
  assert.equal(result.runId, "daily-2026-10-04");
  assert.equal(result.windowStart, "2026-10-03T00:00:00.000Z");
  assert.equal(result.windowEnd, "2026-10-04T00:00:00.000Z");
  assert.equal(result.status, "complete");
  assert.deepEqual(executed, ["database", "readers", "generate", "export", "publish"]);
  await deliverDaily(options, deps);
  assert.equal(executed.length, 5);
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
