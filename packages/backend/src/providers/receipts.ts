// Paid requests (models, SocialData, Jina; historical Dajiala records retained) go through here.
//
// 1. A logical request has a stable key bound to task, input revision, provider, model, prompt and config.
// 2. Before calling, a placeholder row and an attempt row are persisted; budgets count attempts.
// 3. The raw response is saved before any business write; recovery reuses a received response.
// 4. A request whose outcome is unknown (timeout after sending, crash mid-flight) is not re-sent by the
//    caller or scheduled recovery. It waits for an admin to check the provider's bill and result.
import { sql, type Db } from "../db.ts";
import { sha256, stableJson } from "../lib/ids.ts";
import { shutdownSignal } from "../lib/shutdown.ts";
import { DAILY_WORK_BUDGET } from "@aihot/site";
import { dailyWorkArticleIds, dailyWorkWindow } from "../reports/daily-work.ts";
import { getBudgetStatus } from "./budgets.ts";

/** The text of a spent budget's error; with `%` for both parts it is the LIKE pattern that finds every saved one. */
export const budgetMessage = (service: string, window: string) => `Budget for ${service} exhausted (${window})`;

export class BudgetExceededError extends Error {
  readonly service: string;
  readonly retryAfterSeconds: number;
  constructor(service: string, window: string, retryAfterSeconds: number) {
    super(budgetMessage(service, window));
    this.service = service;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class ReceiptBusyError extends Error {}

export class ReceiptUnknownError extends Error {
  readonly receiptId: number;
  constructor(receiptId: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.receiptId = receiptId;
  }
}

/** Raised by a call when the provider clearly did not accept (and will not bill) the request. */
export class ProviderRejectedError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  constructor(message: string, status: number | null, retryable: boolean) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * The HTTP rule for every provider: an answer outside 2xx means the request was not taken. Rate limits
 * and server errors may pass; any other status is a refusal the same request would meet again.
 */
export function assertAccepted(service: string, status: number, body: string): void {
  if (status >= 200 && status < 300) return;
  throw new ProviderRejectedError(`${service} HTTP ${status}: ${body.slice(0, 500)}`, status, status === 429 || status >= 500);
}

export interface CallOutcome {
  response: unknown;
  requestId?: string | null;
  usage?: Record<string, unknown> | null;
  cost?: { amount: number; currency: string; basis: "actual" | "estimated" } | null;
}

export interface ReceiptRequest {
  service: string;
  model?: string | null;
  purpose: string;
  subject?: string | null;
  /** Everything that determines the output. Hashed into the logical key; only a redacted summary is stored. */
  identity: unknown;
  /** Stored for diagnosis; must not contain secrets. */
  requestSummary?: Record<string, unknown>;
  /** Distinguishes an explicit re-run (e.g. admin "re-evaluate") from recovery of the same request. */
  attemptTag?: string;
}

export interface ReceiptResult {
  receiptId: number;
  response: unknown;
  reused: boolean;
}

const PENDING_STALE_MS = 10 * 60 * 1000;

export function logicalKeyFor(req: ReceiptRequest): string {
  const identity = sha256(stableJson(req.identity));
  return [req.service, req.purpose, req.model ?? "-", identity, req.attemptTag ?? "0"].join(":");
}

interface ReceiptRow {
  id: number;
  status: string;
  response: unknown;
  created_at: Date;
  updated_at: Date;
}

// Only steps needed to publish a daily candidate may use the protected capacity. Optional body
// translation, story digests/consolidation and period-report writing share the background allowance.
const DAILY_PURPOSES = ["prefilter_article", "score_article", "structure_article", "understand_article",
  "summarize_article", "mend_wording", "group_article", "group_review"];
const ARTICLE_SUBJECT = "^article:([a-zA-Z0-9_-]{1,80})(?:$|@|:)";

/**
 * The default model's limits from the environment (LLM_BUDGET_PER_MINUTE / _PER_HOUR / _PER_DAY), written
 * into the budgets table when the worker starts, so a deployment sets its own soft limits without a code
 * change; unset values keep what the table (and the admin's settings page) has. Reaching a limit pauses
 * paid requests until the window moves on. No purpose is exempt from the total limit.
 */
export async function applyBudgetEnv(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const read = (name: string) => {
    const value = env[name];
    if (value === undefined || value === "") return null;
    if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer, e.g. 3000`);
    return Number(value);
  };
  const limits = { per_minute: read("LLM_BUDGET_PER_MINUTE"), per_hour: read("LLM_BUDGET_PER_HOUR"), per_day: read("LLM_BUDGET_PER_DAY") };
  if (Object.values(limits).every((v) => v === null)) return;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day)
    VALUES ('llm', ${limits.per_minute ?? 300}, ${limits.per_hour ?? 6000}, ${limits.per_day ?? 40000})
    ON CONFLICT (service) DO UPDATE SET
      per_minute = coalesce(${limits.per_minute}::int, budgets.per_minute),
      per_hour = coalesce(${limits.per_hour}::int, budgets.per_hour),
      per_day = coalesce(${limits.per_day}::int, budgets.per_day)`;
}

async function checkBudget(tx: Db, req: ReceiptRequest): Promise<Date> {
  const { service } = req;
  const budget = await getBudgetStatus(service, tx);
  if (!budget) {
    // Default rows come with migrations; a service an operator removed is unlimited.
    return (await tx<{ at: Date }[]>`SELECT clock_timestamp() AS at`)[0]!.at;
  }
  if (budget.per_minute <= 0 || budget.per_hour <= 0 || budget.per_day <= 0) {
    throw new BudgetExceededError(service, "stopped", 3600);
  }
  if (budget.usedMinute >= budget.per_minute) throw new BudgetExceededError(service, "minute", 60);
  if (budget.usedHour >= budget.per_hour) throw new BudgetExceededError(service, "hour", 600);
  if (budget.usedDay >= budget.per_day) throw new BudgetExceededError(service, "day", 3600);
  if (service !== "llm") return budget.asOf; // Named providers retain their own existing total limits.

  const window = await dailyWorkWindow(tx, budget.asOf);
  const articleIds = await dailyWorkArticleIds(tx, window);
  const articleId = new RegExp(ARTICLE_SUBJECT).exec(req.subject ?? "")?.[1];
  if (DAILY_PURPOSES.includes(req.purpose) && articleId && articleIds.includes(articleId)) return budget.asOf;

  // Reclassify earlier attempts against the same target as this request. When an edition closes,
  // its spent calls remain in the 24h total and conservatively occupy the background allowance;
  // switching dates never resets usage or frees unknown/failed attempts. An explicitly authorized
  // day reset uses the same attempt watermark for the total and background allowance.
  const [background] = await tx<{ used: number }[]>`
    SELECT count(*)::int AS used FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id
    WHERE a.service = ${service} AND a.origin = 'live' AND a.started_at > ${budget.dayStart} AND a.id > ${budget.resetAttemptId}
      AND NOT coalesce(r.purpose = ANY(${DAILY_PURPOSES}::text[])
        AND substring(r.subject from ${ARTICLE_SUBJECT}) = ANY(${articleIds}::text[]), false)`;
  const limit = Math.floor(budget.per_day * DAILY_WORK_BUDGET.backgroundShare);
  if (background!.used >= limit) throw new BudgetExceededError(service, "background", 3600);
  return budget.asOf;
}

/**
 * Runs a paid request at most once per logical key and returns its raw response.
 * A caller persisting business results completes the receipt in the same transaction.
 */
export async function paidRequest(req: ReceiptRequest, call: () => Promise<CallOutcome>): Promise<ReceiptResult> {
  const logicalKey = logicalKeyFor(req);

  const claimed = await sql.begin(async (tx) => {
    // Serialise budget checks per service so concurrent workers cannot overshoot.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"budget:" + req.service}))`;
    const [existing] = await tx<ReceiptRow[]>`
      SELECT id, status, response, created_at, updated_at FROM receipts WHERE logical_key = ${logicalKey} FOR UPDATE`;
    if (existing?.status === "received" || existing?.status === "completed") return { kind: "reuse" as const, row: existing };
    // Finish business writes from saved answers during shutdown, but never reserve or send the
    // next paid page/batch. An answer already in flight still saves below, without this check.
    shutdownSignal.signal.throwIfAborted();
    if (existing) {
      if (existing.status === "pending") {
        if (Date.now() - existing.updated_at.getTime() < PENDING_STALE_MS) return { kind: "busy" as const, row: existing };
        await markUnknown(tx, existing.id, "placeholder went stale without a recorded result");
        return { kind: "unknown" as const, row: existing };
      }
      if (existing.status === "unknown") return { kind: "unknown" as const, row: existing };
      // failed: the provider did not take the request, or its answer was unusable; a new attempt is allowed.
      const admittedAt = await checkBudget(tx, req);
      const [r] = await tx<{ attempts: number }[]>`
        UPDATE receipts SET status = 'pending', attempts = attempts + 1, error = NULL, updated_at = now() WHERE id = ${existing.id} RETURNING attempts`;
      const attemptId = await startAttempt(tx, existing.id, r!.attempts, req, admittedAt);
      return { kind: "call" as const, id: existing.id, attemptId };
    }
    const admittedAt = await checkBudget(tx, req);
    const [row] = await tx<{ id: number }[]>`
      INSERT INTO receipts (logical_key, service, model, purpose, subject, status, request, attempts)
      VALUES (${logicalKey}, ${req.service}, ${req.model ?? null}, ${req.purpose}, ${req.subject ?? null}, 'pending',
              ${tx.json((req.requestSummary ?? {}) as never)}, 1)
      RETURNING id`;
    const attemptId = await startAttempt(tx, row!.id, 1, req, admittedAt);
    return { kind: "call" as const, id: row!.id, attemptId };
  });

  if (claimed.kind === "reuse") return { receiptId: claimed.row.id, response: claimed.row.response, reused: true };
  if (claimed.kind === "busy") throw new ReceiptBusyError(`Receipt ${claimed.row.id} is in flight`);
  if (claimed.kind === "unknown") {
    throw new ReceiptUnknownError(claimed.row.id, `Receipt ${claimed.row.id} has an unknown outcome; an admin must check the provider's bill and result before releasing it`);
  }

  const { id: receiptId, attemptId } = claimed;
  const started = Date.now();
  let outcome: CallOutcome;
  try {
    outcome = await call();
  } catch (error) {
    const status = error instanceof ProviderRejectedError ? "failed" : "unknown";
    // "unknown": the request may have reached the provider (timeout, reset): do not re-send automatically.
    const message = (error instanceof ProviderRejectedError ? error.message : String(error)).slice(0, 2000);
    await sql.begin(async (tx) => {
      await tx`UPDATE receipts SET status = ${status}, error = ${message}, updated_at = now() WHERE id = ${receiptId}`;
      await tx`UPDATE receipt_attempts SET status = ${status}, error = ${message}, latency_ms = ${Date.now() - started}, finished_at = now() WHERE id = ${attemptId}`;
    });
    // The first transport failure needs the same durable identity as a later unknown-result retry.
    if (status === "unknown") throw new ReceiptUnknownError(receiptId, message, { cause: error });
    throw error;
  }

  await sql.begin(async (tx) => {
    await tx`
      UPDATE receipts SET
        status = 'received',
        response = ${tx.json((outcome.response ?? null) as never)},
        request_id = ${outcome.requestId ?? null},
        usage = ${outcome.usage ? tx.json(outcome.usage as never) : null},
        cost = ${outcome.cost?.amount ?? null},
        currency = ${outcome.cost?.currency ?? null},
        cost_basis = ${outcome.cost?.basis ?? null},
        received_at = now(),
        updated_at = now()
      WHERE id = ${receiptId}`;
    await tx`
      UPDATE receipt_attempts SET
        status = 'received', request_id = ${outcome.requestId ?? null}, usage = ${outcome.usage ? tx.json(outcome.usage as never) : null},
        cost = ${outcome.cost?.amount ?? null}, currency = ${outcome.cost?.currency ?? null}, cost_basis = ${outcome.cost?.basis ?? null},
        latency_ms = ${Date.now() - started}, finished_at = now()
      WHERE id = ${attemptId}`;
  });
  return { receiptId, response: outcome.response, reused: false };
}

async function startAttempt(tx: Db, receiptId: number, attempt: number, req: ReceiptRequest, admittedAt: Date): Promise<number> {
  const [row] = await tx<{ id: number }[]>`
    INSERT INTO receipt_attempts (receipt_id, attempt, service, model, status, started_at)
    VALUES (${receiptId}, ${attempt}, ${req.service}, ${req.model ?? null}, 'pending', ${admittedAt})
    RETURNING id`;
  return row!.id;
}

async function markUnknown(tx: Db, receiptId: number, reason: string) {
  await tx`UPDATE receipts SET status = 'unknown', error = ${reason}, updated_at = now() WHERE id = ${receiptId}`;
  await tx`UPDATE receipt_attempts SET status = 'unknown', error = ${reason}, finished_at = now() WHERE receipt_id = ${receiptId} AND status = 'pending'`;
}

/**
 * Placeholders left behind by a process that stopped mid-request (crash, kill) become "unknown", so
 * they remain visible for manual review even when nothing retries them.
 */
export async function markStalePendingReceipts(): Promise<number> {
  const reason = "placeholder went stale without a recorded result";
  return sql.begin(async (tx) => {
    // Recheck status and age when the row lock is acquired: a response may commit while we wait.
    const stale = await tx<{ id: number }[]>`
      UPDATE receipts SET status = 'unknown', error = ${reason}, updated_at = now()
      WHERE status = 'pending' AND updated_at < ${new Date(Date.now() - PENDING_STALE_MS)} RETURNING id`;
    if (stale.length) {
      await tx`UPDATE receipt_attempts SET status = 'unknown', error = ${reason}, finished_at = now()
               WHERE receipt_id IN ${tx(stale.map((r) => r.id))} AND status = 'pending'`;
    }
    return stale.length;
  });
}

/**
 * Releases an unknown receipt: marked failed, so the next attempt of its request calls again (who
 * releases and when: operations/recover.ts). Null when the receipt is not, or no longer, unknown.
 */
export async function releaseUnknownReceipt(db: Db, id: number, error: string): Promise<{ subject: string | null; purpose: string } | null> {
  const [released] = await db<{ subject: string | null; purpose: string }[]>`
    UPDATE receipts SET status = 'failed', error = ${error}, updated_at = now() WHERE id = ${id} AND status = 'unknown' RETURNING subject, purpose`;
  if (released) await db`UPDATE receipt_attempts SET status = 'failed', error = ${error} WHERE receipt_id = ${id} AND status = 'unknown'`;
  return released ?? null;
}

export async function completeReceipt(db: Db, receiptId: number): Promise<void> {
  await db`UPDATE receipts SET status = 'completed', completed_at = coalesce(completed_at, now()), updated_at = now() WHERE id = ${receiptId}`;
}

/** Marks a received response that could not be used (e.g. unparsable) so a fresh attempt can be made. */
export async function rejectReceivedResponse(receiptId: number, reason: string): Promise<void> {
  await sql`UPDATE receipts SET status = 'failed', error = ${reason.slice(0, 2000)}, updated_at = now() WHERE id = ${receiptId}`;
}
