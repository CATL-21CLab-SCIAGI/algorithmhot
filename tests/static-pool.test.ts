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
const readerDay = (item: PublicItem) => {
  const value = item.research?.originalPublishedAt ?? (item.research?.arxivId ? item.timelineAt : item.publishedAt ?? item.timelineAt);
  return value ? new Date(Date.parse(value) + 8 * 3600_000).toISOString().slice(0, 10) : "unknown";
};
const cards = (items: PublicItem[]) => {
  const groups = new Map<string, PublicItem[]>();
  for (const item of items) groups.set(readerDay(item), [...(groups.get(readerDay(item)) ?? []), item]);
  return [...groups].map(([day, dayItems]) => `<section aria-label="${day}"><div class="native-day-header">${day} <span class="num">${dayItems.length}</span></div><ol>${dayItems.map(item => `<li class="native-slot"><article data-item-id="${item.id}" class="native-card"><h2><a href="/items/${item.id}">${item.title}</a></h2><a href="${item.sourceUrl}">原文</a></article></li>`).join("")}</ol></section>`).join("");
};
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

/** A live reader can still group cards by announcement/observation day while the public
 * snapshot is rebuilt around the original publication day. This fixture exercises the
 * native-day-template fallback used by the static exporter. */
function getObservedDaySsr(snapshot: Snapshot) {
  const observedCards = (items: PublicItem[]) => {
    const groups = new Map<string, PublicItem[]>();
    for (const item of items) {
      const at = item.timelineAt ?? item.publishedAt;
      const day = at ? new Date(Date.parse(at) + 8 * 3600_000).toISOString().slice(0, 10) : "unknown";
      groups.set(day, [...(groups.get(day) ?? []), item]);
    }
    return [...groups].map(([day, dayItems]) => {
      const date = new Date(`${day}T00:00:00Z`), label = `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`, weekday = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"][date.getUTCDay()];
      return `<section aria-label="${day}"><div class="native-day-header"><div class="mobile"><span>${label}</span><span>${weekday.replace("星期", "周")}</span></div><div class="desktop"><button>${label}</button><span></span><span>${weekday} · <span class="num">${dayItems.length}</span> 条</span></div></div><ol>${dayItems.map(item => `<li class="native-slot"><article data-item-id="${item.id}" class="native-card"><h2><a href="/items/${item.id}">${item.title}</a></h2><a href="${item.sourceUrl}">原文</a></article></li>`).join("")}</ol></section>`;
    }).join("");
  };
  return async (route: string): Promise<string> => {
    if (route === "/assets/root-pool.css") return ".native-card{color:#123}";
    if (route.startsWith("/all")) {
      const url = new URL(route, "http://reader.example"), category = url.searchParams.get("category"), page = Number(url.searchParams.get("page") ?? 1);
      const items = poolItems(snapshot).filter(item => !category || item.category === category);
      const pageCount = Math.max(1, Math.ceil(items.length / 40));
      const href = (n: number) => `/all?${category ? `category=${category}&` : ""}page=${n}`;
      const pagination = pageCount > 1 ? `<nav aria-label="分页">${Array.from({ length: pageCount }, (_, i) => `<a href="${href(i + 1)}">${i + 1}</a>`).join("")}</nav>` : "";
      return shell(`<div class="pb-6 native-all-layout"><h1>全部动态</h1><div data-native-pool="true">${observedCards(items.slice((page - 1) * 40, page * 40))}</div>${pagination}</div>`);
    }
    if (route === "/" || route.startsWith("/?category=")) {
      const category = new URL(route, "http://reader.example").searchParams.get("category");
      return shell(`<div class="pb-6"><h1>精选</h1><div class="relative">${observedCards(selectedItems(snapshot).filter(item => !category || item.category === category))}</div></div>`);
    }
    return getSsr(snapshot)(route);
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
  assert.doesNotMatch(html("all/index.html"), /网页更新：|更新网页不改写研究日期|data-research-coverage/);
  assert.match(html("all/index.html"), /href="\/algorithmhot\/all\/page\/2\/"/);
  assert.match(html("all/category/algorithm/index.html"), /href="\/algorithmhot\/all\/category\/algorithm\/page\/2\/"/);
  assert.match(html("all/index.html"), /https:\/\/arxiv.org\/abs\/2610.00039/);
  const agent = load(html("agent/index.html"));
  assert.equal(agent('#research-models').length, 0);
  assert.doesNotMatch(html("agent/index.html"), /localhost|127\.0\.0\.1|\/api\/admin|data-live-research-model-panel|data-private-model-control/);
  validateStaticLinks(new Map([...files].map(([file, value]) => [file, String(value)])), base);
});

test("SSR export reuses a native day header when original publication dates are absent from live grouping", async () => {
  const snapshot = await collectSnapshot(getApi, base, "2026-10-05T02:30:00.000Z");
  const files = await renderSsrSite(snapshot, getObservedDaySsr(snapshot));
  const $ = load(String(files.get("index.html")));
  const section = $('section[aria-label="2026-10-02"]');
  assert.equal(section.length, 1);
  assert.match(section.text(), /10月2日/);
  assert.match(section.text(), /星期五/);
  assert.equal(section.find("article[data-item-id]").length, 2);
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
