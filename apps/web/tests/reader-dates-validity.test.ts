import test from "node:test";
import assert from "node:assert/strict";
import { announcementDay, originalPublicationAt, readerDateKnown, readerTimelineAt } from "../app/features/feed/research-date.ts";

test("reader date fallback ignores invalid announcements and unknown arXiv submissions", () => {
  const item = { timelineAt: "2026-10-05T10:00:00.000Z", research: { arxivId: "2610.12345", announcedOn: "2026-02-30", originalPublishedAt: null } };
  assert.equal(announcementDay(item), null);
  assert.equal(readerTimelineAt(item), item.timelineAt);
  assert.equal(originalPublicationAt(item), null);
  assert.equal(readerDateKnown(item), false);
  assert.equal(announcementDay({ research: { arxivId: "2402.12345", announcedOn: "2024-02-29" } }), "2024-02-29");
  assert.equal(announcementDay({ research: { arxivId: null, announcedOn: "2026-10-07" } }), null);
});
