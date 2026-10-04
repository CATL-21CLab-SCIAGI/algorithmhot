import assert from "node:assert/strict";
import { test } from "node:test";
import { beijingDay, nextDailyAt, startClock, takeDue } from "../scripts/scheduler-clock.ts";

test("daily deadline is Beijing 08:00 and exact startup at the deadline schedules tomorrow", () => {
  assert.equal(nextDailyAt("2026-10-02T23:59:59Z"), "2026-10-03T00:00:00.000Z");
  assert.equal(nextDailyAt("2026-10-03T00:00:00Z"), "2026-10-04T00:00:00.000Z");
  assert.equal(beijingDay("2026-10-02T16:00:00Z"), "2026-10-03");
});
test("startup preserves a future source check but does not replay expired checkpoints", () => {
  const previous = { nextDailyAt: "2026-09-01T00:00:00Z", nextSourcesAt: "2026-09-01T01:00:00Z" };
  assert.deepEqual(startClock("2026-10-03T03:00:00Z", previous), { nextDailyAt: "2026-10-04T00:00:00.000Z", nextSourcesAt: "2026-10-03T09:00:00.000Z" });
  assert.equal(startClock("2026-10-03T03:00:00Z", { ...previous, nextSourcesAt: "2026-10-03T04:00:00Z" }).nextSourcesAt, "2026-10-03T04:00:00.000Z");
});
test("08:00 collision emits exactly one daily followed by one source check", () => {
  const initial = startClock("2026-10-02T18:00:00Z"); // Beijing 02:00; six hours later is 08:00.
  const due = takeDue(initial, "2026-10-03T00:00:00Z");
  assert.deepEqual(due.jobs.map(j => [j.kind, j.id]), [["daily", "daily-2026-10-03"], ["sources", "sources-20261003000000"]]);
  assert.deepEqual(takeDue(due.clock, "2026-10-03T00:00:00Z").jobs, []);
  assert.equal(due.clock.nextSourcesAt, "2026-10-03T06:00:00.000Z");
});
test("a suspended process coalesces overdue slots instead of replaying historical batches", () => {
  const due = takeDue({ nextDailyAt: "2026-10-01T00:00:00Z", nextSourcesAt: "2026-10-01T00:00:00Z" }, "2026-10-03T01:00:00Z");
  assert.equal(due.jobs.length, 2);
  assert.equal(due.jobs[0]!.id, "daily-2026-10-03");
  assert.equal(due.clock.nextDailyAt, "2026-10-04T00:00:00.000Z");
});
test("month and year boundaries do not depend on the host timezone", () => {
  assert.equal(nextDailyAt("2026-12-31T00:00:01Z"), "2027-01-01T00:00:00.000Z");
  assert.equal(takeDue({ nextDailyAt: "2027-01-01T00:00:00Z", nextSourcesAt: "2027-01-01T02:00:00Z" }, "2027-01-01T00:00:00Z").jobs[0]!.date, "2027-01-01");
});
