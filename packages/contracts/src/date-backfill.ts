import { dailyWindow } from "./time.ts";

/** Explicit one-time authorization: three historical issues, at most 600 extra calls each. */
export const DATE_BACKFILL_CAMPAIGN = "recollect-20261009-oct05-07-v1";
export const DATE_BACKFILL_DATES = ["2026-10-05", "2026-10-06", "2026-10-07"] as const;

export function dateBackfillRunId(date: string): string {
  if (!(DATE_BACKFILL_DATES as readonly string[]).includes(date)) throw new Error("Date is outside the authorized historical campaign");
  return `${DATE_BACKFILL_CAMPAIGN}-${date}`;
}

/** No arbitrary prefix, new campaign, changed date window, or alternate budget is accepted. */
export function authorizedDateBackfill(
  runId: string, budgetId: string | undefined, kind: string,
  window: { start: Date; end: Date } | undefined, ceiling: number | undefined,
): boolean {
  const date = DATE_BACKFILL_DATES.find(value => dateBackfillRunId(value) === runId);
  if (!date || budgetId !== runId || kind !== "pilot" || ceiling !== 580 || !window) return false;
  const expected = dailyWindow(date);
  return window.start.getTime() === expected.start.getTime() && window.end.getTime() === expected.end.getTime();
}
