import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { extractArticleBody, readable } from "@aihot/backend/content/extract";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publishArticle } from "@aihot/backend/publication/publish";
import { makeResearchMetadata } from "@aihot/backend/sources/research";

const sourceId = `research-extraction-${tag()}`;
const text = "The authors describe their method and report experimental conditions in this original institution article. ".repeat(12);
const html = `<html><head><title>Research</title></head><body><article><h1>Research</h1><p>${text}</p></article></body></html>`;
const server = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(html); });
let base: string;
const priorPrivate = config.allowPrivateNetworkFetch;
before(async () => {
  config.allowPrivateNetworkFetch = true;
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await sql`INSERT INTO sources(id,name,kind,config) VALUES(${sourceId},'Institution extraction fixture','rss',${sql.json({ researchSourceKind: "institution" })})`;
});
after(async () => { config.allowPrivateNetworkFetch = priorPrivate; await new Promise<void>(resolve => server.close(() => resolve())); await closeDb(); });

for (const sameBody of [false, true]) test(`institution evidence reaches publication without changing source raw or dates (${sameBody ? "same" : "new"} body)`, async () => {
  const url = `${base}/${tag()}`;
  const research = makeResearchMetadata({ evidenceBasis: "source_summary", originalPublishedAt: "2026-10-01T01:00:00Z", observedAt: "2026-10-03T02:00:00Z" });
  const raw = { description: "The original RSS summary", originalMarker: tag() };
  const { articleId } = await upsertMaterial({ sourceId, url, title: "机构研究", excerpt: raw.description, research, raw, via: "fetch",
    publishedAt: new Date(research.originalPublishedAt!), ...(sameBody ? { bodyText: readable(html, url)!.text, bodyStatus: "pending" as const } : {}),
  });
  await publishArticle(articleId);
  const [before] = await sql`SELECT revision,published_at,timeline_at,raw FROM articles WHERE id=${articleId}`;
  assert.equal(await extractArticleBody(articleId, false), "ok");
  const [article] = await sql`SELECT revision,published_at,timeline_at,raw,research FROM articles WHERE id=${articleId}`;
  const [publication] = await sql`SELECT research FROM publications WHERE article_id=${articleId}`;
  assert.equal(article.research.evidenceBasis, "fulltext");
  assert.deepEqual(publication.research, article.research);
  assert.deepEqual(article.raw, before.raw);
  assert.deepEqual(article.published_at, before.published_at);
  assert.deepEqual(article.timeline_at, before.timeline_at);
  assert.equal(article.research.observedAt, research.observedAt);
  assert.equal(article.revision, before.revision + (sameBody ? 0 : 1));
});

test("independent limiter instances share the database gate and persist failed request starts", async () => {
  const moduleUrl = new URL("../packages/backend/src/lib/arxiv-rate-limit.ts", import.meta.url);
  const a: typeof import("@aihot/backend/lib/arxiv-rate-limit") = await import(`${moduleUrl.href}?independent=a`);
  const b: typeof import("@aihot/backend/lib/arxiv-rate-limit") = await import(`${moduleUrl.href}?independent=b`);
  let release!: () => void;
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const starts: number[] = [];
  const first = a.withArxivRateLimit("https://rss.arxiv.org/rss/cs.LG", async () => { starts.push(Date.now()); enter(); await held; throw new Error("fixture failure"); });
  const rejection = assert.rejects(first, /fixture failure/);
  await entered;
  const second = b.withArxivRateLimit("https://export.arxiv.org/api/query", async () => { starts.push(Date.now()); });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(starts.length, 1, "independent instances must not overlap their requests");
  release();
  await Promise.all([rejection, second]);
  assert.ok(starts[1]! - starts[0]! >= 3050, `only ${starts[1]! - starts[0]!} ms elapsed between starts`);
  const [row] = await sql`SELECT value FROM settings WHERE key='fetch.arxiv.startedAt'`;
  assert.ok(row.value.startedAt >= starts[0]!);
});
