import { gate, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { sha256 } from "@aihot/backend/lib/ids";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { fetchItemsByIds, toItemSummary } from "@aihot/backend/publication/items";
import { v1Items } from "@aihot/backend/publication/v1";
import { loadReport, v1Daily } from "@aihot/backend/publication/reports";
import { createResearchRun } from "@aihot/backend/research/collect";
import { freezeAdmissions } from "@aihot/backend/research/admission";
import { makeResearchMetadata } from "@aihot/backend/sources/research";
import { generateResearchBrief } from "@aihot/backend/research/brief";
import { generateResearchRoadmap, RESEARCH_ROADMAP_VERSION, researchRoadmapSchemaForSource } from "@aihot/backend/research/roadmap";
import { getModelRun } from "@aihot/backend/providers/model-runs";

const T = tag();
const sourceId = `roadmap-${T}`;
const articleIds: string[] = [];
const runIds: string[] = [];
const reportKeys: string[] = [];
const env = { ...process.env };
const originalEnabled = config.modelCallsEnabled;
const sourceText = `Fixture ${T}. Protein sequences are the inputs. A masked adapter predicts missing residues. The output is a candidate protein sequence. Authors report evaluation on three held-out families. Independent replication is not provided.`;
const answer = {
  title: "从蛋白质序列到掩码补全候选",
  nodes: [
    { stage: "input", label: "蛋白质序列", detail: "以蛋白质序列为输入。", evidenceSnippet: "Protein sequences are the inputs." },
    { stage: "method", label: "掩码适配器", detail: "预测缺失的残基。", evidenceSnippet: "A masked adapter predicts missing residues." },
    { stage: "output", label: "候选序列", detail: "得到候选蛋白质序列。", evidenceSnippet: "The output is a candidate protein sequence." },
    { stage: "validation", label: "留出家族评估", detail: "作者报告在三个留出家族上评估，具体指标未知。", evidenceSnippet: "Authors report evaluation on three held-out families." },
  ],
  limitations: "基于摘要；作者报告的评估未给出指标。独立复现未核验。",
};
interface Control { invalid?: "schema" | "evidence"; entered?: ReturnType<typeof gate<void>>; release?: ReturnType<typeof gate<void>> }
const controls = new Map<string, Control>();
const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
const provider = await stub(async (hit, req) => {
  const request = JSON.parse(req.body); requests.push(request);
  const input = JSON.parse(request.messages.find((m: { role: string }) => m.role === "user").content);
  const control = controls.get(input.sourceText);
  control?.entered?.open();
  if (control?.release) await control.release.promise;
  const content = input.sourceUrl ? control?.invalid === "schema" ? { ...answer, nodes: [] }
    : control?.invalid === "evidence" ? { ...answer, nodes: answer.nodes.map((node, i) => i ? node : { ...node, evidenceSnippet: "An invented source statement." }) }
      : answer : { methodChange: "作者以掩码适配器补全序列。", applicableTasks: "蛋白质序列补全。", comparisonConditions: "作者报告三个留出家族，指标未知。", limitations: "基于摘要，独立复现未核验。" };
  return { id: `${T}-${hit}`, choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 42 } };
});
const envKeys = ["LLM_TRANSPORT", "LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "LLM_EXTRA_JSON", "MODEL_RUN_ID", "MODEL_RUN_MAX_CALLS", "MODEL_RUN_REPORT_RESERVE", "RESEARCH_ADMISSION_ENABLED"];
Object.assign(process.env, { LLM_TRANSPORT: "openai_compatible", LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "test-key", LLM_MODEL: "test-model", MODEL_RUN_MAX_CALLS: "600", MODEL_RUN_REPORT_RESERVE: "20", RESEARCH_ADMISSION_ENABLED: "true" });
delete process.env.LLM_EXTRA_JSON;
config.modelCallsEnabled = true;

after(async () => {
  for (const control of controls.values()) control.release?.open();
  await provider.close(); await stopBoss();
  if (reportKeys.length) await sql`DELETE FROM reports WHERE key=ANY(${reportKeys}::text[])`;
  if (runIds.length) {
    await sql`DELETE FROM research_members WHERE run_id=ANY(${runIds}::text[])`;
    await sql`DELETE FROM research_runs WHERE id=ANY(${runIds}::text[])`;
  }
  if (articleIds.length) await sql`DELETE FROM articles WHERE id=ANY(${articleIds}::text[])`;
  await sql`DELETE FROM sources WHERE id=${sourceId}`;
  config.modelCallsEnabled = originalEnabled;
  for (const key of envKeys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
  await closeDb();
});

async function material(label: string, admitted = true) {
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${sourceId},'Roadmap fixture','rss','T1','editorial') ON CONFLICT DO NOTHING`;
  const now = new Date(), at = new Date(now.getTime() - 60_000), runId = `roadmap-${T}-${label}`;
  await createResearchRun(runId, "pilot", now); runIds.push(runId); process.env.MODEL_RUN_ID = runId;
  const input = { sourceId, url: `https://example.org/${T}/${label}`, title: `Original ${label}`, bodyText: `${sourceText} Scenario: ${label}.`, bodyStatus: "ok" as const, publishedAt: at, discoveredAt: at, via: "import" as const, backfill: "research-bootstrap", research: makeResearchMetadata({ originalPublishedAt: at, evidenceBasis: "abstract" }) };
  const { articleId } = await upsertMaterial(input); articleIds.push(articleId);
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
    VALUES(${articleId},1,'rule','pass','ai4s',${`研究 ${label}`},'Unsupported derived summary must not enter model input',90,true)`;
  await publishArticle(articleId, { releasedAt: at });
  await sql`INSERT INTO research_members(run_id,article_id,source_id,in_window,state) VALUES(${runId},${articleId},${sourceId},${admitted},'pass')`;
  await freezeAdmissions(runId);
  return { articleId, runId, input };
}
const publicItem = async (id: string) => toItemSummary((await fetchItemsByIds([id])).get(id)!);

test("roadmap validates verbatim evidence, method groups, bounded structure and no extra output fields", () => {
  const schema = researchRoadmapSchemaForSource(sourceText);
  assert.equal(schema.safeParse(answer).success, true);
  assert.equal(schema.safeParse({ ...answer, nodes: [answer.nodes[0], answer.nodes[1], answer.nodes[3], answer.nodes[2]] }).success, true,
    "validation may precede an output; groups must not force a false execution order");
  for (const invalid of [
    { ...answer, nodes: answer.nodes.slice(0, 2) },
    { ...answer, nodes: [...answer.nodes].reverse() },
    { ...answer, nodes: answer.nodes.map(n => ({ ...n, stage: "input" })) },
    { ...answer, nodes: answer.nodes.map(n => ({ ...n, evidenceSnippet: n.evidenceSnippet.toLowerCase() })) },
    { ...answer, receiptId: 99 },
  ]) assert.equal(schema.safeParse(invalid).success, false);
});

test("roadmap commits its receipt, reuses the input, preserves original brief and projects only public fields", async () => {
  const { articleId, runId, input } = await material("ready");
  assert.equal((await publicItem(articleId)).researchRoadmap, null, "old records remain readable");
  await generateResearchBrief(articleId);
  const [originalBrief] = await sql`SELECT * FROM research_briefs WHERE article_id=${articleId}`;
  const hits = provider.hits();
  const first = await generateResearchRoadmap(articleId);
  assert.equal(first.state, "ready");
  assert.equal(first.roadmap!.sourceRevision, 1);
  assert.equal(first.roadmap!.sourceHash, sha256(input.bodyText));
  assert.equal(first.roadmap!.sourceUrl, input.url);
  assert.equal(first.roadmap!.evidenceBasis, "abstract");
  assert.equal(first.roadmap!.promptVersion, RESEARCH_ROADMAP_VERSION);
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${first.receiptId!}`)[0]!.status, "completed");
  assert.deepEqual((await sql`SELECT * FROM research_briefs WHERE article_id=${articleId}`)[0], originalBrief);
  assert.deepEqual((await publicItem(articleId)).researchBrief, originalBrief!.brief);
  assert.deepEqual(await generateResearchRoadmap(articleId), { ...first, state: "reused" });
  assert.equal(provider.hits(), hits + 1);
  assert.equal((await getModelRun(runId))!.callsUsed, 2);
  assert.deepEqual(JSON.parse(requests.at(-1)!.messages.find(m => m.role === "user")!.content), { sourceText: input.bodyText, evidenceBasis: "abstract", sourceUrl: input.url });
  const api = await v1Items({ mode: "selected", window: "7d", by: "timeline", category: null, q: null, limit: 100, cursor: null });
  const item = api.items.find(i => i.id === articleId)!;
  assert.deepEqual(item.researchRoadmap, first.roadmap);
  assert.deepEqual((await publicItem(articleId)).researchRoadmap, first.roadmap);
  const [ledger] = await sql`SELECT payload FROM selected_ledger WHERE article_id=${articleId} AND op='upsert' ORDER BY seq DESC LIMIT 1`;
  assert.deepEqual(ledger!.payload.researchRoadmap, first.roadmap);
  assert.ok(!JSON.stringify(item.researchRoadmap).includes("receipt"));
});

test("wrong schema or unsupported source snippets fail one received call without publication", async () => {
  for (const invalid of ["schema", "evidence"] as const) {
    const { articleId, runId, input } = await material(invalid);
    controls.set(input.bodyText, { invalid });
    const hits = provider.hits();
    await assert.rejects(generateResearchRoadmap(articleId), /unusable output/);
    assert.equal(provider.hits(), hits + 1);
    assert.equal((await getModelRun(runId))!.callsUsed, 1);
    assert.equal((await sql`SELECT * FROM research_roadmaps WHERE article_id=${articleId}`).length, 0);
    assert.equal((await publicItem(articleId)).researchRoadmap, null);
    assert.equal((await sql`SELECT status FROM receipts WHERE subject=${`article:${articleId}@1`} AND purpose='research_roadmap'`)[0]!.status, "failed");
  }
});

test("a source change during generation preserves receipt history without publishing a stale roadmap", async () => {
  const { articleId, input } = await material("stale");
  const entered = gate(), release = gate(); controls.set(input.bodyText, { entered, release });
  const pending = generateResearchRoadmap(articleId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([entered.promise, pending.then(r => { throw new Error(`Expected new request, got ${r.state}`); }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Provider did not enter")), 5000); })]);
    await upsertMaterial({ ...input, bodyText: `${input.bodyText} Additional revision details.` });
    release.open();
    const result = await pending;
    assert.equal(result.state, "stale");
    assert.equal(result.roadmap!.sourceRevision, 1);
    assert.equal((await sql`SELECT status FROM receipts WHERE id=${result.receiptId!}`)[0]!.status, "completed");
    await publishArticle(articleId);
    assert.equal((await publicItem(articleId)).researchRoadmap, null);
  } finally { if (timer) clearTimeout(timer); release.open(); await pending.catch(() => {}); }
});

test("source basis and content hash bind reuse even when a correction does not increment revision", async () => {
  const { articleId } = await material("basis");
  const original = await generateResearchRoadmap(articleId);
  await sql`UPDATE articles SET research=jsonb_set(research,'{evidenceBasis}','"fulltext"') WHERE id=${articleId}`;
  await publishArticle(articleId);
  assert.equal((await publicItem(articleId)).researchRoadmap, null);
  const next = await generateResearchRoadmap(articleId);
  assert.equal(next.state, "ready");
  assert.equal(next.roadmap!.evidenceBasis, "fulltext");
  assert.notEqual(next.receiptId, original.receiptId);
  assert.equal((await sql`SELECT * FROM research_roadmaps WHERE article_id=${articleId}`).length, 2);
  await sql`UPDATE articles SET body_text=body_text || ' Changed source bytes.' WHERE id=${articleId}`;
  await publishArticle(articleId);
  assert.equal((await publicItem(articleId)).researchRoadmap, null);
});

test("unadmitted, unselected or withdrawn records cannot generate a roadmap", async () => {
  const { articleId } = await material("unadmitted", false), hits = provider.hits();
  await assert.rejects(generateResearchRoadmap(articleId), /not admitted/);
  await sql`UPDATE publications SET selected=false WHERE article_id=${articleId}`;
  assert.equal((await generateResearchRoadmap(articleId)).state, "skipped");
  await sql`UPDATE publications SET selected=true,visibility='withdrawn' WHERE article_id=${articleId}`;
  assert.equal((await generateResearchRoadmap(articleId)).state, "skipped");
  assert.equal(provider.hits(), hits);
});

test("report diagrams are frozen with citations, old reports stay compatible and withdrawals remove diagrams", async () => {
  const { articleId, input } = await material("report");
  const result = await generateResearchRoadmap(articleId);
  const key = `roadmap-${T}`; reportKeys.push(key);
  const citation = { itemId: articleId, title: "蛋白质路线", summary: "作者报告", sourceName: "Fixture", sourceUrl: input.url, researchRoadmap: result.roadmap };
  const content = { title: "图文试刊", sections: [{ label: "AI4S", items: [citation] }] };
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at,model,origin)
    VALUES('pilot',${key},${input.publishedAt},${new Date()},${sql.json(content as never)},now(),'fixture','manual')`;
  const report = await loadReport("pilot", key);
  assert.deepEqual(report!.sections[0]!.items[0]!.researchRoadmap, result.roadmap);
  assert.deepEqual((await v1Daily(key, "pilot"))!.report.sections[0]!.items[0]!.researchRoadmap, result.roadmap);
  await sql`UPDATE reports SET content=content #- '{sections,0,items,0,researchRoadmap}' WHERE kind='pilot' AND key=${key}`;
  assert.equal((await loadReport("pilot", key))!.sections[0]!.items[0]!.researchRoadmap, null, "do not silently insert a new diagram into an old issue");
  await sql`UPDATE reports SET content=${sql.json(content as never)} WHERE kind='pilot' AND key=${key}`;
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${articleId}`;
  const withdrawn = (await loadReport("pilot", key))!.sections[0]!.items[0]!;
  assert.equal(withdrawn.available, false);
  assert.equal(withdrawn.researchRoadmap, null);
  assert.equal((await v1Daily(key, "pilot"))!.report.sections[0]!.items.length, 0);
});
