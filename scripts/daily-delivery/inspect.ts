// Read-only, numeric safety summary. Run in a child with the project env loaded; never print env/errors.
import { sql, closeDb } from "@aihot/backend/db";
import type { DailyInspection } from "./core.ts";
const id = process.argv[2];
try {
  if (!/^(daily-\d{4}-\d{2}-\d{2}|refresh-\d{4}-\d{2}-\d{2}-(00|03|06|09|12|15|18|21)(?:-r1)?)$/.test(id ?? "")) throw new Error("Invalid daily ID");
  const date = id!.startsWith("refresh-") ? id!.slice(8, 18) : id!.slice(6);
  const budgetId = `daily-${date}`;
  const result = await sql.begin(async tx => {
    const [lock] = await tx<{ available: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('algorithmhot:model-execution')) AS available`;
    const [requests] = await tx<{ pending: number; unknown: number }[]>`SELECT count(*) FILTER (WHERE status='pending')::int AS pending,
      count(*) FILTER (WHERE status='unknown' AND model_run_id=${budgetId})::int AS unknown FROM receipt_attempts WHERE model_run_id IS NOT NULL`;
    const [budget] = await tx<{ calls_used: number }[]>`SELECT calls_used FROM model_runs WHERE id=${budgetId}`;
    const [report] = await tx<{ status: string; published: number; gaps: number; revision: number }[]>`SELECT content->'run'->>'status' AS status,
      coalesce((content->'metrics'->>'totalEvents')::int,0) AS published,
      coalesce(jsonb_array_length(content->'run'->'gaps'),0) AS gaps, revision
      FROM reports WHERE kind='daily' AND key=${date} AND content->'run'->>'id'=${id}`;
    if (report && report.status !== "complete" && report.status !== "partial") throw new Error("Invalid persisted report status");
    return { executionBusy: !lock.available, pendingRequests: requests.pending, unknownRequests: requests.unknown,
      callsUsed: budget?.calls_used ?? 0, report: report ? { ...report, status: report.status as "complete" | "partial" } : null } satisfies DailyInspection;
  });
  console.log(JSON.stringify(result));
} catch { console.error("Daily receipt inspection failed; no model request was sent."); process.exitCode = 1; }
finally { await closeDb(); }
