import { beijingDate, beijingTime, dailyWindow, isValidDate } from "@aihot/contracts/time";
import { reviewCallCeiling } from "@aihot/contracts/review-schedule";
import { createResearchRun, type ResearchAdmissionOptions } from "./collect.ts";
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

/** Within one family, the review slot (then its correction) orders snapshots. */
export function researchSnapshotRank(id: string): number {
  const match = REFRESH_ID.exec(id);
  return match ? Number(match[2]) * 2 + (match[3] ? 1 : 0) : -1;
}

export function refreshWindow(id: string, cutoff: Date, now = new Date(), admissionPolicy: ResearchAdmissionOptions["admissionPolicy"] = "legacy-capped") {
  const match = REFRESH_ID.exec(id);
  const date = match?.[1];
  if (!date || !isValidDate(date) || !Number.isFinite(cutoff.getTime()) || !Number.isFinite(now.getTime())) throw new Error("Invalid research refresh ID or cutoff");
  const hour = Number(beijingTime(cutoff).slice(0, 2));
  const slotHour = Number(match[2]);
  // Keep the old morning range valid for frozen pre-afternoon runs, including corrections.
  // The delivery entry independently restricts new work to the current scheduled slot.
  const inSlot = admissionPolicy === "all-in-window" ? (slotHour === 9 && hour >= 9 && hour < 21) || (slotHour === 15 && hour >= 15 && hour < 21) || (slotHour === 21 && hour >= 21)
    : Math.floor(hour / 3) * 3 === slotHour;
  if (beijingDate(cutoff) !== date || !inSlot) throw new Error("Refresh cutoff must belong to its frozen Beijing review slot");
  if (cutoff > now) throw new Error("Research refresh cutoff is in the future");
  const window = dailyWindow(date);
  return { date, modelRunId: `daily-${date}`, start: window.start, end: admissionPolicy === "all-in-window" ? window.end : cutoff, observedAt: cutoff };
}

/** The first write fixes the cutoff. Reopening a slot never widens its evidence window. */
export async function prepareRefreshRun(id: string, cutoff: Date, options: ResearchAdmissionOptions = {}) {
  const [existing] = await sql<{ admission_policy: ResearchAdmissionOptions["admissionPolicy"]; window_end: Date; collection_cutoff: Date }[]>`
    SELECT admission_policy,window_end,collection_cutoff FROM research_runs WHERE id=${id}`;
  const policy = existing?.admission_policy ?? options.admissionPolicy ?? "legacy-capped";
  const window = refreshWindow(id, existing?.collection_cutoff ?? cutoff, new Date(), policy);
  if (!existing && policy === "all-in-window") {
    // An explicit source correction uses the remaining day allowance; it does not
    // refund the base snapshot or grant the later scheduled review another budget.
    const expectedCeiling = reviewCallCeiling(Number(REFRESH_ID.exec(id)?.[2]), id.endsWith("-r1"));
    if (options.modelCallCeiling !== expectedCeiling) throw new Error("Review slot requires its frozen cumulative model call ceiling");
  }
  if (id.endsWith("-r1")) {
    const [base] = await sql<{ kind: string; admission_frozen: boolean; window_start: Date; collection_cutoff: Date }[]>`
      SELECT kind,admission_frozen,window_start,collection_cutoff FROM research_runs WHERE id=${id.slice(0, -3)}`;
    const permittedStart = base && (base.window_start.getTime() === window.start.getTime()
      || policy === "all-in-window" && base.window_start.getTime() === window.start.getTime() - 3600_000);
    if (!base?.admission_frozen || base.kind !== "daily" || !permittedStart) throw new Error("An explicit refresh correction requires its frozen base snapshot");
    if (cutoff < base.collection_cutoff) throw new Error("Refresh correction cannot precede its frozen base cutoff");
  }
  const run = await createResearchRun(id, "daily", new Date(), window, options);
  if (run.kind !== "daily" || run.window_start.getTime() !== window.start.getTime()
      || researchFamilyDate(run.id) !== window.date) throw new Error("Existing refresh run has incompatible frozen metadata");
  // Also reject malformed historical rows rather than using their ID as an admission escape.
  refreshWindow(run.id, run.collection_cutoff, new Date(), run.admission_policy);
  return run;
}
