// The paper feeds in the worker: arXiv every ten minutes through its announcement morning (Beijing weekdays
// 08:00–12:00) and every three hours otherwise, journals every hour, figures for selected papers every
// twenty minutes (figures.ts, never in the way of publishing); and the hold that keeps a weekday's daily
// waiting for that morning's announcement (reports/compose.ts dailyHold) until the deadline.
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { defineServerModule } from "@aihot/backend/modules";
import { sql } from "@aihot/backend/db";
import { collectArxiv, collectJournals } from "./collect.ts";
import { attachFigures } from "./figures.ts";
import { feeds } from "./feeds.ts";

const collecting = () => process.env.COLLECT_ENABLED === "true";
const OFF_MORNING_EVERY_MS = 3 * 3600_000;

/** Monday to Friday in Beijing: the mornings arXiv announces on. */
export const announcesOn = (day: string) => [1, 2, 3, 4, 5].includes(new Date(`${day}T00:00:00Z`).getUTCDay());

/** The arXiv feeds whose listing still names an earlier day than `day`. */
async function feedsBehind(day: string): Promise<string[]> {
  const ids = feeds().arxiv.map((f) => f.id);
  if (!ids.length) return [];
  const rows = await sql<{ id: string; listing_day: string | null }[]>`
    SELECT id, cursor->>'listingDay' AS listing_day FROM sources WHERE id IN ${sql(ids)} AND enabled`;
  return rows.filter((r) => !r.listing_day || r.listing_day < day).map((r) => r.id);
}

/** Due now: the announcement morning until every feed has read today's listing, otherwise every three hours. */
export async function arxivDue(now = new Date()): Promise<boolean> {
  const day = beijingDate(now);
  const time = beijingTime(now);
  if (announcesOn(day) && time >= "08:00" && time < "12:00" && (await feedsBehind(day)).length > 0) return true;
  const [{ last }] = await sql<{ last: Date | null }[]>`
    SELECT max(last_fetch_at) AS last FROM sources WHERE id IN ${sql(feeds().arxiv.map((f) => f.id).concat("-"))}`;
  return !last || now.getTime() - last.getTime() >= OFF_MORNING_EVERY_MS;
}

export default defineServerModule({
  name: "research",
  schedules: [
    { name: "research.arxiv", cron: "*/10 * * * *", when: collecting, run: async () => ((await arxivDue()) ? collectArxiv() : { skipped: "not due" }) },
    { name: "research.journals", cron: "25 * * * *", when: collecting, run: () => collectJournals() },
    { name: "research.figures", cron: "5,25,45 * * * *", when: collecting, run: () => attachFigures() },
  ],
  reports: {
    // A weekday's daily includes that morning's announcement (it goes online at 08:00, the window's last minute).
    dailyHold: async ({ date }) => {
      if (!collecting() || !announcesOn(date)) return null;
      const behind = await feedsBehind(date);
      return behind.length ? `arXiv ${date} 的公告还没读到（${behind.join("、")}）` : null;
    },
  },
});
