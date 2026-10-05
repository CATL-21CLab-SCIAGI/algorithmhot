import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { decideTimeline, upsertMaterial } from "@aihot/backend/content/materials";
import { makeResearchMetadata, mergeResearchMetadata, parseArxivIdentity, researchAnnouncementDate } from "@aihot/backend/sources/research";

const T = tag(), sourceId = `announcement-${T}`;
const articles: string[] = [];
const submitted = new Date("2026-10-02T00:00:00Z"), observed = new Date("2026-10-05T02:00:00Z");
let paperNumber = Date.now() % 80000 + 10000;
const metadata = (announcedOn?: string | null) => makeResearchMetadata({ identity: parseArxivIdentity(`9812.${String(paperNumber++).padStart(5, "0")}`),
  originalPublishedAt: submitted, announcedOn, observedAt: observed, evidenceBasis: "abstract" });

before(async () => { await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${sourceId},'Official announcement fixture','rss','T1','editorial')`; });
after(async () => {
  if (articles.length) await sql`DELETE FROM articles WHERE id=ANY(${articles})`;
  await sql`DELETE FROM sources WHERE id=${sourceId}`;
  await closeDb();
});

test("announcement headings remain strict source calendar dates and merge independently of submission", () => {
  assert.equal(researchAnnouncementDate("2026-10-05"), "2026-10-05");
  for (const value of ["2026-02-30", "2026-10-05T00:00:00Z", "Mon, 05 Oct 2026", "invalid", null, new Date()]) assert.equal(researchAnnouncementDate(value), null);
  const original = metadata("2026-10-02");
  const next = mergeResearchMetadata(original, { ...original, announcedOn: "2026-10-05", observedAt: "2026-10-06T00:00:00Z" });
  assert.equal(next.announcedOn, "2026-10-05");
  assert.equal(next.originalPublishedAt, submitted.toISOString());
  assert.equal(next.observedAt, observed.toISOString());
  assert.equal(mergeResearchMetadata(next, original).announcedOn, "2026-10-05");
  assert.equal(mergeResearchMetadata(next, { ...original, announcedOn: "2026-02-30" }).announcedOn, "2026-10-05");
  assert.equal(metadata("invalid").announcedOn, null);
});

test("a valid recent arXiv announcement affects freshness without replacing either timestamp", () => {
  const research = metadata("2026-10-05");
  const result = decideTimeline(submitted, observed, null, research);
  assert.equal(result.publishedAt?.toISOString(), submitted.toISOString());
  assert.equal(result.timelineAt.toISOString(), observed.toISOString());
  assert.equal(result.backfill, false);
  for (const announcedOn of [null, "invalid", "2026-02-30", "2026-10-01", "2026-10-06"]) {
    assert.equal(decideTimeline(submitted, observed, null, { ...research, announcedOn }).backfill, true);
  }
  assert.equal(decideTimeline(submitted, observed, null, { ...research, arxivId: null }).backfill, true);
  assert.equal(decideTimeline(submitted, observed, null, { ...research, arxivId: "not-an-arxiv-id" }).backfill, true);
  assert.equal(decideTimeline(submitted, observed, null, { ...research, signalOnly: true }).backfill, true);
  assert.equal(decideTimeline(submitted, observed, "research-bootstrap", research).backfill, true);
});

test("freshly announced material stores the submission date and observation timeline unchanged", async () => {
  const research = metadata("2026-10-05");
  const material = await upsertMaterial({ sourceId, url: `https://arxiv.org/abs/${research.arxivId}`, title: "Announced today", bodyText: "Original source abstract",
    bodyStatus: "ok", publishedAt: submitted, discoveredAt: observed, research, via: "import" });
  articles.push(material.articleId);
  const [row] = await sql`SELECT published_at,published_at_claim,discovered_at,timeline_at,backfill,backfill_reason,research FROM articles WHERE id=${material.articleId}`;
  assert.equal(material.backfill, false);
  assert.equal(row.published_at.toISOString(), submitted.toISOString());
  assert.equal(row.published_at_claim.toISOString(), submitted.toISOString());
  assert.equal(row.discovered_at.toISOString(), observed.toISOString());
  assert.equal(row.timeline_at.toISOString(), observed.toISOString());
  assert.equal(row.research.announcedOn, "2026-10-05");
});

test("official announcement evidence corrects only automatic stale flags on existing identities", async () => {
  for (const [label, explicit, announcedOn, expected] of [
    ["automatic", null, "2026-10-05", false],
    ["explicit-history", "research-bootstrap", "2026-10-05", true],
    ["future-announcement", null, "2026-10-06", true],
  ] as const) {
    const research = metadata(null);
    const input = { sourceId, url: `https://arxiv.org/abs/${research.arxivId}`, title: label, bodyText: "A frozen original abstract", bodyStatus: "ok" as const,
      publishedAt: submitted, discoveredAt: observed, research, via: "import" as const, backfill: explicit };
    const first = await upsertMaterial(input); articles.push(first.articleId);
    assert.equal(first.backfill, true);
    const corrected = await upsertMaterial({ ...input, research: { ...research, announcedOn }, discoveredAt: new Date(observed.getTime() + 60_000) });
    assert.equal(corrected.articleId, first.articleId);
    assert.equal(corrected.created, false); assert.equal(corrected.revised, false); assert.equal(corrected.backfill, expected);
    const [row] = await sql`SELECT published_at,discovered_at,timeline_at,backfill,backfill_reason,revision FROM articles WHERE id=${first.articleId}`;
    assert.equal(row.published_at.toISOString(), submitted.toISOString());
    assert.equal(row.discovered_at.toISOString(), observed.toISOString());
    assert.equal(row.backfill, expected); assert.equal(row.revision, 1);
    if (!expected) {
      assert.equal(row.timeline_at.toISOString(), observed.toISOString());
      assert.equal(row.backfill_reason, null);
      assert.equal((await upsertMaterial(input)).backfill, false, "a feed without announcement metadata cannot revert verified freshness");
    }
  }
});
