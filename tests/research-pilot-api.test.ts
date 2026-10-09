import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { MCP_TOOL_NAMES } from "@aihot/contracts/mcp";
import { buildApp } from "../apps/api/src/app.ts";

const app = await buildApp();
const key = "2098-11-21";
const run = { id: "pilot-api-test", kind: "pilot", status: "partial", metrics: { admitted: 0, sourcesFailed: 1 }, gaps: ["A source failed; no claim of zero new research."] };
before(async () => {
  await sql`DELETE FROM reports WHERE kind IN ('daily', 'pilot') AND key=${key}`;
  for (const kind of ["daily", "pilot"]) {
    const content = { title: kind === "pilot" ? "最近七天科研试刊" : "正常日报", sections: [], flashes: [], ...(kind === "pilot" ? { run } : {}) };
    await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at,origin)
      VALUES (${kind},${key},'2098-11-14T00:00:00Z','2098-11-21T00:00:00Z',${sql.json(content)},now(),'manual')`;
  }
});
after(async () => {
  await sql`DELETE FROM reports WHERE kind IN ('daily','pilot') AND key=${key}`;
  await app.close();
  await stopBoss();
  await closeDb();
});

test("historical pilots stay private while daily reports remain available", async () => {
  for (const route of [`/api/site/reports/pilot/${key}`, "/api/site/reports/pilot", "/api/site/reports/pilot/latest", `/api/v1/pilots/${key}`, "/api/v1/pilots/latest", "/api/v1/pilots", "/og/pilot.png"]) {
    assert.equal((await app.inject(route)).statusCode, 404, route);
  }
  const daily = await app.inject(`/api/v1/dailies/${key}`);
  assert.equal(daily.statusCode, 200);
  assert.equal(daily.json().report.date, key);
  assert.equal(daily.json().report.title, "正常日报");
  assert.equal((await sql`SELECT count(*)::int AS n FROM reports WHERE kind='pilot' AND key=${key}`)[0]!.n, 1);
});

test("OpenAPI retains research metadata and no longer advertises pilot routes", () => {
  const schema = JSON.parse(readFileSync(new URL("../reference/public-v1.openapi.json", import.meta.url), "utf8"));
  assert.ok(Object.keys(schema.paths).every(route => !route.startsWith("/api/v1/pilots")));
  assert.equal(schema.components.schemas.Item.properties.research.$ref, "#/components/schemas/ResearchMetadata");
});

async function mcp(method: string, params: Record<string, unknown> = {}) {
  const response = await app.inject({ method: "POST", url: "/api/mcp", headers: { host: "localhost", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" }, payload: { jsonrpc: "2.0", id: 71, method, params } });
  assert.equal(response.statusCode, 200, response.body);
  return response.headers["content-type"]?.startsWith("text/event-stream")
    ? JSON.parse(response.body.split("\n").find(line => line.startsWith("data: "))!.slice(6))
    : response.json();
}

test("MCP advertises the daily tool without the retired pilot", async () => {
  const tools = await mcp("tools/list");
  assert.ok(!tools.result.tools.some((tool: { name: string }) => tool.name === MCP_TOOL_NAMES.pilot));
  assert.ok(tools.result.tools.some((tool: { name: string }) => tool.name === MCP_TOOL_NAMES.daily));
  const daily = await mcp("tools/call", { name: MCP_TOOL_NAMES.daily, arguments: { date: key } });
  assert.equal(daily.result.structuredContent.report.date, key);
  assert.equal(daily.result.structuredContent.report.run, undefined);
});
