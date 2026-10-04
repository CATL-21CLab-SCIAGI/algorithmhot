import { gate, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { fetchItemsByIds, toItemSummary } from "@aihot/backend/publication/items";
import { v1Items } from "@aihot/backend/publication/v1";
import { itemFeed } from "@aihot/backend/publication/feeds";
import { latestAnswer } from "@aihot/backend/publication/agent";
import { createResearchRun } from "@aihot/backend/research/collect";
import { freezeAdmissions } from "@aihot/backend/research/admission";
import { makeResearchMetadata } from "@aihot/backend/sources/research";
import { generateResearchBrief, RESEARCH_BRIEF_VERSION } from "@aihot/backend/research/brief";
import { getModelRun } from "@aihot/backend/providers/model-runs";
import type { ResearchBrief } from "@aihot/contracts/research";
import { overrideFields } from "@aihot/backend/admin/content";

const T = tag();
const sourceId = `brief-${T}`;
const articleIds: string[] = [];
const runIds: string[] = [];
const env = { ...process.env };
const originalEnabled = config.modelCallsEnabled;
const sourceText = `Fixture ${T}. The authors propose a lightweight adapter for 3 avatar models. Their CPU comparison reports up to three orders of magnitude speedup; mobile rendering reaches 60 fps. Hardware models and independent replication are not reported.`;
const answer = {
  methodChange: "作者提出轻量适配器，改造头像模型的推理方法。",
  applicableTasks: "作者报告适用于头像模型的 CPU 推理和移动端渲染。",
  comparisonConditions: "作者在 3 个头像模型上比较，报告 CPU 最高加速 3 个数量级；移动端渲染达 60 fps。具体硬件型号和比较基线：未知，当前资料未提供。",
  limitations: "基于摘要，结果为作者报告。独立复现：未知，当前资料未提供。最高加速不代表所有条件。",
};
interface MockControl { invalid?: boolean; entered?: ReturnType<typeof gate<void>>; release?: ReturnType<typeof gate<void>> }
const controls = new Map<string, MockControl>();
const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
const provider = await stub(async (hit, req) => {
  const request = JSON.parse(req.body);
  requests.push(request);
  const input = JSON.parse(request.messages.find((m: { role: string }) => m.role === "user").content);
  const control = controls.get(input.sourceText);
  control?.entered?.open();
  if (control?.release) await control.release.promise;
  return { id: `${T}-${hit}`, choices: [{ message: { content: JSON.stringify(control?.invalid ? { ...answer, comparisonConditions: "" } : answer) } }], usage: { total_tokens: 42 } };
});
const envKeys = ["LLM_TRANSPORT", "LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "LLM_EXTRA_JSON", "MODEL_RUN_ID", "MODEL_RUN_MAX_CALLS", "MODEL_RUN_REPORT_RESERVE", "RESEARCH_ADMISSION_ENABLED"];
Object.assign(process.env, { LLM_TRANSPORT: "openai_compatible", LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "test-key", LLM_MODEL: "test-model", MODEL_RUN_MAX_CALLS: "600", MODEL_RUN_REPORT_RESERVE: "20", RESEARCH_ADMISSION_ENABLED: "true" });
delete process.env.LLM_EXTRA_JSON;
config.modelCallsEnabled = true;

after(async () => {
  for (const control of controls.values()) control.release?.open();
  await provider.close();
  await stopBoss();
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
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode) VALUES(${sourceId},'Brief fixture','rss','T1','editorial') ON CONFLICT DO NOTHING`;
  const now = new Date();
  const at = new Date(now.getTime() - 60_000);
  const runId = `brief-${T}-${label}`;
  await createResearchRun(runId, "pilot", now);
  runIds.push(runId); process.env.MODEL_RUN_ID = runId;
  // Receipt reuse is content-addressed: each independent scenario needs its own source input.
  const text = `${sourceText} Scenario: ${label}.`;
  const input = { sourceId, url: `https://example.org/${T}/${label}`, title: `Original ${label}`, bodyText: text, bodyStatus: "ok" as const, publishedAt: at, discoveredAt: at, via: "import" as const, backfill: "research-bootstrap", research: makeResearchMetadata({ originalPublishedAt: at, evidenceBasis: "abstract" }) };
  const { articleId } = await upsertMaterial(input);
  articleIds.push(articleId);
  await sql`INSERT INTO analyses(article_id,input_revision,origin,relevance,category,title_zh,summary_zh,score,selected)
    VALUES(${articleId},1,'rule','pass','algorithm',${`研究 ${label}`},'Do not use this unsupported derived summary',90,true)`;
  await publishArticle(articleId, { releasedAt: at });
  await sql`INSERT INTO research_members(run_id,article_id,source_id,in_window,state) VALUES(${runId},${articleId},${sourceId},${admitted},'pass')`;
  await freezeAdmissions(runId);
  return { articleId, runId, input };
}

test("research brief commits with its receipt, preserves explicit comparisons and is reused across public exports", async () => {
  const { articleId, runId, input: materialInput } = await material("ready");
  const hits = provider.hits();
  const first = await generateResearchBrief(articleId);
  assert.equal(first.state, "ready");
  assert.equal(first.brief?.comparisonConditions, answer.comparisonConditions);
  assert.equal(first.brief?.sourceRevision, 1);
  assert.equal(first.brief?.promptVersion, RESEARCH_BRIEF_VERSION);
  assert.equal(first.brief?.evidenceBasis, "abstract");
  assert.equal((await sql`SELECT status FROM receipts WHERE id=${first.receiptId!}`)[0]!.status, "completed");
  assert.equal((await sql`SELECT count(*)::int AS n FROM research_briefs WHERE article_id=${articleId}`)[0]!.n, 1);
  const repeated = await generateResearchBrief(articleId);
  assert.equal(repeated.state, "reused");
  assert.deepEqual(repeated.brief, first.brief);
  assert.equal(repeated.receiptId, first.receiptId);
  assert.equal(provider.hits(), hits + 1);
  assert.equal((await getModelRun(runId))!.callsUsed, 1);
  const input = JSON.parse(requests.at(-1)!.messages.find(m => m.role === "user")!.content);
  assert.deepEqual(input, { evidenceBasis: "abstract", sourceText: materialInput.bodyText });
  assert.ok(!JSON.stringify(requests.at(-1)).includes("unsupported derived summary"));
  const site = toItemSummary((await fetchItemsByIds([articleId])).get(articleId)!);
  assert.deepEqual(site.researchBrief, first.brief);
  const api = await v1Items({ mode: "selected", window: "7d", by: "timeline", category: null, q: null, limit: 100, cursor: null });
  const item = api.items.find(i => i.id === articleId)!;
  assert.deepEqual(item.researchBrief, first.brief);
  const feed = await itemFeed("selected", null);
  assert.ok(feed.includes(answer.comparisonConditions));
  const mcpText = latestAnswer({ ...api, items: [item] }, { window: "7d", mode: "selected", category: null, limit: 1 });
  for (const value of Object.values(answer)) assert.ok(mcpText.includes(value));
  const ledger = (await sql<{ payload: { researchBrief: ResearchBrief } }[]>`SELECT payload FROM selected_ledger WHERE article_id=${articleId} AND op='upsert' ORDER BY seq DESC LIMIT 1`)[0]!;
  assert.deepEqual(ledger.payload.researchBrief, first.brief);
});

test("a changed source retains a historical receipt but never publishes its stale brief", async () => {
  const { articleId, input } = await material("stale");
  const entered = gate();
  const release = gate();
  controls.set(input.bodyText, { entered, release });
  const hits = provider.hits();
  const pending = generateResearchBrief(articleId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entered.promise,
      pending.then(result => { throw new Error(`Expected a new provider request, got ${result.state}`); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Provider did not enter the test gate within 5s")), 5000); }),
    ]);
    await upsertMaterial({ ...input, bodyText: `${input.bodyText} Updated experimental setup is now available.` });
    release.open();
    const result = await pending;
    assert.equal(provider.hits(), hits + 1);
    assert.equal(result.state, "stale");
    assert.equal(result.brief?.sourceRevision, 1);
    assert.equal((await sql`SELECT status FROM receipts WHERE id=${result.receiptId!}`)[0]!.status, "completed");
    await publishArticle(articleId);
    assert.equal((await sql`SELECT research_brief FROM publications WHERE article_id=${articleId}`)[0]!.research_brief, null);
  } finally {
    if (timer) clearTimeout(timer);
    release.open();
    await pending.catch(() => {});
    controls.delete(input.bodyText);
  }
});

test("invalid model content stays failed without a published brief or automatic retry", async () => {
  const { articleId, runId, input } = await material("invalid");
  controls.set(input.bodyText, { invalid: true });
  const hits = provider.hits();
  try {
    await assert.rejects(generateResearchBrief(articleId), /unusable output/);
  } finally { controls.delete(input.bodyText); }
  assert.equal(provider.hits(), hits + 1);
  assert.equal((await getModelRun(runId))!.callsUsed, 1);
  assert.equal((await sql`SELECT * FROM research_briefs WHERE article_id=${articleId}`).length, 0);
  assert.equal((await sql`SELECT status FROM receipts WHERE subject=${`article:${articleId}@1`} AND purpose='research_brief'`)[0]!.status, "failed");
});

test("brief enrichment cannot spend on unadmitted or withdrawn material", async () => {
  const { articleId } = await material("not-admitted", false);
  const hits = provider.hits();
  await assert.rejects(generateResearchBrief(articleId), /not admitted/);
  await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${articleId}`;
  assert.equal((await generateResearchBrief(articleId)).state, "skipped");
  assert.equal(provider.hits(), hits);
});

test("audited brief corrections change every publication exit without changing original receipts, and expire on source revision", async () => {
  const { articleId, runId, input } = await material("review");
  const original = await generateResearchBrief(articleId);
  const [receipt] = await sql`SELECT * FROM receipts WHERE id=${original.receiptId!}`;
  const [stored] = await sql`SELECT * FROM research_briefs WHERE article_id=${articleId} AND input_revision=1`;
  const corrected = "作者提出轻量适配器；原始摘要中未展开的宏不能作为正式名称。";
  const reason = "按原始摘要复核：去除未展开宏作为名称的表述，比较条件保留未知。";
  const patch = { sourceRevision: 1, fields: { methodChange: corrected } };
  const hits = provider.hits();
  await overrideFields(articleId, { version: 0, reason, fields: { researchBrief: patch } }, "fixture-reviewer");
  assert.equal(provider.hits(), hits, "editorial review never invokes a model");
  assert.equal((await getModelRun(runId))!.callsUsed, 1);
  assert.deepEqual((await sql`SELECT * FROM receipts WHERE id=${original.receiptId!}`)[0], receipt);
  assert.deepEqual((await sql`SELECT * FROM research_briefs WHERE article_id=${articleId} AND input_revision=1`)[0], stored);
  const item = toItemSummary((await fetchItemsByIds([articleId])).get(articleId)!);
  assert.equal(item.researchBrief?.methodChange, corrected);
  assert.equal(item.researchBrief?.comparisonConditions, original.brief!.comparisonConditions);
  assert.equal(item.researchBrief?.editorialReview?.note, reason);
  assert.equal(item.researchBrief?.editorialReview?.sourceRevision, 1);
  const [audited] = await sql`SELECT actor,reason,before,after FROM audit_log WHERE subject=${`content:${articleId}`} AND action='content.override' ORDER BY id DESC LIMIT 1`;
  assert.equal(audited!.actor, "fixture-reviewer");
  assert.equal(audited!.reason, reason);
  assert.deepEqual(audited!.before, {});
  assert.equal(audited!.after.researchBrief.fields.methodChange, corrected);
  const api = await v1Items({ mode: "selected", window: "7d", by: "timeline", category: null, q: null, limit: 100, cursor: null });
  const exported = api.items.find(i => i.id === articleId)!;
  assert.deepEqual(exported.researchBrief, item.researchBrief);
  assert.ok((await itemFeed("selected", null)).includes(corrected));
  assert.ok(latestAnswer({ ...api, items: [exported] }, { window: "7d", mode: "selected", category: null, limit: 1 }).includes(corrected));
  const [ledger] = await sql`SELECT payload FROM selected_ledger WHERE article_id=${articleId} AND op='upsert' ORDER BY seq DESC LIMIT 1`;
  assert.deepEqual(ledger!.payload.researchBrief, item.researchBrief);

  for (const fields of [{}, { evidenceBasis: "fulltext" }, { receiptId: 42 }, { methodChange: " " }]) {
    await assert.rejects(overrideFields(articleId, { version: 1, reason, fields: { researchBrief: { sourceRevision: 1, fields } } }, "fixture-reviewer"));
  }
  await assert.rejects(overrideFields(articleId, { version: 0, reason, fields: { researchBrief: patch } }, "fixture-reviewer"), /已被修改/);

  await overrideFields(articleId, { version: 1, reason: "撤销本次文案修订", fields: {}, clear: ["researchBrief"] }, "fixture-reviewer");
  assert.deepEqual(toItemSummary((await fetchItemsByIds([articleId])).get(articleId)!).researchBrief, original.brief);
  await overrideFields(articleId, { version: 2, reason, fields: { researchBrief: patch } }, "fixture-reviewer");
  await upsertMaterial({ ...input, bodyText: `${input.bodyText} Revised source describes a different adapter.` });
  await publishArticle(articleId);
  assert.equal(toItemSummary((await fetchItemsByIds([articleId])).get(articleId)!).researchBrief, null);
  const next = await generateResearchBrief(articleId);
  assert.equal(next.brief?.sourceRevision, 2);
  const republished = toItemSummary((await fetchItemsByIds([articleId])).get(articleId)!).researchBrief!;
  assert.equal(republished.methodChange, answer.methodChange);
  assert.equal(republished.editorialReview, undefined, "a revision-1 correction must not attach to revision 2");
  await assert.rejects(overrideFields(articleId, { version: 3, reason, fields: { researchBrief: patch } }, "fixture-reviewer"), /原始资料已修订/);
  assert.deepEqual((await sql`SELECT * FROM receipts WHERE id=${original.receiptId!}`)[0], receipt);
  assert.deepEqual((await sql`SELECT * FROM research_briefs WHERE article_id=${articleId} AND input_revision=1`)[0], stored);
});

test("an evidence-basis correction must match verified source metadata and cannot survive a source revision", async () => {
  const { articleId, input } = await material("basis-review");
  await sql`UPDATE articles SET research=jsonb_set(research,'{evidenceBasis}','"unknown"') WHERE id=${articleId}`;
  const original = await generateResearchBrief(articleId);
  assert.equal(original.brief?.evidenceBasis, "unknown");
  const [receipt] = await sql`SELECT * FROM receipts WHERE id=${original.receiptId!}`;
  const reason = "已核对回执输入与当前资料正文一致，仅纠正证据依据标签。";
  const patch = { sourceRevision: 1, fields: { evidenceBasis: "fulltext" } };
  const hits = provider.hits();
  await assert.rejects(overrideFields(articleId, { version: 0, reason, fields: { researchBrief: patch } }, "fixture-reviewer"), /必须与当前原始资料已确认/);
  assert.equal((await sql`SELECT * FROM editorial_overrides WHERE article_id=${articleId}`).length, 0);
  await sql`UPDATE articles SET research=jsonb_set(research,'{evidenceBasis}','"fulltext"') WHERE id=${articleId}`;
  await overrideFields(articleId, { version: 0, reason, fields: { researchBrief: patch } }, "fixture-reviewer");
  const currentBrief = async () => toItemSummary((await fetchItemsByIds([articleId])).get(articleId)!).researchBrief;
  assert.equal((await currentBrief())?.evidenceBasis, "fulltext");
  assert.equal((await currentBrief())?.editorialReview?.note, reason);
  assert.equal((await currentBrief())?.methodChange, original.brief!.methodChange);
  assert.equal(provider.hits(), hits);
  assert.deepEqual((await sql`SELECT brief FROM research_briefs WHERE article_id=${articleId} AND input_revision=1`)[0]!.brief, original.brief);
  assert.deepEqual((await sql`SELECT * FROM receipts WHERE id=${original.receiptId!}`)[0], receipt);

  // Publication rechecks metadata, so an old patch cannot elevate a subsequently corrected source.
  await sql`UPDATE articles SET research=jsonb_set(research,'{evidenceBasis}','"abstract"') WHERE id=${articleId}`;
  await publishArticle(articleId);
  assert.equal((await currentBrief())?.evidenceBasis, "unknown");
  assert.equal((await currentBrief())?.editorialReview, undefined);
  await sql`UPDATE articles SET research=jsonb_set(research,'{evidenceBasis}','"fulltext"') WHERE id=${articleId}`;
  await upsertMaterial({ ...input, bodyText: `${input.bodyText} This is the next source revision.` });
  await publishArticle(articleId);
  assert.equal(await currentBrief(), null);
  const revised = await generateResearchBrief(articleId);
  assert.equal(revised.brief?.sourceRevision, 2);
  assert.equal((await currentBrief())?.editorialReview, undefined);
  await assert.rejects(overrideFields(articleId, { version: 1, reason, fields: { researchBrief: patch } }, "fixture-reviewer"), /原始资料已修订/);
  assert.deepEqual((await sql`SELECT * FROM receipts WHERE id=${original.receiptId!}`)[0], receipt);
});
