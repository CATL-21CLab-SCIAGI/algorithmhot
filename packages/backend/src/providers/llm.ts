// Receipt-backed chat calls. The local deployment selects codex_cli; installations that omit the
// transport retain their OpenAI-compatible API configuration and named model presets.
import type { z } from "zod";
import { config, credential } from "../config.ts";
import { sha256 } from "../lib/ids.ts";
import { completeReceipt, logicalKeyFor, paidRequest, ProviderRejectedError, rejectReceivedResponse, type ReceiptRequest } from "./receipts.ts";
import { sql } from "../db.ts";
import { admittedForProcessing } from "../research/admission.ts";
import { callCodex, CODEX_ADAPTER_VERSION } from "./codex.ts";
import { modelRunFromEnv, withModelExecutionLock } from "./model-runs.ts";
import { assertIsolatedModelRequestAllowed, assertIsolatedRequestKeyAllowed, rememberResearchAccountFailure } from "../research/request-isolation.ts";

export interface ModelSpec {
  key: string;
  service: string;
  model: string;
  baseUrlEnv: string;
  apiKeyEnv: string;
  /** Extra request fields, e.g. switching reasoning off for short structured tasks. */
  extra?: Record<string, unknown>;
  jsonMode: boolean;
  vision?: boolean;
}

function extraFromEnv(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new Error("LLM_EXTRA_JSON must be a JSON object, e.g. {\"enable_thinking\": false}");
  }
}

export const MODELS: Record<string, ModelSpec> = {
  // Read from the environment at call time.
  default: {
    key: "default", service: "llm", baseUrlEnv: "LLM_BASE_URL", apiKeyEnv: "LLM_API_KEY",
    get model() { return process.env.LLM_TRANSPORT === "codex_cli" ? process.env.CODEX_MODEL || "gpt-6-astra" : process.env.LLM_MODEL ?? ""; },
    get extra() { return extraFromEnv(process.env.LLM_EXTRA_JSON); },
    get jsonMode() { return process.env.LLM_JSON_MODE !== "false"; },
    get vision() { return process.env.LLM_VISION === "true"; },
  },
  // Named presets (the models AIHOT itself runs on); each needs its own key.
  // GLM 5.3 Flash always reasons; the lowest effort keeps short structured tasks fast.
  "glm-5.3-flash": {
    key: "glm-5.3-flash", service: "zhipu", model: "glm-5.3-flash",
    baseUrlEnv: "ZHIPU_BASE_URL", apiKeyEnv: "ZHIPU_API_KEY",
    extra: { thinking: { type: "enabled" }, reasoning_effort: "low" }, jsonMode: true,
  },
  // The scorer's parameters for glm-5.3-flash (score calls; temperature 1 is set per call).
  "glm-5.3-flash-selection": {
    key: "glm-5.3-flash-selection", service: "zhipu", model: "glm-5.3-flash",
    baseUrlEnv: "ZHIPU_BASE_URL", apiKeyEnv: "ZHIPU_API_KEY",
    extra: { thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "high", top_p: 0.95 }, jsonMode: true,
  },
  // DeepSeek Flash reasons by default; structured tasks switch it off unless the -think variant is used.
  "deepseek-flash": {
    key: "deepseek-flash", service: "deepseek", model: "deepseek-flash",
    baseUrlEnv: "DEEPSEEK_BASE_URL", apiKeyEnv: "DEEPSEEK_API_KEY",
    extra: { thinking: { type: "disabled" } }, jsonMode: true,
  },
  "deepseek-flash-think": {
    key: "deepseek-flash-think", service: "deepseek", model: "deepseek-flash",
    baseUrlEnv: "DEEPSEEK_BASE_URL", apiKeyEnv: "DEEPSEEK_API_KEY", jsonMode: true,
  },
  "qwen3.7-flash": {
    key: "qwen3.7-flash", service: "dashscope", model: "qwen3.7-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL", apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false }, jsonMode: true,
  },
  "qwen3.8-flash": {
    key: "qwen3.8-flash", service: "dashscope", model: "qwen3.8-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL", apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false }, jsonMode: true,
  },
  "mimo-v2.6-flash": {
    key: "mimo-v2.6-flash", service: "mimo", model: "mimo-v2.6-flash",
    baseUrlEnv: "XIAOMI_MIMO_BASE_URL", apiKeyEnv: "XIAOMI_MIMO_API_KEY",
    extra: { thinking: { type: "disabled" } }, jsonMode: true,
  },
  "qwen3-vl-flash": {
    key: "qwen3-vl-flash", service: "dashscope", model: "qwen3-vl-flash",
    baseUrlEnv: "DASHSCOPE_BASE_URL", apiKeyEnv: "DASHSCOPE_API_KEY",
    extra: { enable_thinking: false }, jsonMode: false, vision: true,
  },
};

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatJsonOptions<S extends z.ZodType> {
  model: string;
  purpose: string;
  subject: string;
  promptVersion: string;
  system: string;
  user: string | ContentPart[];
  schema: S;
  temperature?: number;
  maxTokens?: number;
  attemptTag?: string;
  timeoutMs?: number;
  /** false: the model answers in its own text format (no JSON mode); `parse` turns it into the schema's input. */
  json?: boolean;
  parse?: (content: string) => unknown;
}

export interface ChatJsonResult<T> {
  data: T;
  receiptId: number;
  reused: boolean;
  model: string;
  usage: Record<string, unknown> | null;
}

export class ModelOutputError extends Error {
  readonly receiptId: number | null;
  constructor(message: string, receiptId: number | null = null) {
    super(message);
    this.receiptId = receiptId;
  }
}

function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1]!;
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1) throw new ModelOutputError("No JSON object in model output");
  const body = t.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch {
    return JSON.parse(escapeControlCharsInStrings(body));
  }
}

/** Models sometimes emit raw newlines or tabs inside JSON strings (multi-line posts); escape only those. */
export function escapeControlCharsInStrings(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      else if (ch < " ") {
        out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
        continue;
      }
    } else if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

function isConnectFailure(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code;
  return ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "ECONNRESET_BEFORE_SEND", "CERT_HAS_EXPIRED"].includes(code ?? "");
}

export async function chatJson<S extends z.ZodType>(opts: ChatJsonOptions<S>): Promise<ChatJsonResult<z.infer<S>>> {
  const articleId = /^article:([^@:#]+)/.exec(opts.subject)?.[1];
  if (articleId && !(await admittedForProcessing(articleId))) throw new Error(`Article ${articleId} is not admitted to the frozen research run`);
  const spec = MODELS[opts.model];
  if (!spec) throw new Error(`Unknown model ${opts.model}`);
  if (!config.modelCallsEnabled) throw new Error("Model calls are disabled (MODEL_CALLS_ENABLED=false)");
  const transport = process.env.LLM_TRANSPORT || "openai_compatible";
  if (!["codex_cli", "openai_compatible"].includes(transport)) throw new Error(`Unknown LLM_TRANSPORT ${transport}`);
  const isCodex = transport === "codex_cli";
  const modelRun = modelRunFromEnv(isCodex || process.env.RESEARCH_ADMISSION_ENABLED === "true");
  const model = isCodex ? process.env.CODEX_MODEL || "gpt-6-astra" : spec.model;
  const reasoningEffort = process.env.CODEX_REASONING_EFFORT || "medium";
  const baseUrl = isCodex ? null : credential("models", spec.baseUrlEnv);
  const apiKey = isCodex ? null : credential("models", spec.apiKeyEnv);
  if (!isCodex && (!baseUrl || !apiKey || !model)) throw new Error(`Model ${opts.model} is not configured (${spec.baseUrlEnv}, ${spec.apiKeyEnv}${spec.key === "default" ? ", LLM_MODEL" : ""})`);
  if (isCodex && typeof opts.user !== "string" && opts.user.some((part) => part.type !== "text")) throw new Error("codex_cli text processing does not accept image inputs");

  const temperature = opts.temperature ?? 0.2;
  const maxTokens = Math.max(opts.maxTokens ?? 1500, 512) + (spec.key.endsWith("-think") ? 4000 : 0);
  const userText = typeof opts.user === "string" ? opts.user : JSON.stringify(opts.user);
  const body: Record<string, unknown> = {
    model,
    messages: [
      // A prompt given as one user message (the title/summary prompts) has no system message.
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      // Multimodal parts go through as parts; plain objects are sent as JSON text.
      { role: "user", content: typeof opts.user === "string" || Array.isArray(opts.user) ? opts.user : userText },
    ],
    temperature,
    max_tokens: maxTokens,
    ...(spec.jsonMode && opts.json !== false ? { response_format: { type: "json_object" } } : {}),
    ...(!isCodex ? spec.extra ?? {} : {}),
  };

  const requestSpec: ReceiptRequest = {
      service: isCodex ? "codex_cli" : spec.service,
      model,
      purpose: opts.purpose,
      subject: opts.subject,
      identity: { transport, model, promptVersion: opts.promptVersion, system: sha256(opts.system), user: sha256(userText), temperature, maxTokens, json: opts.json !== false, extra: isCodex ? { reasoningEffort, adapterVersion: CODEX_ADAPTER_VERSION } : spec.extra ?? null },
      requestSummary: { transport, modelRunId: modelRun?.id ?? null, promptVersion: opts.promptVersion, systemHash: sha256(opts.system), userHash: sha256(userText), userChars: userText.length, temperature, maxTokens, ...(isCodex ? { reasoningEffort, adapterVersion: CODEX_ADAPTER_VERSION, effectiveTemperature: null, maxTokensEnforcement: "prompt_hint" } : {}) },
      attemptTag: opts.attemptTag,
      modelRun,
    };
  const request = () => paidRequest(requestSpec, async () => {
      if (isCodex) return callCodex({ model, reasoningEffort, system: opts.system, user: typeof opts.user === "string" ? opts.user : opts.user.map((part) => part.type === "text" ? part.text : "").join("\n"), json: opts.json !== false, maxTokens, timeoutMs: opts.timeoutMs ?? Number(process.env.CODEX_TIMEOUT_MS || 180_000) });
      const started = Date.now();
      let res: Response;
      try {
        res = await fetch(`${baseUrl!.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
        });
      } catch (error) {
        if (isConnectFailure(error)) throw new ProviderRejectedError(`connect failed: ${String(error)}`, null, true);
        throw error;
      }
      const text = await res.text();
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        throw new ProviderRejectedError(`HTTP ${res.status}: ${text.slice(0, 500)}`, res.status, retryable);
      }
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(text);
        if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("Expected a response object");
      } catch {
        json = { unparsable: text.slice(0, 20000) };
      }
      const usage = (json.usage as Record<string, unknown> | undefined) ?? null;
      return {
        response: { ...json, _latencyMs: Date.now() - started },
        requestId: (json.id as string | undefined) ?? res.headers.get("x-request-id"),
        usage,
        cost: null,
      };
    },
  );
  const execute = async () => {
    const isolated = process.env.RESEARCH_REQUEST_ISOLATION === "true";
    if (isolated) {
      await assertIsolatedModelRequestAllowed(opts.subject);
      await assertIsolatedRequestKeyAllowed(logicalKeyFor(requestSpec));
    }
    const receipt = await request().catch(async (error: unknown) => {
      if (isolated) await rememberResearchAccountFailure(process.env.RESEARCH_RUN_ID ?? "", opts.subject, error);
      throw error;
    });

    const response = receipt.response as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: Record<string, unknown>; _invalidEnvelope?: boolean };
    const content = response.choices?.[0]?.message?.content ?? "";
    let parsed: z.infer<S>;
    try {
      if (response._invalidEnvelope) throw new Error("Invalid Codex structured-output envelope");
      parsed = opts.schema.parse(opts.parse ? opts.parse(content) : extractJson(content));
    } catch (error) {
      // Unusable output: record it and let a later attempt pay for a fresh answer.
      await rejectReceivedResponse(receipt.receiptId, `unusable output: ${String(error).slice(0, 500)}`);
      throw new ModelOutputError(`Model ${opts.model} returned unusable output for ${opts.subject}: ${String(error).slice(0, 300)}`, receipt.receiptId);
    }
    return { data: parsed, receiptId: receipt.receiptId, reused: receipt.reused, model: spec.key, usage: response.usage ?? null };
  };
  return isCodex || modelRun ? await withModelExecutionLock(execute) : await execute();
}

export async function markReceiptsCompleted(ids: number[]): Promise<void> {
  for (const id of ids) await completeReceipt(sql, id);
}
