// LLM_REASONING_API: the default model is sent the request shape OpenAI's reasoning models take (Bedrock's
// OpenAI-compatible endpoint included): max_completion_tokens and no temperature.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { chatJson } from "@aihot/backend/providers/llm";

const bodies: Array<Record<string, unknown>> = [];
const provider = await stub((_hit, req) => {
  bodies.push(JSON.parse(req.body));
  return { id: `stub-${bodies.length}`, choices: [{ message: { content: JSON.stringify({ ok: true }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
});
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "test-key", LLM_MODEL: "reasoner", MODEL_CALLS_ENABLED: "true" });
after(async () => {
  await provider.close();
  await stopBoss();
  await closeDb();
});

const ask = (subject: string) => chatJson({ model: "default", purpose: "probe", subject, promptVersion: "v1", system: "s", user: subject, schema: z.object({ ok: z.boolean() }), temperature: 0.7, maxTokens: 800 });

test("off: temperature and max_tokens, as every OpenAI-compatible service takes them", async () => {
  delete process.env.LLM_REASONING_API;
  await ask(`plain-${tag()}`);
  const body = bodies.at(-1)!;
  assert.deepEqual([body.temperature, body.max_tokens, body.max_completion_tokens], [0.7, 800, undefined]);
});

test("on: max_completion_tokens and no temperature, with JSON mode kept", async () => {
  process.env.LLM_REASONING_API = "true";
  try {
    await ask(`reasoning-${tag()}`);
  } finally {
    delete process.env.LLM_REASONING_API;
  }
  const body = bodies.at(-1)!;
  assert.equal("temperature" in body, false);
  assert.equal("max_tokens" in body, false);
  assert.equal(body.max_completion_tokens, 800);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.model, "reasoner");
});
