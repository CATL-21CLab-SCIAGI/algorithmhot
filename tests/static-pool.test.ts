import test from "node:test";
import assert from "node:assert/strict";
import { load } from "cheerio";
import { collectSnapshot } from "../scripts/static-site.ts";
import { collectPoolSsrPages, renderSsrSite } from "../scripts/static-site/ssr.ts";
import { sanitizeItem, selectedItems, poolItems } from "../scripts/static-site/model.ts";
import type { Snapshot, PublicItem } from "../scripts/static-site/model.ts";
import { validateStaticLinks } from "../scripts/static-site/render.ts";

const base = "https://pkucy2016.github.io/algorithmhot/";
const rawItems = Array.from({ length: 41 }, (_, i) => ({
  id: `paper_${i}`, title: i < 2 ? `Selected ${i}` : `Reviewed unselected ${i}`, selected: i < 2, summary: "Public research summary",
  source: { name: "arXiv" }, links: { original: `https://arxiv.org/abs/2610.${String(i).padStart(5, "0")}` },
  publishedAt: "2026-10-01T17:59:58.000Z", timelineAt: new Date(Date.parse("2026-10-05T02:00:00Z") - i * 60_000).toISOString(),
  category: "algorithm", tags: ["算法"], research: { announcedOn: "2026-10-05", originalPublishedAt: "2026-10-01T17:59:58.000Z", evidenceBasis: "abstract" },
}));
const getApi = async (route: string): Promise<unknown> => {
  if (route === "/api/site/topics") return { topics: [] };
  if (route.startsWith("/api/site/reports/")) return { items: [] };
  if (route.startsWith("/api/site/timeline?")) return { cards: rawItems.filter(item => item.selected).map(item => ({ item })), nextCursor: null };
  if (route.startsWith("/api/site/pool?")) {
    const page = Number(new URL(route, "http://reader.example").searchParams.get("page"));
    return { page, pageCount: 2, total: 41, items: rawItems.slice((page - 1) * 40, page * 40) };
  }
  const item = rawItems.find(item => route === `/api/site/items/${item.id}`);
  if (item) return item;
  throw new Error(`Unexpected API read: ${route}`);
};
const shell = (body: string) => `<!doctype html><html><head><title>Local title</title><link rel="stylesheet" href="/assets/root-pool.css"></head><body><nav aria-label="主导航"><a href="/">精选</a><a href="/all">全部</a></nav><main id="main"><div>${body}</div></main></body></html>`;
const cards = (items: PublicItem[]) => items.length ? `<section aria-label="2026-10-05"><div class="native-day-header">10月5日 <span class="num">${items.length}</span></div><ol>${items.map(item => `<li class="native-slot"><article data-item-id="${item.id}" class="native-card"><h2><a href="/items/${item.id}">${item.title}</a></h2><a href="${item.sourceUrl}">原文</a></article></li>`).join("")}</ol></section>` : "";
const nativePool = (snapshot: Snapshot, route: string) => {
  const url = new URL(route, "http://reader.example"), category = url.searchParams.get("category"), page = Number(url.searchParams.get("page") ?? 1);
  const items = poolItems(snapshot).filter(item => !category || item.category === category), count = Math.max(1, Math.ceil(items.length / 40));
  const href = (n: number) => `/all?${category ? `category=${category}&` : ""}page=${n}`;
  return shell(`<div class="pb-6 native-all-layout"><h1>全部动态</h1><a href="/all?category=algorithm">算法</a><div data-native-pool="true">${cards(items.slice((page - 1) * 40, page * 40))}</div>${count > 1 ? `<nav aria-label="分页"><a href="${href(1)}">1</a><a href="${href(count)}">${count}</a></nav>` : ""}</div>`);
};
const home = (items: PublicItem[]) => shell(`<div class="pb-6"><h1>精选</h1><div class="relative">${cards(items)}</div></div>`);
function getSsr(snapshot: Snapshot) {
  return async (route: string): Promise<string> => {
    if (route === "/assets/root-pool.css") return ".native-card{color:#123}";
    if (route.startsWith("/all")) return nativePool(snapshot, route);
    if (route === "/" || route.startsWith("/?category=")) {
      const category = new URL(route, "http://reader.example").searchParams.get("category");
      return home(selectedItems(snapshot).filter(item => !category || item.category === category));
    }
    if (route.startsWith("/items/")) return shell(`<h1>Public detail</h1><a href="https://arxiv.org">原文</a>`);
    if (route === "/agent") return shell('<div class="reading-layout"><div><button role="tab">Reader</button></div><aside></aside></div>');
    return shell('<section><h1>Public shell</h1></section>');
  };
}

test("publication collection includes all reviewed pool pages and keeps selected membership distinct", async () => {
  const calls: string[] = [];
  const snapshot = await collectSnapshot(async route => { calls.push(route); return getApi(route); }, base);
  assert.equal(snapshot.items.length, 41);
  assert.equal(poolItems(snapshot).length, 41);
  assert.equal(selectedItems(snapshot).length, 2);
  assert.ok(calls.includes("/api/site/pool?page=2"));
  assert.equal(snapshot.items.find(item => item.id === "paper_40")?.selected, false);
  assert.equal(snapshot.items[0].research?.announcedOn, "2026-10-05");
  assert.equal(snapshot.items[0].publishedAt, "2026-10-01T17:59:58.000Z");
});

test("pool collection fails rather than hiding API caps, changing totals or repeated/incomplete pages", async () => {
  for (const mutation of [
    (value: any) => ({ ...value, total: 2000, pageCount: 50 }),
    (value: any) => value.page === 2 ? { ...value, total: 42 } : value,
    (value: any) => value.page === 2 ? { ...value, items: [rawItems[0]] } : value,
    (value: any) => value.page === 2 ? { ...value, items: [] } : value,
  ]) await assert.rejects(collectSnapshot(async route => { const value = await getApi(route); return route.startsWith("/api/site/pool?") ? mutation(value) : value; }, base), /pool/);
});

test("actual SSR export puts reviewed nonselected items only in all pages while preserving native cards and pagination", async () => {
  const snapshot = await collectSnapshot(getApi, base, "2026-10-05T02:30:00.000Z");
  const files = await renderSsrSite(snapshot, getSsr(snapshot));
  const html = (file: string) => String(files.get(file));
  const itemIds = (file: string) => load(html(file))("article[data-item-id]").map((_, node) => node.attribs["data-item-id"]).get();
  assert.deepEqual(itemIds("index.html"), ["paper_0", "paper_1"]);
  assert.equal(itemIds("all/index.html").length, 40);
  assert.deepEqual(itemIds("all/page/2/index.html"), ["paper_40"]);
  assert.equal(itemIds("category/algorithm/index.html").length, 2);
  assert.equal(itemIds("all/category/algorithm/index.html").length, 40);
  assert.deepEqual(itemIds("all/category/algorithm/page/2/index.html"), ["paper_40"]);
  assert.match(html("all/index.html"), /native-all-layout/);
  assert.match(html("all/index.html"), /网页更新：2026-10-05 10:30 北京时间/);
  assert.match(html("all/index.html"), /更新网页不改写研究日期/);
  assert.match(html("all/index.html"), /href="\/algorithmhot\/all\/page\/2\/"/);
  assert.match(html("all/category/algorithm/index.html"), /href="\/algorithmhot\/all\/category\/algorithm\/page\/2\/"/);
  assert.match(html("all/index.html"), /https:\/\/arxiv.org\/abs\/2610.00039/);
  validateStaticLinks(new Map([...files].map(([file, value]) => [file, String(value)])), base);
});

test("SSR pool export rejects live membership drift instead of leaking a newly arrived out-of-snapshot item", async () => {
  const snapshot = await collectSnapshot(getApi, base);
  await assert.rejects(collectPoolSsrPages(snapshot, async route => nativePool(snapshot, route).replace('data-item-id="paper_0"', 'data-item-id="not_public"')), /scope/);
  await assert.rejects(collectPoolSsrPages(snapshot, async route => nativePool(snapshot, route).replace('data-item-id="paper_0"', 'data-item-id="paper_1"')), /membership or order/);
});

test("public research announcement dates do not overwrite original publication dates", () => {
  const item = sanitizeItem(rawItems[0]);
  assert.equal(item.research?.announcedOn, "2026-10-05");
  assert.equal(item.research?.originalPublishedAt, "2026-10-01T17:59:58.000Z");
  assert.equal(item.publishedAt, "2026-10-01T17:59:58.000Z");
  assert.equal(sanitizeItem({ ...rawItems[0], research: { announcedOn: "nonsense" } }).research?.announcedOn, undefined);
  assert.equal(sanitizeItem({ ...rawItems[0], research: { announcedOn: "2026-02-31" } }).research?.announcedOn, undefined);
});
