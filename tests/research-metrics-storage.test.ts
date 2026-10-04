import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { candidates } from "@aihot/backend/reports/compose";
import { researchRunMetrics } from "@aihot/backend/research/admission";
import { makeResearchMetadata } from "@aihot/backend/sources/research";
import type { ResearchBrief } from "@aihot/contracts/research";

const T = tag();
const sourceIds = Array.from({ length: 6 }, (_, i) => `research-metrics-${T}-${i}`);
const runIds: string[] = [], articleIds: string[] = [];
before(async () => {
  for (const sourceId of sourceIds) await sql`INSERT INTO sources(id,name,kind,tier) VALUES(${sourceId},'Metrics fixture','rss','T1')`;
});
after(async () => {
  await sql`DELETE FROM research_members WHERE run_id=ANY(${runIds})`;
  await sql`DELETE FROM research_fetches WHERE run_id=ANY(${runIds})`;
  await sql`DELETE FROM research_runs WHERE id=ANY(${runIds})`;
  await sql`DELETE FROM articles WHERE id=ANY(${articleIds})`;
  await sql`DELETE FROM sources WHERE id=ANY(${sourceIds})`;
  await closeDb();
});

async function run(label: string): Promise<string> {
  const id = `metrics-${T}-${label}`;
  runIds.push(id);
  await sql`INSERT INTO research_runs(id,kind,window_start,window_end) VALUES(${id},'pilot','2012-01-01','2012-01-08')`;
  for (const sourceId of sourceIds) await sql`INSERT INTO research_fetches(run_id,source_id,url,status)
    VALUES(${id},${sourceId},${`https://example.org/${id}/${sourceId}`},'ok')`;
  return id;
}

async function attempt(runId: string, source: number, number: number, status: string, parsed = 0, truncated = false) {
  const sourceId = sourceIds[source]!;
  await sql`INSERT INTO research_fetches(run_id,source_id,url,attempt_number,status,returned_count,parsed_count,truncated)
    VALUES(${runId},${sourceId},${`https://example.org/${runId}/${sourceId}`},${number},${status},${parsed},${parsed},${truncated})`;
}

async function member(runId: string) {
  const { articleId } = await upsertMaterial({ sourceId: sourceIds[0]!, url: `https://example.org/${runId}/paper`, title: "指标测试论文", via: "import" });
  articleIds.push(articleId);
  await sql`INSERT INTO research_members(run_id,article_id,source_id,in_window) VALUES(${runId},${articleId},${sourceIds[0]!},true)`;
}

test("healthy-empty and success counts require untruncated final attempts while historical failure evidence remains", async () => {
  const id = await run("truncation");
  await attempt(id, 0, 2, "ok", 0, true);
  let result = await researchRunMetrics(id);
  assert.equal(result.metrics.sourcesSucceeded, 5);
  assert.equal(result.metrics.sourcesFailed, 1);
  assert.equal(result.metrics.healthyEmptySources, 5);
  assert.equal(result.metrics.truncatedRequests, 1);
  assert.match(result.gaps.join("；"), /截断/);
  await attempt(id, 0, 3, "ok");
  await attempt(id, 1, 2, "failed");
  await attempt(id, 1, 3, "ok");
  result = await researchRunMetrics(id);
  assert.equal(result.metrics.sourcesSucceeded, 6);
  assert.equal(result.metrics.sourcesFailed, 0);
  assert.equal(result.metrics.healthyEmptySources, 6);
  assert.equal(result.metrics.truncatedRequests, 0);
  assert.equal(result.metrics.failedRequests, 1);
  assert.deepEqual(result.gaps, []);
  assert.equal((await sql`SELECT count(*)::int AS n FROM research_fetches WHERE run_id=${id} AND truncated`)[0]!.n, 1, "resolving a gap must not erase historical attempts");
});

test("a parsed but unpersisted failed or pending page is not reported as a duplicate", async () => {
  for (const status of ["failed", "pending"]) {
    const id = await run(`unpersisted-${status}`);
    await attempt(id, 0, 2, status, 1);
    const { metrics, gaps } = await researchRunMetrics(id);
    assert.equal(metrics.parsed, 1);
    assert.equal(metrics.stored, 0);
    assert.equal(metrics.duplicateRecords, 0);
    assert.equal(metrics.duplicateRecordsLowerBound, 0);
    assert.equal(metrics.duplicateRecordsExact, 0);
    assert.equal(metrics.persistenceUnreconciled, 1);
    assert.match(gaps.join("；"), /落库对账.*确认下界/);
  }
});

test("completed batches retain exact duplicate counts, while interrupted attempts only support a lower bound", async () => {
  const complete = await run("complete-counts");
  await member(complete);
  await attempt(complete, 0, 2, "ok", 450);
  let result = await researchRunMetrics(complete);
  assert.equal(result.metrics.duplicateRecords, 449);
  assert.equal(result.metrics.duplicateRecordsExact, 1);
  assert.equal(result.metrics.persistenceUnreconciled, 0);
  assert.deepEqual(result.gaps, []);
  await attempt(complete, 1, 2, "failed", 4);
  result = await researchRunMetrics(complete);
  assert.equal(result.metrics.parsed, 454);
  assert.equal(result.metrics.duplicateRecords, 449, "the four unreconciled records must not become claimed duplicates");
  assert.equal(result.metrics.duplicateRecordsLowerBound, 449);
  assert.equal(result.metrics.duplicateRecordsExact, 0);
  assert.equal(result.metrics.persistenceUnreconciled, 4);
});

test("legacy daily candidates use the source publication date or unknown and carry research evidence", async () => {
  const original = "2012-01-01T21:00:00.000Z", observed = new Date("2012-01-01T22:00:00Z"), released = new Date("2012-01-01T23:00:00Z");
  for (const publishedAt of [new Date(original), null]) {
    const research = makeResearchMetadata({ evidenceBasis: "abstract", originalPublishedAt: publishedAt, observedAt: observed });
    const brief: ResearchBrief = { methodChange: "方法变化", applicableTasks: "适用任务", comparisonConditions: "作者报告的比较", limitations: "仅摘要", evidenceBasis: "abstract", sourceRevision: 1, promptVersion: "fixture", generatedAt: released.toISOString() };
    const { articleId } = await upsertMaterial({ sourceId: sourceIds[0]!, url: `https://example.org/${T}/daily-${publishedAt ? "known" : "unknown"}`, title: "日报日期测试", bodyText: "Source abstract.", bodyStatus: "ok", publishedAt, discoveredAt: observed, research, via: "fetch" });
    articleIds.push(articleId);
    await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
      VALUES(${articleId},1,'rule','pass','algorithm','日报日期测试','来源摘要',90,true)`;
    await publishArticle(articleId, { now: released, releasedAt: released });
    await sql`UPDATE publications SET research_brief=${sql.json(brief as never)} WHERE article_id=${articleId}`;
    const item = (await candidates(new Date("2012-01-01"), new Date("2012-01-02"))).find(item => item.itemId === articleId)!;
    assert.ok(item, "window membership continues to use release/arrival time");
    assert.equal(item.publishedAt, publishedAt ? original : "");
    assert.notEqual(item.publishedAt, observed.toISOString());
    assert.deepEqual(item.research, research);
    assert.deepEqual(item.researchBrief, brief);
  }
});
