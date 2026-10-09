import postgres from "postgres";
import { config } from "../config.ts";
import { sql, type Db } from "../db.ts";
import { shutdownSignal } from "../lib/shutdown.ts";

export interface ModelRunConfig { id: string; maxCalls: number; reportReserve: number; callCeiling?: number }
export interface ModelRunStatus extends ModelRunConfig { callsUsed: number; remaining: number }

/** The local deployment sets a stable run ID; compatibility API users may leave it unset. */
export function modelRunFromEnv(required = false): ModelRunConfig | null {
  const id = process.env.MODEL_RUN_ID?.trim();
  if (!id) {
    if (required) throw new Error("MODEL_RUN_ID is required for codex_cli; reuse the batch ID when restarting");
    return null;
  }
  return validateRun({ id, maxCalls: Number(process.env.MODEL_RUN_MAX_CALLS ?? 600), reportReserve: Number(process.env.MODEL_RUN_REPORT_RESERVE ?? 20),
    ...(process.env.MODEL_RUN_CALL_CEILING ? { callCeiling: Number(process.env.MODEL_RUN_CALL_CEILING) } : {}) });
}

function validateRun(run: ModelRunConfig): ModelRunConfig {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,159}$/.test(run.id)) throw new Error("Invalid MODEL_RUN_ID");
  if (!Number.isInteger(run.maxCalls) || run.maxCalls < 1 || run.maxCalls > 600) throw new Error("MODEL_RUN_MAX_CALLS must be between 1 and 600");
  if (!Number.isInteger(run.reportReserve) || run.reportReserve < 0 || run.reportReserve >= run.maxCalls) throw new Error("MODEL_RUN_REPORT_RESERVE must be nonnegative and smaller than MODEL_RUN_MAX_CALLS");
  if (run.callCeiling !== undefined && (!Number.isInteger(run.callCeiling) || run.callCeiling < 1 || run.callCeiling > run.maxCalls)) throw new Error("MODEL_RUN_CALL_CEILING must be between 1 and MODEL_RUN_MAX_CALLS");
  return run;
}

/** Idempotent creation; changing environment variables cannot enlarge an existing allowance. */
export async function ensureModelRun(run: ModelRunConfig, db: Db = sql): Promise<ModelRunStatus> {
  validateRun(run);
  await db`INSERT INTO model_runs (id, max_calls, report_reserve) VALUES (${run.id}, ${run.maxCalls}, ${run.reportReserve}) ON CONFLICT (id) DO NOTHING`;
  const found = await getModelRun(run.id, db);
  if (!found || found.maxCalls !== run.maxCalls || found.reportReserve !== run.reportReserve) throw new Error(`Model run ${run.id} already exists with different frozen limits`);
  return found;
}

export async function getModelRun(id: string, db: Db = sql): Promise<ModelRunStatus | null> {
  const [row] = await db<{ id: string; max_calls: number; report_reserve: number; calls_used: number }[]>`
    SELECT id, max_calls, report_reserve, calls_used FROM model_runs WHERE id = ${id}`;
  return row ? { id: row.id, maxCalls: row.max_calls, reportReserve: row.report_reserve, callsUsed: row.calls_used, remaining: row.max_calls - row.calls_used } : null;
}

/** Called in the same transaction as the receipt attempt. Reused answers never reach this function. */
export async function reserveModelRunCall(db: Db, run: ModelRunConfig, purpose: string): Promise<boolean> {
  await ensureModelRun(run, db);
  const isReport = /^report(?:_|$)/.test(purpose);
  const rows = await db`
    UPDATE model_runs SET calls_used = calls_used + 1 WHERE id = ${run.id}
    AND calls_used < max_calls - CASE WHEN ${isReport} THEN 0 ELSE report_reserve END
    AND calls_used < ${run.callCeiling ?? run.maxCalls} RETURNING id`;
  return rows.length === 1;
}

// One connection per process waits for a session lock shared by every worker in this database.
// The lock stays held through receipt persistence. A process crash releases the lock, while its
// persisted pending receipt becomes UNKNOWN and cannot be retried without reconciliation.
let previous: Promise<unknown> = Promise.resolve();
export function withModelExecutionLock<T>(call: () => Promise<T>): Promise<T> {
  const result = previous.then(async () => {
    shutdownSignal.signal.throwIfAborted();
    const lockDb = postgres(config.databaseUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
    try {
      await lockDb`SELECT pg_advisory_lock(hashtext('algorithmhot:model-execution'))`;
      shutdownSignal.signal.throwIfAborted();
      return await call();
    } finally {
      // Closing this dedicated connection releases the advisory lock, including on a failed call.
      await lockDb.end({ timeout: 5 });
    }
  });
  previous = result.catch(() => {});
  return result;
}
