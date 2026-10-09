// Native Bedrock Converse. The caller owns paidRequest, budgets and schema validation.
// No SDK retries, alternate endpoints, credential discovery or automatic model switching.
import type { CallOutcome } from "./receipts.ts";

export const BEDROCK_ADAPTER_VERSION = "algorithmhot-bedrock-converse-v1";
// Official GPT-6 Astra model card, checked 2026-10-06. Keep the regional endpoint explicit.
export const BEDROCK_REGIONS = ["us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1",
  "eu-central-1", "eu-north-1", "eu-west-1", "eu-west-2", "eu-west-3", "ap-northeast-1", "ap-northeast-2",
  "ap-northeast-3", "ap-south-1", "ap-southeast-1", "ap-southeast-2", "sa-east-1"] as const;
export const BEDROCK_MODELS = ["global.openai.gpt-6-astra", "us.openai.gpt-6-astra"] as const;
const US_PROFILE_REGIONS = new Set(["us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1"]);

export interface BedrockCall {
  region: string;
  model: string;
  apiToken: string;
  system: string;
  user: string;
  json: boolean;
  maxTokens: number;
  timeoutMs: number;
  /** Non-null effort is rejected until a model-specific Converse mapping is verified. */
  reasoningEffort?: string | null;
}

export interface BedrockResponse {
  choices: Array<{ message: { role: "assistant"; content: string }; finish_reason: string | null }>;
  usage: Record<string, unknown> | null;
  _invalidEnvelope: boolean;
  /** The caller persists this response before marking the receipt failed or UNKNOWN. */
  _providerError?: { status: number; message: string; retryable: false };
  _bedrock: {
    adapterVersion: string;
    model: string;
    region: string;
    httpStatus: number;
    requestId: string | null;
    stopReason: string | null;
    raw: unknown;
    rawBody: string;
    credentialsRedacted: boolean;
    requestedReasoningEffort: string | null;
    effectiveReasoningEffort: null;
  };
  _latencyMs: number;
}
export interface BedrockOutcome extends CallOutcome { response: BedrockResponse }
export type BedrockFetch = (input: string, init: RequestInit) => Promise<Response>;

export function bedrockConverseEndpoint(region: string, model: string): string {
  if (!(BEDROCK_REGIONS as readonly string[]).includes(region)) throw new Error("Unsupported Bedrock region");
  if (!(BEDROCK_MODELS as readonly string[]).includes(model)) throw new Error("Unsupported Bedrock inference profile");
  if (model.startsWith("us.") && !US_PROFILE_REGIONS.has(region)) throw new Error("Bedrock US inference profile requires a supported source region");
  return `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`;
}

/** Call before reserving a paid attempt too, so local configuration failures never consume it. */
export function validateBedrockCall(call: BedrockCall): void {
  bedrockConverseEndpoint(call.region, call.model);
  if (typeof call.apiToken !== "string" || !/^[a-zA-Z0-9._~+\/-]+=*$/.test(call.apiToken)) throw new Error("Bedrock API token is missing or malformed");
  if (typeof call.system !== "string" || typeof call.user !== "string" || !call.user.trim()) throw new Error("Bedrock requires nonempty text input");
  if (typeof call.json !== "boolean") throw new Error("Bedrock JSON preference must be boolean");
  if (!Number.isSafeInteger(call.maxTokens) || call.maxTokens < 1 || call.maxTokens > 128_000) throw new Error("Invalid Bedrock maxTokens");
  if (!Number.isSafeInteger(call.timeoutMs) || call.timeoutMs < 1 || call.timeoutMs > 600_000) throw new Error("Invalid Bedrock timeoutMs");
  if (call.reasoningEffort != null) throw new Error("Bedrock Converse reasoning effort is not configured; use the provider default");
}

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
function normalizedUsage(raw: unknown): Record<string, unknown> | null {
  const source = object(raw);
  if (!source) return null;
  const usage: Record<string, unknown> = { ...source };
  for (const [native, normalized] of [["inputTokens", "input_tokens"], ["outputTokens", "output_tokens"], ["totalTokens", "total_tokens"],
    ["inputTokens", "prompt_tokens"], ["outputTokens", "completion_tokens"],
    ["cacheReadInputTokens", "cached_input_tokens"], ["cacheWriteInputTokens", "cache_write_input_tokens"]]) {
    const value = source[native];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) usage[normalized] = value;
  }
  return usage;
}

export async function callBedrock(call: BedrockCall, fetchImpl: BedrockFetch = fetch): Promise<BedrockOutcome> {
  validateBedrockCall(call);
  const started = Date.now();
  const endpoint = bedrockConverseEndpoint(call.region, call.model);
  const instructions = [call.system, ...(call.json ? ["Return only one valid JSON object in the requested format, without Markdown fences."] : [])].filter(Boolean).join("\n\n");
  const body = {
    ...(instructions ? { system: [{ text: instructions }] } : {}),
    messages: [{ role: "user", content: [{ text: call.user }] }],
    inferenceConfig: { maxTokens: call.maxTokens },
  };
  const signal = AbortSignal.timeout(call.timeoutMs);
  let response: Response, received: string;
  try {
    response = await fetchImpl(endpoint, { method: "POST", redirect: "manual", signal,
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${call.apiToken}` },
      body: JSON.stringify(body) });
    received = await response.text();
    signal.throwIfAborted();
  } catch {
    // A transport error cannot establish whether the provider accepted the request. Do not attach
    // the fetch error/cause, which can contain headers or credentials from a custom transport.
    throw new Error(signal.aborted ? "Bedrock request timed out; outcome UNKNOWN, no automatic resend"
      : "Bedrock connection ended before a complete response; outcome UNKNOWN, no automatic resend");
  }
  const redact = (value: string) => value.split(call.apiToken).join("[redacted]");
  const rawBody = redact(received);
  let raw: unknown = null;
  try { raw = JSON.parse(rawBody); } catch { /* The full invalid body is retained for reconciliation. */ }
  const envelope = object(raw), message = object(object(envelope?.output)?.message);
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const content = blocks.flatMap(block => typeof object(block)?.text === "string" ? [object(block)!.text as string] : []).join("");
  const unsupportedBlock = blocks.some(block => {
    const item = object(block);
    return !item || Object.keys(item).length !== 1
      || !(typeof item.text === "string" || object(item.reasoningContent));
  });
  const stopReason = typeof envelope?.stopReason === "string" ? envelope.stopReason : null;
  const usage = normalizedUsage(envelope?.usage);
  const requestId = response.headers.get("x-amzn-requestid") ?? response.headers.get("x-amz-request-id") ?? response.headers.get("x-request-id");
  const safeRequestId = requestId ? redact(requestId) : null;
  const providerError = !response.ok ? { status: response.status,
    message: `Bedrock HTTP ${response.status}; provider response retained in receipt`, retryable: false as const } : undefined;
  return {
    response: {
      choices: [{ message: { role: "assistant", content }, finish_reason: stopReason }], usage,
      _invalidEnvelope: Boolean(providerError) || message?.role !== "assistant" || !content.trim() || unsupportedBlock || stopReason !== "end_turn",
      ...(providerError ? { _providerError: providerError } : {}),
      _bedrock: { adapterVersion: BEDROCK_ADAPTER_VERSION, model: call.model, region: call.region, httpStatus: response.status,
        requestId: safeRequestId, stopReason, raw, rawBody, credentialsRedacted: rawBody !== received || requestId !== safeRequestId,
        requestedReasoningEffort: call.reasoningEffort ?? null, effectiveReasoningEffort: null },
      _latencyMs: Date.now() - started,
    },
    requestId: safeRequestId, usage, cost: null,
  };
}
