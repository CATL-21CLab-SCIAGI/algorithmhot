import test from "node:test";
import assert from "node:assert/strict";
import { load } from "cheerio";
import { sanitizeSsrPage, ssrClient } from "../scripts/static-site/ssr.ts";
import { sanitizeItem } from "../scripts/static-site/model.ts";
import type { Snapshot } from "../scripts/static-site/model.ts";

const snapshot: Snapshot = { schemaVersion: 1, publicBaseUrl: "https://pkucy2016.github.io/algorithmhot/", generatedAt: "2026-10-04T08:00:00.000Z", mode: "static-snapshot", scope: "only published items", topics: [], reports: [], items: [sanitizeItem({ id: "item1", title: "Public paper", source: { name: "arXiv" }, links: { original: "https://arxiv.org/abs/1234.5678" }, tags: ["算法"] })] };
const routes = new Set(["/", "/all", "/topics", "/daily", "/daily/2026-10-03", "/agent", "/archive", "/about", "/category/algorithm", "/items/item1", "/data/snapshot.json"]);
const shell = (body: string) => `<!DOCTYPE html><html><head><title>Local site</title><link rel="canonical" href="http://127.0.0.1:3102/topics"><link rel="stylesheet" href="/assets/root-ABC.css"><link rel="modulepreload" href="/assets/app.js"><script>window.__reactRouterContext={body:"RAW FULLTEXT",token:"SECRET"};</script></head><body><aside class="sticky top-0 hidden h-dvh w-[180px] lg:flex"><nav aria-label="主导航"><a href="/" class="flex h-10 bg-accent/10 font-semibold text-ink dark:bg-accent-soft" aria-current="page"><span class="text-accent">精选</span></a><a href="/all" class="flex h-10 font-medium text-ink-3 hover:bg-bg-sunk">全部</a></nav></aside><main id="main"><div class="mx-auto w-full max-w-[640px] lg:max-w-[var(--page-max-wide)]">${body}</div></main></body></html>`;
const sanitize = (body: string, route = "/topics") => sanitizeSsrPage(shell(body), { route, snapshot, routes, assets: new Set(["/assets/root-ABC.css"]) });

test("SSR export retains original report two rails, article columns, SVG and inline sizing", () => {
  const html = sanitize('<div class="report-shell lg:flex"><aside class="w-[280px] lg:flex">Archive</aside><article class="@container grid @[760px]:grid-cols-2"><h1 id="report-start">Original masthead</h1><svg viewBox="0 0 420 110"><text x="0" y="88">科研试刊</text></svg><div style="grid-template-columns:repeat(4, minmax(0, 1fr))">metrics</div><details><summary>完整统计</summary>60 admitted</details></article></div>', "/daily/2026-10-03");
  const $ = load(html);
  assert.equal($(".report-shell > aside").attr("class"), "w-[280px] lg:flex");
  assert.equal($("article").attr("class"), "@container grid @[760px]:grid-cols-2");
  assert.equal($("svg").attr("viewBox"), "0 0 420 110");
  assert.equal($("svg text").text(), "科研试刊");
  assert.equal($("[style]").attr("style"), "grid-template-columns:repeat(4, minmax(0, 1fr))");
  assert.equal($("details summary").text(), "完整统计");
  assert.equal($('link[rel="stylesheet"]').attr("href"), "/algorithmhot/assets/root-ABC.css");
  assert.match($("footer").text(), /2026-10-04 16:00 北京时间/);
  assert.doesNotMatch($("footer").text(), /T08:00/);
});

test("SSR scripts and hydration loader state are removed, not serialized into public HTML", () => {
  const html = sanitize('<script type="application/ld+json">{"url":"http://127.0.0.1/private"}</script><template>private loader</template><div hidden>UNPUBLISHED</div><style>body{background:url(https://tracker.example/pixel)}</style><h1>Public heading</h1>');
  assert.doesNotMatch(html, /<script|modulepreload|window\.__reactRouter|RAW FULLTEXT|SECRET|UNPUBLISHED|tracker\.example|127\.0\.0\.1/);
  assert.match(html, /Public heading/);
  assert.equal(load(html)('meta[name="algorithmhot-renderer"]').attr("content"), "local-ssr");
});

test("static export removes live model settings and private controls before resolving admin links", () => {
  const html = sanitize('<section data-live-research-model-panel="true"><h2>PRIVATE_MODEL_SELECTION</h2><a href="/admin/login?return=%2Fagent">Login</a><form><input name="csrf" value="PRIVATE_CSRF"><button>Save</button></form></section><div data-private-model-control="true">PRIVATE_MODEL_HISTORY</div><h1>Public Agent reading</h1>', "/agent");
  assert.doesNotMatch(html, /PRIVATE_|\/admin|data-live-research-model-panel|data-private-model-control|<form|<select/);
  assert.match(html, /Public Agent reading/);
});

test("item export strips original prose section, images and unsafe embedded media", () => {
  const html = sanitize('<div class="lg:grid-cols-[minmax(0,1fr)_240px]"><article><h1>Public summary</h1><section><h2>正文</h2><div class="prose">RAW SOURCE FULLTEXT</div></section><img src="https://images.example/pic.png"><svg><image href="https://images.example/pic.svg"/><foreignObject><iframe src="https://evil.example"/></foreignObject></svg></article></div>', "/items/item1");
  assert.doesNotMatch(html, /RAW SOURCE FULLTEXT|<img|<iframe|<image|foreignObject/);
  assert.match(html, /Public summary/);
  assert.match(html, /lg:grid-cols-\[minmax\(0,1fr\)_240px\]/);
});

test("SSR links map fixed filters to static routes without inventing a dynamic endpoint", () => {
  const html = sanitize('<a href="/?category=algorithm">算法</a><a href="/all?search=1">搜索</a><a href="/?channel=firstParty">一手</a><a href="/data/snapshot.json">JSON</a><a href="/api/mcp">MCP</a><a href="/items/item1">论文</a>');
  const $ = load(html);
  assert.equal($('a').filter((_, node) => $(node).text() === "算法").attr("href"), "/algorithmhot/category/algorithm/");
  assert.equal($('a').filter((_, node) => $(node).text() === "搜索").attr("href"), "/algorithmhot/topics/");
  assert.equal($('a').filter((_, node) => $(node).text() === "一手").length, 0);
  assert.equal($('a').filter((_, node) => $(node).text() === "JSON").attr("href"), "/algorithmhot/data/snapshot.json");
  assert.equal($('a').filter((_, node) => $(node).text() === "MCP").attr("href"), "/algorithmhot/agent/");
});

test("out-of-scope cards, item links, unknown routes and external style loads fail closed", () => {
  assert.throws(() => sanitize('<article data-item-id="private-id">not admitted</article>'), /outside snapshot scope/);
  assert.throws(() => sanitize('<a href="/items/private-id">not admitted</a>'), /out-of-scope item/);
  assert.throws(() => sanitize('<a href="/admin">admin</a>'), /Unmapped SSR/);
  assert.throws(() => sanitize('<div style="background-image:url(https://tracker.example)">tracking</div>'), /Unsafe inline style/);
});

test("static controls cannot imply functional browser storage or copy buttons", () => {
  const html = sanitize('<div role="radiogroup" aria-label="外观"><button title="深色">深色</button></div><button aria-label="收藏">bookmark</button><button aria-label="复制">copy</button><button> 返回</button><button aria-label="回到顶部">top</button><form action="/all"><input name="q"><button>搜索</button></form><button>10月4日</button>', "/items/item1");
  const $ = load(html);
  assert.equal($("button,form,input,[role=radiogroup]").length, 0);
  assert.equal($('a').filter((_, node) => $(node).text().trim() === "返回").attr("href"), "/algorithmhot/");
  assert.equal($('a[aria-label="回到顶部"]').attr("href"), "#main");
  assert.match(html, /10月4日/);
});

test("day header fold control preserves its grid slot after static conversion", () => {
  const $ = load(sanitize('<section aria-label="2026-10-04"><div class="grid-cols-[64px_22px_minmax(0,1fr)]"><button>10月4日</button><button aria-label="收起10月4日" class="grid size-6 place-items-center"></button><span>星期日 · 29 条</span></div></section>'));
  const header = $('section[aria-label="2026-10-04"] > div');
  assert.equal(header.children().length, 3);
  assert.equal(header.children().eq(1).attr("class"), "grid size-6 place-items-center");
  assert.equal(header.children().eq(2).text(), "星期日 · 29 条");
});

test("static Agent metadata agrees with its limited reading interface", () => {
  const source = shell('<h1>Agent 阅读</h1><p>公开静态阅读</p>').replace('</head>', '<meta name="description" content="实时 API MCP RSS"><meta property="og:description" content="实时 API MCP RSS"><meta name="twitter:description" content="实时 API MCP RSS"></head>');
  const $ = load(sanitizeSsrPage(source, { route: "/agent", snapshot, routes, assets: new Set(["/assets/root-ABC.css"]) }));
  for (const selector of ['meta[name="description"]', 'meta[property="og:description"]', 'meta[name="twitter:description"]']) assert.match($(selector).attr("content")!, /不提供实时 API、MCP 或 RSS/);
});

test("SSR client rejects search, unbounded pool pages, original, admin and remote-origin requests before networking", async () => {
  assert.throws(() => ssrClient("https://example.com"), /local reader origin/);
  const get = ssrClient("http://127.0.0.1:3102");
  for (const route of ["/all?page=51", "/all?q=private", "/all?category=unknown", "/admin", "/api/site/items/item1", "/items/item1/original", "/items/item1/markdown", "/assets/app.js", "//evil.example/path"]) await assert.rejects(get(route), /allowlist entry/);
});

test("all-public listing retains native shell but highlights the all destination", () => {
  const $ = load(sanitize("<h1>全部公开精选</h1>", "/all"));
  assert.equal($('nav[aria-label="主导航"] [aria-current=page]').attr("href"), "/algorithmhot/all/");
});

test("mobile tabs highlight the static route instead of the cloned page's original route", () => {
  const input = shell("<h1>Public page</h1>").replace("</body>", '<nav aria-label="底部导航"><a href="/" class="relative flex font-semibold text-accent" aria-current="page">精选</a><a href="/all" class="relative flex text-ink-3 active:text-ink">全部</a><a href="/daily" class="relative flex text-ink-3 active:text-ink">刊物</a><a href="/more" class="relative flex text-ink-3 active:text-ink">更多</a></nav></body>');
  const known = new Set([...routes, "/more", "/daily", "/daily/archive"]);
  for (const [route, expected] of [["/all", "/algorithmhot/all/"], ["/topics", "/algorithmhot/more/"], ["/daily/archive", "/algorithmhot/daily/"], ["/category/algorithm", "/algorithmhot/"]]) {
    const $ = load(sanitizeSsrPage(input, { route, snapshot, routes: known, assets: new Set(["/assets/root-ABC.css"]) }));
    const current = $('nav[aria-label="底部导航"] [aria-current="page"]');
    assert.equal(current.length, 1);
    assert.equal(current.attr("href"), expected);
    assert.match(current.attr("class")!, /font-semibold text-accent/);
  }
});

const originalFigure = {
  itemId: "item1", sourceRevision: 2, imageOrigin: "remote" as const,
  imageUrl: "https://arxiv.org/html/2610.01234v2/figure1.png", sourceUrl: "https://arxiv.org/html/2610.01234v2#S2.F1",
  figureLabel: "原文图 1", caption: "数据经过编码器进入预测模块。", attribution: "Example et al.", licenseName: "CC BY 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/", verifiedAt: "2026-10-04T08:00:00.000Z", width: 640, height: 320, contentType: "image/png", sha256: "a".repeat(64),
};
const figureSnapshot: Snapshot = { ...snapshot, items: [sanitizeItem({ id: "item1", researchBrief: { sourceRevision: 2 } })], reports: [
  { kind: "daily", key: "2026-10-03", issueNumber: 1, title: "Pilot", windowStart: "2026-09-26T00:00:00Z", windowEnd: "2026-10-03T00:00:00Z", generatedAt: "2026-10-03T00:00:00Z", revision: 1, lead: null, overview: null, metrics: {}, status: "partial", gaps: [], sections: [{ label: "算法", summary: null, items: [{ itemId: "item1", title: "Paper", available: true, summary: null, sourceName: "arXiv", sourceUrl: originalFigure.sourceUrl, publishedAt: null, research: null, researchRoadmap: null, researchBrief: sanitizeItem({ id: "item1", researchBrief: { sourceRevision: 2 } }).researchBrief }] }] },
] };
const figureMarkup = (src = originalFigure.imageUrl) => `<figure data-paper-figure="true" data-item-id="item1" data-source-revision="2"><img data-paper-figure="item1" src="${src}" class="w-full" srcset="https://tracker.example/alternate.png 2x" onerror="alert(1)"><figcaption>${originalFigure.figureLabel} · ${originalFigure.caption} ${originalFigure.attribution} <a href="${originalFigure.sourceUrl}">原文</a> <a href="${originalFigure.licenseUrl}">${originalFigure.licenseName}</a></figcaption></figure>`;
const sanitizeFigure = (markup: string, route = "/daily/2026-10-03", figures = [originalFigure], data = figureSnapshot) => sanitizeSsrPage(shell(markup), { route, snapshot: data, routes, assets: new Set(["/assets/root-ABC.css"]), figures });

test("original figures require exact paper revision and URL, preserve attribution, strip trackers and use narrow CSP", () => {
  const $ = load(sanitizeFigure(figureMarkup() + '<img src="https://tracker.example/pixel">'));
  assert.equal($("img").length, 1);
  assert.equal($("img").attr("src"), originalFigure.imageUrl);
  assert.equal($("img").attr("srcset"), undefined);
  assert.equal($("img").attr("onerror"), undefined);
  assert.equal($("img").attr("referrerpolicy"), "no-referrer");
  assert.equal($("img").attr("width"), "640");
  assert.match($("figcaption").text(), /CC BY 4.0/);
  assert.match($('meta[http-equiv="Content-Security-Policy"]').attr("content")!, /img-src 'self' data: https:\/\/arxiv.org;/);
  assert.doesNotMatch($.html(), /tracker\.example/);
  assert.throws(() => sanitizeFigure(figureMarkup("https://arxiv.org/html/2610.01234v2/another.png")), /Unapproved/);
  assert.throws(() => sanitizeFigure(figureMarkup().replace('data-source-revision="2"', 'data-source-revision="1"')), /Unapproved/);
  assert.throws(() => sanitizeFigure(figureMarkup(), "/topics"), /Unapproved/);
  assert.throws(() => sanitizeFigure(figureMarkup().replace(originalFigure.attribution, "Other author")), /attribution/);
  assert.throws(() => sanitizeFigure(figureMarkup(), "/daily/2026-10-03", [originalFigure], { ...figureSnapshot, reports: [] }), /published citation revision/);
});

test("PDF extracts map to scoped local static assets and never broaden external image CSP", () => {
  const local = { ...originalFigure, imageOrigin: "pdf-extract" as const, imageUrl: "/paper-figures/figure1.png" };
  const $ = load(sanitizeSsrPage(shell(figureMarkup(local.imageUrl) + `<a href="${local.imageUrl}">查看大图</a>`), { route: "/daily/2026-10-03", snapshot: figureSnapshot, routes, assets: new Set(["/assets/root-ABC.css"]), figures: [local] }));
  assert.equal($("img").attr("src"), "/algorithmhot/assets/paper-figures/figure1.png");
  assert.equal($('a').filter((_, node) => $(node).text() === "查看大图").attr("href"), "/algorithmhot/assets/paper-figures/figure1.png");
  assert.match($('meta[http-equiv="Content-Security-Policy"]').attr("content")!, /img-src 'self' data:;/);
});
