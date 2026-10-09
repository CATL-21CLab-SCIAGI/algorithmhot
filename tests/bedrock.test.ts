import assert from "node:assert/strict";
import { test } from "node:test";
import { BEDROCK_ADAPTER_VERSION, bedrockConverseEndpoint, callBedrock, validateBedrockCall, type BedrockCall, type BedrockFetch } from "@aihot/backend/providers/bedrock";

const call: BedrockCall = { region: "us-east-1", model: "global.openai.gpt-6-astra", apiToken: "offline-token-do-not-persist",
  system: "Use only the supplied source.", user: "Source material.", json: true, maxTokens: 3200, timeoutMs: 1000 };
const valid = () => ({ output: { message: { role: "assistant", content: [{ text: '{"ok":' }, { text: "true}" }] } },
  stopReason: "end_turn", usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20, cacheReadInputTokens: 3, cacheWriteInputTokens: 0 }, metrics: { latencyMs: 21 } });
const reply = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(typeof value === "string" ? value : JSON.stringify(value),
  { status, headers: { "content-type": "application/json", "x-amzn-requestid": "fixture-request-1", ...headers } });

test("Bedrock uses one exact native Converse request and preserves response, request id and token usage", async () => {
  let hits = 0;
  const raw = valid();
  const outcome = await callBedrock(call, async (url, init) => {
    hits++;
    assert.equal(url, "https://bedrock-runtime.us-east-1.amazonaws.com/model/global.openai.gpt-6-astra/converse");
    assert.equal(init.method, "POST"); assert.equal(init.redirect, "manual");
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${call.apiToken}`);
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body.inferenceConfig, { maxTokens: 3200 });
    assert.equal(body.messages[0].content[0].text, call.user);
    assert.match(body.system[0].text, /Use only the supplied source/);
    assert.match(body.system[0].text, /valid JSON object/);
    for (const key of ["temperature", "topP", "additionalModelRequestFields", "toolConfig", "outputConfig"]) assert.equal(body[key], undefined);
    assert.ok(init.signal);
    return reply(raw);
  });
  assert.equal(hits, 1);
  assert.equal(outcome.response.choices[0].message.content, '{"ok":true}');
  assert.equal(outcome.response._invalidEnvelope, false);
  assert.equal(outcome.requestId, "fixture-request-1");
  assert.equal(outcome.response._bedrock.adapterVersion, BEDROCK_ADAPTER_VERSION);
  assert.deepEqual(outcome.response._bedrock.raw, raw);
  assert.equal(outcome.response._bedrock.rawBody, JSON.stringify(raw));
  assert.equal(outcome.response._bedrock.stopReason, "end_turn");
  assert.equal(outcome.response._bedrock.requestedReasoningEffort, null);
  assert.equal(outcome.response._bedrock.effectiveReasoningEffort, null);
  assert.deepEqual(outcome.usage, { ...raw.usage, input_tokens: 12, output_tokens: 8, prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, cached_input_tokens: 3, cache_write_input_tokens: 0 });
  assert.equal(outcome.cost, null);
  assert.ok(!JSON.stringify(outcome).includes(call.apiToken));
});

test("json false retains the caller's text format without unverified model parameters", async () => {
  await callBedrock({ ...call, system: "", json: false }, async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init.body)), { messages: [{ role: "user", content: [{ text: call.user }] }], inferenceConfig: { maxTokens: 3200 } });
    return reply(valid());
  });
});

test("local configuration errors never call fetch or expose the supplied credential", async () => {
  const invalid: Partial<BedrockCall>[] = [
    { region: "us-east-1.evil.example" }, { region: "http://127.0.0.1" }, { model: "../other" }, { model: "openai.gpt-6-astra" },
    { model: "us.openai.gpt-6-astra", region: "eu-west-1" }, { apiToken: "" }, { apiToken: "secret\nheader" }, { apiToken: "secret\0header" },
    { maxTokens: 0 }, { maxTokens: 128_001 }, { timeoutMs: 0 }, { timeoutMs: 600_001 }, { user: " " }, { reasoningEffort: "medium" },
    { model: "global.openai.gpt-6.1-sol" }, { model: "us.openai.gpt-6.1-sol" },
  ];
  let hits = 0;
  for (const fields of invalid) await assert.rejects(callBedrock({ ...call, ...fields }, async () => { hits++; return reply(valid()); }), error => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(call.apiToken));
    return true;
  });
  assert.equal(hits, 0);
  validateBedrockCall(call);
  assert.match(bedrockConverseEndpoint("us-east-1", "us.openai.gpt-6-astra"), /us\.openai\.gpt-6-astra/);
});

test("HTTP errors and redirects retain their full bodies without retries or fallback", async () => {
  for (const status of [301, 400, 401, 403, 408, 429, 500, 503]) {
    let hits = 0;
    const raw = { message: `fixture error ${status}`, detail: "a".repeat(3000) };
    const outcome = await callBedrock(call, async (_url, init) => { hits++; assert.equal(init.redirect, "manual"); return reply(raw, status); });
    assert.equal(hits, 1);
    assert.equal(outcome.response._providerError!.status, status);
    assert.equal(outcome.response._providerError!.retryable, false);
    assert.equal(outcome.response._invalidEnvelope, true);
    assert.equal(outcome.response._bedrock.rawBody, JSON.stringify(raw));
    assert.equal(outcome.requestId, "fixture-request-1");
  }
});

test("max tokens, filtering, tool output and malformed bodies cannot masquerade as usable JSON", async () => {
  for (const stopReason of ["max_tokens", "tool_use", "guardrail_intervened", "content_filtered", "malformed_model_output", "model_context_window_exceeded", "stop_sequence"]) {
    const raw = { ...valid(), stopReason };
    const outcome = await callBedrock(call, async () => reply(raw));
    assert.equal(outcome.response._invalidEnvelope, true, stopReason);
    assert.equal(outcome.response.choices[0].message.content, '{"ok":true}', "even parseable partial text stays invalid");
    assert.deepEqual(outcome.response._bedrock.raw, raw);
  }
  for (const raw of ["not json", {}, { ...valid(), stopReason: null }, { ...valid(), output: { message: { role: "user", content: [{ text: "{}" }] } } },
    { ...valid(), output: { message: { role: "assistant", content: [{ text: "{}" }, { toolUse: { name: "unknown" } }] } } },
    { ...valid(), output: { message: { role: "assistant", content: [{ text: "{}" }, { text: 42 }] } } }]) {
    const outcome = await callBedrock(call, async () => reply(raw));
    assert.equal(outcome.response._invalidEnvelope, true);
  }
});

test("reasoning blocks stay in the native receipt while only answer text reaches the business parser", async () => {
  const raw = valid();
  const native = { ...raw, output: { message: { role: "assistant", content: [{ reasoningContent: { reasoningText: { text: "fixture reasoning" } } }, { text: '{"ok":true}' }] } } };
  const result = await callBedrock(call, async () => reply(native));
  assert.equal(result.response._invalidEnvelope, false);
  assert.equal(result.response.choices[0].message.content, '{"ok":true}');
  assert.deepEqual(result.response._bedrock.raw, native);
});

test("disconnect and deadline are UNKNOWN with no retry and no secret in the thrown diagnostic", async () => {
  let hits = 0;
  await assert.rejects(callBedrock(call, async () => { hits++; throw new Error(`transport included ${call.apiToken}`); }), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /UNKNOWN/); assert.doesNotMatch(error.message, /offline-token/); assert.equal(error.cause, undefined); return true;
  });
  assert.equal(hits, 1);
  const stalled: BedrockFetch = async (_url, init) => {
    hits++;
    await new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error("fixture exceeded deadline")), 100);
      init.signal!.addEventListener("abort", () => { clearTimeout(keepAlive); reject(init.signal!.reason); }, { once: true });
    });
    throw new Error("unreachable");
  };
  await assert.rejects(callBedrock({ ...call, timeoutMs: 10 }, stalled), /timed out; outcome UNKNOWN/);
  assert.equal(hits, 2);
});

test("an interrupted response body is UNKNOWN and provider credential echoes are redacted", async () => {
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"partial":')); controller.error(new Error(call.apiToken)); } });
  await assert.rejects(callBedrock(call, async () => new Response(stream)), /outcome UNKNOWN/);
  const result = await callBedrock(call, async () => reply({ message: `Bearer ${call.apiToken}`, nested: [call.apiToken] }, 403, { "x-amzn-requestid": call.apiToken }));
  assert.equal(result.response._bedrock.credentialsRedacted, true);
  assert.ok(!JSON.stringify(result).includes(call.apiToken));
  assert.match(result.response._bedrock.rawBody, /\[redacted\]/);
});

test("missing token usage stays unknown rather than fabricated zero", async () => {
  const { usage: _usage, ...raw } = valid();
  const result = await callBedrock(call, async () => reply(raw));
  assert.equal(result.usage, null);
  assert.equal(result.response.usage, null);
});
