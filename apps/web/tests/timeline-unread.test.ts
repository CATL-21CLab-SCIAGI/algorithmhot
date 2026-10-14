// Failure modes fixed before adding the timeline's reader-side unread filter (issue #185):
// - a page whose cards are all read shows nothing and stops, instead of paging on and handing the
//   rest back to the button;
// - a failed page is not offered for retry, or retrying loses the filter;
// - a reading group disappears because its representative is read, or a fully read one stays;
// - returning to the list drops the filter, or an ordinary card survives it.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { chromium, expect, type Browser } from "@playwright/test";
import type { FeedItemSummary, SiteItemDetail } from "@aihot/contracts/site";
import { startWebServer, type WebServer } from "./web-server.ts";

const at = "2026-10-04T08:00:00.000Z";
const earlier = "2026-10-03T08:00:00.000Z";

function summaryOf(id: string, title: string, timelineAt = at): FeedItemSummary {
  return { id, title, summary: "固定摘要", reason: "固定推荐理由", source: { name: "Fixture" }, publishedAt: timelineAt, timelineAt, category: "algorithm", tags: [], score: 80, selected: true, channel: "news", notes: [], x: null };
}

function detailOf(id: string, title: string): SiteItemDetail {
  return {
    ...summaryOf(id, title), x: null, originalTitle: title, links: { original: "https://example.org/article" }, discoveredAt: at,
    story: null, readingMode: "full", author: null,
    body: { zh: "<p>固定正文</p>", original: null, zhKind: "translation", complete: true },
    outline: [], relatedStories: [], topics: [], indexable: true, markdownAvailable: true, group: null,
    hasTranslation: true, bodyLanguage: "zh",
  };
}

const card = (id: string, title: string, timelineAt = at) => ({ key: id, anchorAt: timelineAt, item: summaryOf(id, title, timelineAt), group: null });
// A reading group whose representative is read but whose other selected report is not: the filter
// must keep it, or the unread report behind the representative would be unreachable.
const groupCard = { key: "g1", anchorAt: at, item: summaryOf("rep-1", "代表文章"), group: { factId: "f1", additionalSourceCount: 1, reportCount: 2, memberIds: ["rep-1", "member-2"] } };
// ...and one whose every selected report is read: it must go.
const readGroupCard = { key: "g2", anchorAt: at, item: summaryOf("rep-3", "已读完的组"), group: { factId: "f2", additionalSourceCount: 1, reportCount: 2, memberIds: ["rep-3", "member-4"] } };

let web: WebServer;
let origin: string;
let chrome: Browser;
let failNextPage = false;
let boundaryRequests = 0;

const api = createServer((req, res) => {
  const url = new URL(req.url!, "http://local");
  const p = url.pathname;
  res.setHeader("Content-Type", "application/json");
  if (p === "/api/site/meta") return res.end(JSON.stringify({ changelogVersion: "fixture" }));
  if (p === "/api/site/track") { res.statusCode = 204; return res.end(); }
  if (p === "/api/health") return res.end("{}");
  if (p === "/api/site/topics") return res.end(JSON.stringify({ groups: [], topics: [] }));
  if (p === "/api/site/hot") return res.end(JSON.stringify({ computedAt: at, windowHours: 48, entries: [] }));
  if (p === "/api/site/timeline") {
    const tag = url.searchParams.get("tag");
    const cursor = url.searchParams.get("cursor");
    if (tag === "boundary") {
      boundaryRequests++;
      const n = cursor ? Number(cursor) : 1;
      return res.end(JSON.stringify({ filters: { channel: "all", category: null, tag }, cards: [card(`boundary-${n}`, `批次 ${n}`)], nextCursor: n < 5 ? String(n + 1) : null, hot: null, dayCounts: { "2026-10-04": 5 } }));
    }
    if (tag === "group") {
      return res.end(JSON.stringify({ filters: { channel: "all", category: null, tag: "group" }, cards: [groupCard, readGroupCard], nextCursor: null, hot: null, dayCounts: { "2026-10-04": 2 } }));
    }
    if (tag === "read") {
      return res.end(JSON.stringify({ filters: { channel: "all", category: null, tag: "read" }, cards: [card("c1", "第一页文章甲")], nextCursor: null, hot: null, dayCounts: { "2026-10-04": 1 } }));
    }
    if (cursor === "p2") {
      if (failNextPage) { res.statusCode = 503; return res.end(JSON.stringify({ code: "unavailable" })); }
      return res.end(JSON.stringify({ filters: { channel: "all", category: null, tag: null }, cards: [card("c3", "第二页文章甲", earlier), card("c4", "第二页文章乙", earlier)], nextCursor: null, hot: null, dayCounts: { "2026-10-03": 2 } }));
    }
    return res.end(JSON.stringify({ filters: { channel: "all", category: null, tag: null }, cards: [card("c1", "第一页文章甲"), card("c2", "第一页文章乙")], nextCursor: "p2", hot: null, dayCounts: { "2026-10-04": 2 } }));
  }
  if (p.startsWith("/api/site/items/")) {
    const id = p.split("/").at(-1)!;
    return res.end(JSON.stringify(detailOf(id, `文章 ${id}`)));
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ code: "not_found" }));
});

before(async () => {
  const started = await Promise.allSettled([
    startWebServer(api).then((w) => { web = w; origin = w.origin; }),
    chromium.launch({ channel: "chromium" }).then((b) => { chrome = b; }),
  ]);
  for (const result of started) if (result.status === "rejected") throw result.reason;
});

after(async () => {
  await chrome?.close();
  await web?.stop();
});

/** A reader who has already opened these reports, in this browser only. */
async function readerWith(read: string[]) {
  const context = await chrome.newContext();
  await context.addInitScript((ids) => {
    try { window.localStorage.setItem("aihot-read-items", JSON.stringify(ids)); } catch { /* storage unavailable */ }
  }, read);
  return context;
}

test("an all-read page keeps paging, then hides the read cards and shows the unread one", async () => {
  const context = await readerWith(["c1", "c2"]);
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/`);
    await expect(page.getByRole("link", { name: "第一页文章甲", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "只看未读" }).click();
    // Both loaded cards are read: the list pages on by itself and lands on the unread report.
    await expect(page.getByRole("link", { name: "第二页文章甲", exact: true })).toBeVisible();
    assert.equal(await page.getByRole("link", { name: "第一页文章甲", exact: true }).count(), 0, "a read card is hidden");
    assert.equal(await page.getByRole("button", { name: "只看未读" }).getAttribute("aria-pressed"), "true");
  } finally {
    await context.close();
  }
});

test("a page that fails to load offers a retry that keeps the filter", async () => {
  const context = await readerWith(["c1", "c2"]);
  const page = await context.newPage();
  failNextPage = true;
  try {
    await page.goto(`${origin}/`);
    await expect(page.getByRole("link", { name: "第一页文章甲", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "只看未读" }).click();
    const retry = page.getByRole("button", { name: "加载失败，点此重试" });
    await expect(retry).toBeVisible();
    failNextPage = false;
    await retry.click();
    await expect(page.getByRole("link", { name: "第二页文章甲", exact: true })).toBeVisible();
    assert.equal(await page.getByRole("button", { name: "只看未读" }).getAttribute("aria-pressed"), "true", "retrying keeps the filter");
  } finally {
    failNextPage = false;
    await context.close();
  }
});

test("returning to the list keeps the filter and finds the unread report again", async () => {
  const context = await readerWith(["c1", "c2"]);
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/`);
    await expect(page.getByRole("link", { name: "第一页文章甲", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "只看未读" }).click();
    const opened = page.getByRole("link", { name: "第二页文章甲", exact: true });
    await expect(opened).toBeVisible();
    // Opening a card marks it read in this browser, so the return has to find the other unread one.
    await opened.click();
    await expect(page.getByText("固定正文", { exact: true })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("button", { name: "只看未读" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("link", { name: "第二页文章乙", exact: true })).toBeVisible();
    assert.equal(await page.getByRole("link", { name: "第二页文章甲", exact: true }).count(), 0, "the report just opened stays hidden");
  } finally {
    await context.close();
  }
});

test("a group stays while any selected report in it is unread, and goes once all are read", async () => {
  const context = await readerWith(["rep-1", "rep-3", "member-4"]);
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/?tag=group`);
    await expect(page.getByRole("link", { name: "代表文章", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "只看未读" }).click();
    await expect(page.getByRole("link", { name: "代表文章", exact: true })).toBeVisible();
    assert.equal(await page.getByRole("link", { name: "已读完的组", exact: true }).count(), 0, "a fully read group is hidden");
  } finally {
    await context.close();
  }
});

test("with everything read and no more pages, the filter says so instead of looking empty", async () => {
  const context = await readerWith(["c1"]);
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/?tag=read`);
    await expect(page.getByRole("link", { name: "第一页文章甲", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "只看未读" }).click();
    await expect(page.getByText("没有未读的精选内容", { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("all-read pages stop at the automatic bound and can continue manually without changing local records", async () => {
  const context = await readerWith(["boundary-1", "boundary-2", "boundary-3", "boundary-4"]);
  const page = await context.newPage();
  boundaryRequests = 0;
  try {
    await page.goto(`${origin}/?tag=boundary`);
    const raw = await page.evaluate(() => localStorage.getItem("aihot-read-items"));
    await page.getByRole("button", { name: "只看未读" }).click();
    const more = page.getByRole("button", { name: "加载更多", exact: true });
    await expect(more).toBeVisible();
    assert.equal(boundaryRequests, 3, "the unread filter respects the existing three-batch limit");
    await more.click();
    await expect(more).toBeVisible();
    await expect(page.getByText("这批精选都读过了", { exact: true })).toBeVisible();
    await more.click();
    await expect(page.getByRole("link", { name: "批次 5", exact: true })).toBeVisible();
    assert.equal(boundaryRequests, 5);
    assert.equal(await page.evaluate(() => localStorage.getItem("aihot-read-items")), raw);
  } finally { await context.close(); }
});
