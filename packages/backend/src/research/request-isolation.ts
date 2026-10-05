import { sql, type Db } from "../db.ts";
import { BudgetExceededError, ProviderRejectedError } from "../providers/receipts.ts";

export interface ArticleRequestHold {
  status: "unknown" | "failed";
  receiptId: number | null;
  attemptId: number | null;
  purpose: string;
  subject: string;
  modelRunId: string | null;
  error: string | null;
}

// Match account failures, not words such as "author" in an article title.
const ACCOUNT_FAILURE = "\\m(auth|authentication|unauthorized|forbidden|login|quota|rate limit|usage limit|insufficient_quota|invalid_api_key)\\M|not logged in|sign in required|too many requests|token[- ]expired|\\m(http|status|status_code|statusCode)[\\s:=\"']+(401|403|429)\\M";
const accountFailure = (message: string, error?: unknown) => (error instanceof ProviderRejectedError && [401, 403, 429].includes(error.status ?? 0))
  || /\b(auth|authentication|unauthorized|forbidden|login|quota|rate limit|usage limit|insufficient_quota|invalid_api_key)\b|not logged in|sign in required|too many requests|token[- ]expired|\b(http|status|status_code|statusCode)[\s:="']+(401|403|429)\b/i.test(message);
export class ResearchBatchStoppedError extends Error {}
export class ResearchRequestHeldError extends Error {
  readonly hold?: ArticleRequestHold;
  constructor(message: string, hold?: ArticleRequestHold) { super(message); this.hold = hold; }
}

/** A terminal article request is held across revisions, prompts, slots and days, including aliases. */
export async function articleRequestHold(articleId: string, db: Db = sql): Promise<ArticleRequestHold | null> {
  const [receipt] = await db<ArticleRequestHold[]>`
    WITH identities AS (
      SELECT other.id FROM articles current JOIN articles other
        ON other.id=current.id OR coalesce(other.research->>'canonicalKey',other.identity_key)=coalesce(current.research->>'canonicalKey',current.identity_key)
      WHERE current.id=${articleId}
    )
    SELECT CASE WHEN r.status='unknown' OR ra.status='unknown' THEN 'unknown' ELSE 'failed' END AS status,
      r.id AS "receiptId",ra.id AS "attemptId",r.purpose,coalesce(r.subject,'') AS subject,
      ra.model_run_id AS "modelRunId",coalesce(ra.error,r.error) AS error
    FROM receipts r LEFT JOIN receipt_attempts ra ON ra.receipt_id=r.id
    WHERE substring(r.subject FROM '^article:([^@:#]+)') IN (SELECT id FROM identities)
      AND (r.status IN ('unknown','failed') OR ra.status IN ('unknown','failed'))
      AND (r.service='codex_cli' OR r.model IS NOT NULL OR ra.model_run_id IS NOT NULL)
    ORDER BY (r.status='unknown' OR ra.status='unknown') DESC NULLS LAST,ra.id DESC NULLS LAST,r.id DESC LIMIT 1`;
  if (receipt) return receipt;
  // Local failures without a paid attempt are held too; never turn a new day into a retry.
  const [member] = await db<{ state: string; error: string | null }[]>`
    SELECT m.state,m.error FROM research_members m JOIN articles a ON a.id=m.article_id JOIN articles current
      ON a.id=current.id OR coalesce(a.research->>'canonicalKey',a.identity_key)=coalesce(current.research->>'canonicalKey',current.identity_key)
    WHERE current.id=${articleId} AND (m.state IN ('unknown-receipt','failed') OR m.error LIKE 'held-request:%')
    ORDER BY (m.state='unknown-receipt') DESC,m.updated_at DESC LIMIT 1`;
  return member ? { status: member.state === "unknown-receipt" || member.error?.includes("status=unknown;") ? "unknown" : "failed",
    receiptId: null, attemptId: null, purpose: "article", subject: `article:${articleId}`, modelRunId: null, error: member.error } : null;
}

/** No global UNKNOWN count: independent, attributable terminal requests can be quarantined. */
export async function assertResearchRequestsIdle(db: Db = sql): Promise<void> {
  // This is a probe only. Holding this lock while chatJson acquires it on another connection deadlocks.
  // chatJson itself holds the execution mutex through response/receipt persistence.
  const [lock] = await db<{ idle: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('algorithmhot:model-execution')) AS idle`;
  if (!lock?.idle) throw new ResearchBatchStoppedError("Model execution is still active; stop this batch");
  await assertResearchLedgerReady(db);
}

async function assertResearchLedgerReady(db: Db): Promise<void> {
  const [pending] = await db<{ n: number }[]>`
    SELECT count(*)::int AS n FROM receipts r LEFT JOIN receipt_attempts ra ON ra.receipt_id=r.id
    WHERE (r.service='codex_cli' OR r.model IS NOT NULL OR ra.model_run_id IS NOT NULL)
      AND (r.status='pending' OR ra.status='pending')`;
  if (pending?.n) throw new ResearchBatchStoppedError("Existing pending model request; stop this batch");
  const [account] = await db<{ id: number }[]>`
    SELECT r.id FROM receipts r LEFT JOIN receipt_attempts ra ON ra.receipt_id=r.id
    WHERE (r.service='codex_cli' OR r.model IS NOT NULL OR ra.model_run_id IS NOT NULL)
      AND (r.status IN ('unknown','failed') OR ra.status IN ('unknown','failed'))
      AND (coalesce(r.error,'') ~* ${ACCOUNT_FAILURE} OR coalesce(ra.error,'') ~* ${ACCOUNT_FAILURE}) LIMIT 1`;
  const [marked] = await db<{ article_id: string }[]>`SELECT article_id FROM research_members WHERE error LIKE 'account-blocked:%' LIMIT 1`;
  if (account || marked) throw new ResearchBatchStoppedError("Model account or quota failure requires confirmed recovery before new requests");
  const [unattributed] = await db<{ id: number }[]>`
    SELECT r.id FROM receipts r LEFT JOIN receipt_attempts ra ON ra.receipt_id=r.id
    WHERE (r.service='codex_cli' OR r.model IS NOT NULL OR ra.model_run_id IS NOT NULL)
      AND (r.status='unknown' OR ra.status='unknown')
      AND NOT (coalesce(r.subject,'') ~ '^article:[^@:#]+' OR coalesce(r.subject,'') ~ '^report:[^:]+:.+'
        OR (coalesce(r.subject,'') ~ '^probe:[a-zA-Z0-9_-]{1,80}$' AND r.purpose ~ '^probe_[a-zA-Z0-9_]+$')) LIMIT 1`;
  if (unattributed) throw new ResearchBatchStoppedError(`UNKNOWN receipt ${unattributed.id} has no isolatable article/report subject`);
}

/** Called with the model execution mutex already held, just before reserving a paid attempt. */
export async function assertIsolatedModelRequestAllowed(subject: string, db: Db = sql): Promise<void> {
  await assertResearchLedgerReady(db);
  const articleId = /^article:([^@:#]+)/.exec(subject)?.[1];
  if (articleId) {
    const hold = await articleRequestHold(articleId, db);
    if (hold) throw new ResearchRequestHeldError(heldRequestMessage(hold), hold);
  } else if (subject.startsWith("report:")) {
    const [held] = await db<{ id: number }[]>`SELECT r.id FROM receipts r LEFT JOIN receipt_attempts ra ON ra.receipt_id=r.id
      WHERE r.subject=${subject} AND (r.status IN ('unknown','failed') OR ra.status IN ('unknown','failed')) LIMIT 1`;
    if (held) throw new ResearchRequestHeldError(`Report subject held by receipt ${held.id}; compose with ruleOnly`);
  } else throw new ResearchBatchStoppedError("Research model request needs an isolatable article/report subject");
}

/** Logical keys omit subject: identical inputs from two identities must not retry the first failure. */
export async function assertIsolatedRequestKeyAllowed(logicalKey: string, db: Db = sql): Promise<void> {
  const [hold] = await db<ArticleRequestHold[]>`
    SELECT CASE WHEN r.status='unknown' OR ra.status='unknown' THEN 'unknown' ELSE 'failed' END AS status,
      r.id AS "receiptId",ra.id AS "attemptId",r.purpose,coalesce(r.subject,'') AS subject,
      ra.model_run_id AS "modelRunId",coalesce(ra.error,r.error) AS error
    FROM receipts r LEFT JOIN receipt_attempts ra ON ra.receipt_id=r.id
    WHERE r.logical_key=${logicalKey} AND (r.status IN ('unknown','failed') OR ra.status IN ('unknown','failed'))
    ORDER BY (r.status='unknown' OR ra.status='unknown') DESC NULLS LAST,ra.id DESC NULLS LAST LIMIT 1`;
  if (hold) throw new ResearchRequestHeldError(heldRequestMessage(hold), hold);
}

/** Persist the full-error classification before truncation, including failures swallowed by analysis. */
export async function rememberResearchAccountFailure(runId: string, subject: string, error: unknown, db: Db = sql): Promise<void> {
  const fullMessage = String(error), articleId = /^article:([^@:#]+)/.exec(subject)?.[1];
  if (articleId && accountFailure(fullMessage, error)) await db`UPDATE research_members SET error=${`account-blocked: ${fullMessage}`.slice(0, 1200)},updated_at=now()
    WHERE run_id=${runId} AND article_id=${articleId}`;
}

export function heldRequestMessage(hold: ArticleRequestHold): string {
  return `held-request: status=${hold.status}; receipt=${hold.receiptId ?? "none"}; attempt=${hold.attemptId ?? "none"}; purpose=${hold.purpose}; subject=${hold.subject}; modelRun=${hold.modelRunId ?? "none"}; ${hold.error ?? ""}`.slice(0, 1200);
}

export async function recordArticleHold(runId: string, articleId: string, hold: ArticleRequestHold, db: Db = sql) {
  await db`UPDATE research_members SET state=CASE WHEN state IN ('pass','block','unknown') THEN state ELSE ${hold.status === "unknown" ? "unknown-receipt" : "failed"} END,
    error=${heldRequestMessage(hold)},updated_at=now() WHERE run_id=${runId} AND article_id=${articleId}`;
}

export type IsolatedArticleResult<T> = { state: "ready"; value: T } | { state: "held"; hold: ArticleRequestHold; value?: T };

/** Used at every mainflow, brief and roadmap boundary by the research runner. */
export async function runIsolatedArticleStep<T>(runId: string, articleId: string, call: () => Promise<T>, db: Db = sql): Promise<IsolatedArticleResult<T>> {
  await assertResearchRequestsIdle(db);
  let hold = await articleRequestHold(articleId, db);
  if (hold) { await recordArticleHold(runId, articleId, hold, db); return { state: "held", hold }; }
  let value: T;
  try { value = await call(); }
  catch (error) {
    const fullMessage = String(error);
    if (accountFailure(fullMessage, error)) {
      // The marker precedes truncation: a late diagnostic cannot disappear and reopen the next slot.
      await rememberResearchAccountFailure(runId, `article:${articleId}`, error, db);
      throw new ResearchBatchStoppedError("Model account or quota failure; no further requests sent", { cause: error });
    }
    if (error instanceof ResearchBatchStoppedError || error instanceof BudgetExceededError || /\bbudget\b/i.test(fullMessage)) throw error;
    await assertResearchRequestsIdle(db);
    hold = await articleRequestHold(articleId, db) ?? (error instanceof ResearchRequestHeldError ? error.hold : null) ?? { status: "failed", receiptId: null, attemptId: null, purpose: "article",
      subject: `article:${articleId}`, modelRunId: null, error: fullMessage };
    await recordArticleHold(runId, articleId, hold, db);
    return { state: "held", hold };
  }
  await assertResearchRequestsIdle(db);
  hold = await articleRequestHold(articleId, db);
  if (hold) { await recordArticleHold(runId, articleId, hold, db); return { state: "held", hold, value }; }
  return { state: "ready", value };
}

export interface ResearchArticleExecutor {
  process(articleId: string): Promise<{ state: string }>;
  extract(articleId: string): Promise<unknown>;
  brief(articleId: string): Promise<unknown>;
  hasBudget(): Promise<boolean>;
  observed?(articleId: string, stage: string, result: unknown): void;
}

/** Sequential admission order is shared by the CLI and database-backed offline tests. */
export async function processIsolatedResearchArticles(runId: string, rows: { article_id: string; state: string }[], execute: ResearchArticleExecutor, db: Db = sql) {
  for (const row of rows) {
    await assertResearchRequestsIdle(db);
    const hold = await articleRequestHold(row.article_id, db);
    if (hold) { await recordArticleHold(runId, row.article_id, hold, db); execute.observed?.(row.article_id, "held", hold); continue; }
    if (["block", "unknown", "unknown-receipt", "failed"].includes(row.state)) continue;
    if (!(await execute.hasBudget())) break;
    if (row.state !== "pass") {
      let result = await runIsolatedArticleStep(runId, row.article_id, () => execute.process(row.article_id), db);
      if (result.state === "ready" && result.value.state === "fetching-body") {
        result = await runIsolatedArticleStep(runId, row.article_id, async () => {
          await execute.extract(row.article_id);
          return execute.process(row.article_id);
        }, db);
      }
      execute.observed?.(row.article_id, "mainflow", result);
      if (result.state === "held") continue;
      await db`UPDATE research_members SET state=${result.value.state},error=NULL,updated_at=now() WHERE run_id=${runId} AND article_id=${row.article_id}`;
      if (result.value.state !== "pass") continue;
    }
    if (!(await execute.hasBudget())) break;
    const brief = await runIsolatedArticleStep(runId, row.article_id, () => execute.brief(row.article_id), db);
    if (brief.state === "ready") await db`UPDATE research_members SET error=NULL,updated_at=now() WHERE run_id=${runId} AND article_id=${row.article_id}`;
    execute.observed?.(row.article_id, "brief", brief);
  }
}
