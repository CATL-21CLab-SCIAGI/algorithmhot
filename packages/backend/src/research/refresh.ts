import { beijingDate, beijingTime, dailyWindow, isValidDate } from "@aihot/contracts/time";
import { createResearchRun } from "./collect.ts";
import { sql } from "../db.ts";

const REFRESH_ID = /^refresh-(\d{4}-\d{2}-\d{2})-(00|03|06|09|12|15|18|21)(-r1)?$/;

/** Only a single explicit correction suffix is admitted; timers keep using ordinary slot IDs. */
export function refreshFamilyPattern(date: string): string {
  if (!isValidDate(date)) throw new Error("Invalid research family date");
  return `^refresh-${date}-(00|03|06|09|12|15|18|21)(-r1)?$`;
}

/** Daily and intraday snapshots share an admission family and one persisted model allowance. */
export function researchFamilyDate(id: string): string | null {
  const date = REFRESH_ID.exec(id)?.[1] ?? /^daily-(\d{4}-\d{2}-\d{2})$/.exec(id)?.[1];
  return date && isValidDate(date) ? date : null;
}

export function refreshWindow(id: string, cutoff: Date, now = new Date()) {
  const match = REFRESH_ID.exec(id);
  const date = match?.[1];
  if (!date || !isValidDate(date) || !Number.isFinite(cutoff.getTime()) || !Number.isFinite(now.getTime())) throw new Error("Invalid research refresh ID or cutoff");
  const hour = Number(beijingTime(cutoff).slice(0, 2));
  if (beijingDate(cutoff) !== date || Math.floor(hour / 3) * 3 !== Number(match[2])) throw new Error("Refresh cutoff must belong to its frozen Beijing three-hour slot");
  if (cutoff > now) throw new Error("Research refresh cutoff is in the future");
  return { date, modelRunId: `daily-${date}`, start: dailyWindow(date).start, end: cutoff };
}

/** The first write fixes the cutoff. Reopening a slot never widens its evidence window. */
export async function prepareRefreshRun(id: string, cutoff: Date) {
  const window = refreshWindow(id, cutoff);
  if (id.endsWith("-r1")) {
    const [base] = await sql<{ kind: string; admission_frozen: boolean; window_start: Date; window_end: Date }[]>`
      SELECT kind,admission_frozen,window_start,window_end FROM research_runs WHERE id=${id.slice(0, -3)}`;
    if (!base?.admission_frozen || base.kind !== "daily" || base.window_start.getTime() !== window.start.getTime()) throw new Error("An explicit refresh correction requires its frozen base snapshot");
    if (cutoff < base.window_end) throw new Error("Refresh correction cannot precede its frozen base cutoff");
  }
  const run = await createResearchRun(id, "daily", new Date(), { start: window.start, end: window.end });
  if (run.kind !== "daily" || run.window_start.getTime() !== window.start.getTime()
      || researchFamilyDate(run.id) !== window.date) throw new Error("Existing refresh run has incompatible frozen metadata");
  // Also reject malformed historical rows rather than using their ID as an admission escape.
  refreshWindow(run.id, run.window_end);
  return run;
}
