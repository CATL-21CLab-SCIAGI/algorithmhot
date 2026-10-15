import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import type { SiteItemDetail } from "@aihot/contracts/site";
import { startWebServer, type WebServer } from "./web-server.ts";

test("a wrapping outline settles with classic scrollbars at a limited viewport height", async (t) => {
  const at = "2026-10-04T08:00:00.000Z";
  const outline = Array.from({ length: 40 }, (_, i) => ({
    id: `section-${i}`, level: 2, text: i === 0 ? "用于验证目录滚动行为的长文章标题测试" : `Section ${i}`,
  }));
  const item: SiteItemDetail = {
    id: "outline-fixture", title: "目录滚动检查", summary: "固定摘要", reason: "固定推荐理由", source: { name: "Fixture" },
    publishedAt: at, timelineAt: at, discoveredAt: at, category: null, tags: [], score: 80, selected: true,
    channel: "news", notes: [], x: null, originalTitle: null, links: { original: "https://example.org/article" },
    story: null, readingMode: "full", author: null, outline, relatedStories: [], topics: [], indexable: false,
    markdownAvailable: false, group: null, hasTranslation: false, bodyLanguage: "zh",
    body: { zh: outline.map((o) => `<h2 id="${o.id}">${o.text}</h2><p>${"固定正文。".repeat(100)}</p>`).join(""), original: null, zhKind: "original", complete: true },
  };
  const api = createServer((req, res) => {
    const path = new URL(req.url!, "http://local").pathname;
    res.setHeader("Content-Type", "application/json");
    if (path === "/api/site/meta") return res.end(JSON.stringify({ changelogVersion: "fixture" }));
    if (path === "/api/site/track") { res.statusCode = 204; return res.end(); }
    if (path === "/api/site/items/outline-fixture") return res.end(JSON.stringify(item));
    res.statusCode = 404; res.end("{}");
  });
  // The usual hidden/overlay scrollbar cannot expose the width -> wrap -> height feedback loop.
  const browser = await chromium.launch({ channel: "chromium", ignoreDefaultArgs: ["--hide-scrollbars"] });
  let web: WebServer | undefined;
  try {
    web = await startWebServer(api);
    const page = await browser.newPage({ viewport: { width: 1366, height: 2000 }, reducedMotion: "reduce" });
    await page.goto(web.origin + "/items/outline-fixture");
    const nav = page.getByRole("navigation", { name: "本文目录" });
    const first = nav.locator("a").first();
    await expect(nav).toBeVisible();
    const unwrapped = await first.evaluate((a) => a.getBoundingClientRect().height);
    await page.setViewportSize({ width: 1366, height: 768 });
    await expect(nav).toHaveAttribute("tabindex", "0");
    const geometry = await nav.evaluate((n: HTMLElement) => {
      const rail = n.closest("aside")!.firstElementChild!;
      return {
        gutter: n.offsetWidth - n.clientWidth,
        wrapped: n.querySelector("a")!.getBoundingClientRect().height,
        inset: parseFloat(getComputedStyle(rail).top),
        offset: n.getBoundingClientRect().top - rail.getBoundingClientRect().top,
      };
    });
    if (geometry.gutter === 0) {
      t.skip("this platform uses overlay scrollbars; the classic gutter feedback case requires layout-consuming scrollbars");
      return;
    }
    assert.ok(geometry.wrapped > unwrapped, "the scrollbar must wrap the first heading");
    const available = (unwrapped + geometry.wrapped) / 2;
    await page.setViewportSize({ width: 1366, height: Math.round(geometry.inset * 2 + geometry.offset + available) });
    const frames = await nav.evaluate(async (n) => {
      const values = [];
      for (let i = 0; i < 60; i++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        values.push({ height: n.clientHeight, width: n.clientWidth, tab: n.getAttribute("tabindex") });
      }
      return values.slice(10);
    });
    assert.equal(new Set(frames.map((f) => `${f.height}:${f.width}:${f.tab}`)).size, 1, "the outline must settle across frames, not alternate between scrolling and expanding");
    assert.equal(frames[0].tab, "0");
    assert.ok(frames[0].height <= Math.ceil(available));
    await nav.evaluate((n) => { n.scrollTop = n.scrollHeight; n.focus({ preventScroll: true }); });
    const beforeKey = await page.evaluate(() => scrollY);
    await page.keyboard.press("PageDown");
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => scrollY), beforeKey, "the limited outline still contains keyboard scrolling at its boundary");
    // Less than a single line retains the original uncapped layout, and growing restores scrolling.
    await page.setViewportSize({ width: 1366, height: Math.floor(geometry.inset * 2 + geometry.offset + unwrapped - 1) });
    await expect.poll(() => nav.evaluate((n) => n.style.maxHeight)).toBe("");
    await expect(nav).not.toHaveAttribute("tabindex");
    await page.setViewportSize({ width: 1366, height: 768 });
    await expect(nav).toHaveAttribute("tabindex", "0");
  } finally {
    await browser.close();
    await web?.stop();
  }
});
