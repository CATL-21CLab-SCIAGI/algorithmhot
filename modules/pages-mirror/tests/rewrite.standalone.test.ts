import assert from "node:assert/strict";
import { test } from "node:test";
import { cssRefs, htmlRefs, kindOf, normalizeBase, outputFile, rewriteCss, rewriteHtml, stripScripts, type RewriteContext } from "../mirror.ts";

const ctx = (over: Partial<RewriteContext> = {}): RewriteContext => ({
  base: "/algorithmhot",
  primary: "https://hot.example.com",
  mirrored: new Set(["/", "/daily", "/daily/2026-10-11", "/items/abc", "/assets/root-1.css", "/favicon.ico", "/feed.xml"]),
  siteName: "AlgorithmHot",
  ...over,
});

test("kinds: pages by the allowlist, files under /assets and at the root, never admin or api", () => {
  assert.equal(kindOf("/"), "page");
  assert.equal(kindOf("/daily/2026-10-11"), "page");
  assert.equal(kindOf("/topics/%E6%A8%A1%E5%9E%8B"), "page");
  assert.equal(kindOf("/story/42"), "page");
  assert.equal(kindOf("/feed/daily.xml"), "page");
  assert.equal(kindOf("/hot"), "page");
  assert.equal(kindOf("/all/c/ai4s"), "page");
  assert.equal(kindOf("/assets/x-1.woff2"), "asset");
  assert.equal(kindOf("/apple-icon.png"), "asset");
  for (const p of ["/admin", "/admin/runs", "/api/v1/items", "/items/a/original", "/topics/a/page/2", "/feed/all.xml", "/daily/%2E%2E", "/daily/a%2Fb"]) assert.equal(kindOf(p), null, p);
});

test("output files: index.html per page, files keep their names", () => {
  assert.equal(outputFile("/"), "index.html");
  assert.equal(outputFile("/daily/2026-10-11"), "daily/2026-10-11/index.html");
  assert.equal(outputFile("/topics/%E6%A8%A1%E5%9E%8B"), "topics/模型/index.html");
  assert.equal(outputFile("/feed/daily.xml"), "feed/daily.xml");
  assert.equal(outputFile("/assets/root-1.css"), "assets/root-1.css");
  assert.equal(normalizeBase("algorithmhot/"), "/algorithmhot");
  assert.equal(normalizeBase(""), "");
});

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<link rel="modulepreload" href="/assets/entry.client-1.js"/><link rel="preload" as="script" href="/assets/chunk-2.js"/>
<link rel="stylesheet" href="/assets/root-1.css"/><link rel="icon" href="/favicon.ico"/><link rel="alternate" href="/feed.xml"/>
<link rel="canonical" href="https://hot.example.com/daily"/>
<style>.a{background:url(/assets/bg.png)}</style>
<script>window.__reactRouterContext = {"x":"</div>"};</script>
<script type="module" async="">import "/assets/entry.client-1.js";</script>
</head><body class="b"><a href="/daily/2026-10-11#top">day</a><a href="/hot">hot</a><a href="/all?page=2&amp;q=x">more</a>
<a href="https://example.org/x">out</a><a href="/">home</a>
<img alt="cover" src="/api/img-proxy?u=x&amp;sig=1" srcset="/api/img-proxy?u=x 1x, /api/img-proxy?u=y 2x"/>
<img alt="logo" src="/assets/logo.svg"/><form action="/all" method="get"></form>
<div style="background-image:url('/assets/bg.png')"></div><SCRIPT src="/assets/x.js"></SCRIPT></body></html>`;

test("scripts and script preloads are removed, stylesheets stay", () => {
  const out = stripScripts(PAGE);
  assert.doesNotMatch(out, /<script|modulepreload|chunk-2|__reactRouterContext/i);
  assert.match(out, /rel="stylesheet" href="\/assets\/root-1.css"/);
});

test("root-relative addresses go under the base; what the mirror lacks goes to the full site", () => {
  const out = rewriteHtml(PAGE, ctx());
  assert.doesNotMatch(out, /<script/i);
  assert.match(out, /<link rel="stylesheet" href="\/algorithmhot\/assets\/root-1.css"\/>/);
  assert.match(out, /href="\/algorithmhot\/favicon.ico"/);
  assert.match(out, /href="\/algorithmhot\/feed.xml"/);
  assert.match(out, /href="https:\/\/hot.example.com\/daily"/);
  assert.match(out, /<a href="\/algorithmhot\/daily\/2026-10-11\/#top">/);
  assert.match(out, /<a href="\/algorithmhot\/">home/);
  assert.match(out, /<a href="https:\/\/hot.example.com\/hot">/);
  assert.match(out, /<a href="https:\/\/hot.example.com\/all\?page=2&amp;q=x">/);
  assert.match(out, /<a href="https:\/\/example.org\/x">/);
  assert.match(out, /<form action="https:\/\/hot.example.com\/all" method="get">/);
  assert.match(out, /background:url\(\/algorithmhot\/assets\/bg.png\)/);
  assert.match(out, /style="background-image:url\('\/algorithmhot\/assets\/bg.png'\)"/);
  assert.match(out, /<img alt="logo" src="\/algorithmhot\/assets\/logo.svg"\/>/);
  // Proxied images keep their alt text and lose their source.
  assert.match(out, /<img alt="cover"\/>/);
  assert.doesNotMatch(out, /img-proxy/);
});

test("the banner opens the body and names the full site when there is one, and is left out without one", () => {
  const out = rewriteHtml(PAGE, ctx());
  assert.match(out, /<body class="b"><div data-pages-mirror="" [^>]*>这是 AlgorithmHot 的只读镜像，每小时同步；完整站点：<a href="https:\/\/hot.example.com\/"[^>]*>hot.example.com<\/a><\/div><a href/);
  const bare = rewriteHtml(PAGE, ctx({ primary: null }));
  assert.doesNotMatch(bare, /data-pages-mirror|只读镜像/);
  assert.match(bare, /<a href="\/algorithmhot\/hot">/);
});

test("stylesheets: root-relative url() and @import under the base; relative ones untouched", () => {
  const css = `@import "/assets/a.css";@font-face{src:url(/assets/f.woff2) format("woff2"),url("./g.woff")}.x{background:url(data:image/png;base64,AA)}`;
  assert.equal(rewriteCss(css, ctx()), `@import "/algorithmhot/assets/a.css";@font-face{src:url(/algorithmhot/assets/f.woff2) format("woff2"),url("./g.woff")}.x{background:url(data:image/png;base64,AA)}`);
  assert.deepEqual(cssRefs(css, "/assets/root-1.css"), ["/assets/f.woff2", "/assets/g.woff", "/assets/a.css"]);
});

test("references found in a page", () => {
  const refs = htmlRefs(stripScripts(PAGE));
  for (const r of ["/assets/root-1.css", "/favicon.ico", "/daily/2026-10-11#top", "/hot", "/assets/logo.svg", "/assets/bg.png"]) assert.ok(refs.includes(r), r);
  assert.ok(!refs.includes("/assets/x.js"));
});

test("category tabs get addresses of their own; other filtered links are dropped without a full site", async () => {
  const { staticPath, sourcePath, mapUrl } = await import("../mirror.ts");
  assert.equal(staticPath("/", "?category=algorithm"), "/c/algorithm");
  assert.equal(staticPath("/all", "?category=ai4s"), "/all/c/ai4s");
  assert.equal(staticPath("/all", "?tag=%E8%AE%BA%E6%96%87"), null);
  assert.equal(staticPath("/daily", "?category=ai4s"), null);
  assert.equal(sourcePath("/all/c/ai4s"), "/all?category=ai4s");
  assert.equal(sourcePath("/c/algorithm"), "/?category=algorithm");
  const ctx = { base: "/algorithmhot", primary: null, mirrored: new Set(["/", "/c/algorithm"]), siteName: "S" };
  assert.equal(mapUrl("/?category=algorithm", ctx, true), "/algorithmhot/c/algorithm/");
  assert.equal(mapUrl("/all?tag=x", ctx, true), null);
  assert.equal(mapUrl("/all?tag=x", { ...ctx, primary: "https://site.example" }, true), "https://site.example/all?tag=x");
});
