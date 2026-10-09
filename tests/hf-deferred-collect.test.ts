// Exercise the real collector and report path against a disposable database; HTTP is injected.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { collectResearchRun, createResearchRun } from "@aihot/backend/research/collect";
import { freezeAdmissions, researchRunMetrics } from "@aihot/backend/research/admission";
import { researchResponsePath, saveResearchResponse } from "@aihot/backend/research/collect-utils";
import { composePilot } from "@aihot/backend/reports/compose";
import type { GuardedResponse } from "@aihot/backend/lib/http-fetch";
import { createExport } from "../scripts/static-site.ts";
import { sanitizeReport } from "../scripts/static-site/model.ts";

const T = tag(), sourceId = `hf-deferred-${T}`;
const otherSources = Array.from({ length: 5 }, (_, i) => `hf-other-${T}-${i}`);
const originalDataDir = config.dataDir, callsEnabled = config.modelCallsEnabled;
const observed = new Date("2026-10-06T05:00:00Z");
const runIds: string[] = [];
let folder: string;
const dateError = (through = "2026-10-05") => JSON.stringify({ error: `✖ "date" must be less than or equal to "${through}T00:00:00.000Z"\n  → at date` });
const response = (url: string, status: number, text = "[]"): GuardedResponse => {
  const body = Buffer.from(text);
  return { url, status, body, headers: new Headers({ "content-type": "application/json" }), text: () => body.toString("utf8") };
};
async function run(label: string, start = "2026-10-05T00:00:00Z", end = "2026-10-06T01:00:00Z") {
  const id = `hf-${T}-${label}`; runIds.push(id);
  await createResearchRun(id, "pilot", observed, { start: new Date(start), end: new Date(end) });
  return id;
}
const neverFetch = async (): Promise<GuardedResponse> => { throw new Error("Unexpected retry in the same snapshot"); };
const neverWait = async () => { assert.fail("A non-retryable response must not back off"); };

before(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "algorithmhot-hf-deferred-"));
  config.dataDir = folder; config.modelCallsEnabled = false;
  mock.timers.enable({ apis: ["Date"], now: observed });
  await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,config) VALUES(${sourceId},'HF availability fixture','json_list','T2','hot_signal',${sql.json({
    url: "https://huggingface.co/api/daily_papers", researchSourceKind: "huggingface", titlePaths: ["paper.title"], summaryPaths: ["paper.summary"],
    summaryIsBody: true, urlTemplate: "https://huggingface.co/papers/{paper.id}", externalIdPath: "paper.id",
  })})`;
  for (const id of otherSources) await sql`INSERT INTO sources(id,name,kind,tier) VALUES(${id},'Other healthy source','rss','T1')`;
});
after(async () => {
  mock.timers.reset(); config.dataDir = originalDataDir; config.modelCallsEnabled = callsEnabled;
  await sql`DELETE FROM reports WHERE content->'run'->>'id'=ANY(${runIds})`;
  await sql`DELETE FROM research_members WHERE run_id=ANY(${runIds})`;
  await sql`DELETE FROM research_fetches WHERE run_id=ANY(${runIds})`;
  await sql`DELETE FROM research_runs WHERE id=ANY(${runIds})`;
  await sql`DELETE FROM articles WHERE source_id=${sourceId}`;
  await sql`DELETE FROM sources WHERE id=ANY(${[sourceId, ...otherSources]})`;
  await closeDb(); await rm(folder, { recursive: true, force: true });
});

test("unopened HF dates retain raw HTTP 400 and private partial-coverage evidence", async () => {
  const id = await run("unopened"), raw = `${dateError()}\n`;
  const requests: string[] = [];
  const before = Number((await sql`SELECT count(*) AS n FROM receipt_attempts`)[0].n);
  await collectResearchRun(id, { sourceIds: [sourceId], wait: neverWait, fetch: async url => {
    requests.push(url);
    return response(url, url.includes("date=2026-10-06") ? 400 : 200, url.includes("date=2026-10-06") ? raw : "[]");
  } });
  assert.equal(requests.length, 2);
  const [receipt] = await sql`SELECT * FROM research_fetches WHERE run_id=${id} AND http_status=400`;
  assert.equal(receipt.status, "failed"); assert.equal(receipt.outcome, "not_yet_available");
  assert.equal(receipt.attempt_number, 1); assert.equal(receipt.returned_count, 0); assert.equal(receipt.parsed_count, 0);
  const bytes = await readFile(receipt.response_path), metadata = JSON.parse(await readFile(`${receipt.response_path}.json`, "utf8"));
  assert.deepEqual(bytes, Buffer.from(raw));
  assert.equal(receipt.response_sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(metadata.sha256, receipt.response_sha256); assert.equal(metadata.status, 400);
  assert.equal(metadata.bytes, bytes.length);
  assert.deepEqual((await sql`SELECT health,fail_count FROM sources WHERE id=${sourceId}`)[0], { health: "unknown", fail_count: 0 });
  await collectResearchRun(id, { sourceIds: [sourceId], fetch: neverFetch, wait: neverWait });
  assert.deepEqual((await sql`SELECT * FROM research_fetches WHERE id=${receipt.id}`)[0], receipt, "same-slot recovery does not rewrite or retry the 400");
  assert.deepEqual(await readFile(receipt.response_path), bytes);
  for (const source of otherSources) await sql`INSERT INTO research_fetches(run_id,source_id,url,status) VALUES(${id},${source},${`https://example.org/${source}`},'ok')`;
  const { metrics, gaps } = await researchRunMetrics(id);
  assert.equal(metrics.sourcesObserved, 6); assert.equal(metrics.sourcesSucceeded, 5);
  assert.equal(metrics.sourcesFailed, 0); assert.equal(metrics.sourcesDeferred, 1);
  assert.equal(metrics.failedRequests, 0); assert.equal(metrics.deferredRequests, 1); assert.equal(metrics.healthyEmptySources, 5);
  assert.equal(metrics.stored, 0); assert.equal(metrics.signals, 0);
  assert.equal(gaps.length, 1); assert.match(gaps[0], /尚未开放 2026-10-06 的社区信号.*下一正常刷新补采.*不表示当天没有新研究/);
  await freezeAdmissions(id);
  const result = await composePilot(id, false, { ruleOnly: true });
  const [report] = await sql`SELECT * FROM reports WHERE kind='pilot' AND key=${result.key}`;
  assert.equal(report.content.run.status, "partial"); assert.deepEqual(report.content.run.gaps, gaps);
  const publicReport = sanitizeReport({ ...report.content, kind: "pilot", key: result.key, windowStart: report.window_start.toISOString(), windowEnd: report.window_end.toISOString() });
  const { files } = createExport({ schemaVersion: 1, generatedAt: observed.toISOString(), publicBaseUrl: "https://example.org/algorithmhot/", mode: "static-snapshot", scope: "HF fixture", items: [], topics: [], reports: [publicReport] });
  assert.equal(files.has(`pilot/${result.key}/index.html`), false, "retired pilot evidence stays private");
  assert.deepEqual(publicReport.gaps, gaps, "source diagnostics remain in the saved audit data");
  assert.equal(publicReport.status, "partial");
  assert.equal(Number((await sql`SELECT count(*) AS n FROM receipt_attempts`)[0].n), before, "collection and empty report must not call a model");

  const nextId = await run("next-slot", "2026-10-05T00:00:00Z", "2026-10-06T04:00:00Z"), nextRequests: string[] = [];
  await collectResearchRun(nextId, { sourceIds: [sourceId], wait: neverWait, fetch: async url => { nextRequests.push(url); return response(url, 200); } });
  assert.equal(nextRequests.filter(url => url.includes("date=2026-10-06")).length, 1, "a fresh normal slot observes the formerly unopened date once");
  const next = await researchRunMetrics(nextId);
  assert.equal(next.metrics.sourcesSucceeded, 1); assert.equal(next.metrics.sourcesDeferred, 0); assert.equal(next.metrics.deferredRequests, 0);
  assert.deepEqual((await sql`SELECT * FROM research_fetches WHERE id=${receipt.id}`)[0], receipt, "new observations never retrofit the old failure receipt");
  assert.deepEqual(await readFile(receipt.response_path), bytes);
});

test("a deferred date does not stop collection of another date", async () => {
  const id = await run("continue"), dates: string[] = [];
  await collectResearchRun(id, { sourceIds: [sourceId], wait: neverWait, fetch: async url => {
    const date = new URL(url).searchParams.get("date")!; dates.push(date);
    return date === "2026-10-05" ? response(url, 400, dateError("2026-10-04")) : response(url, 200);
  } });
  assert.deepEqual(dates, ["2026-10-05", "2026-10-06"]);
  assert.deepEqual((await sql`SELECT status,outcome FROM research_fetches WHERE run_id=${id} ORDER BY id`).map(r => [r.status, r.outcome]), [["failed", "not_yet_available"], ["ok", null]]);
  const { metrics } = await researchRunMetrics(id);
  assert.equal(metrics.sourcesSucceeded, 0); assert.equal(metrics.sourcesDeferred, 1); assert.equal(metrics.healthyEmptySources, 0);
});

test("deferral cannot hide an independent failed date from the same source", async () => {
  const id = await run("mixed-failure");
  await collectResearchRun(id, { sourceIds: [sourceId], wait: neverWait, fetch: async url => response(url, 400, url.includes("date=2026-10-06") ? dateError() : '{"error":"Bad request"}') });
  const { metrics, gaps } = await researchRunMetrics(id);
  assert.equal(metrics.sourcesObserved, 1); assert.equal(metrics.sourcesFailed, 1);
  assert.equal(metrics.sourcesSucceeded, 0); assert.equal(metrics.sourcesDeferred, 0); assert.equal(metrics.healthyEmptySources, 0);
  assert.equal(metrics.failedRequests, 1); assert.equal(metrics.deferredRequests, 1);
  assert.match(gaps.join("；"), /来源采集尚不完整/); assert.match(gaps.join("；"), /尚未开放 2026-10-06/);
  assert.deepEqual((await sql`SELECT health,fail_count FROM sources WHERE id=${sourceId}`)[0], { health: "degraded", fail_count: 1 });
});

test("ordinary HTTP 400 and mismatched redirect evidence remain failures without retries", async () => {
  for (const [label, body, finalUrl] of [["ordinary", '{"error":"Invalid date format"}', null], ["redirect", dateError(), "https://example.org/api/daily_papers?date=2026-10-06"], ["wrong-date", dateError("2026-10-06"), null]] as const) {
    const id = await run(label, "2026-10-06T00:00:00Z"), calls: string[] = [];
    await collectResearchRun(id, { sourceIds: [sourceId], wait: neverWait, fetch: async url => { calls.push(url); return response(finalUrl ?? url, 400, body); } });
    assert.equal(calls.length, 1);
    const [receipt] = await sql`SELECT * FROM research_fetches WHERE run_id=${id}`;
    assert.equal(receipt.outcome, null); assert.equal(receipt.status, "failed"); assert.equal(receipt.http_status, 400);
    await collectResearchRun(id, { sourceIds: [sourceId], fetch: neverFetch, wait: neverWait });
    assert.equal((await sql`SELECT count(*)::int AS n FROM research_fetches WHERE run_id=${id}`)[0].n, 1);
    const { metrics } = await researchRunMetrics(id);
    assert.equal(metrics.sourcesFailed, 1); assert.equal(metrics.sourcesDeferred, 0); assert.equal(metrics.deferredRequests, 0); assert.equal(metrics.healthyEmptySources, 0);
  }
});

test("429, 5xx and network failures back off and stop after three attempts, including on resume", async () => {
  for (const status of [429, 500, 503, null]) {
    const id = await run(`bounded-${status}`, "2026-10-06T00:00:00Z"), waits: number[] = [];
    let calls = 0;
    await collectResearchRun(id, { sourceIds: [sourceId], wait: async ms => { waits.push(ms); }, fetch: async url => { calls++; if (status === null) throw new Error("fixture network failure"); return response(url, status, '{"error":"Temporary failure"}'); } });
    assert.equal(calls, 3); assert.deepEqual(waits, [1500, 3000]);
    const receipts = await sql`SELECT * FROM research_fetches WHERE run_id=${id} ORDER BY attempt_number`;
    assert.deepEqual(receipts.map(r => r.attempt_number), [1, 2, 3]); assert.ok(receipts.every(r => r.status === "failed" && r.outcome === null));
    await collectResearchRun(id, { sourceIds: [sourceId], fetch: neverFetch, wait: neverWait });
    assert.equal((await sql`SELECT count(*)::int AS n FROM research_fetches WHERE run_id=${id}`)[0].n, 3);
    const { metrics } = await researchRunMetrics(id);
    assert.equal(metrics.sourcesFailed, 1); assert.equal(metrics.failedRequests, 3); assert.equal(metrics.sourcesDeferred, 0);
  }
});

test("successful bounded retry retains earlier error bytes and makes final source health successful", async () => {
  const id = await run("retry-success", "2026-10-06T00:00:00Z"), waits: number[] = [];
  let calls = 0;
  await collectResearchRun(id, { sourceIds: [sourceId], wait: async ms => { waits.push(ms); }, fetch: async url => response(url, [429, 503, 200][calls++], calls === 3 ? "[]" : '{"error":"Temporary failure"}') });
  assert.deepEqual(waits, [1500, 3000]); assert.equal(calls, 3);
  const receipts = await sql`SELECT * FROM research_fetches WHERE run_id=${id} ORDER BY attempt_number`;
  assert.deepEqual(receipts.map(r => r.status), ["failed", "failed", "ok"]);
  for (const receipt of receipts) assert.equal(createHash("sha256").update(await readFile(receipt.response_path)).digest("hex"), receipt.response_sha256);
  const { metrics } = await researchRunMetrics(id);
  assert.equal(metrics.failedRequests, 2); assert.equal(metrics.sourcesSucceeded, 1); assert.equal(metrics.sourcesFailed, 0); assert.equal(metrics.sourcesDeferred, 0);
});

test("UTC midnight is exclusive and only the next window observes the newly opened date partition", async () => {
  for (const [label, end, expected] of [["midnight", "2026-10-06T00:00:00Z", ["2026-10-05"]], ["after-midnight", "2026-10-06T00:00:00.001Z", ["2026-10-05", "2026-10-06"]]] as const) {
    const id = await run(label, "2026-10-05T23:59:59Z", end), dates: string[] = [];
    await collectResearchRun(id, { sourceIds: [sourceId], wait: neverWait, fetch: async url => { const date = new URL(url).searchParams.get("date")!; dates.push(date); return response(url, date === "2026-10-06" ? 400 : 200, date === "2026-10-06" ? dateError() : "[]"); } });
    assert.deepEqual(dates, expected);
    assert.equal((await researchRunMetrics(id)).metrics.deferredRequests, expected.length - 1);
  }
});

test("an interrupted explicit 400 response is classified from retained bytes without resending it", async () => {
  const id = await run("interrupted", "2026-10-06T00:00:00Z"), url = "https://huggingface.co/api/daily_papers?date=2026-10-06&limit=100&p=0";
  const file = researchResponsePath(folder, "hf-interrupted"), raw = Buffer.from(dateError());
  await sql`INSERT INTO research_fetches(run_id,source_id,url,observed_at,status,http_status,response_path) VALUES(${id},${sourceId},${url},${observed},'pending',400,${file})`;
  const hash = await saveResearchResponse(file, raw, { url, finalUrl: url, status: 400, observedAt: observed, headers: {} });
  await collectResearchRun(id, { sourceIds: [sourceId], fetch: neverFetch, wait: neverWait });
  const [receipt] = await sql`SELECT * FROM research_fetches WHERE run_id=${id}`;
  assert.equal(receipt.status, "failed"); assert.equal(receipt.outcome, "not_yet_available"); assert.equal(receipt.attempt_number, 1);
  assert.equal(receipt.response_sha256, hash); assert.deepEqual(await readFile(file), raw);
});

test("interrupted 400s without matching final-origin evidence remain failures", async () => {
  for (const [label, finalUrl, originalUrl] of [["missing-final", undefined, null], ["redirect-final", "https://example.org/api/daily_papers?date=2026-10-06", null], ["other-date-final", "https://huggingface.co/api/daily_papers?date=2026-10-05&limit=100&p=0", null], ["wrong-original", "https://huggingface.co/api/daily_papers?date=2026-10-06&limit=100&p=0", "https://example.org/other"]] as const) {
    const id = await run(label, "2026-10-06T00:00:00Z"), url = "https://huggingface.co/api/daily_papers?date=2026-10-06&limit=100&p=0";
    const file = researchResponsePath(folder, label), raw = Buffer.from(dateError());
    await sql`INSERT INTO research_fetches(run_id,source_id,url,observed_at,status,http_status,response_path) VALUES(${id},${sourceId},${url},${observed},'pending',400,${file})`;
    const hash = await saveResearchResponse(file, raw, { url: originalUrl ?? url, ...(finalUrl ? { finalUrl } : {}), status: 400, observedAt: observed, headers: {} });
    await collectResearchRun(id, { sourceIds: [sourceId], fetch: neverFetch, wait: neverWait });
    const [receipt] = await sql`SELECT * FROM research_fetches WHERE run_id=${id}`;
    assert.equal(receipt.status, "failed"); assert.equal(receipt.outcome, null); assert.equal(receipt.attempt_number, 1);
    assert.equal(receipt.response_sha256, hash); assert.deepEqual(await readFile(file), raw);
    const { metrics } = await researchRunMetrics(id);
    assert.equal(metrics.sourcesFailed, 1); assert.equal(metrics.sourcesDeferred, 0);
  }
});
