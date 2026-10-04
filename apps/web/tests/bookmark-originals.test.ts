import assert from "node:assert/strict";
import { test } from "node:test";
import { loadBookmarkOriginals } from "../app/lib/bookmark-originals.ts";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

test("bookmark edits do not re-request resolved or failed legacy originals during the same visit", async () => {
  const attempted = new Set<string>(), requests: string[] = [], found: string[] = [];
  const items = [{ id: "old-success" }, { id: "old-failed" }, { id: "saved", originalUrl: "https://example.org/saved" }];
  const options = { items, attempted, signal: new AbortController().signal, onAvailability: () => {}, onOriginal: (id: string) => { found.push(id); },
    fetcher: async (url: string) => {
      requests.push(url);
      if (url.includes("availability?")) return json({});
      const id = url.split("/").at(-1)!;
      return id === "old-failed" ? json({}, 503) : json({ id, links: { original: `https://example.org/${id}` } });
    },
  };
  await loadBookmarkOriginals(options);
  await loadBookmarkOriginals({ ...options, items: [...items, { id: "new" }] });
  await loadBookmarkOriginals({ ...options, items: items.slice(0, 2) });
  assert.deepEqual(requests.filter(url => !url.includes("availability?")), ["/api/site/items/old-success", "/api/site/items/old-failed", "/api/site/items/new"]);
  assert.deepEqual(found, ["old-success", "new"]);
  assert.equal(attempted.has("old-failed"), true);
});

test("an availability failure never expands into detail requests", async () => {
  const requests: string[] = [], attempted = new Set<string>();
  await loadBookmarkOriginals({ items: Array.from({ length: 500 }, (_, i) => ({ id: `legacy-${i}` })), attempted,
    signal: new AbortController().signal, onAvailability: () => { assert.fail("availability failure"); }, onOriginal: () => { assert.fail("no originals"); },
    fetcher: async url => { requests.push(url); return json({}, 503); },
  });
  assert.equal(requests.length, 1); assert.equal(attempted.size, 0);
});

test("legacy lookup is bounded to four requests and ignores unavailable or mismatched originals", async () => {
  let active = 0, max = 0;
  const found: string[] = [];
  await loadBookmarkOriginals({ items: Array.from({ length: 13 }, (_, i) => ({ id: `id-${i}` })), attempted: new Set(),
    signal: new AbortController().signal, onAvailability: () => {}, onOriginal: id => { found.push(id); },
    fetcher: async url => {
      if (url.includes("availability?")) return json({ "id-12": "unavailable" });
      const id = url.split("/").at(-1)!;
      active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 2)); active--;
      return json({ id: id === "id-0" ? "different" : id, links: { original: `https://example.org/${id}` } });
    },
  });
  assert.equal(max, 4); assert.equal(found.length, 11); assert.equal(found.includes("id-12"), false); assert.equal(found.includes("id-0"), false);
});
