// Real local end-to-end verification. Reads retained evidence; never invokes a model or collector.
// PASS covers these automated checks only; the source-support audit and full goal remain separate.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { sql, closeDb } from "@aihot/backend/db";
import { config } from "@aihot/backend/config";
import { getModelRun } from "@aihot/backend/providers/model-runs";
import { researchRunMetrics } from "@aihot/backend/research/admission";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { escapeXml } from "@aihot/backend/lib/text";
import { RESEARCH_BRIEF_LABELS } from "@aihot/contracts/research";

const id = process.argv[2];
if (!id || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("stable run ID required");
const site = new URL(config.siteUrl);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(site.hostname), "acceptance only supports the local site");
const checks: Array<{ name: string; status: "PASS" | "FAIL" }> = [];
const startedAt = new Date().toISOString();
const directory = path.join(config.dataDir, "research", id);
const base = { runId: id, site: config.siteUrl, startedAt, scope: "retained-evidence-and-local-endpoints", sourceSupportAudit: "SEPARATE_MANUAL_CHECK" };
let activeCheck = "initialize";
async function save(value: Record<string, unknown>) {
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `acceptance.${process.pid}.tmp`);
  await writeFile(temporary, JSON.stringify({ ...base, checkedAt: new Date().toISOString(), checks, ...value }, null, 2), { mode: 0o600 });
  await rename(temporary, path.join(directory, "acceptance.json"));
}
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  activeCheck = name;
  await fn();
  checks.push({ name, status: "PASS" });
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "expected a JSON object");
  return value as Record<string, unknown>;
}
const request = (pathname: string, init: RequestInit = {}) => fetch(`${config.siteUrl}${pathname}`, { ...init, signal: AbortSignal.timeout(15_000) });
async function get(pathname: string) {
  const response = await request(pathname);
  assert.equal(response.status, 200, `${pathname}: ${response.status}`);
  return response;
}

try {
  // Invalidate an old PASS before starting, so a crash cannot silently leave it as the latest result.
  await save({ status: "RUNNING" });
  activeCheck = "run-exists";
  const [run] = await sql`SELECT * FROM research_runs WHERE id=${id}`;
  assert.ok(run?.admission_frozen, "existing frozen run required");
  assert.ok(run.kind === "pilot" || run.kind === "daily");
  const members = await sql`SELECT m.*,a.research FROM research_members m JOIN articles a ON a.id=m.article_id WHERE m.run_id=${id} AND m.admitted`;
  await check("frozen-admission", () => {
    assert.ok(members.length <= 60);
    assert.equal(new Set(members.map(row => row.research?.canonicalKey ?? row.article_id)).size, members.length);
    assert.ok(members.every(row => row.in_window && !row.signal_only));
  });
  activeCheck = "budget-exists";
  const budget = await getModelRun(id);
  assert.ok(budget);
  const attempts = await sql`SELECT r.purpose,r.status AS receipt_status,a.status,a.service,a.model,a.usage,a.response FROM receipt_attempts a JOIN receipts r ON r.id=a.receipt_id WHERE a.model_run_id=${id}`;
  await check("persisted-budget", () => {
    assert.equal(budget.callsUsed, attempts.length);
    assert.ok(budget.maxCalls <= 600 && budget.callsUsed <= budget.maxCalls);
    assert.equal(attempts.filter(attempt => attempt.status === "pending").length, 0, "finish or reconcile active model requests before acceptance");
  });
  await check("real-model-stages", () => {
    const successful = attempts.filter(attempt => attempt.service === "codex_cli" && attempt.status === "received" && attempt.receipt_status === "completed" && typeof attempt.response?._codex?.threadId === "string");
    for (const purpose of ["prefilter_article", "score_article"]) assert.ok(successful.some(attempt => attempt.purpose === purpose), `missing completed Codex ${purpose}`);
    assert.ok(successful.some(attempt => ["summarize_article", "understand_article"].includes(attempt.purpose)), "missing completed Codex summary-producing stage");
  });
  const files = await sql`SELECT response_path,response_sha256 FROM research_fetches WHERE run_id=${id} AND response_path IS NOT NULL`;
  await check("raw-response-hashes", async () => {
    assert.ok(files.length > 0, "no retained source response");
    for (const file of files) assert.equal(createHash("sha256").update(await readFile(file.response_path)).digest("hex"), file.response_sha256, file.response_path);
  });
  activeCheck = "report-exists";
  const [report] = await sql`SELECT * FROM reports WHERE kind=${run.kind} AND key=${run.report_key}`;
  assert.ok(report, "report must be generated before acceptance");
  const entries = report.content.sections.flatMap((section: { items: Array<{ itemId: string; sourceUrl: string; research?: unknown; researchBrief?: unknown }> }) => section.items);
  await check("report-window-and-cap", () => {
    assert.equal(+report.window_start, +run.window_start);
    assert.equal(+report.window_end, +run.window_end);
    assert.equal(report.content.run?.id, id, "report belongs to another batch");
    assert.ok(entries.length <= 15);
    assert.ok(report.content.sections.every((section: { items: unknown[] }) => section.items.length <= 5));
    assert.equal(new Set(entries.map((entry: { itemId: string }) => entry.itemId)).size, entries.length);
    assert.ok(entries.every((entry: { itemId: string }) => members.some(member => member.article_id === entry.itemId)));
  });
  const health = await researchRunMetrics(id);
  await check("report-processing-disclosure", () => {
    assert.deepEqual(report.content.run.gaps, health.gaps, "regenerate stale report before acceptance");
    assert.equal(report.content.run.status, health.gaps.length ? "partial" : "complete");
    for (const [key, value] of Object.entries(health.metrics)) assert.equal(report.content.run.metrics[key], value, `stale report metric: ${key}`);
  });
  await check("API-MCP-report-consistency", async () => {
    const prefix = run.kind === "pilot" ? "pilots" : "dailies";
    const exported: unknown = await (await get(`/api/v1/${prefix}/${report.key}`)).json();
    const response = await request("/api/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: `algorithmhot_get_${run.kind}`, arguments: run.kind === "pilot" ? { key: report.key } : { date: report.key } } }) });
    assert.equal(response.status, 200);
    const raw = await response.text();
    const data = response.headers.get("content-type")?.startsWith("text/event-stream") ? raw.split("\n").find(line => line.startsWith("data: "))?.slice(6) : raw;
    assert.ok(data, "missing MCP response payload");
    const payload = object(JSON.parse(data));
    assert.equal(payload.error, undefined, "MCP returned an error");
    const result = object(payload.result);
    assert.notEqual(result.isError, true);
    const { _trust, ...mcp } = object(result.structuredContent);
    assert.deepEqual(mcp, exported);
    assert.equal(object(_trust).contentTrust, "untrusted_external_data");
  });
  await check("pages-and-published-evidence", async () => {
    for (const pathname of ["/", "/?category=algorithm", "/?category=ai4ai", "/?category=ai4s", "/topics", "/daily", `/${run.kind}/${report.key}`]) assert.ok((await (await get(pathname)).text()).includes("AlgorithmHot"));
    for (const entry of entries) {
      assert.ok(entry.sourceUrl && ["http:", "https:"].includes(new URL(entry.sourceUrl).protocol));
      assert.ok(entry.research);
      assert.ok(entry.researchBrief);
      await get(`/items/${entry.itemId}`);
    }
  });
  await check("RSS-API-item-consistency", async () => {
    const feed = new XMLParser({ parseTagValue: false }).parse(await (await get("/feed/all.xml")).text());
    const rawItems = feed?.rss?.channel?.item;
    const rssItems = rawItems ? Array.isArray(rawItems) ? rawItems : [rawItems] : [];
    const api = object(await (await get("/api/v1/items?mode=all&window=7d&by=published&limit=50")).json());
    assert.ok(Array.isArray(api.items));
    const items = api.items.map(object);
    assert.deepEqual(rssItems.map(item => item.guid), items.map(item => item.id));
    for (const item of items) {
      const rss = rssItems.find(row => row.guid === item.id);
      assert.equal(rss.title, item.title);
      assert.equal(rss.link, object(item.links).aihot);
      assert.ok(rss.description.includes(escapeXml(String(item.summary ?? ""))));
      assert.ok(rss.description.includes(escapeXml(String(object(item.links).original))));
      if (item.publishedAt) assert.equal(+new Date(rss.pubDate), +new Date(String(item.publishedAt)));
      if (item.researchBrief) for (const key of Object.keys(RESEARCH_BRIEF_LABELS)) assert.ok(rss.description.includes(escapeXml(String(object(item.researchBrief)[key]))));
      if (item.research) for (const key of ["originalPublishedAt", "revisedAt", "communitySelectedAt", "observedAt"]) assert.ok(rss.description.includes(escapeXml(String(object(item.research)[key] ?? "未知"))));
    }
  });
  await check("admin-on-demand-status", async () => {
    // Credentials and session cookies remain local to this process and are never printed or saved.
    const login = await request("/api/auth/password", { method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: config.adminPassword, return: "/admin/runs" }) });
    assert.equal(login.status, 303);
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);
    const headers = { cookie };
    try {
      const admin = await request("/api/admin/runs", { headers });
      assert.equal(admin.status, 200);
      const status = object(await admin.json());
      assert.equal(status.onDemand, true);
      assert.ok(Array.isArray(status.researchRuns));
      assert.ok(status.researchRuns.some(value => object(value).id === id));
    } finally {
      const me = await request("/api/admin/me", { headers });
      assert.equal(me.status, 200);
      const principal = object(await me.json());
      assert.equal(typeof principal.csrf, "string");
      const logout = await request("/api/auth/logout", { method: "POST", headers: { ...headers, "x-csrf-token": principal.csrf as string }, redirect: "manual" });
      assert.equal(logout.status, 303);
    }
  });
  const receipt = { status: "PASS", ...health, budget, modelAttempts: { received: attempts.filter(attempt => attempt.status === "received").length, failed: attempts.filter(attempt => attempt.status === "failed").length, unknown: attempts.filter(attempt => attempt.status === "unknown").length }, rawResponsesVerified: files.length, published: entries.length };
  await save(receipt);
  console.log(JSON.stringify({ ...base, checks, ...receipt }));
} catch (error) {
  checks.push({ name: activeCheck, status: "FAIL" });
  // Deliberately omit exception values that might contain response bodies, credentials, or cookies.
  await save({ status: "FAIL", failedCheck: activeCheck });
  console.error(`Acceptance failed at ${activeCheck}; see .data/research/${id}/acceptance.json`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
