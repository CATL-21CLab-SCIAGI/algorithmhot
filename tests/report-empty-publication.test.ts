// An opted-in empty edition stays recoverable in storage, disappears from public readers, and
// becomes visible again when the normal revision writer commits an edition with real items.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { publicReportCondition } from "@aihot/backend/publication/report-scope";
import { loadReport, reportIndexRows, v1Daily } from "@aihot/backend/publication/reports";
import { loadSiteStats } from "@aihot/backend/site/stats";
import { saveReport } from "@aihot/backend/reports/compose";
import { buildApp } from "../apps/api/src/app.ts";
import { collectSnapshot } from "../scripts/static-site.ts";

const fixtureTag = tag();
const app = await buildApp();
const [{ year }] = await sql<{ year: number }[]>`SELECT greatest(2050, coalesce(max(left(key, 4)::int), 0) + 2)::int AS year FROM reports`;
const start = new Date("2026-10-08T01:00:00Z");
const end = new Date("2026-10-09T01:00:00Z");
const key = (day: number) => `${year}-01-${String(day).padStart(2, "0")}`;
const citation = { itemId: null, title: `Collected item ${fixtureTag}`, sourceName: "Fixture", sourceUrl: "https://example.com/paper" };
const content = (items: typeof citation[]) => ({ fixtureTag, title: `Edition ${fixtureTag}`, sections: [{ label: "Research", items }], metrics: { totalEvents: items.length } });

async function get(route: string, status = 200) {
  const result = await app.inject({ method: "GET", url: route });
  assert.equal(result.statusCode, status, route);
  return result;
}

async function json(route: string) {
  return (await get(route)).json();
}

// Report routes go through the real API; unrelated export inputs stay empty in this fixture.
async function snapshot() {
  return collectSnapshot(async (route) => {
    if (route === "/api/site/reports/daily") {
      const index = await json(route);
      return { ...index, items: index.items.filter((entry: { key: string }) => entry.key.startsWith(`${year}-`)) };
    }
    if (["/api/site/reports/weekly", "/api/site/reports/monthly"].includes(route)) return { items: [] };
    if (route.startsWith("/api/site/reports/")) return json(route);
    if (route === "/api/site/topics") return { topics: [] };
    if (route === "/api/site/timeline?limit=40") return { cards: [], nextCursor: null };
    if (route === "/api/site/pool?page=1") return { page: 1, pageCount: 1, total: 0, items: [] };
    throw new Error(`Unexpected fixture request: ${route}`);
  }, "https://example.com/research/");
}

after(async () => {
  await sql`DELETE FROM reports WHERE content->>'fixtureTag' = ${fixtureTag}`;
  await app.close();
  await closeDb();
});

test("the opt-in condition requires a real object in daily section item arrays", async () => {
  const samples = [
    { content: {}, visible: false },
    { content: { sections: [] }, visible: false },
    { content: { sections: [{ items: [] }] }, visible: false },
    { content: { sections: [{ items: [null, "placeholder", 1, []] }] }, visible: false },
    { content: { sections: { items: [citation] } }, visible: false },
    { content: { sections: [{ items: citation }] }, visible: false },
    { content: { sections: [], flashes: [citation], metrics: { totalEvents: 99 } }, visible: false },
    { content: { sections: [{ items: [] }, { items: [citation] }] }, visible: true },
  ];
  for (const sample of samples) {
    for (const hideWhenEmpty of [false, true]) {
      const [result] = await sql<{ visible: boolean }[]>`
        SELECT ${publicReportCondition("candidate")} AS visible
        FROM (SELECT ${hideWhenEmpty}::boolean AS hide_when_empty, ${sql.json(sample.content)}::jsonb AS content) candidate`;
      assert.equal(result!.visible, !hideWhenEmpty || sample.visible, JSON.stringify({ ...sample, hideWhenEmpty }));
    }
  }
});

test("empty opt-in editions are hidden consistently and normal revisions restore publication", async (t) => {
  const baseline = (await reportIndexRows("daily", 1))[0]?.issue_number ?? 0;
  // Omit the new column to exercise the backwards-compatible default for existing callers.
  await sql`INSERT INTO reports (kind, key, window_start, window_end, generated_at, origin, content)
    VALUES ('daily', ${key(1)}, ${start}, ${end}, now(), 'manual', ${sql.json(content([]))})`;
  for (const day of [2, 3, 4]) {
    await sql`INSERT INTO reports (kind, key, window_start, window_end, generated_at, origin, content, hide_when_empty)
      VALUES ('daily', ${key(day)}, ${start}, ${end}, now(), 'manual', ${sql.json(content(day === 3 ? [citation] : []))}, true)`;
  }

  await t.test("directories, detail, v1, neighbors, ordinals and discovery use the same scope", async () => {
    const index = (await json("/api/site/reports/daily")).items;
    assert.deepEqual(index.filter((entry: { key: string }) => entry.key.startsWith(`${year}-`)).map((entry: { key: string; issueNumber: number }) => [entry.key, entry.issueNumber]), [
      [key(3), baseline + 2], [key(1), baseline + 1],
    ]);
    for (const day of [2, 4]) {
      assert.equal(await loadReport("daily", key(day)), null);
      assert.equal(await v1Daily(key(day)), null);
      await get(`/api/site/reports/daily/${key(day)}`, 404);
      await get(`/api/v1/dailies/${key(day)}`, 404);
      await get(`/og/reports/daily/${key(day)}.png`, 404);
    }
    const first = await json(`/api/site/reports/daily/${key(1)}`);
    const third = await json(`/api/site/reports/daily/${key(3)}`);
    assert.equal(first.next, key(3));
    assert.equal(third.prev, key(1));
    assert.equal(third.next, null);
    assert.equal(third.issueNumber, baseline + 2);
    assert.equal(first.sections[0].items.length, 0, "unflagged empty editions retain their previous behavior");
    const latest = await json("/api/site/reports/daily/latest-page");
    assert.equal(latest.report.key, key(3));
    assert.equal(latest.report.issueNumber, baseline + 2);
    assert.equal((await json("/api/v1/dailies/latest")).report.date, key(3));
    const v1 = await json("/api/v1/dailies");
    assert.deepEqual(v1.items.filter((entry: { date: string }) => entry.date.startsWith(`${year}-`)).map((entry: { date: string }) => entry.date), [key(3), key(1)]);
    for (const route of [`/api/site/reports/daily/navigation/${key(3)}`, `/api/site/reports/daily/months/${year}-01`]) {
      const entries = (await json(route)).items.filter((entry: { key: string }) => entry.key.startsWith(`${year}-`));
      assert.deepEqual(entries.map((entry: { key: string; issueNumber: number }) => [entry.key, entry.issueNumber]), [[key(3), baseline + 2], [key(1), baseline + 1]]);
    }
    for (const route of ["/sitemap.xml", "/feed/daily.xml"]) {
      const body = (await get(route)).body;
      assert.ok(body.includes(`/daily/${key(1)}`) && body.includes(`/daily/${key(3)}`), route);
      assert.ok(!body.includes(`/daily/${key(2)}`) && !body.includes(`/daily/${key(4)}`), route);
    }
    assert.equal((await loadSiteStats()).dailies, baseline + 2);
    assert.deepEqual((await snapshot()).reports.map((report) => report.key), [key(3), key(1)]);
    const stored = await sql<{ key: string; hide_when_empty: boolean; revision: number }[]>`
      SELECT key, hide_when_empty, revision FROM reports WHERE content->>'fixtureTag' = ${fixtureTag} ORDER BY key`;
    assert.equal(stored.length, 4, "hiding must not delete reports or revisions");
    assert.deepEqual(stored.map((row) => row.hide_when_empty), [false, true, true, true]);
  });

  await t.test("the existing writer preserves the flag while a populated revision becomes visible", async () => {
    await saveReport("daily", key(2), start, end, content([citation]), "empty-publication-test", "rule", null, 1);
    const report = await json(`/api/site/reports/daily/${key(2)}`);
    assert.equal(report.revision, 2);
    assert.equal(report.issueNumber, baseline + 2);
    assert.equal(report.prev, key(1));
    assert.equal(report.next, key(3));
    assert.equal((await json(`/api/v1/dailies/${key(2)}`)).report.date, key(2));
    assert.equal((await loadReport("daily", key(3)))!.issueNumber, baseline + 3);
    assert.equal((await loadReport("daily", key(1)))!.next, key(2));
    assert.deepEqual((await snapshot()).reports.map((entry) => entry.key), [key(3), key(2), key(1)]);
    const [stored] = await sql<{ hide_when_empty: boolean; revisions: number }[]>`
      SELECT r.hide_when_empty, (SELECT count(*)::int FROM report_revisions WHERE report_id = r.id) AS revisions
      FROM reports r WHERE kind = 'daily' AND key = ${key(2)}`;
    assert.equal(stored!.hide_when_empty, true);
    assert.equal(stored!.revisions, 1);
    // A later empty revision is hidden again without losing the opt-in policy or older revision.
    await saveReport("daily", key(2), start, end, content([]), "empty-publication-test", "rule", null, 2);
    assert.equal(await loadReport("daily", key(2)), null);
    assert.equal((await loadReport("daily", key(3)))!.issueNumber, baseline + 2);
    const [revised] = await sql<{ revision: number; hide_when_empty: boolean }[]>`
      SELECT revision, hide_when_empty FROM reports WHERE kind = 'daily' AND key = ${key(2)}`;
    assert.deepEqual(revised, { revision: 3, hide_when_empty: true });
  });
});
