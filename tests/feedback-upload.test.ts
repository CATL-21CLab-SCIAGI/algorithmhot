import "./setup.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { buildApp } from "../apps/api/src/app.ts";

process.env.FEISHU_INTERNAL_ENABLED = "false";
config.dataDir = await mkdtemp(path.join(tmpdir(), "aihot-upload-"));
const app = await buildApp();
after(async () => { await app.close(); await closeDb(); await rm(config.dataDir, { recursive: true }); });

async function upload(file: Buffer, ip: string) {
  const form = new FormData();
  form.set("content", "手机截图反馈，文字保持不变");
  form.set("email", "reader@example.com");
  form.set("pageUrl", "/daily");
  form.set("screenshot", new File([new Uint8Array(file)], "screenshot.png", { type: "image/png" }));
  const request = new Request("http://local/api/site/feedback", { method: "POST", body: form });
  const payload = Buffer.from(await request.arrayBuffer());
  return app.inject({ method: "POST", url: "/api/site/feedback", headers: { "content-type": request.headers.get("content-type")!, "x-real-ip": ip }, payload });
}

test("a 5 MiB multipart screenshot waits intact for forwarding", async () => {
  const file = Buffer.alloc(5 * 1024 * 1024, 137);
  const result = await upload(file, "203.0.113.211");
  assert.equal(result.statusCode, 201, result.body);
  assert.equal(result.headers["cache-control"], "no-store");
  const [row] = await sql`SELECT content,email,page_url,screenshot_key,forward_error FROM feedback WHERE id = ${result.json().id}`;
  assert.equal(row!.content, "手机截图反馈，文字保持不变");
  assert.equal(row!.email, "reader@example.com");
  assert.equal(row!.page_url, "/daily");
  assert.equal(row!.forward_error, "pending");
  assert.deepEqual(await readFile(path.join(config.dataDir, "feedback-screenshots", row!.screenshot_key.slice(6))), file);
});

test("malformed multipart and screenshots above the existing backend limit are rejected", async () => {
  const bad = await app.inject({ method: "POST", url: "/api/site/feedback", headers: { "content-type": "multipart/form-data; boundary=missing" }, payload: Buffer.from("bad") });
  assert.equal(bad.statusCode, 400);
  const result = await upload(Buffer.alloc(8 * 1024 * 1024 + 1), "203.0.113.212");
  assert.equal(result.statusCode, 400);
  assert.match(result.json().detail, /8MB/);
});

test("the JSON screenshot sent by an already-open tab remains accepted", async () => {
  const file = Buffer.from("existing screenshot");
  const result = await app.inject({ method: "POST", url: "/api/site/feedback", headers: { "x-real-ip": "203.0.113.213" }, payload: { content: "旧标签页", screenshot: { mime: "image/png", data: file.toString("base64") } } });
  assert.equal(result.statusCode, 201);
  const [row] = await sql`SELECT screenshot_key FROM feedback WHERE id = ${result.json().id}`;
  assert.deepEqual(await readFile(path.join(config.dataDir, "feedback-screenshots", row!.screenshot_key.slice(6))), file);
});
