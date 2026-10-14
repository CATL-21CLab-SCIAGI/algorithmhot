// The timeline rule: material sits where its source put it online, never later than it was found; a date
// alone counts until the last moment of that Beijing day.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decideTimeline, STALE_ON_DISCOVERY_MS } from "@aihot/backend/content/materials";

const at = (s: string) => new Date(s);

test("a timed source date is the timeline; a found-earlier claim cannot move it after discovery", () => {
  const found = at("2026-10-12T03:00:00Z");
  assert.equal(decideTimeline(at("2026-10-12T00:00:00+08:00"), found).timelineAt.toISOString(), "2026-10-11T16:00:00.000Z");
  // An arXiv announcement (08:00 Beijing) read at 08:40 sits at 08:00.
  const arxiv = decideTimeline(at("2026-10-12T08:00:00+08:00"), at("2026-10-12T08:40:00+08:00"));
  assert.equal(arxiv.timelineAt.toISOString(), "2026-10-12T00:00:00.000Z");
  assert.equal(arxiv.backfill, false);
  // A claim up to the future tolerance ahead is trusted but never put after the time it was found.
  const ahead = decideTimeline(at("2026-10-12T03:30:00Z"), found);
  assert.equal(ahead.timelineAt.toISOString(), found.toISOString());
});

test("a date alone stays on its Beijing day, at the time it was found when found that day", () => {
  const day = at("2026-10-09T00:00:00Z");
  // Found during that Beijing day: when it was found.
  const sameDay = at("2026-10-09T15:00:00+08:00");
  assert.equal(decideTimeline(day, sameDay, null, true).timelineAt.toISOString(), sameDay.toISOString());
  // The same instant read as a time (an arXiv announcement at 08:00 Beijing is 00:00 UTC) is that time.
  assert.equal(decideTimeline(day, sameDay).timelineAt.toISOString(), day.toISOString());
  // Found the next day: the last moment of its day (23:59:59.999 Beijing), so it stays on that day.
  const nextDay = decideTimeline(day, at("2026-10-10T10:00:00+08:00"), null, true);
  assert.equal(nextDay.timelineAt.toISOString(), "2026-10-09T15:59:59.999Z");
  assert.equal(nextDay.backfill, false);
  // Found long after: archived on its day.
  const late = decideTimeline(day, new Date(Date.parse("2026-10-09T16:00:00Z") + STALE_ON_DISCOVERY_MS + 1), null, true);
  assert.deepEqual([late.backfill, late.backfillReason, late.timelineAt.toISOString()], [true, "stale-on-discovery", "2026-10-09T15:59:59.999Z"]);
  // A date alone is in the future only when its whole day is.
  assert.ok(decideTimeline(at("2026-10-10T00:00:00Z"), at("2026-10-09T23:30:00+08:00"), null, true).publishedAt);
  assert.equal(decideTimeline(at("2026-10-11T00:00:00Z"), at("2026-10-09T23:30:00+08:00"), null, true).publishedAt, null);
});

test("without a source date the material waits for one, as before", () => {
  const t = decideTimeline(null, at("2026-10-12T03:00:00Z"));
  assert.deepEqual([t.backfill, t.backfillReason, t.timelineAt.toISOString()], [true, "unknown-publication-time", "2026-10-12T03:00:00.000Z"]);
});
