import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { chooseAdmissions, freezeAdmissions, admittedForProcessing, type AdmissionCandidate } from "@aihot/backend/research/admission";
import { createResearchRun } from "@aihot/backend/research/collect";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { queueProcessing, processArticle, sweepUnprocessed } from "@aihot/backend/jobs/content";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { publishArticle } from "@aihot/backend/publication/publish";
import { makeResearchMetadata, parseArxivIdentity } from "@aihot/backend/sources/research";
import type { ResearchMetadata } from "@aihot/contracts/research";
import { z } from "zod";
import { chatJson } from "@aihot/backend/providers/llm";

const T = tag();
const sourceIds: string[] = [];
const runIds: string[] = [];
const articleIds: string[] = [];
const originalEnv = { admission: process.env.RESEARCH_ADMISSION_ENABLED, run: process.env.MODEL_RUN_ID };
after(async () => {
  for (const [key, value] of [["RESEARCH_ADMISSION_ENABLED", originalEnv.admission], ["MODEL_RUN_ID", originalEnv.run]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
  await stopBoss();
  if (runIds.length) {
    await sql`DELETE FROM research_members WHERE run_id = ANY(${runIds}::text[])`;
    await sql`DELETE FROM research_fetches WHERE run_id = ANY(${runIds}::text[])`;
    await sql`DELETE FROM research_runs WHERE id = ANY(${runIds}::text[])`;
  }
  if (articleIds.length) {
    const [boss] = await sql`SELECT to_regclass('pgboss.job') AS present`;
    if (boss?.present) await sql`DELETE FROM pgboss.job WHERE data->>'articleId' = ANY(${articleIds}::text[])`;
    await sql`DELETE FROM articles WHERE id = ANY(${articleIds}::text[])`;
  }
  if (sourceIds.length) await sql`DELETE FROM sources WHERE id = ANY(${sourceIds}::text[])`;
  await closeDb();
});

function candidates(sourceId: string, count: number, prefix: string, date = "2026-10-02T12:00:00.000Z"): AdmissionCandidate[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${String(i).padStart(3, "0")}`, sourceId, canonicalKey: `${prefix}:${String(i).padStart(3, "0")}`, publishedAt: date }));
}

test("admission quotas reserve 20/15/15/10 and select at most 60 deterministic identities", () => {
  const input = [...candidates("research-arxiv-ml-ai", 30, "ml"), ...candidates("research-arxiv-physical-science", 30, "physics"), ...candidates("research-arxiv-molecular", 30, "molecular"), ...candidates("rss-bair", 8, "bair"), ...candidates("rss-google-deepmind", 8, "deepmind")];
  const result = chooseAdmissions(input);
  assert.equal(result.length, 60);
  const count = (sources: string[]) => result.filter((a) => sources.includes(a.sourceId)).length;
  assert.equal(count(["research-arxiv-ml-ai"]), 20);
  assert.equal(count(["research-arxiv-physical-science"]), 15);
  assert.equal(count(["research-arxiv-molecular"]), 15);
  assert.equal(count(["rss-bair", "rss-google-deepmind"]), 10);
  assert.deepEqual(chooseAdmissions([...input].reverse()), result, "arrival order does not alter the frozen sequence");
  assert.equal(new Set(result.map((a) => a.canonicalKey)).size, 60);
  for (const limit of [0, 61, 1.5]) assert.throws(() => chooseAdmissions(input, limit), /limit/);
});

test("admission redistributes unused quotas and retains short or empty candidate sets", () => {
  const input = [...candidates("research-arxiv-ml-ai", 70, "ml"), ...candidates("research-arxiv-molecular", 2, "molecular")];
  const result = chooseAdmissions(input);
  assert.equal(result.length, 60);
  assert.equal(result.filter((a) => a.sourceId === "research-arxiv-molecular").length, 2);
  assert.equal(result.filter((a) => a.sourceId === "research-arxiv-ml-ai").length, 58);
  assert.equal(chooseAdmissions(input.slice(0, 7)).length, 7);
  assert.deepEqual(chooseAdmissions([]), []);
});

test("admission tie-breaking and cross-source duplicates are independent of input order", () => {
  const a = candidates("research-arxiv-ml-ai", 1, "same")[0]!;
  const older = { ...a, id: "old", sourceId: "research-arxiv-physical-science", publishedAt: "2026-10-01T12:00:00.000Z" };
  const same = { ...a, id: "z-duplicate", sourceId: "research-arxiv-molecular" };
  const other = { ...a, id: "other", canonicalKey: "other" };
  const result = chooseAdmissions([older, same, a, other]);
  assert.deepEqual(chooseAdmissions([other, a, same, older]), result);
  assert.equal(result.length, 2);
  assert.equal(result.find((r) => r.canonicalKey === a.canonicalKey)?.id, a.id);
});

async function source(label: string, signal = false): Promise<string> {
  const id = `admission-${T}-${label}`;
  await sql`INSERT INTO sources(id,name,kind,participation_mode,tier) VALUES(${id},${label},'rss',${signal ? "hot_signal" : "editorial"},'T1')`;
  sourceIds.push(id);
  return id;
}

async function run(label: string): Promise<string> {
  const id = `admission-${T}-${label}`;
  await createResearchRun(id, "pilot", new Date("2014-03-08T00:00:00Z"));
  runIds.push(id);
  return id;
}

async function material(runId: string, sourceId: string, label: string, opts: { inWindow?: boolean; signal?: boolean; url?: string; research?: ResearchMetadata; identityKey?: string } = {}) {
  const { articleId } = await upsertMaterial({ sourceId, url: opts.url ?? `https://example.org/admission/${T}/${label}`, title: `资料 ${label}`, bodyText: `Abstract ${label}`, bodyStatus: "ok", via: "import", publishedAt: new Date("2014-03-07T00:00:00Z"), discoveredAt: new Date("2014-03-08T00:00:00Z"), backfill: "test-research", identityKey: opts.identityKey, research: opts.research });
  if (!articleIds.includes(articleId)) articleIds.push(articleId);
  await sql`INSERT INTO research_members(run_id,article_id,source_id,in_window,signal_only) VALUES(${runId},${articleId},${sourceId},${opts.inWindow ?? true},${opts.signal ?? false}) ON CONFLICT DO NOTHING`;
  return articleId;
}

test("database admission freezes 60, survives restart and ignores later candidates or resorting", async () => {
  const id = await run("frozen");
  const s = await source("frozen");
  const ids = [];
  for (let i = 0; i < 62; i++) ids.push(await material(id, s, `frozen-${String(i).padStart(2, "0")}`));
  const outside = await material(id, s, "outside-window", { inWindow: false });
  assert.deepEqual(await Promise.all([freezeAdmissions(id), freezeAdmissions(id)]), [60, 60]);
  const before = await sql`SELECT article_id,admission_rank FROM research_members WHERE run_id = ${id} AND admitted ORDER BY admission_rank`;
  assert.equal(before.length, 60);
  assert.equal(new Set(before.map((r) => r.admission_rank)).size, 60);
  await sql`UPDATE articles SET published_at = '2014-03-07T23:59:00Z' WHERE id = ${ids[61]!}`;
  const later = await material(id, s, "later-new-record");
  const reopened = await createResearchRun(id, "pilot", new Date("2026-10-03T00:00:00Z"));
  assert.equal(reopened.window_end.toISOString(), "2014-03-08T00:00:00.000Z");
  assert.equal(await freezeAdmissions(id), 60);
  const afterFreeze = await sql`SELECT article_id,admission_rank FROM research_members WHERE run_id = ${id} AND admitted ORDER BY admission_rank`;
  assert.deepEqual(afterFreeze, before);
  process.env.RESEARCH_ADMISSION_ENABLED = "true";
  process.env.MODEL_RUN_ID = id;
  assert.equal(await admittedForProcessing(String(before[0]!.article_id)), true);
  assert.equal(await admittedForProcessing(outside), false);
  assert.equal(await admittedForProcessing(later), false);
});

test("queue, direct processing and sweep cannot send unadmitted material to models", async () => {
  const id = await run("gate");
  const s = await source("gate");
  const outside = await material(id, s, "gate-outside", { inWindow: false });
  process.env.RESEARCH_ADMISSION_ENABLED = "true";
  process.env.MODEL_RUN_ID = id;
  assert.equal(await admittedForProcessing(outside), false, "an unfrozen run is closed");
  await freezeAdmissions(id);
  await getBoss();
  const callsEnabled = config.modelCallsEnabled;
  config.modelCallsEnabled = false;
  try {
    assert.equal(await queueProcessing(outside, { attemptTag: "manual-evaluation" }), null);
    assert.deepEqual(await processArticle(outside, { attemptTag: "manual-evaluation" }), { state: "not-admitted" });
    await assert.rejects(chatJson({ model: "default", purpose: "score_article", subject: `article:${outside}@1`, promptVersion: "gate-fixture", system: "fixture", user: "fixture", schema: z.object({ ok: z.boolean() }) }), /not admitted/);
    await sql`UPDATE articles SET created_at=now()-interval '5 minutes',processing_queued_at=NULL WHERE id=${outside}`;
    await sweepUnprocessed();
    assert.equal((await sql`SELECT id FROM pgboss.job WHERE data->>'articleId'=${outside}`).length, 0);
    assert.equal((await sql`SELECT id FROM receipts WHERE subject LIKE ${`article:${outside}%`}`).length, 0);
    const [row] = await sql`SELECT processing_state,processing_queued_at FROM articles WHERE id=${outside}`;
    assert.equal(row!.processing_state, "new");
    assert.equal(row!.processing_queued_at, null);
    delete process.env.MODEL_RUN_ID;
    assert.equal(await admittedForProcessing(outside), false, "missing run ID is closed");
  } finally { config.modelCallsEnabled = callsEnabled; }
});

for (const signalFirst of [true, false]) test(`HF ${signalFirst ? "before" : "after"} arXiv never consumes the paper identity or admission`, async () => {
  const id = await run(signalFirst ? "hf-first" : "paper-first");
  const paperSource = await source(signalFirst ? "paper-a" : "paper-b");
  const signalSource = await source(signalFirst ? "signal-a" : "signal-b", true);
  const arxivId = `9912.${String((Date.now() % 90000) + (signalFirst ? 10000 : 10001)).padStart(5, "0")}`;
  const identity = parseArxivIdentity(`${arxivId}v1`)!;
  const paper = () => material(id, paperSource, `paper-${arxivId}`, { url: `https://arxiv.org/abs/${arxivId}v1`, research: makeResearchMetadata({ identity, originalPublishedAt: "2014-03-05", observedAt: "2014-03-08", evidenceBasis: "abstract" }) });
  const signal = () => material(id, signalSource, `signal-${arxivId}`, { signal: true, url: `https://huggingface.co/papers/${arxivId}`, identityKey: `hf:${arxivId}`, research: makeResearchMetadata({ identity, originalPublishedAt: "2014-03-05", communitySelectedAt: "2014-03-07", observedAt: "2014-03-08", evidenceBasis: "abstract", signalOnly: true }) });
  let paperId: string, signalId: string;
  if (signalFirst) { signalId = await signal(); paperId = await paper(); }
  else { paperId = await paper(); signalId = await signal(); }
  assert.notEqual(paperId, signalId);
  assert.equal(await freezeAdmissions(id), 1);
  const [admitted] = await sql`SELECT article_id FROM research_members WHERE run_id=${id} AND admitted`;
  assert.equal(admitted!.article_id, paperId);
  await publishArticle(paperId);
  const [published] = await sql<{ research: ResearchMetadata }[]>`SELECT research FROM publications WHERE article_id=${paperId}`;
  assert.equal(published!.research.signalOnly, false);
  assert.equal(published!.research.originalPublishedAt, "2014-03-05T00:00:00.000Z");
  assert.equal(published!.research.communitySelectedAt, "2014-03-07T00:00:00.000Z");
});
