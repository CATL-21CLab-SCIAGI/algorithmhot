// Compose the latest due research publications from existing public research; never run a model.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isoWeekRange, monthRange } from "@aihot/contracts/time";
import { composeResearchPeriod, dueResearchEditions } from "@aihot/backend/reports/compose";
import { config } from "@aihot/backend/config";
import { closeDb } from "@aihot/backend/db";

export interface EditionRequest { kind: "weekly" | "monthly"; key: string }

export function editionRequests(args: string[], now = new Date()): { at: Date; requests: EditionRequest[] } {
  let due = false, weekly: string | undefined, monthly: string | undefined, suppliedNow: string | undefined;
  for (const arg of args) {
    if (arg === "--due" && !due) due = true;
    else if (arg.startsWith("--weekly=") && weekly === undefined) weekly = arg.slice("--weekly=".length);
    else if (arg.startsWith("--monthly=") && monthly === undefined) monthly = arg.slice("--monthly=".length);
    else if (arg.startsWith("--now=") && suppliedNow === undefined) suppliedNow = arg.slice("--now=".length);
    else throw new Error(`Invalid or repeated research edition option: ${arg}`);
  }
  if (suppliedNow !== undefined) {
    if (!due || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(suppliedNow) || !Number.isFinite(Date.parse(suppliedNow))) throw new Error("--now requires --due and an explicit ISO timezone");
    now = new Date(suppliedNow);
  }
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid research edition clock");
  if (due && (weekly !== undefined || monthly !== undefined)) throw new Error("Use either --due or explicit edition keys");
  if (due) ({ weekly, monthly } = dueResearchEditions(now));
  if (weekly === undefined && monthly === undefined) throw new Error("Use --due, --weekly=YYYY-Www or --monthly=YYYY-MM");
  if (weekly !== undefined && !isoWeekRange(weekly)) throw new Error("Invalid weekly edition key");
  if (monthly !== undefined && !monthRange(monthly)) throw new Error("Invalid monthly edition key");
  return { at: now, requests: [
    ...(weekly ? [{ kind: "weekly" as const, key: weekly }] : []),
    ...(monthly ? [{ kind: "monthly" as const, key: monthly }] : []),
  ] };
}

async function main() {
  const plan = editionRequests(process.argv.slice(2));
  config.modelCallsEnabled = false;
  process.env.MODEL_CALLS_ENABLED = "false";
  const results = [];
  try {
    for (const request of plan.requests) results.push(await composeResearchPeriod(request.kind, request.key));
    console.log(JSON.stringify({ at: plan.at.toISOString(), modelCalls: 0, editions: results }));
  } finally { await closeDb(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
