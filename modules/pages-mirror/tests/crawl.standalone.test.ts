import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { crawl } from "../crawl.ts";

const page = (body: string) => `<!DOCTYPE html><html><head><link rel="stylesheet" href="/assets/root-1.css"/><link rel="icon" href="/favicon.ico"/>`
  + `<link rel="modulepreload" href="/assets/entry-1.js"/></head><body><nav><a href="/">首页</a><a href="/daily">日报</a><a href="/admin">后台</a></nav>${body}`
  + `<script>window.__ctx={}</script><script type="module">import "/assets/entry-1.js"</script></body></html>`;

const SITE: Record<string, [number, string, string]> = {
  "/api/img-proxy?u=1": [200, "image/png", "PNGDATA"],
  "/": [200, "text/html; charset=utf-8", page(`<a href="/items/a1">a1</a><a href="/story/7">s7</a><a href="/all?page=2">p2</a><a href="/api/v1/items">api</a><img alt="x" src="/api/img-proxy?u=1"/>`)],
  "/all": [200, "text/html", page(`<a href="/items/a2">a2</a>`)],
  "/daily": [200, "text/html", page(`<a href="/daily/2026-10-11">d</a><a href="/daily/2026-10-10">d</a>`)],
  "/daily/2026-10-11": [200, "text/html", page(`<a href="/items/a3">a3</a>`)],
  "/daily/2026-10-10": [500, "text/html", "boom"],
  "/items/a1": [200, "text/html", page("item a1")],
  "/items/a2": [200, "text/html", page("item a2")],
  "/items/a3": [200, "text/html", page("item a3")],
  "/story/7": [200, "text/html", page(`<a href="/topics/x">t</a>`)],
  "/feed.xml": [200, "application/rss+xml", `<rss><channel><link>https://hot.example.com/</link></channel></rss>`],
  "/assets/root-1.css": [200, "text/css", `@font-face{src:url(/assets/font-1.woff2)}body{background:url(./bg.png)}`],
  "/assets/font-1.woff2": [200, "font/woff2", "FONT"],
  "/assets/bg.png": [200, "image/png", "PNG"],
  "/favicon.ico": [200, "image/x-icon", "ICO"],
};
const hits: string[] = [];
let server: http.Server;
let origin = "";

before(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url!);
    const hit = SITE[req.url!];
    if (!hit) { res.writeHead(404, { "content-type": "text/html" }).end(page("<h1>页面不存在</h1>")); return; }
    res.writeHead(hit[0], { "content-type": hit[1] }).end(hit[2]);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("crawls the entries and the allowed links, rewrites them and leaves out what failed", async () => {
  const site = await crawl({ origin, maxPages: 400, base: "/algorithmhot", primary: "https://hot.example.com", siteName: "AlgorithmHot" });
  const files = [...site.files.keys()].sort();
  for (const f of ["index.html", "all/index.html", "daily/index.html", "daily/2026-10-11/index.html", "items/a1/index.html", "items/a2/index.html",
    "items/a3/index.html", "story/7/index.html", "feed.xml", "assets/root-1.css", "assets/font-1.woff2", "assets/bg.png", "favicon.ico", "404.html", ".nojekyll"]) {
    assert.ok(files.includes(f), f);
  }
  assert.ok(!files.some((f) => f.startsWith("admin") || f.startsWith("api") || f.includes("entry-1.js") || f.startsWith("daily/2026-10-10")));
  // Proxied images are saved as files; nothing else of the api is read.
  assert.ok(!hits.some((h) => h.startsWith("/admin") || (h.startsWith("/api") && !h.startsWith("/api/img-proxy?")) || (h.includes("?") && !h.startsWith("/api/img-proxy?")) || h.endsWith(".js")), hits.join(" "));
  assert.ok(site.skipped.includes("/daily/2026-10-10") && site.skipped.includes("/topics/x") && site.skipped.includes("/weekly"));
  assert.equal(site.assets, 5);
  const image = [...site.files.keys()].find((f) => /^img\/[0-9a-f]{24}\.png$/.test(f));
  assert.ok(image && site.files.get(image)!.toString() === "PNGDATA", "the proxied image is saved under a stable name");

  const home = site.files.get("index.html")!.toString();
  assert.doesNotMatch(home, /<script|modulepreload/);
  assert.match(home, /href="\/algorithmhot\/assets\/root-1.css"/);
  assert.match(home, /<a href="\/algorithmhot\/items\/a1\/">/);
  assert.match(home, /<a href="\/algorithmhot\/daily\/">/);
  assert.match(home, /<a href="https:\/\/hot.example.com\/admin">/);
  // Failed and unmirrored pages point at the full site.
  assert.match(site.files.get("daily/index.html")!.toString(), /<a href="https:\/\/hot.example.com\/daily\/2026-10-10">/);
  assert.match(home, new RegExp(`<img alt="x" src="/algorithmhot/${image}"/>`));
  assert.match(home, /只读镜像/);
  assert.equal(site.files.get("assets/root-1.css")!.toString(), "@font-face{src:url(/algorithmhot/assets/font-1.woff2)}body{background:url(./bg.png)}");
  assert.equal(site.files.get("feed.xml")!.toString(), SITE["/feed.xml"]![2]);
  assert.match(site.files.get("404.html")!.toString(), /页面不存在/);
  assert.equal(site.files.get(".nojekyll")!.length, 0);
});

test("the page cap counts entries first, then links in the order found", async () => {
  const site = await crawl({ origin, maxPages: 15, base: "", primary: null, siteName: "AlgorithmHot" });
  // 14 entries, then the first link found on the home page.
  assert.ok(site.files.has("items/a1/index.html"));
  assert.ok(!site.files.has("story/7/index.html") && !site.files.has("items/a2/index.html"));
  assert.match(site.files.get("index.html")!.toString(), /<a href="\/story\/7">/);
});

test("an unreadable home page stops the run", async () => {
  const down = http.createServer((_req, res) => res.writeHead(503).end());
  await new Promise<void>((resolve) => down.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(crawl({ origin: `http://127.0.0.1:${(down.address() as AddressInfo).port}`, maxPages: 10, base: "", primary: null, siteName: "x" }), /home page/);
  } finally {
    down.close();
  }
});
