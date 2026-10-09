// Run after the web build. Uses the real web server/router and a synthetic local API only.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { load } from "cheerio";
import { internalModelFixture } from "./research-model-fixture.ts";

let web: ChildProcess, origin: string, logs = "";
let modelStatus = 200;
const calls: Array<{ path: string; method: string; cookie: string | undefined }> = [];
const api = createServer((req, res) => {
  const path = new URL(req.url!, "http://synthetic-api.test").pathname;
  calls.push({ path, method: req.method!, cookie: req.headers.cookie });
  res.setHeader("Content-Type", "application/json");
  if (path === "/api/site/meta") return res.end(JSON.stringify({ changelogVersion: "2026-10-06T00:00" }));
  if (path === "/api/health") return res.end(JSON.stringify({ ok: true }));
  if (path === "/api/auth/options") return res.end(JSON.stringify({ password: true, feishu: false }));
  if (path === "/api/admin/me") {
    res.statusCode = req.headers.cookie === "admin_session=synthetic-session" ? 200 : 401;
    return res.end(JSON.stringify({ csrf: "SYNTHETIC_CSRF", privateData: "PRIVATE_ME" }));
  }
  if (path === "/api/admin/research-model") {
    res.statusCode = modelStatus;
    return res.end(JSON.stringify(modelStatus === 200 ? internalModelFixture() : { error: "PRIVATE_UPSTREAM_ERROR" }));
  }
  res.statusCode = 404;
  res.end("{}");
});

before(async () => {
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  web = spawn(process.execPath, [fileURLToPath(new URL("../server.ts", import.meta.url))], {
    env: { ...process.env, WEB_PORT: "0", TRUST_PROXY: "false", LLM_ENABLED: "false", EMBEDDING_ENABLED: "false", CORE_ENABLED: "false", API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`web did not start: ${logs}`)), 15_000);
    web.on("exit", () => { clearTimeout(timeout); reject(new Error(`web exited: ${logs}`)); });
    web.stderr!.on("data", chunk => { logs += String(chunk); });
    web.stdout!.on("data", chunk => {
      logs += String(chunk);
      const match = logs.match(/"msg":"web started","port":(\d+)/);
      if (match) { origin = `http://127.0.0.1:${match[1]}`; clearTimeout(timeout); resolve(); }
    });
  });
});

after(async () => {
  if (web && web.exitCode === null) { web.kill("SIGTERM"); await once(web, "exit"); }
  api.closeAllConnections();
  await new Promise<void>(resolve => api.close(() => resolve()));
});

test("anonymous Agent HTML exposes a login entry and no private model state", async () => {
  const start = calls.length;
  const response = await fetch(`${origin}/agent`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Cache-Control")!, /no-store/);
  assert.equal(response.headers.get("X-Accel-Expires"), "0");
  const html = await response.text(), $ = load(html);
  assert.equal($('#research-models a').attr("href"), "/admin/login?return=%2Fagent");
  assert.match($('#research-models').text(), /页面阅读不会发起模型调用/);
  assert.equal($('#research-models form').length, 0);
  assert.doesNotMatch(html, /SYNTHETIC_CSRF|PRIVATE_|synthetic-partial-batch|codex-gpt-6\.1-sol/);
  assert.equal(calls.slice(start).some(call => call.path === "/api/admin/research-model"), false);
  assert.ok(calls.slice(start).every(call => call.method === "GET"));
});

test("admin Agent HTML shows the chosen model, readiness evidence and frozen historical batches", async () => {
  const start = calls.length;
  const response = await fetch(`${origin}/agent`, { headers: { cookie: "admin_session=synthetic-session" } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Cache-Control")!, /no-store/);
  const html = await response.text(), $ = load(html), panel = $('#research-models');
  assert.match(panel.text(), /已选模型 · 管理员设置/);
  assert.match(panel.text(), /gpt-6\.1-sol · Codex/);
  assert.match(panel.text(), /Codex 订阅/);
  assert.match(panel.text(), /模型可用性未测试/);
  assert.match(panel.text(), /服务区域拒绝访问；HTTP 400，未成功生成/);
  assert.match(panel.text(), /检查/);
  assert.equal(panel.find('select option').first().attr("value"), "codex-gpt-6-astra");
  assert.equal(panel.find('option[value="bedrock-gpt-6-astra"]').prop("disabled"), true);
  assert.equal(panel.find('option[value="codex-gpt-6.1-sol"]').prop("selected"), true);
  assert.equal(panel.find('button[type="submit"]').prop("disabled"), true);
  assert.match(panel.find('details').text(), /已有批次的固定配置/);
  assert.match(panel.find('details').text(), /实际进程是否仍在运行未核验/);
  assert.match(panel.find('details').text(), /状态：partial/);
  assert.match(panel.find('details').text(), /旧批次未保存模型快照/);
  assert.doesNotMatch(html, /PRIVATE_/);
  const reads = calls.slice(start).filter(call => call.path.startsWith("/api/admin/"));
  assert.deepEqual(reads.map(call => call.path), ["/api/admin/me", "/api/admin/research-model"]);
  assert.ok(reads.every(call => call.cookie === "admin_session=synthetic-session" && call.method === "GET"));
  assert.ok(calls.slice(start).every(call => call.method === "GET"));
});

test("failed model settings do not take down the Agent reading page", async () => {
  modelStatus = 503;
  try {
    const response = await fetch(`${origin}/agent`, { headers: { cookie: "admin_session=synthetic-session" } });
    assert.equal(response.status, 200);
    const html = await response.text(), $ = load(html);
    assert.match($('#research-models').text(), /模型设置暂时无法读取/);
    assert.equal($('#research-models form').length, 0);
    assert.ok($('#agent-panel-mcp').length);
    assert.doesNotMatch(html, /PRIVATE_|SYNTHETIC_CSRF/);
  } finally { modelStatus = 200; }
});

test("login keeps the exact Agent return route and rejects arbitrary destinations", async () => {
  for (const [requested, expected] of [["/agent", "/agent"], ["/admin/models", "/admin/models"], ["/agent?redirect=external", "/admin"], ["https://outside.test/agent", "/admin"], ["//outside.test/agent", "/admin"]]) {
    const response = await fetch(`${origin}/admin/login?${new URLSearchParams({ return: requested })}`);
    assert.equal(response.status, 200);
    const $ = load(await response.text());
    assert.equal($('input[name="return"]').val(), expected, requested);
    assert.match(response.headers.get("Cache-Control")!, /no-store/);
  }
});
