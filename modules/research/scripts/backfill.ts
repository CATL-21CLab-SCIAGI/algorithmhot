// One-off catch-up of papers that went online before the site watched (modules/research/backfill.ts).
//
//   node --env-file=.env modules/research/scripts/backfill.ts 2026-10-09 [2026-10-12]
// arXiv announcements on the days from the first date to the second (default: yesterday), and journal
// articles first online since the first date. The worker then judges them like any other paper.
import { addDays, beijingDate, isValidDate } from "@aihot/contracts/time";
import { installModules } from "@aihot/backend/modules";
import { closeDb } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { backfillArxiv, backfillJournals } from "../backfill.ts";

installModules(SERVER_MODULES);
const [from, to = addDays(beijingDate(new Date()), -1)] = process.argv.slice(2);
if (!from || !isValidDate(from) || !isValidDate(to) || to < from) {
  console.error("usage: node --env-file=.env modules/research/scripts/backfill.ts FROM [TO]   (YYYY-MM-DD, Beijing days)");
  process.exit(2);
}
console.log(JSON.stringify({ arxiv: await backfillArxiv(from, to) }));
console.log(JSON.stringify({ journals: await backfillJournals(from) }));
await stopBoss();
await closeDb();
