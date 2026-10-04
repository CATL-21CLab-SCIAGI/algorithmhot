import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { fetchItemsByIds, toItemSummary, toFeedItemSummary } from "@aihot/backend/publication/items";
import { rowToV1 } from "@aihot/backend/publication/v1";
import { loadReport, v1Daily } from "@aihot/backend/publication/reports";
import { itemFeed } from "@aihot/backend/publication/feeds";
import { adaptIntervals } from "@aihot/backend/sources/collect";
import { makeResearchMetadata, parseArxivIdentity } from "@aihot/backend/sources/research";

const T = tag();
const editorial = `research-editorial-${T}`;
const other = `research-cross-category-${T}`;
const signalSource = `research-signal-${T}`;
let paperNumber = Number(String(Date.now()).slice(-5));
const observed = new Date();
before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, enabled, config, interval_minutes, next_fetch_at)
    VALUES (${editorial}, 'arXiv test', 'rss', 'T1_5', 'editorial', true, '{"fixedInterval":true}', 360, '2100-01-01'),
      (${other}, 'arXiv cross category', 'rss', 'T1_5', 'editorial', false, '{}', 360, '2100-01-01'),
      (${signalSource}, 'HF signal test', 'json_list', 'T1_5', 'hot_signal', false, '{}', 360, '2100-01-01')`;
});
after(() => closeDb());

function materials() {
  const arxivId = `2609.${String(++paperNumber % 100000).padStart(5, "0")}`;
  const identity = parseArxivIdentity(`${arxivId}v1`)!;
  const research = makeResearchMetadata({ identity, originalPublishedAt: "2026-09-10T00:00:00Z", observedAt: observed, evidenceBasis: "abstract" });
  const paper = { sourceId: editorial, url: `${identity.canonicalUrl}v1`, title: "Research method", bodyText: "A source abstract.", excerpt: "A source abstract.", bodyStatus: "ok" as const, via: "fetch" as const, discoveredAt: observed, backfill: "first-import", research };
  const signal = { ...paper, sourceId: signalSource, identityKey: `hf:${arxivId}`, url: `https://huggingface.co/papers/${arxivId}`, title: "HF rendering", research: { ...research, signalOnly: true, communitySelectedAt: "2026-10-02T00:00:00.000Z" } };
  return { paper, signal, identity };
}

for (const first of ["signal", "paper"] as const) test(`HF ${first === "signal" ? "before" : "after"} paper never owns the body identity and enriches publication`, async () => {
  const input = materials();
  const firstResult = await upsertMaterial(input[first]);
  const second = first === "signal" ? "paper" : "signal";
  const secondResult = await upsertMaterial(input[second]);
  const paperId = first === "paper" ? firstResult.articleId : secondResult.articleId;
  const signalId = first === "signal" ? firstResult.articleId : secondResult.articleId;
  assert.notEqual(paperId, signalId);
  const [stored] = await sql`SELECT source_id, title, body_text, identity_key FROM articles WHERE id=${paperId}`;
  assert.equal(stored!.source_id, editorial);
  assert.equal(stored!.identity_key, input.identity.canonicalKey);
  assert.equal(stored!.title, "Research method");
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, reason_zh, score, selected)
    VALUES (${paperId}, 1, 'rule', 'pass', 'algorithm', '研究方法', '作者报告的方法变化；基于摘要。', '方法具有迁移价值', 90, true)`;
  await publishArticle(paperId, { releasedAt: observed });
  await publishArticle(signalId);
  const row = (await fetchItemsByIds([paperId])).get(paperId)!;
  for (const output of [toItemSummary(row), toFeedItemSummary(row), rowToV1(row)]) {
    assert.equal(output.research?.communitySelectedAt, "2026-10-02T00:00:00.000Z");
    assert.equal(output.research?.originalPublishedAt, "2026-09-10T00:00:00.000Z");
    assert.equal(output.research?.signalOnly, false);
  }
  const [hidden] = await sql`SELECT eligible, selected FROM publications WHERE article_id=${signalId}`;
  assert.equal(hidden!.eligible, false);
  assert.equal(hidden!.selected, false);
  const [ledger] = await sql`SELECT payload FROM selected_ledger WHERE article_id=${paperId} ORDER BY seq DESC LIMIT 1`;
  assert.equal(ledger!.payload.research.canonicalKey, input.identity.canonicalKey);
  const rss = await itemFeed("selected", null);
  const rssItem = rss.split("<item>").find(item => item.includes(`<guid isPermaLink="false">${paperId}</guid>`));
  assert.ok(rssItem);
  assert.match(rssItem, /基于摘要/);
  assert.match(rssItem, /2026-10-02T00:00:00.000Z/);
  assert.doesNotMatch(rssItem, /<pubDate>/, "unknown source publication must not be replaced by observation time");
});

test("cross-category arXiv arrivals add discovery/version metadata without replacing the owned abstract", async () => {
  const { paper, identity } = materials();
  const first = await upsertMaterial(paper);
  const alias = await upsertMaterial({ ...paper, sourceId: other, url: `https://arxiv.org/pdf/${identity.id}v2.pdf`, title: "Another rendering", research: { ...paper.research, arxivVersion: "v2", arxivVersions: ["v2"], revisedAt: observed.toISOString() } });
  assert.equal(alias.articleId, first.articleId);
  assert.equal(alias.created, false);
  assert.equal(alias.revised, false);
  assert.equal(alias.metadataChanged, true);
  const [stored] = await sql`SELECT research, title, revision FROM articles WHERE id=${first.articleId}`;
  assert.deepEqual(stored!.research.arxivVersions, ["v1", "v2"]);
  assert.equal(stored!.title, paper.title);
  const discoveries = await sql`SELECT source_id FROM article_discoveries WHERE article_id=${first.articleId}`;
  assert.equal(discoveries.length, 2);
  const again = await upsertMaterial({ ...paper, discoveredAt: new Date(observed.getTime() + 1000), research: { ...paper.research, observedAt: new Date(observed.getTime() + 1000).toISOString() } });
  assert.equal(again.metadataChanged, undefined);
});

test("citation exports carry source metadata, keep unknown publication null, and redact withdrawn research", async () => {
  const { paper } = materials();
  const { articleId } = await upsertMaterial(paper);
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected)
    VALUES (${articleId}, 1, 'rule', 'pass', 'algorithm', '论文', '摘要', 90, true)`;
  await publishArticle(articleId, { releasedAt: observed });
  const key = `metadata-${T}`;
  const content = { title: "研究元数据测试", sections: [{ label: "算法", items: [{ itemId: articleId, title: "论文", summary: "摘要", sourceName: "arXiv", sourceUrl: paper.url }] }], flashes: [{ itemId: articleId, title: "快讯", sourceUrl: paper.url }] };
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at, origin)
    VALUES ('daily', ${key}, ${observed}, ${observed}, ${sql.json(content)}, ${observed}, 'manual')`;
  try {
    const detail = await loadReport("daily", key);
    assert.equal(detail!.title, content.title);
    assert.equal(detail!.sections[0]!.items[0]!.research?.arxivId, paper.research.arxivId);
    assert.equal(detail!.sections[0]!.items[0]!.publishedAt, null);
    const api = await v1Daily(key);
    assert.equal(api!.report.sections[0].items[0].research.arxivId, paper.research.arxivId);
    assert.equal(api!.report.flashes[0].publishedAt, null);
    await sql`UPDATE publications SET visibility='withdrawn' WHERE article_id=${articleId}`;
    const hidden = (await loadReport("daily", key))!.sections[0]!.items[0]!;
    assert.equal(hidden.available, false);
    assert.equal(hidden.research, null);
    assert.equal((await v1Daily(key))!.report.sections[0].items.length, 0);
  } finally {
    await sql`DELETE FROM reports WHERE kind='daily' AND key=${key}`;
  }
});

test("fixed research source frequency survives automatic adaptation", async () => {
  await adaptIntervals();
  const [row] = await sql`SELECT interval_minutes FROM sources WHERE id=${editorial}`;
  assert.equal(row!.interval_minutes, 360);
});
