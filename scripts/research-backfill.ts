// Explicit, bounded historical material review. This never composes a pilot or starts a scheduler.
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { addDays, beijingDate, beijingMidnight, isValidDate, monthRange } from "@aihot/contracts/time";
import { saveJson, withDeliveryLock } from "./daily-delivery/core.ts";

interface BackfillOptions { month: string; calls: number; mode: "all" | "collect" | "process" | "repair"; stopAtCalls?: number }
interface BackfillWindow { week: number; runId: string; start: string; end: string; collected: boolean; frozen: boolean }
export interface BackfillCandidate {
  week: number; runId: string; articleId: string; canonicalKey: string; sourceId: string; sortDate: string;
}
export interface BackfillDatedCandidate extends Omit<BackfillCandidate, "sortDate"> {
  arxivId: string | null; announcedOn: string | null; originalPublishedAt: string | null;
}
interface BackfillQueueAudit {
  policy: "reader-date-v1"; auditedAt: string; admittedRows: number; eligibleRows: number; queuedRows: number;
  excluded: (Omit<BackfillCandidate, "sortDate"> & { readerDate: string | null; reason: "outside-window" | "missing-reader-date" })[];
  previousQueueRows?: number; originalPlan?: { file: string; sha256: string }; attemptsSincePlan?: number;
}
export interface BackfillPlan {
  version: 1; month: string; budgetDate: string; budgetId: string; createdAt: string;
  requestedCalls: number; startCalls: number; callCeiling: number; windows: BackfillWindow[];
  queue?: BackfillCandidate[]; queueAudit?: BackfillQueueAudit; cursor: number;
  status: "planned" | "collecting" | "collected" | "processing" | "partial" | "complete" | "stopped";
  updatedAt?: string; error?: string; summary?: unknown;
  cursorRecoveries?: BackfillCursorRecovery[];
}
interface BackfillCursorRecovery { checkedAt: string; from: number; to: number; inspected: number; articleIds: string[] }
export interface BackfillBriefCheckpoint { state: string; error: string | null; briefEligible: boolean; hasCurrentBrief: boolean; held: boolean }

export function backfillOptions(args: string[]): BackfillOptions {
  let month: string | undefined, calls: number | undefined, stopAtCalls: number | undefined, mode: BackfillOptions["mode"] = "all";
  for (const arg of args) {
    if (arg.startsWith("--month=") && month === undefined) month = arg.slice(8);
    else if (arg.startsWith("--calls=") && calls === undefined && /^\d+$/.test(arg.slice(8))) calls = Number(arg.slice(8));
    else if (arg.startsWith("--stop-at-calls=") && stopAtCalls === undefined && /^\d+$/.test(arg.slice(16))) stopAtCalls = Number(arg.slice(16));
    else if (arg === "--collect-only" && mode === "all") mode = "collect";
    else if (arg === "--process-only" && mode === "all") mode = "process";
    else if (arg === "--repair-queue" && mode === "all") mode = "repair";
    else throw new Error("Use --month=YYYY-MM --calls=1..290 with at most one of --collect-only, --process-only or --repair-queue");
  }
  if (!month || !monthRange(month) || !Number.isInteger(calls) || calls! < 1 || calls! > 290) throw new Error("A valid --month and --calls=1..290 are required");
  if (stopAtCalls !== undefined && (mode !== "process" || !Number.isInteger(stopAtCalls) || stopAtCalls < 1 || stopAtCalls > 290)) throw new Error("--stop-at-calls=1..290 requires --process-only");
  return { month, calls: calls!, mode, ...(stopAtCalls === undefined ? {} : { stopAtCalls }) };
}

/** A one-invocation stop can conserve calls but never alter or enlarge the frozen allowance. */
export function backfillInvocationCeiling(plan: Pick<BackfillPlan, "callCeiling">, callsUsed: number, stopAtCalls?: number): number {
  if (stopAtCalls === undefined) return plan.callCeiling;
  if (!Number.isInteger(stopAtCalls) || stopAtCalls < 1 || stopAtCalls > plan.callCeiling || stopAtCalls < callsUsed) {
    throw new Error("Invocation stop must be at least current shared calls used and no more than the frozen plan ceiling");
  }
  return Math.min(plan.callCeiling, stopAtCalls);
}

export function newBackfillPlan(month: string, calls: number, callsUsed: number, now = new Date()): BackfillPlan {
  const range = monthRange(month);
  if (!range || !Number.isFinite(now.getTime()) || beijingMidnight(addDays(range.end, 1)) > now) throw new Error("Historical month must have closed in Beijing time");
  if (!Number.isInteger(calls) || calls < 1 || calls > 290 || !Number.isInteger(callsUsed) || callsUsed < 0 || callsUsed > 600) throw new Error("Invalid historical call allowance");
  const budgetDate = beijingDate(now);
  const starts = [range.start, `${month}-08`, `${month}-15`, `${month}-22`];
  return { version: 1, month, budgetDate, budgetId: `daily-${budgetDate}`, createdAt: now.toISOString(),
    requestedCalls: calls, startCalls: callsUsed, callCeiling: Math.min(callsUsed + calls, 290), cursor: 0, status: "planned",
    windows: starts.map((start, index) => ({ week: index + 1, runId: `history-${month}-${budgetDate}-w${index + 1}`,
      start: beijingMidnight(start).toISOString(), end: beijingMidnight(starts[index + 1] ?? addDays(range.end, 1)).toISOString(), collected: false, frozen: false })) };
}

export function validateBackfillPlan(value: unknown, month: string, calls: number): BackfillPlan {
  const plan = value as BackfillPlan;
  if (!plan || plan.version !== 1 || plan.month !== month || plan.requestedCalls !== calls || !isValidDate(plan.budgetDate)) throw new Error("Existing historical plan differs; its allowance cannot be reset or enlarged");
  const expected = newBackfillPlan(month, calls, plan.startCalls, new Date(plan.createdAt));
  if (plan.budgetId !== expected.budgetId || plan.budgetDate !== expected.budgetDate || plan.callCeiling !== expected.callCeiling
      || !Array.isArray(plan.windows) || plan.windows.length !== 4 || !Number.isInteger(plan.cursor) || plan.cursor < 0) throw new Error("Invalid frozen historical plan");
  for (const [index, window] of plan.windows.entries()) {
    const reference = expected.windows[index]!;
    if (window.runId !== reference.runId || window.week !== reference.week || window.start !== reference.start || window.end !== reference.end
        || typeof window.collected !== "boolean" || typeof window.frozen !== "boolean") throw new Error("Historical plan windows changed");
  }
  if (plan.queue && (!Array.isArray(plan.queue) || plan.cursor > plan.queue.length
      || plan.queue.some(row => !plan.windows.some(window => window.runId === row.runId && window.week === row.week)
        || !row.articleId || !row.canonicalKey || typeof row.sortDate !== "string" || sourceGroup(row.sourceId) < 0)
      || new Set(plan.queue.map(row => row.canonicalKey)).size !== plan.queue.length)) throw new Error("Invalid frozen historical processing queue");
  return plan;
}

/** An earlier day's plan remains authoritative. A later invocation cannot allocate another 140 calls. */
export async function findBackfillPlan(directory: string, month: string, calls: number): Promise<{ file: string; plan: BackfillPlan } | null> {
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const matching = names.filter(name => new RegExp(`^${month}-\\d{4}-\\d{2}-\\d{2}$`).test(name));
  if (matching.length > 1) throw new Error("Multiple historical plans exist for this month; preserve them for inspection");
  if (!matching[0]) return null;
  const file = path.join(directory, matching[0], "plan.json");
  const plan = validateBackfillPlan(JSON.parse(await readFile(file, "utf8")), month, calls);
  if (matching[0] !== `${plan.month}-${plan.budgetDate}`) throw new Error("Historical plan directory does not match its frozen day");
  return { file, plan };
}

function sourceGroup(source: string): number {
  return [["research-arxiv-ml-ai"], ["research-arxiv-physical-science"], ["research-arxiv-molecular"], ["rss-google-deepmind", "rss-bair"]]
    .findIndex(group => group.includes(source));
}
function roundRobin<T>(queues: T[][]): T[] {
  const result: T[] = [];
  for (let index = 0; queues.some(queue => index < queue.length); index++) for (const queue of queues) if (index < queue.length) result.push(queue[index]!);
  return result;
}

/** Weeks alternate; within each week the four editorial source groups alternate newest first. */
export function backfillOrder(rows: BackfillCandidate[]): BackfillCandidate[] {
  if (rows.some(row => !Number.isInteger(row.week) || row.week < 1 || row.week > 4 || sourceGroup(row.sourceId) < 0)) throw new Error("Unexpected historical week or source");
  const weeks = [1, 2, 3, 4].map(week => roundRobin([0, 1, 2, 3].map(group => rows.filter(row => row.week === week && sourceGroup(row.sourceId) === group)
    .sort((a, b) => b.sortDate.localeCompare(a.sortDate) || a.canonicalKey.localeCompare(b.canonicalKey) || a.articleId.localeCompare(b.articleId)))));
  const seen = new Set<string>();
  return roundRobin(weeks).filter(row => { if (seen.has(row.canonicalKey)) return false; seen.add(row.canonicalKey); return true; });
}

/** Match the reader's official arXiv announcement day, otherwise the original publication's Beijing day.
 * Discovery/arrival timestamps never determine a historical issue's membership. */
export function backfillReaderDate(row: Pick<BackfillDatedCandidate, "arxivId" | "announcedOn" | "originalPublishedAt">): string | null {
  if (row.arxivId && row.announcedOn && isValidDate(row.announcedOn)) return row.announcedOn;
  const original = row.originalPublishedAt;
  if (!original || !isValidDate(original.slice(0, 10)) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(original) || !Number.isFinite(Date.parse(original))) return null;
  return beijingDate(original);
}

export function auditBackfillQueue(rows: BackfillDatedCandidate[], windows: BackfillWindow[], now = new Date()): { queue: BackfillCandidate[]; queueAudit: BackfillQueueAudit } {
  const eligible: BackfillCandidate[] = [], excluded: BackfillQueueAudit["excluded"] = [];
  for (const row of rows) {
    const window = windows.find(window => window.week === row.week && window.runId === row.runId);
    if (!window || sourceGroup(row.sourceId) < 0) throw new Error("Unexpected historical candidate window or source");
    const readerDate = backfillReaderDate(row), at = readerDate ? beijingMidnight(readerDate).getTime() : NaN;
    const { week, runId, articleId, canonicalKey, sourceId } = row;
    if (at >= Date.parse(window.start) && at < Date.parse(window.end)) eligible.push({ week, runId, articleId, canonicalKey, sourceId, sortDate: readerDate! });
    else excluded.push({ week, runId, articleId, canonicalKey, sourceId, readerDate, reason: readerDate ? "outside-window" : "missing-reader-date" });
  }
  const queue = backfillOrder(eligible);
  return { queue, queueAudit: { policy: "reader-date-v1", auditedAt: now.toISOString(), admittedRows: rows.length,
    eligibleRows: eligible.length, queuedRows: queue.length, excluded } };
}

/** Explicit, pre-processing repair only. Original admissions and the exact old plan stay intact. */
export async function repairBackfillQueue(file: string, plan: BackfillPlan, rows: BackfillDatedCandidate[], attemptsSincePlan: number, now = new Date()): Promise<BackfillPlan> {
  if (!plan.queue || plan.queueAudit || plan.cursor !== 0 || attemptsSincePlan !== 0 || plan.windows.some(window => !window.collected || !window.frozen)) {
    throw new Error("Queue repair requires an unaudited collected plan, cursor=0 and no model attempts since plan creation; preserve the current plan");
  }
  const original = await readFile(file, "utf8");
  if (JSON.stringify(JSON.parse(original)) !== JSON.stringify(plan)) throw new Error("Historical plan changed during queue repair; preserve it");
  const audited = auditBackfillQueue(rows, plan.windows, now);
  const sha256 = createHash("sha256").update(original).digest("hex"), backup = `${file}.before-reader-date-${sha256.slice(0, 16)}.json`;
  try { await writeFile(backup, original, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(backup, "utf8") !== original) throw error; }
  const repaired: BackfillPlan = { ...plan, ...audited, status: "collected", updatedAt: now.toISOString() };
  repaired.queueAudit = { ...audited.queueAudit, previousQueueRows: plan.queue.length,
    originalPlan: { file: path.basename(backup), sha256 }, attemptsSincePlan };
  delete repaired.summary; delete repaired.error;
  await saveJson(file, repaired);
  return repaired;
}

export function assertBackfillQueueAudited(plan: BackfillPlan): void {
  if (!plan.queue || plan.queueAudit?.policy !== "reader-date-v1" || plan.queueAudit.queuedRows !== plan.queue.length) {
    throw new Error("Historical queue lacks the reader-date audit; use --repair-queue only before processing and without new model attempts");
  }
  for (const row of plan.queue) {
    const window = plan.windows.find(window => window.runId === row.runId && window.week === row.week), at = beijingMidnight(row.sortDate).getTime();
    if (!window || !isValidDate(row.sortDate) || !(at >= Date.parse(window.start) && at < Date.parse(window.end))) throw new Error("Audited historical queue date is outside its frozen window");
  }
}

/** The shared executor can return normally when its second budget check stops before the brief. */
export async function visitBackfillArticle(execute: (hasBudget: () => Promise<boolean>) => Promise<void>, hasBudget: () => Promise<boolean>,
  isBudgetExceeded: (error: unknown) => boolean): Promise<"visited" | "budget-stopped"> {
  let budgetStopped = false;
  try {
    await execute(async () => {
      const available = await hasBudget();
      if (!available) budgetStopped = true;
      return available;
    });
  } catch (error) { if (isBudgetExceeded(error)) budgetStopped = true; else throw error; }
  return budgetStopped ? "budget-stopped" : "visited";
}

/** Bounded repair of legacy checkpoints that advanced after a successful mainflow but before its brief.
 * Held requests and deliberate skips never become retry candidates. The queue itself stays frozen. */
export async function backfillCursorRecovery(plan: Pick<BackfillPlan, "queue" | "cursor">,
  inspect: (entry: BackfillCandidate) => Promise<BackfillBriefCheckpoint>, now = new Date()): Promise<BackfillCursorRecovery | null> {
  if (!plan.queue || !Number.isInteger(plan.cursor) || plan.cursor < 0 || plan.cursor > plan.queue.length) throw new Error("Invalid historical cursor for recovery");
  const start = Math.max(0, plan.cursor - 32), missing: { index: number; articleId: string }[] = [];
  for (let index = start; index < plan.cursor; index++) {
    const entry = plan.queue[index]!, checkpoint = await inspect(entry);
    if (checkpoint.state === "pass" && !checkpoint.error && checkpoint.briefEligible && !checkpoint.hasCurrentBrief && !checkpoint.held) {
      missing.push({ index, articleId: entry.articleId });
    }
  }
  return missing[0] ? { checkedAt: now.toISOString(), from: plan.cursor, to: missing[0].index,
    inspected: plan.cursor - start, articleIds: missing.map(row => row.articleId) } : null;
}

export async function withBackfillBatchLock<T>(directory: string, action: () => Promise<T>, startedAt: string): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, "batch.lock"), owner = { pid: process.pid, startedAt, token: randomUUID() };
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Project batch lock exists; inspect its owner without reclaiming it"); throw error; }
  await saveJson(path.join(lock, "owner.json"), owner);
  try { return await action(); }
  finally {
    const current = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8"));
    if (current.token === owner.token) await rm(lock, { recursive: true });
  }
}

export function assertNoProjectProducer(root: string): string {
  const listing = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  if (listing.status !== 0) throw new Error("Cannot inspect active project producers");
  for (const line of listing.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match || Number(match[1]) === process.pid || !/^(?:\S*\/)?node(?:\s|$)/.test(match[2]!)
        || !/scripts\/(?:research-run|research-scheduler|research-backfill|research-date-backfill|research-editions)\.ts/.test(match[2]!)) continue;
    const pid = Number(match[1]);
    if (match[2]!.includes(root)) throw new Error(`Project research producer is active (${pid}); preserve it`);
    const cwd = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
    if (cwd.status !== 0) throw new Error(`Cannot determine research producer ${pid}'s project; preserve it`);
    if (cwd.stdout.split("\n").includes(`n${root}`)) throw new Error(`Project research producer is active (${pid}); preserve it`);
  }
  const own = spawnSync("ps", ["-p", String(process.pid), "-o", "lstart="], { encoding: "utf8" });
  if (own.status !== 0 || !own.stdout.trim()) throw new Error("Cannot record this batch's process identity");
  return own.stdout.trim();
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = backfillOptions(args), root = path.resolve(import.meta.dirname, ".."), now = new Date();
  newBackfillPlan(options.month, options.calls, 0, now); // Reject a future/open month before opening a database or creating a ledger row.
  if (existsSync(path.join(root, ".env"))) for (const [key, value] of Object.entries(parseEnv(readFileSync(path.join(root, ".env"), "utf8")))) process.env[key] ??= value;
  Object.assign(process.env, { COLLECT_ENABLED: options.mode === "process" || options.mode === "repair" ? "false" : "true", MODEL_CALLS_ENABLED: options.mode === "collect" || options.mode === "repair" ? "false" : "true",
    RESEARCH_ADMISSION_ENABLED: "true", RESEARCH_REQUEST_ISOLATION: "true", MODEL_RUN_MAX_CALLS: "600", MODEL_RUN_REPORT_RESERVE: "20" });
  const [{ config }, { sql, closeDb }, { createResearchRun, collectResearchRun }, { freezeAdmissions, researchRunMetrics },
    { ensureModelRun, getModelRun }, { researchModelForRun }, { assertResearchRequestsIdle, processIsolatedResearchArticles, articleRequestHold },
    { processArticle }, { extractArticleBody }, { generateResearchBrief, RESEARCH_BRIEF_VERSION }, { publishArticle }, { BudgetExceededError }, { stopBoss }, { shutdownSignal }] = await Promise.all([
    import("@aihot/backend/config"), import("@aihot/backend/db"), import("@aihot/backend/research/collect"), import("@aihot/backend/research/admission"),
    import("@aihot/backend/providers/model-runs"), import("@aihot/backend/providers/research-model"), import("@aihot/backend/research/request-isolation"),
    import("@aihot/backend/jobs/content"), import("@aihot/backend/content/extract"), import("@aihot/backend/research/brief"), import("@aihot/backend/publication/publish"),
    import("@aihot/backend/providers/receipts"), import("@aihot/backend/jobs/queue"), import("@aihot/backend/lib/shutdown"),
  ]);
  const directory = path.join(config.dataDir, "research-backfills");
  const interrupted = () => shutdownSignal.abort();
  process.on("SIGINT", interrupted); process.on("SIGTERM", interrupted);
  try {
    await withDeliveryLock(path.join(root, ".data/daily-delivery"), async () => withBackfillBatchLock(path.join(root, ".data/local"), async () => {
      await assertResearchRequestsIdle();
      let saved = await findBackfillPlan(directory, options.month, options.calls);
      if (!saved) {
        if (options.mode === "process" || options.mode === "repair") throw new Error("Processing or queue repair requires an existing frozen and collected plan");
        const budget = await ensureModelRun({ id: `daily-${beijingDate(now)}`, maxCalls: 600, reportReserve: 20 });
        const plan = newBackfillPlan(options.month, options.calls, budget.callsUsed, now);
        const file = path.join(directory, `${plan.month}-${plan.budgetDate}`, "plan.json");
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await saveJson(file, plan); saved = { plan, file };
      }
      const { plan, file } = saved;
      const persist = async () => { plan.updatedAt = new Date().toISOString(); await saveJson(file, plan); };
      const readCandidates = async (): Promise<BackfillDatedCandidate[]> => {
        const candidates: BackfillDatedCandidate[] = [];
        for (const window of plan.windows) {
          const rows = await sql<Omit<BackfillDatedCandidate, "week" | "runId">[]>`
            SELECT m.article_id AS "articleId",coalesce(a.research->>'canonicalKey',a.identity_key) AS "canonicalKey",m.source_id AS "sourceId",
              a.research->>'arxivId' AS "arxivId",a.research->>'announcedOn' AS "announcedOn",a.research->>'originalPublishedAt' AS "originalPublishedAt"
            FROM research_members m JOIN articles a ON a.id=m.article_id WHERE m.run_id=${window.runId} AND m.admitted`;
          candidates.push(...rows.map(row => ({ ...row, week: window.week, runId: window.runId })));
        }
        return candidates;
      };
      if (options.mode === "repair") {
        const [attempts] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM receipt_attempts ra JOIN receipts r ON r.id=ra.receipt_id
          WHERE ra.started_at>=${plan.createdAt}::timestamptz AND (ra.model_run_id=${plan.budgetId} OR substring(r.subject FROM '^article:([^@:#]+)') IN
            (SELECT article_id FROM research_members WHERE run_id=ANY(${plan.windows.map(window => window.runId)})))`;
        const repaired = await repairBackfillQueue(file, plan, await readCandidates(), attempts?.n ?? -1);
        console.log(JSON.stringify({ event: "backfill-queue-repaired", queue: repaired.queue?.length, excluded: repaired.queueAudit?.excluded.length,
          admittedRows: repaired.queueAudit?.admittedRows, originalPlan: repaired.queueAudit?.originalPlan, cursor: repaired.cursor,
          budgetId: repaired.budgetId, callCeiling: repaired.callCeiling }));
        return;
      }
      if (plan.queue) assertBackfillQueueAudited(plan);
      const budget = await ensureModelRun({ id: plan.budgetId, maxCalls: 600, reportReserve: 20 });
      if (budget.callsUsed < plan.startCalls) throw new Error("Shared model ledger moved backwards; preserve the plan");
      const invocationCallCeiling = backfillInvocationCeiling(plan, budget.callsUsed, options.stopAtCalls);
      process.env.MODEL_RUN_ID = plan.budgetId; process.env.MODEL_RUN_CALL_CEILING = String(invocationCallCeiling);
      const hasBudget = async () => { const b = await getModelRun(plan.budgetId); return Boolean(b && b.callsUsed < invocationCallCeiling && b.remaining > b.reportReserve); };
      console.log(JSON.stringify({ event: "backfill-start", month: plan.month, mode: options.mode, budgetId: plan.budgetId, sharedCallsUsed: budget.callsUsed,
        callCeiling: plan.callCeiling, invocationCallCeiling, windows: 4 }));
      try {
        for (const window of plan.windows) {
          const run = await createResearchRun(window.runId, "pilot", new Date(plan.createdAt), { start: new Date(window.start), end: new Date(window.end) },
            { admissionPolicy: "all-in-window", modelCallCeiling: 290, modelBudgetId: plan.budgetId });
          if (run.model_budget_id !== plan.budgetId || run.model_call_ceiling !== 290 || run.admission_policy !== "all-in-window"
              || run.window_start.toISOString() !== window.start || run.window_end.toISOString() !== window.end) throw new Error("Historical run differs from its frozen plan");
          if ((await researchModelForRun(window.runId))?.transport !== "codex_cli") throw new Error("Historical review requires its existing Codex subscription profile; no paid API fallback");
        }
        if (options.mode !== "process") for (const window of plan.windows) {
          shutdownSignal.signal.throwIfAborted(); await assertResearchRequestsIdle(); process.env.RESEARCH_RUN_ID = window.runId;
          if (!window.collected) { plan.status = "collecting"; await persist(); await collectResearchRun(window.runId); window.collected = true; await persist(); }
          if (!window.frozen) { await freezeAdmissions(window.runId); window.frozen = true; await persist(); }
        }
        if (plan.windows.some(window => !window.collected || !window.frozen)) throw new Error("Collect all four source windows and freeze admissions before processing");
        if (!plan.queue) {
          Object.assign(plan, auditBackfillQueue(await readCandidates(), plan.windows)); await persist();
        }
        assertBackfillQueueAudited(plan);
        const queue = plan.queue!;
        if (options.mode !== "collect" && plan.cursor > 0) {
          const recovery = await backfillCursorRecovery(plan, async entry => {
            const [checkpoint] = await sql<Omit<BackfillBriefCheckpoint, "held">[]>`
              SELECT m.state,m.error,
                EXISTS(SELECT 1 FROM research_briefs b WHERE b.article_id=a.id AND b.input_revision=a.revision AND b.version=${RESEARCH_BRIEF_VERSION}) AS "hasCurrentBrief",
                (coalesce(p.eligible,false) AND p.visibility='public' AND a.research IS NOT NULL AND coalesce(a.research->>'signalOnly','false')<>'true'
                  AND coalesce(nullif(btrim(a.body_text),''),nullif(btrim(a.excerpt),'')) IS NOT NULL
                  AND EXISTS(SELECT 1 FROM analyses n WHERE n.article_id=a.id AND n.input_revision=a.revision AND n.relevance='pass')) AS "briefEligible"
              FROM research_members m JOIN articles a ON a.id=m.article_id LEFT JOIN publications p ON p.article_id=a.id
              WHERE m.run_id=${entry.runId} AND m.article_id=${entry.articleId} AND m.admitted`;
            if (!checkpoint) throw new Error("Visited historical queue member is missing; preserve its checkpoint");
            const held = checkpoint.state === "pass" && !checkpoint.error && checkpoint.briefEligible && !checkpoint.hasCurrentBrief
              ? Boolean(await articleRequestHold(entry.articleId)) : false;
            return { ...checkpoint, held };
          });
          if (recovery) {
            plan.cursor = recovery.to; (plan.cursorRecoveries ??= []).push(recovery); await persist();
            console.log(JSON.stringify({ event: "backfill-cursor-recovered", ...recovery }));
          }
        }
        plan.status = options.mode === "collect" ? "collected" : "processing"; await persist();
        if (options.mode !== "collect") while (plan.cursor < queue.length && await hasBudget()) {
          shutdownSignal.signal.throwIfAborted(); await assertResearchRequestsIdle();
          const entry = queue[plan.cursor]!; process.env.RESEARCH_RUN_ID = entry.runId;
          const [member] = await sql<({ article_id: string; state: string } & Pick<BackfillDatedCandidate, "arxivId" | "announcedOn" | "originalPublishedAt">)[]>`
            SELECT m.article_id,m.state,a.research->>'arxivId' AS "arxivId",a.research->>'announcedOn' AS "announcedOn",
              a.research->>'originalPublishedAt' AS "originalPublishedAt" FROM research_members m JOIN articles a ON a.id=m.article_id
            WHERE m.run_id=${entry.runId} AND m.article_id=${entry.articleId} AND m.admitted`;
          if (!member) throw new Error("Frozen historical queue member is missing");
          if (backfillReaderDate(member) !== entry.sortDate) throw new Error("Historical candidate reader date changed after queue audit; preserve its cursor for inspection");
          const outcome = await visitBackfillArticle(checkedBudget => processIsolatedResearchArticles(entry.runId, [member], { process: processArticle,
            extract: articleId => extractArticleBody(articleId, false), brief: generateResearchBrief, hasBudget: checkedBudget }),
            hasBudget, error => error instanceof BudgetExceededError);
          if (outcome === "budget-stopped") break;
          await publishArticle(entry.articleId); plan.cursor++; await persist();
        }
        await assertResearchRequestsIdle();
        const summaries = [];
        for (const window of plan.windows) summaries.push({ runId: window.runId, ...await researchRunMetrics(window.runId) });
        const current = await getModelRun(plan.budgetId);
        plan.status = options.mode === "collect" ? "collected" : summaries.some(summary => summary.gaps.length > 0) || plan.cursor < queue.length ? "partial" : "complete";
        plan.summary = { sharedCallsUsed: current?.callsUsed, callCeiling: plan.callCeiling, invocationCallCeiling, queue: queue.length, visited: plan.cursor, windows: summaries };
        delete plan.error; await persist();
        console.log(JSON.stringify({ event: "backfill-end", status: plan.status, month: plan.month, sharedCallsUsed: current?.callsUsed,
          callCeiling: plan.callCeiling, invocationCallCeiling, queue: queue.length, visited: plan.cursor,
          windows: summaries.map(({ runId, metrics }) => ({ runId, stored: metrics.stored, admitted: metrics.admitted, processed: metrics.processed,
            pending: metrics.pending, failed: metrics.failed, unknown: metrics.unknownOutcome, selected: metrics.selected, sourcesSucceeded: metrics.sourcesSucceeded })) }));
      } catch (error) {
        plan.status = "stopped"; plan.error = String(error).replace(/postgres(?:ql)?:\/\/[^\s"']+/g, "[database redacted]").slice(0, 1600); await persist();
        console.log(JSON.stringify({ event: "backfill-end", status: "stopped", month: plan.month, visited: plan.cursor, callCeiling: plan.callCeiling, invocationCallCeiling })); throw error;
      }
    }, assertNoProjectProducer(root)));
  } finally { process.off("SIGINT", interrupted); process.off("SIGTERM", interrupted); await stopBoss(); await closeDb(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main().catch(error => { console.error((error instanceof Error ? error.message : "Historical review stopped").replace(/postgres(?:ql)?:\/\/[^\s"']+/g, "[database redacted]")); process.exitCode = 1; });
}
