// A worker commits a new issue after the API has already served the archive. The exporter
// must see the same issue as the detail page's live next/previous links, without a cache wait.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ReportDetail, ReportKind } from "@aihot/contracts/site";
import { sql, closeDb } from "@aihot/backend/db";
import { buildApp } from "../apps/api/src/app.ts";
import { collectSnapshot } from "../scripts/static-site.ts";
import { sanitizeSsrPage } from "../scripts/static-site/ssr.ts";

const fixtureTag = tag();
const app = await buildApp();
const [{ year }] = await sql<{ year: number }[]>`SELECT greatest(2050, coalesce(max(left(key, 4)::int), 0) + 2)::int AS year FROM reports`;
const base = "https://pkucy2016.github.io/algorithmhot/";

async function get(route: string) {
  const response = await app.inject({ method: "GET", url: route });
  assert.equal(response.statusCode, 200, route);
  return response.json();
}

async function insert(kind: ReportKind, key: string) {
  await sql`INSERT INTO reports (kind, key, window_start, window_end, generated_at, origin, content)
    VALUES (${kind}, ${key}, ${new Date("2026-10-08T01:00:00Z")}, ${new Date("2026-10-09T01:00:00Z")}, now(), 'manual',
      ${sql.json({ fixtureTag, title: `Issue ${key}`, sections: [], themes: [] })})`;
}

// Keep unrelated item/topic pagination empty; report requests use the real API and database.
const snapshot = () => collectSnapshot(async (route) => {
  if (route.startsWith("/api/site/reports/")) return get(route);
  if (route === "/api/site/topics") return { topics: [] };
  if (route === "/api/site/timeline?limit=40") return { cards: [], nextCursor: null };
  if (route === "/api/site/pool?page=1") return { page: 1, pageCount: 1, total: 0, items: [] };
  throw new Error(`Unexpected fixture request: ${route}`);
}, base);

after(async () => {
  await sql`DELETE FROM reports WHERE content->>'fixtureTag' = ${fixtureTag}`;
  await app.close();
  await closeDb();
});

test("a newly committed issue is immediately included in export routes and reader navigation", async (t) => {
  const editions = [
    ["daily", `${year}-01-08`, `${year}-01-09`],
    ["weekly", `${year}-W01`, `${year}-W02`],
    ["monthly", `${year}-01`, `${year}-02`],
  ] as const;
  for (const [kind, earlier] of editions) await insert(kind, earlier);
  for (const [kind, earlier, later] of editions) {
    await t.test(kind, async () => {
      const warm = await get(`/api/site/reports/${kind}`);
      assert.equal(warm.items[0].key, earlier);
      // Direct DB write models the separate producer process, without an in-process invalidator.
      await insert(kind, later);
      const exported = await snapshot();
      const detail: ReportDetail = await get(`/api/site/reports/${kind}/${earlier}`);
      assert.equal(detail.next, later);
      const routes = new Set(["/", "/about", ...exported.reports.map(r => `/${r.kind}/${r.key}`)]);
      const html = `<html><head><title>Issue</title></head><body><main id="main"><div class="mx-auto w-full"><a href="/${kind}/${detail.next}">Next issue</a></div></main></body></html>`;
      assert.doesNotThrow(() => sanitizeSsrPage(html, { snapshot: exported, routes, route: `/${kind}/${earlier}`, assets: new Set() }));
      assert.ok(exported.reports.some(r => r.kind === kind && r.key === later));
      assert.equal((await get(`/api/site/reports/${kind}/latest-page`)).report.key, later);
      assert.equal((await get(`/api/site/reports/${kind}/navigation/${earlier}`)).items[0].key, later);
      const updated = await get(`/api/site/reports/${kind}`);
      assert.equal(updated.items.find((r: { key: string }) => r.key === earlier).issueNumber, warm.items[0].issueNumber);

      await sql`DELETE FROM reports WHERE kind=${kind} AND key=${later} AND content->>'fixtureTag'=${fixtureTag}`;
      assert.equal((await get(`/api/site/reports/${kind}`)).items[0].key, earlier);
      assert.equal((await get(`/api/site/reports/${kind}/${earlier}`)).next, null);
    });
  }
});
