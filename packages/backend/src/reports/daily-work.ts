// The edition whose input processing gets priority. Queue ordering and paid-call admission must
// use the same (start, end] window; yesterday's unfinished work must not remain live forever.
import { addDays, beijingAt, beijingDate } from "@aihot/contracts/time";
import { EDITION_TIMES } from "@aihot/site";
import { sql, type Db } from "../db.ts";

export interface DailyWorkWindow {
  date: string;
  start: Date;
  end: Date;
}

/** Keep today's issue protected after its deadline; once saved, prepare the next issue. */
export async function dailyWorkWindow(db: Db = sql, now = new Date()): Promise<DailyWorkWindow> {
  const today = beijingDate(now);
  const [saved] = await db`SELECT 1 FROM reports WHERE kind = 'daily' AND key = ${today}`;
  const date = saved ? addDays(today, 1) : today;
  const end = beijingAt(date, EDITION_TIMES.daily);
  return { date, start: new Date(end.getTime() - 86400000), end };
}

export function isDailyWorkArticle(
  article: { timeline_at: Date; backfill: boolean; participation_mode: string },
  window: DailyWorkWindow,
): boolean {
  return article.participation_mode === "editorial" && !article.backfill
    && article.timeline_at > window.start && article.timeline_at <= window.end;
}

export async function dailyWorkArticleIds(db: Db, window: DailyWorkWindow): Promise<string[]> {
  const rows = await db<{ id: string }[]>`
    SELECT a.id FROM articles a JOIN sources s ON s.id = a.source_id
    WHERE s.participation_mode = 'editorial' AND NOT a.backfill
      AND a.timeline_at > ${window.start} AND a.timeline_at <= ${window.end}`;
  return rows.map((row) => row.id);
}
