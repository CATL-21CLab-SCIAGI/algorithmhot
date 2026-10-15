// Writes the dailies of the given Beijing dates that do not exist yet, e.g. the days before a site's first
// issue (the scheduled run only fills gaps after it). An issue already out is not touched, unless --replace
// asks for it explicitly (after a backfill put papers into its window): the replaced edition is kept as a
// revision.
//
//   node --env-file=.env scripts/compose-daily.ts 2026-10-10 2026-10-11
//   node --env-file=.env scripts/compose-daily.ts --replace 2026-10-11
import { isValidDate } from "@aihot/contracts/time";
import { installModules } from "@aihot/backend/modules";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { composeDaily } from "@aihot/backend/reports/compose";
import { SERVER_MODULES } from "@aihot/site/modules/server";

installModules(SERVER_MODULES);
const replace = process.argv.includes("--replace");
const dates = process.argv.slice(2).filter((a) => a !== "--replace");
if (!dates.length || !dates.every(isValidDate)) {
  console.error("usage: node --env-file=.env scripts/compose-daily.ts [--replace] YYYY-MM-DD [YYYY-MM-DD ...]");
  process.exit(2);
}
let failed = 0;
for (const date of dates.sort()) {
  const [existing] = await sql`SELECT 1 FROM reports WHERE kind = 'daily' AND key = ${date}`;
  if (existing && !replace) {
    console.log(JSON.stringify({ date, status: "exists" }));
    continue;
  }
  try {
    const { entries } = await composeDaily(date, existing ? "replaced after a backfill" : undefined);
    console.log(JSON.stringify({ date, status: existing ? "replaced" : "written", entries }));
  } catch (error) {
    failed += 1;
    console.log(JSON.stringify({ date, status: "not written", reason: String((error as Error).message ?? error) }));
  }
}
await stopBoss();
await closeDb();
process.exitCode = failed ? 1 : 0;
