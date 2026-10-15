// Budget admission and its displayed counters share one clock and reset boundary. A manual reset
// grants a new allowance; it never rewrites the paid-call ledger or releases an unknown receipt.
import { sql, type Db } from "../db.ts";
import { audit } from "../audit.ts";

interface BudgetRow {
  service: string;
  per_minute: number;
  per_hour: number;
  per_day: number;
  note: string | null;
  updated_at: Date;
}

interface Reset { resetAt: string; afterAttemptId: number; operationId: string }
export interface BudgetStatus extends BudgetRow {
  asOf: Date;
  dayStart: Date;
  resetAt: Date | null;
  resetAttemptId: number;
  usedMinute: number;
  usedHour: number;
  usedDay: number;
  used24h: number;
}

const resetKey = (service: string) => `budget.day.reset.${service}`;

/** Call after the service's budget lock for admission; use without a lock for a read-only snapshot. */
export async function getBudgetStatus(service: string, db: Db = sql): Promise<BudgetStatus | null> {
  const [row] = await db<(BudgetRow & { as_of: Date; reset: Reset | null })[]>`
    SELECT b.*, clock_timestamp() AS as_of, s.value AS reset
    FROM budgets b LEFT JOIN settings s ON s.key = ${resetKey(service)} WHERE b.service = ${service}`;
  if (!row) return null;
  const { as_of: asOf, reset, ...budget } = row;
  const resetAttemptId = reset?.afterAttemptId ?? 0;
  const resetAt = reset ? new Date(reset.resetAt) : null;
  if (!Number.isSafeInteger(resetAttemptId) || resetAttemptId < 0 || (resetAt && !Number.isFinite(resetAt.getTime()))) {
    throw new Error(`invalid budget reset boundary for ${service}`);
  }
  const dayStart = new Date(asOf.getTime() - 86400_000);
  const [counts] = await db<{ minute: number; hour: number; day: number; actual: number }[]>`
    SELECT count(*) FILTER (WHERE started_at > ${new Date(asOf.getTime() - 60_000)})::int AS minute,
           count(*) FILTER (WHERE started_at > ${new Date(asOf.getTime() - 3600_000)})::int AS hour,
           count(*) FILTER (WHERE id > ${resetAttemptId})::int AS day,
           count(*)::int AS actual
    FROM receipt_attempts WHERE service = ${service} AND origin = 'live' AND started_at > ${dayStart}`;
  return { ...budget, asOf, dayStart, resetAt, resetAttemptId,
    usedMinute: counts!.minute, usedHour: counts!.hour, usedDay: counts!.day, used24h: counts!.actual };
}

export async function listBudgetStatuses(db: Db = sql): Promise<BudgetStatus[]> {
  const services = await db<{ service: string }[]>`SELECT service FROM budgets ORDER BY service`;
  const rows = await Promise.all(services.map(({ service }) => getBudgetStatus(service, db)));
  return rows.filter((row): row is BudgetStatus => row !== null);
}

/** An explicit, idempotent operator action. Minute/hour limits and every paid record remain intact. */
export async function resetBudgetUsage(service: string, input: { operationId: string; reason: string }, actor: string) {
  if (!input.operationId?.trim() || !input.reason?.trim() || !actor?.trim()) throw new Error("operationId, reason and actor are required");
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${"budget:" + service}))`;
    // Keep idempotency in the append-only audit, not only the most recent reset setting.
    const [already] = await tx<{ after: Reset }[]>`
      SELECT "after" FROM audit_log WHERE action = 'budget.day.reset' AND subject = ${`budget:${service}`}
        AND request_id = ${input.operationId} ORDER BY id LIMIT 1`;
    if (already) return { ...already.after, alreadyReset: true };
    const before = await getBudgetStatus(service, tx);
    if (!before) throw new Error(`unknown budget service: ${service}`);
    const [boundary] = await tx<{ at: Date; id: number }[]>`
      SELECT clock_timestamp() AS at, coalesce(max(id), 0)::bigint AS id FROM receipt_attempts WHERE service = ${service}`;
    const next: Reset = { resetAt: boundary!.at.toISOString(), afterAttemptId: boundary!.id, operationId: input.operationId };
    await tx`INSERT INTO settings (key, value, updated_by) VALUES (${resetKey(service)}, ${tx.json({ ...next })}, ${actor})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = clock_timestamp()`;
    await audit(actor, "budget.day.reset", `budget:${service}`, input.reason, before, next, { db: tx, requestId: input.operationId });
    return { ...next, alreadyReset: false };
  });
}
