import assert from "node:assert/strict";
import test from "node:test";
import { loadResearchModelPanel } from "../app/lib/research-model.server.ts";
import { researchModelOverview, ResearchModelSaveError, saveResearchModel } from "../app/lib/research-model.ts";
import { internalModelFixture, modelOverviewFixture } from "./research-model-fixture.ts";

const request = () => new Request("http://reader.test/agent", { headers: { cookie: "admin_session=synthetic-session", "user-agent": "synthetic-browser" } });

test("anonymous readers do not receive or request the private model configuration", async () => {
  for (const status of [401, 403]) {
    const calls: string[] = [];
    const result = await loadResearchModelPanel(request(), async url => {
      calls.push(String(url));
      return Response.json({ csrf: "DO_NOT_EXPOSE" }, { status });
    });
    assert.deepEqual(result, { kind: "anonymous" });
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0]).pathname, "/api/admin/me");
  }
});

test("authenticated reads forward only session context and whitelist the browser DTO", async () => {
  const calls: string[] = [];
  const result = await loadResearchModelPanel(request(), async (url, options) => {
    calls.push(new URL(String(url)).pathname);
    assert.equal(options?.method ?? "GET", "GET");
    assert.equal(options?.cache, "no-store");
    assert.equal(options?.redirect, "error");
    assert.equal(options?.body, undefined);
    const headers = new Headers(options?.headers);
    assert.equal(headers.get("cookie"), "admin_session=synthetic-session");
    assert.equal(headers.get("user-agent"), "synthetic-browser");
    assert.equal(headers.get("authorization"), null);
    assert.ok(options?.signal);
    return Response.json(calls.length === 1 ? { csrf: "synthetic-csrf", privateData: "PRIVATE_ME" } : internalModelFixture());
  });
  assert.deepEqual(calls, ["/api/admin/me", "/api/admin/research-model"]);
  assert.deepEqual(result, { kind: "admin", csrf: "synthetic-csrf", overview: modelOverviewFixture() });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  assert.deepEqual(researchModelOverview(internalModelFixture()), modelOverviewFixture());
});

test("read failures preserve the public page and never expose partial private responses", async () => {
  for (const stage of ["session-error", "missing-csrf", "expired-session", "model-error", "bad-json", "network-error"]) {
    let calls = 0;
    const result = await loadResearchModelPanel(request(), async () => {
      calls++;
      if (stage === "network-error") throw new Error("PRIVATE_NETWORK_DETAIL");
      if (calls === 1) return Response.json(stage === "missing-csrf" ? {} : { csrf: "PRIVATE_CSRF" }, { status: stage === "session-error" ? 500 : 200 });
      if (stage === "bad-json") return new Response("malformed PRIVATE_DATA");
      return Response.json({ details: "PRIVATE_ERROR" }, { status: stage === "expired-session" ? 401 : 503 });
    });
    assert.deepEqual(result, { kind: stage === "expired-session" ? "anonymous" : "unavailable" }, stage);
    assert.equal(calls, ["session-error", "missing-csrf", "network-error"].includes(stage) ? 1 : 2, stage);
  }
});

test("save uses the same-origin admin endpoint with CSRF and optimistic revision once", async () => {
  let calls = 0;
  const result = await saveResearchModel({ profileId: "codex-gpt-6-astra", expectedRevision: 4, reason: "人工选择后续调研模型" }, "synthetic-csrf", async (url, options) => {
    calls++;
    assert.equal(url, "/api/admin/research-model");
    assert.equal(options?.method, "PUT");
    assert.equal(options?.credentials, "same-origin");
    assert.equal(options?.redirect, "error");
    assert.equal(new Headers(options?.headers).get("x-csrf-token"), "synthetic-csrf");
    assert.deepEqual(JSON.parse(String(options?.body)), { profileId: "codex-gpt-6-astra", expectedRevision: 4, reason: "人工选择后续调研模型" });
    return Response.json(internalModelFixture());
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, modelOverviewFixture());
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
});

test("save preserves auth/conflict failures without retries or private server details", async () => {
  for (const [status, message] of [[401, /重新登录/], [403, /刷新页面/], [409, /其他操作更新/], [400, /无法保存/], [500, /尚未确认是否保存成功/]] as const) {
    let calls = 0;
    await assert.rejects(saveResearchModel({ profileId: "codex-gpt-6-astra", expectedRevision: 4, reason: "切换模型" }, "csrf", async () => {
      calls++;
      return Response.json({ detail: "PRIVATE_SERVER_DETAIL" }, { status });
    }), (error: unknown) => {
      assert.ok(error instanceof ResearchModelSaveError);
      assert.equal(error.status, status);
      assert.match(error.message, message);
      assert.doesNotMatch(error.message, /PRIVATE_SERVER_DETAIL/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("an interrupted save remains unconfirmed and is never replayed automatically", async () => {
  let calls = 0;
  await assert.rejects(saveResearchModel({ profileId: "codex-gpt-6-astra", expectedRevision: 4, reason: "切换模型" }, "csrf", async () => {
    calls++;
    throw new Error("PRIVATE_TRANSPORT_DETAIL");
  }), (error: unknown) => {
    assert.ok(error instanceof ResearchModelSaveError);
    assert.equal(error.status, 0);
    assert.match(error.message, /尚未确认是否保存成功/);
    assert.doesNotMatch(error.message, /PRIVATE_TRANSPORT_DETAIL/);
    return true;
  });
  assert.equal(calls, 1);
});
