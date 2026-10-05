import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { createResearchRun } from "@aihot/backend/research/collect";
import { freezeAdmissions } from "@aihot/backend/research/admission";
import { composePilot, composeDaily, dueDaily } from "@aihot/backend/reports/compose";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { makeResearchMetadata } from "@aihot/backend/sources/research";
import { getModelRun } from "@aihot/backend/providers/model-runs";

const T = tag();
const env = { ...process.env };
const callsEnabled = config.modelCallsEnabled;
const sourceIds: string[] = [];
const runIds: string[] = [];
const articleIds: string[] = [];
const fetchIds: number[] = [];
const dailyKeys: string[] = [];
const provider = await stub((hit) => ({ choices: [{ message: { content: JSON.stringify({ title: `研究试刊 ${T}`, leadParagraph: "摘要依据公开来源，作者报告的实验尚未独立复现。", highlights: [1] }) } }], usage: { total_tokens: 20 }, id: `${T}:${hit}` }));
Object.assign(process.env, { LLM_TRANSPORT: "openai_compatible", LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "fixture-key", LLM_MODEL: "fixture-model", REPORT_MODEL: "default", RESEARCH_REPORTS_ENABLED: "true", MODEL_RUN_MAX_CALLS: "600", MODEL_RUN_REPORT_RESERVE: "20" });
config.modelCallsEnabled = true;

after(async () => {
  await provider.close();
  await stopBoss();
  if (runIds.length) {
    await sql`DELETE FROM reports WHERE kind = 'pilot' AND content->'run'->>'id' = ANY(${runIds}::text[])`;
    await sql`DELETE FROM research_fetches WHERE run_id = ANY(${runIds}::text[])`;
    await sql`DELETE FROM research_members WHERE run_id = ANY(${runIds}::text[])`;
    await sql`DELETE FROM research_runs WHERE id = ANY(${runIds}::text[])`;
  }
  if (dailyKeys.length) await sql`DELETE FROM reports WHERE kind='daily' AND key=ANY(${dailyKeys}::text[])`;
  if (fetchIds.length) await sql`DELETE FROM fetch_runs WHERE id=ANY(${fetchIds}::bigint[])`;
  if (articleIds.length) await sql`DELETE FROM articles WHERE id=ANY(${articleIds}::text[])`;
  if (sourceIds.length) await sql`DELETE FROM sources WHERE id=ANY(${sourceIds}::text[])`;
  config.modelCallsEnabled = callsEnabled;
  for (const key of ["LLM_TRANSPORT", "LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "REPORT_MODEL", "RESEARCH_REPORTS_ENABLED", "MODEL_RUN_ID", "MODEL_RUN_MAX_CALLS", "MODEL_RUN_REPORT_RESERVE"]) {
    if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
  }
  await closeDb();
});

async function sources() {
  if (sourceIds.length) return;
  for (let i = 0; i < 6; i++) {
    const id = `research-report-${T}-${i}`;
    await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,config) VALUES(${id},${`研究信源 ${i}`},'rss','T1','editorial','{"researchSourceKind":"arxiv"}')`;
    sourceIds.push(id);
  }
}

async function run(label: string, day: string, failed = false) {
  await sources();
  const id = `research-report-${T}-${label}`;
  await createResearchRun(id, "pilot", new Date(`${day}T00:00:00Z`));
  runIds.push(id);
  for (const [i, sourceId] of sourceIds.entries()) await sql`
    INSERT INTO research_fetches(run_id,source_id,url,status,returned_count,parsed_count)
    VALUES(${id},${sourceId},${`https://example.org/${T}/${label}/${i}`},${failed && i === 0 ? "failed" : "ok"},0,0)`;
  process.env.MODEL_RUN_ID = id;
  return id;
}

async function material(runId: string, label: string, category: string, selected = true, state = "pass", backfill = true) {
  const [r] = await sql<{ window_end: Date }[]>`SELECT window_end FROM research_runs WHERE id=${runId}`;
  const at = new Date(r!.window_end.getTime() - 3600_000);
  const sourceId = sourceIds[0]!;
  const { articleId } = await upsertMaterial({ sourceId, url: `https://example.org/${T}/${runId}/${label}`, title: `研究 ${label} ${T}`, bodyText: "Public abstract with an author-reported comparison.", bodyStatus: "ok", publishedAt: at, discoveredAt: at, via: "import", backfill: backfill ? "research-bootstrap" : null, research: makeResearchMetadata({ originalPublishedAt: at, observedAt: at, evidenceBasis: "abstract" }) });
  articleIds.push(articleId);
  await sql`INSERT INTO research_members(run_id,article_id,source_id,in_window,state) VALUES(${runId},${articleId},${sourceId},true,${state})`;
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
    VALUES(${articleId},1,'rule',${selected ? "pass" : "block"},${category},${`研究 ${label} ${T}`},'作者报告的方法结果；基于摘要，未独立复现。',90,${selected})`;
  await publishArticle(articleId, { now: at, releasedAt: at });
  if (selected) await sql`UPDATE publications SET research_brief=${sql.json({ methodChange: "作者报告方法增量", applicableTasks: "摘要描述的任务", comparisonConditions: "未知：当前资料未提供。", limitations: "基于摘要，尚未独立复现。", evidenceBasis: "abstract", sourceRevision: 1, promptVersion: "fixture", generatedAt: at.toISOString() })} WHERE article_id=${articleId}`;
  return articleId;
}

const report = async (kind: string, key: string) => (await sql<{ id: number; revision: number; content: Record<string, any>; window_start: Date; window_end: Date; model: string; origin: string }[]>`SELECT * FROM reports WHERE kind=${kind} AND key=${key}`)[0]!;

test("pilot is capped at five per section, keeps its exact window, is idempotent and versions explicit revisions", async () => {
  const id = await run("populated", "2013-07-10");
  const ids = [];
  for (const category of ["algorithm", "ai4ai", "ai4s"]) for (let i = 0; i < 6; i++) ids.push(await material(id, `${category}-${i}`, category));
  assert.equal(await freezeAdmissions(id), 18);
  await sql`UPDATE research_members SET state='pass' WHERE run_id=${id}`;
  const hits = provider.hits();
  const result = await composePilot(id);
  assert.equal(result.entries, 15);
  const first = await report("pilot", result.key);
  assert.equal(first.revision, 1);
  assert.equal(first.content.run.id, id);
  assert.equal(first.content.run.status, "complete");
  assert.equal(first.content.sections.length, 3);
  assert.ok(first.content.sections.every((section: { items: unknown[] }) => section.items.length === 5));
  assert.equal(first.content.metrics.displayOmitted, 3);
  assert.equal(first.content.generator.calibration, "NOT_EVALUATED");
  assert.equal(first.window_start.toISOString(), "2013-07-03T00:00:00.000Z");
  assert.equal(first.window_end.toISOString(), "2013-07-10T00:00:00.000Z");
  assert.equal(first.content.sections[0].items[0].research.evidenceBasis, "abstract");
  assert.equal(provider.hits() - hits, 1);
  assert.deepEqual(await composePilot(id), result);
  assert.equal(provider.hits() - hits, 1, "an automatic replay does not call a model or revise the report");
  assert.equal((await report("pilot", result.key)).revision, 1);
  const includedId = first.content.sections[0].items[0].itemId;
  await sql`UPDATE publications SET title=${`修订后的论文标题 ${T}`} WHERE article_id=${includedId}`;
  await composePilot(id, true);
  const revised = await report("pilot", result.key);
  assert.equal(revised.revision, 2);
  const revisions = await sql<{ revision: number; content: Record<string, any> }[]>`SELECT revision,content FROM report_revisions WHERE report_id=${first.id}`;
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0]!.revision, 1);
  assert.deepEqual(revisions[0]!.content, first.content);
  assert.equal((await getModelRun(id))!.callsUsed, 2);
  assert.equal((await sql`SELECT id FROM reports WHERE kind='daily' AND key=${result.key}`).length, 0, "the pilot never takes a normal daily issue key");
});

test("an unfrozen pilot or a different run colliding with an existing pilot key cannot silently replace it", async () => {
  const id = await run("collision", "2013-07-10");
  await assert.rejects(composePilot(id), /not frozen/);
  await freezeAdmissions(id);
  await assert.rejects(composePilot(id), /另一批次|different|already/i);
  assert.notEqual((await report("pilot", "2013-07-10")).content.run.id, id);
});

test("healthy zero-selection pilot is a complete empty issue without making a model call", async () => {
  const id = await run("empty", "2013-07-11");
  await material(id, "not-selected", "algorithm", false, "block");
  await freezeAdmissions(id);
  await sql`UPDATE research_members SET state='block' WHERE run_id=${id}`;
  const hits = provider.hits();
  const result = await composePilot(id);
  assert.equal(result.entries, 0);
  const saved = await report("pilot", result.key);
  assert.equal(saved.content.run.status, "complete");
  assert.deepEqual(saved.content.run.gaps, []);
  assert.match(saved.content.lead.title, /暂无刊载研究/);
  assert.match(saved.content.lead.leadParagraph, /不代表.*没有新研究/);
  assert.equal(provider.hits(), hits);
});

test("source failure, unfinished processing and unknown outcomes produce a partial pilot", async () => {
  const id = await run("partial", "2013-07-12", true);
  const unfinished = await material(id, "unfinished", "algorithm", false);
  const unknown = await material(id, "unknown", "ai4ai", false);
  const failed = await material(id, "failed", "ai4s", false);
  await freezeAdmissions(id);
  await sql`UPDATE research_members SET state='unknown-receipt' WHERE run_id=${id} AND article_id=${unknown}`;
  await sql`UPDATE research_members SET state='failed' WHERE run_id=${id} AND article_id=${failed}`;
  const result = await composePilot(id);
  const saved = await report("pilot", result.key);
  assert.equal(result.entries, 0);
  assert.equal(saved.content.run.status, "partial");
  assert.equal(saved.content.run.metrics.failedRequests, 1);
  assert.equal(saved.content.run.metrics.unknownOutcome, 1);
  assert.equal(saved.content.run.metrics.failed, 1);
  assert.equal(saved.content.run.metrics.pending, 1);
  assert.match(saved.content.lead.title, /缺口/);
  assert.equal((await sql`SELECT state FROM research_members WHERE run_id=${id} AND article_id=${unfinished}`)[0]!.state, "pending");
});

test("a selected paper with an unresolved brief remains an explicit gap instead of a complete published entry", async () => {
  const id = await run("brief-gap", "2013-07-13");
  const article = await material(id, "selected-unresolved-brief", "algorithm");
  await sql`UPDATE publications SET research_brief=NULL WHERE article_id=${article}`;
  await freezeAdmissions(id);
  await sql`UPDATE research_members SET state='pass',error='brief: outcome UNKNOWN' WHERE run_id=${id}`;
  const hits = provider.hits();
  const result = await composePilot(id);
  const saved = await report("pilot", result.key);
  assert.equal(result.entries, 0);
  assert.equal(saved.content.run.status, "partial");
  assert.equal(saved.content.metrics.selected, 1);
  assert.equal(saved.content.metrics.selectedWithoutBrief, 1);
  assert.equal(saved.content.metrics.excludedByDisplayLimit, 0);
  assert.match(saved.content.run.gaps.join(";"), /研究解读尚未完成/);
  assert.equal(provider.hits(), hits);
});

test("normal daily empty issue separates healthy collection from an unobserved window", async () => {
  await sources();
  const healthyKey = "2013-07-20";
  const partialKey = "2013-07-21";
  dailyKeys.push(healthyKey, partialKey);
  const planned = await sql<{ id: string }[]>`SELECT id FROM sources WHERE config ? 'researchSourceKind'`;
  for (const source of planned) {
    const [f] = await sql<{ id: number }[]>`INSERT INTO fetch_runs(source_id,status,started_at,finished_at) VALUES(${source.id},'ok','2013-07-19T12:00:00Z','2013-07-19T12:01:00Z') RETURNING id`;
    fetchIds.push(f!.id);
  }
  const hits = provider.hits();
  assert.equal((await composeDaily(healthyKey)).entries, 0);
  const healthy = await report("daily", healthyKey);
  assert.equal(healthy.content.run.status, "complete");
  assert.equal(healthy.content.run.metrics.healthySources, planned.length);
  assert.equal(healthy.window_start.toISOString(), "2013-07-19T00:00:00.000Z");
  assert.equal(healthy.window_end.toISOString(), "2013-07-20T00:00:00.000Z");
  await composeDaily(partialKey);
  assert.equal((await report("daily", partialKey)).content.run.status, "partial");
  assert.equal(provider.hits(), hits);
});

test("normal daily becomes due exactly at Beijing 08:00", () => {
  assert.equal(dueDaily(new Date("2026-10-03T07:59:59.999+08:00")), "2026-10-02");
  assert.equal(dueDaily(new Date("2026-10-03T08:00:00.000+08:00")), "2026-10-03");
});

test("a frozen daily keeps the previous 08:00-to-08:00 window and is independent of a same-date pilot", async () => {
  await sources();
  const id = `research-report-${T}-daily`;
  const key = "2013-07-10";
  const before = await report("pilot", key);
  const oldDate = process.env.RESEARCH_RUN_DATE;
  try {
    process.env.RESEARCH_RUN_DATE = key;
    await assert.rejects(createResearchRun(id, "daily", new Date("2013-07-09T23:59:59.999Z")), /not closed/);
    const daily = await createResearchRun(id, "daily", new Date("2013-07-10T00:00:00.000Z"));
    runIds.push(id); dailyKeys.push(key);
    assert.equal(daily.kind, "daily");
    assert.equal(daily.window_start.toISOString(), "2013-07-09T00:00:00.000Z");
    assert.equal(daily.window_end.toISOString(), "2013-07-10T00:00:00.000Z");
    for (const sourceId of sourceIds) await sql`INSERT INTO research_fetches(run_id,source_id,url,status)
      VALUES(${id},${sourceId},${`https://example.org/${id}/${sourceId}`},'ok')`;
    process.env.MODEL_RUN_ID = id;
    const live = await material(id, "daily-live", "algorithm", true, "pass", false);
    const imported = await material(id, "daily-import", "algorithm");
    assert.equal(await freezeAdmissions(id), 1);
    assert.equal((await sql`SELECT admitted FROM research_members WHERE run_id=${id} AND article_id=${imported}`)[0]!.admitted, false);
    await sql`UPDATE research_members SET state='pass' WHERE run_id=${id} AND admitted`;
    const result = await composePilot(id);
    assert.equal(result.entries, 1);
    assert.equal(result.key, key);
    const saved = await report("daily", key);
    assert.equal(saved.content.run.kind, "daily");
    assert.equal(saved.content.run.status, "complete");
    assert.equal(saved.content.sections[0].items[0].itemId, live);
    assert.ok(saved.content.sections[0].items[0].researchBrief);
    assert.equal(saved.window_start.toISOString(), daily.window_start.toISOString());
    assert.equal(saved.window_end.toISOString(), daily.window_end.toISOString());
    assert.deepEqual(await report("pilot", key), before);
    assert.deepEqual(await composePilot(id), result);
    assert.equal((await report("daily", key)).revision, saved.revision);
  } finally {
    if (oldDate === undefined) delete process.env.RESEARCH_RUN_DATE; else process.env.RESEARCH_RUN_DATE = oldDate;
  }
});

test("explicit rule-only recovery publishes completed nonempty results and actual gaps with zero model requests", async () => {
  const id = await run("rule-only", "2013-07-14", true);
  const ready = await material(id, "rule-ready", "algorithm");
  const noBrief = await material(id, "rule-no-brief", "ai4ai");
  const pending = await material(id, "rule-pending", "ai4s");
  const held = await material(id, "rule-held", "algorithm");
  await sql`UPDATE publications SET research_brief=NULL WHERE article_id=${noBrief}`;
  await freezeAdmissions(id);
  await sql`UPDATE research_members SET state='pass' WHERE run_id=${id} AND article_id=ANY(${[ready, noBrief]})`;
  await sql`UPDATE research_members SET state='unknown-receipt' WHERE run_id=${id} AND article_id=${held}`;
  const hits = provider.hits();
  const [before] = await sql`SELECT (SELECT count(*) FROM receipts)::int AS receipts,(SELECT count(*) FROM receipt_attempts)::int AS attempts`;
  const previousEnabled = config.modelCallsEnabled;
  const previousEnv = { enabled: process.env.MODEL_CALLS_ENABLED, key: process.env.LLM_API_KEY, url: process.env.LLM_BASE_URL };
  config.modelCallsEnabled = false; process.env.MODEL_CALLS_ENABLED = "false";
  delete process.env.LLM_API_KEY; process.env.LLM_BASE_URL = "http://127.0.0.1:1";
  try {
    const result = await composePilot(id, false, { ruleOnly: true });
    assert.equal(result.entries, 1);
    const saved = await report("pilot", result.key);
    assert.equal(saved.model, "rule"); assert.equal(saved.origin, "manual");
    assert.equal(saved.content.generator.model, "rule");
    assert.equal(saved.content.generator.version, "research-rule-lead-v1");
    assert.equal(saved.content.run.status, "partial");
    assert.match(saved.content.title, /部分结果/);
    assert.match(saved.content.lead.title, /部分结果.*1 项研究/);
    assert.equal(saved.content.sections[0].items[0].itemId, ready);
    assert.ok(saved.content.run.gaps.length > 0);
    for (const gap of saved.content.run.gaps) assert.ok(saved.content.lead.leadParagraph.includes(gap));
    assert.equal(saved.content.run.metrics.pending, 1);
    assert.equal(saved.content.run.metrics.unknownOutcome, 1);
    assert.equal(saved.content.run.metrics.selectedWithoutBrief, 1);
    assert.equal((await sql`SELECT state FROM research_members WHERE run_id=${id} AND article_id=${pending}`)[0].state, "pending");
    assert.deepEqual(await composePilot(id, false, { ruleOnly: true }), result);
    assert.equal((await report("pilot", result.key)).revision, 1);
    await composePilot(id, true, { ruleOnly: true });
    const revised = await report("pilot", result.key);
    assert.equal(revised.revision, 2);
    assert.deepEqual(revised.content.lead, saved.content.lead, "the same retained results produce the same rule lead");
    assert.equal((await sql`SELECT count(*)::int AS n FROM report_revisions WHERE report_id=${saved.id}`)[0].n, 1);
    assert.deepEqual((await sql`SELECT (SELECT count(*) FROM receipts)::int AS receipts,(SELECT count(*) FROM receipt_attempts)::int AS attempts`)[0], before);
    assert.equal(provider.hits(), hits);
    assert.equal(await getModelRun(id), null, "rule-only composition does not create a model budget or request");
  } finally {
    config.modelCallsEnabled = previousEnabled;
    for (const [name, value] of [["MODEL_CALLS_ENABLED", previousEnv.enabled], ["LLM_API_KEY", previousEnv.key], ["LLM_BASE_URL", previousEnv.url]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
  }
});

test("rule-only intraday revisions retain the monotonic cutoff guard without model requests", async () => {
  await sources();
  const key = "2013-07-15"; dailyKeys.push(key);
  const previousEnabled = config.modelCallsEnabled; config.modelCallsEnabled = false;
  const hits = provider.hits();
  try {
    const firstId = `refresh-${key}-09`, nextId = `refresh-${key}-12`;
    for (const [id, end] of [[firstId, "2013-07-15T01:30:00Z"], [nextId, "2013-07-15T04:30:00Z"]]) {
      runIds.push(id);
      await createResearchRun(id, "daily", new Date(end), { start: new Date("2013-07-14T00:00:00Z"), end: new Date(end) });
      await material(id, id, "algorithm", true, "pass", false);
      await freezeAdmissions(id);
      await sql`UPDATE research_members SET state='pass' WHERE run_id=${id} AND admitted`;
      await composePilot(id, true, { ruleOnly: true });
    }
    const before = await report("daily", key);
    assert.match(before.content.title, /日内更新.*部分结果/);
    assert.equal(before.window_end.toISOString(), "2013-07-15T04:30:00.000Z");
    await assert.rejects(composePilot(firstId, true, { ruleOnly: true }), /旧时段不能覆盖/);
    assert.deepEqual(await report("daily", key), before);
    assert.equal(provider.hits(), hits);
  } finally { config.modelCallsEnabled = previousEnabled; }
});
