// No login, network, database or model calls: CODEX_BIN points to a disposable process fixture.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, writeFile, readFile, stat, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { callCodex, codexArguments, codexEnvironment, safeCodexDiagnostic, type CodexCall } from "@aihot/backend/providers/codex";
import { ProviderRejectedError } from "@aihot/backend/providers/receipts";
import { modelRunFromEnv } from "@aihot/backend/providers/model-runs";

const dir = await mkdtemp(path.join(tmpdir(), "algorithmhot-codex-test-"));
const savedBin = process.env.CODEX_BIN;
const savedEvidence = process.env.CODEX_EVIDENCE_DIR;
process.env.CODEX_EVIDENCE_DIR = path.join(dir, "evidence");
after(async () => {
  if (savedBin === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = savedBin;
  if (savedEvidence === undefined) delete process.env.CODEX_EVIDENCE_DIR; else process.env.CODEX_EVIDENCE_DIR = savedEvidence;
  await rm(dir, { recursive: true, force: true });
});
const call: CodexCall = { model: "gpt-6-astra", reasoningEffort: "medium", system: "Return the requested result", user: "public abstract", json: true, maxTokens: 500, timeoutMs: 10_000 };
let serial = 0;
async function fixture(source: string) {
  const file = path.join(dir, `fake-${serial++}.mjs`);
  await writeFile(file, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  await chmod(file, 0o700);
  process.env.CODEX_BIN = file;
}

test("Codex subprocess has a clean configuration and cannot inherit API keys or parent session state", () => {
  const args = codexArguments(call, dir);
  for (const flag of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--output-schema"]) assert.ok(args.includes(flag));
  for (const setting of ['web_search="disabled"', "mcp_servers={}", "features.skip_host_skill_discovery=true", 'forced_login_method="chatgpt"']) assert.ok(args.includes(setting));
  const env = codexEnvironment({ HOME: "/fake", PATH: "/bin", CODEX_HOME: "/fake/codex", OPENAI_API_KEY: "secret", DATABASE_URL: "secret", CODEX_THREAD_ID: "parent", CODEX_TURN_ID: "parent-turn" });
  assert.deepEqual(env, { HOME: "/fake", PATH: "/bin", CODEX_HOME: "/fake/codex" });
});

test("Codex captures structured content, thread identity and token accounting", async () => {
  await fixture(`
    import fs from "node:fs";
    const args = process.argv.slice(2);
    let input = ""; for await (const chunk of process.stdin) input += chunk;
    if (!input.includes("public abstract")) process.exit(2);
    fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({ content: '{"ok":true}' }));
    console.log(JSON.stringify({ type: "thread.started", thread_id: "fixture-thread" }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }));
  `);
  const out = await callCodex(call);
  assert.equal((out.response as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content, '{"ok":true}');
  assert.equal(out.requestId, "fixture-thread");
  assert.deepEqual(out.usage, { input_tokens: 10, output_tokens: 5 });
});

test("Codex text output preserves upstream custom parser input", async () => {
  await fixture(`
    import fs from "node:fs";
    const args = process.argv.slice(2);
    for await (const chunk of process.stdin) {}
    fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({ content: "title_zh: 中文标题\\nsummary_zh: 作者报告的结果" }));
    console.log(JSON.stringify({ type: "turn.completed", usage: {} }));
  `);
  const out = await callCodex({ ...call, json: false });
  assert.equal((out.response as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content, "title_zh: 中文标题\nsummary_zh: 作者报告的结果");
});

test("Codex timeout stays unknown and an unexpected tool event fails closed", async () => {
  await fixture('setInterval(() => {}, 1000);');
  await assert.rejects(callCodex({ ...call, timeoutMs: 80 }), /outcome UNKNOWN/);
  await fixture('console.log(JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "forbidden" } })); setInterval(() => {}, 1000);');
  await assert.rejects(callCodex(call), /unexpected item command_execution/);
});

async function unknownEvidence(input: CodexCall) {
  let file = "";
  await assert.rejects(callCodex(input), (error: unknown) => {
    assert.match(String(error), /outcome UNKNOWN, no automatic resend/);
    file = /; evidence=(.+?);/.exec(String(error))?.[1] ?? "";
    assert.ok(file, "an UNKNOWN outcome must identify its local reconciliation evidence");
    assert.ok(!String(error).includes("PRIVATE-FINAL-ANSWER"), "the receipt error must not inline the answer");
    return true;
  });
  return { file, data: JSON.parse(await readFile(file, "utf8")) };
}

test("a completed answer followed by a process timeout stays UNKNOWN and retains private reconciliation evidence", async () => {
  await fixture(`
    import fs from "node:fs";
    const args = process.argv.slice(2);
    for await (const chunk of process.stdin) {}
    console.log(JSON.stringify({ type: "thread.started", thread_id: "fixture-late-answer" }));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "PRIVATE-REASONING" } }));
    console.error("PRIVATE-STDERR");
    console.log(JSON.stringify({ type: "item.completed", item: { type: "error", message: "Bearer private-token" } }));
    const answer = JSON.stringify({ content: "PRIVATE-FINAL-ANSWER" });
    fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], answer);
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: answer } }));
    console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 5, ignored: "PRIVATE-USAGE-EXTRA" } }));
    setInterval(() => {}, 1000);
  `);
  const { file, data } = await unknownEvidence({ ...call, timeoutMs: 1500 });
  assert.equal(data.status, "UNKNOWN");
  assert.equal(data.threadId, "fixture-late-answer");
  assert.equal(data.turnCompleted, true);
  assert.equal(JSON.parse(data.structuredEnvelope).content, "PRIVATE-FINAL-ANSWER");
  assert.deepEqual(data.receivedMessages, [data.structuredEnvelope]);
  assert.deepEqual(data.usage, { input_tokens: 10, cached_input_tokens: 4, output_tokens: 5 });
  assert.equal(data.inputHashes.user.length, 64);
  const stored = JSON.stringify(data);
  for (const secret of ["PRIVATE-REASONING", "PRIVATE-STDERR", "PRIVATE-USAGE-EXTRA", "private-token"]) assert.ok(!stored.includes(secret));
  assert.ok(stored.includes("Bearer [redacted]"));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
});

test("an abnormal exit retains a received agent message even without a final output file", async () => {
  await fixture(`
    console.log(JSON.stringify({ type: "thread.started", thread_id: "fixture-partial-answer" }));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "PRIVATE-FINAL-ANSWER" } }));
    process.exitCode = 3;
  `);
  const { data } = await unknownEvidence(call);
  assert.equal(data.status, "UNKNOWN");
  assert.equal(data.structuredEnvelope, "");
  assert.deepEqual(data.receivedMessages, ["PRIVATE-FINAL-ANSWER"]);
  assert.equal(data.turnCompleted, false);
  assert.equal(data.usage, null);
  assert.equal(data.exit.code, 3);
});

test("official diagnostic and todo-list items are recorded without being mistaken for tools", async () => {
  await fixture(`
    import fs from "node:fs";
    const args = process.argv.slice(2);
    for await (const chunk of process.stdin) {}
    console.log(JSON.stringify({ type: "thread.started", thread_id: "fixture-diagnostic" }));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "error", message: "temporary provider warning" } }));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "todo_list", items: [] } }));
    fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({ content: '{"ok":true}' }));
    console.log(JSON.stringify({ type: "turn.completed", usage: {} }));
  `);
  const out = await callCodex(call);
  const diagnostics = (out.response as { _codex: { diagnostics: Array<{ item?: string; message?: string }> } })._codex.diagnostics;
  assert.ok(diagnostics.some((event) => event.item === "error" && event.message === "temporary provider warning"));
  assert.ok(diagnostics.some((event) => event.item === "todo_list"));
});

test("failed Codex runs retain safe event identity and redact secrets in provider diagnostics", async () => {
  await fixture(`
    console.log(JSON.stringify({ type: "thread.started", thread_id: "fixture-failure" }));
    console.log(JSON.stringify({ type: "item.completed", item: { type: "error", message: "HTTP 429 quota exceeded" } }));
    console.log(JSON.stringify({ type: "turn.failed", error: { message: "quota exceeded" } }));
    process.exitCode = 1;
  `);
  await assert.rejects(callCodex(call), (error: unknown) => {
    assert.match(String(error), /fixture-failure/);
    assert.match(String(error), /HTTP 429 quota exceeded/);
    assert.match(String(error), /outcome UNKNOWN/);
    return true;
  });
  assert.equal(safeCodexDiagnostic("Bearer private-value api_key=another-value sk-example-private"), "Bearer [redacted] api_key=[redacted] [redacted]");
});

test("a missing executable is a confirmed local rejection, not a submitted model request", async () => {
  process.env.CODEX_BIN = path.join(dir, "does-not-exist");
  await assert.rejects(callCodex(call), ProviderRejectedError);
});

test("Codex requires a stable run ID and rejects limits above the authorized 600 calls", () => {
  const saved = { id: process.env.MODEL_RUN_ID, max: process.env.MODEL_RUN_MAX_CALLS, reserve: process.env.MODEL_RUN_REPORT_RESERVE };
  try {
    delete process.env.MODEL_RUN_ID;
    assert.throws(() => modelRunFromEnv(true), /MODEL_RUN_ID is required/);
    process.env.MODEL_RUN_ID = "test-batch";
    process.env.MODEL_RUN_MAX_CALLS = "601";
    assert.throws(() => modelRunFromEnv(true), /between 1 and 600/);
    process.env.MODEL_RUN_MAX_CALLS = "600";
    process.env.MODEL_RUN_REPORT_RESERVE = "20";
    assert.deepEqual(modelRunFromEnv(true), { id: "test-batch", maxCalls: 600, reportReserve: 20 });
  } finally {
    for (const [key, value] of [["MODEL_RUN_ID", saved.id], ["MODEL_RUN_MAX_CALLS", saved.max], ["MODEL_RUN_REPORT_RESERVE", saved.reserve]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  }
});
