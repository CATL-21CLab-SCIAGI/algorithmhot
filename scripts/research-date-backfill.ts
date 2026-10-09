// Explicit Oct 05–07 recollection. The fixed campaign is an allowance, never a call target.
import { mkdir, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseEnv } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dailyWindow, isValidDate } from "@aihot/contracts/time";
import { DATE_BACKFILL_CAMPAIGN, DATE_BACKFILL_DATES, dateBackfillRunId } from "@aihot/contracts/date-backfill";
import type { ResearchModelProfile } from "@aihot/contracts/research-model";
import type { ResearchMetadata } from "@aihot/contracts/research";
import { saveJson, withDeliveryLock } from "./daily-delivery/core.ts";
import { visitBackfillArticle, withBackfillBatchLock } from "./research-backfill.ts";

const SOURCE_IDS = ["research-arxiv-ml-ai", "research-arxiv-molecular", "research-arxiv-physical-science", "research-hf-daily-papers", "rss-bair", "rss-google-deepmind"];
const LIMITS = { maxCalls: 600, reportReserve: 20, callCeiling: 580 } as const;
export interface DateBackfillOptions { run: boolean; collectOnly: boolean; resume: boolean }
interface SourceSnapshot { id: string; kind: string; sha256: string }
export interface DateBackfillCandidate {
  articleId: string; canonicalKey: string; sourceId: string; sourceDate: string;
}
export interface DateBackfillSourceRow {
  articleId: string; canonicalKey: string; sourceId: string; arxivId: string | null;
  originalPublishedAt: string | null; publishedAt: string | null; signalOnly?: boolean;
}
export interface DateBackfillReport {
  revision: number; runId: string | null; contentHash: string;
}
interface ReportCheckpoint {
  state: "prepared" | "saved"; expectedRevision: number; previousHash: string | null;
  saved?: DateBackfillReport;
}
export interface DateBackfillWindow {
  date: string; runId: string; budgetId: string; start: string; end: string;
  maxCalls: number; reportReserve: number; callCeiling: number;
  collected: boolean; frozen: boolean; cursor: number; callsObserved: number;
  queue?: DateBackfillCandidate[]; queueHash?: string; figureScope?: "edition"; figureMetrics?: Record<string, number>;
  projection?: { updatedAt: string; refreshedIds: string[]; considered: number };
  release?: { checkedAt: string; waitedMs: number; checks: number }; heatAfter?: unknown;
  report?: ReportCheckpoint; summary?: Record<string, unknown>;
}
export interface DateBackfillPlan {
  version: 1; campaign: string; createdAt: string; updatedAt: string; maxCalls: 1800;
  sourceDatePolicy: "original-publication-09-to-09-v1";
  status: "planned" | "collecting" | "collected" | "processing" | "partial" | "complete" | "stopped";
  model: ResearchModelProfile; sources: SourceSnapshot[]; publicationBaseline: string[];
  windows: DateBackfillWindow[]; heatBefore?: unknown; heatAfter?: unknown; error?: string;
}

export function dateBackfillOptions(args: string[]): DateBackfillOptions {
  if (new Set(args).size !== args.length || args.some(arg => !["--run", "--status", "--collect-only", "--resume"].includes(arg))
      || args.includes("--run") && args.includes("--status")
      || !args.includes("--run") && args.some(arg => ["--collect-only", "--resume"].includes(arg))) {
    throw new Error("Default is read-only status. Use --run [--collect-only] [--resume]; campaign, dates and allowances cannot be changed");
  }
  return { run: args.includes("--run"), collectOnly: args.includes("--collect-only"), resume: args.includes("--resume") };
}

/** Service throttles remain resumable stops; they cannot close a date's independent allowance. */
export function isDateBackfillBudgetStop(service: string, budgetId: string): boolean {
  return service === `model-run:${budgetId}`;
}

export interface DateBackfillProjectionCandidate {
  articleId: string; publicEligible: boolean; currentPass: boolean; signalOnly: boolean; inRun: boolean; linkedHf: boolean;
}
/** Refresh source metadata only on already public, currently reviewed papers in this campaign's scope. */
export function dateBackfillProjectionIds(rows: DateBackfillProjectionCandidate[]): string[] {
  return [...new Set(rows.filter(row => row.articleId && row.publicEligible && row.currentPass && !row.signalOnly && (row.inRun || row.linkedHf))
    .map(row => row.articleId))].sort();
}

export interface DateBackfillReleaseState { at: string; pending: { articleId: string; visibleAfter: string | null }[] }
/** Wait for the real database release gate, without backdating publications or finalizing an incomplete issue. */
export async function waitDateBackfillRelease(io: {
  read(): Promise<DateBackfillReleaseState>; wait(ms: number, signal: AbortSignal): Promise<unknown>; signal: AbortSignal;
  now?(): number; waiting?(pending: number, waitMs: number): void;
}, maxWaitMs = 240_000): Promise<{ checkedAt: string; waitedMs: number; checks: number }> {
  if (!Number.isFinite(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > 300_000) throw new Error("Historical publication wait must be bounded to at most five minutes");
  const clock = io.now ?? Date.now, started = clock(); let checks = 0;
  while (true) {
    io.signal.throwIfAborted();
    const state = await io.read(), at = Date.parse(state.at); checks++; io.signal.throwIfAborted();
    if (!Number.isFinite(at)) throw new Error("Cannot establish the database release clock");
    const releaseTimes = state.pending.map(row => row.visibleAfter ? Date.parse(row.visibleAfter) : NaN);
    if (releaseTimes.some(time => !Number.isFinite(time))) throw new Error("A selected historical paper has an unknown release gate; preserve the unfinished issue");
    const remaining = Math.max(0, ...releaseTimes.map(time => time - at));
    if (!remaining) return { checkedAt: state.at, waitedMs: Math.max(0, clock() - started), checks };
    const allowance = maxWaitMs - Math.max(0, clock() - started);
    if (allowance <= 0 || remaining > allowance) throw new Error("Historical publication release exceeds the bounded wait; resume after the gate opens, without resetting its report checkpoint");
    const waitMs = Math.min(30_000, remaining + 50, allowance);
    io.waiting?.(state.pending.length, waitMs); await io.wait(waitMs, io.signal);
  }
}

/** Object key order from PostgreSQL JSONB must not change a frozen snapshot's identity. */
export function dateBackfillHash(value: unknown): string {
  const ordered = (input: unknown): unknown => Array.isArray(input) ? input.map(ordered)
    : input && typeof input === "object" ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)])) : input;
  return createHash("sha256").update(JSON.stringify(ordered(value))).digest("hex");
}

export function newDateBackfillPlan(model: ResearchModelProfile, sources: SourceSnapshot[], publicationBaseline: string[] = [], now = new Date()): DateBackfillPlan {
  if (!Number.isFinite(now.getTime()) || DATE_BACKFILL_DATES.some(date => dailyWindow(date).end > now)) throw new Error("All authorized historical daily windows must be closed");
  if (model.transport !== "codex_cli") throw new Error("Date recollection requires the frozen Codex subscription route; no paid API fallback");
  if (dateBackfillHash(sources.map(source => source.id).sort()) !== dateBackfillHash(SOURCE_IDS)) throw new Error("Date recollection requires exactly the six registered research sources");
  return { version: 1, campaign: DATE_BACKFILL_CAMPAIGN, createdAt: now.toISOString(), updatedAt: now.toISOString(), maxCalls: 1800,
    sourceDatePolicy: "original-publication-09-to-09-v1", status: "planned", model, sources: [...sources].sort((a, b) => a.id.localeCompare(b.id)),
    publicationBaseline: [...new Set(publicationBaseline)].sort(), windows: DATE_BACKFILL_DATES.map(date => {
      const { start, end } = dailyWindow(date), runId = dateBackfillRunId(date);
      return { date, runId, budgetId: runId, start: start.toISOString(), end: end.toISOString(), ...LIMITS,
        collected: false, frozen: false, cursor: 0, callsObserved: 0 };
    }) };
}

export function originalDateBackfillTime(row: Pick<DateBackfillSourceRow, "arxivId" | "originalPublishedAt" | "publishedAt">): string | null {
  const value = row.arxivId ? row.originalPublishedAt : row.publishedAt;
  if (!value || !isValidDate(value.slice(0, 10)) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

/** Recheck every admitted row; never shrink the admission denominator to conceal a date mismatch. */
export function dateBackfillQueue(rows: DateBackfillSourceRow[], window: Pick<DateBackfillWindow, "start" | "end">): DateBackfillCandidate[] {
  const seen = new Set<string>();
  return rows.map(row => {
    const sourceDate = originalDateBackfillTime(row);
    if (!sourceDate || sourceDate < window.start || sourceDate >= window.end || row.signalOnly
        || !SOURCE_IDS.includes(row.sourceId) || row.sourceId === "research-hf-daily-papers") {
      throw new Error(`Admitted historical identity ${row.articleId} does not match its original publication window; preserve all observations`);
    }
    if (!row.articleId || !row.canonicalKey || seen.has(row.canonicalKey)) throw new Error("Historical admissions contain a missing or repeated canonical identity");
    seen.add(row.canonicalKey);
    return { articleId: row.articleId, canonicalKey: row.canonicalKey, sourceId: row.sourceId, sourceDate };
  }).sort((a, b) => b.sourceDate.localeCompare(a.sourceDate) || a.canonicalKey.localeCompare(b.canonicalKey) || a.articleId.localeCompare(b.articleId));
}

export function validateDateBackfillPlan(value: unknown): DateBackfillPlan {
  const plan = value as DateBackfillPlan;
  if (!plan || plan.version !== 1 || plan.campaign !== DATE_BACKFILL_CAMPAIGN || plan.maxCalls !== 1800
      || plan.sourceDatePolicy !== "original-publication-09-to-09-v1" || !Array.isArray(plan.sources) || !Array.isArray(plan.publicationBaseline)
      || !plan.model || !Array.isArray(plan.windows) || plan.windows.length !== DATE_BACKFILL_DATES.length) throw new Error("Invalid fixed date recollection plan");
  const reference = newDateBackfillPlan(plan.model, plan.sources, plan.publicationBaseline, new Date(plan.createdAt));
  for (const [index, window] of plan.windows.entries()) {
    const expected = reference.windows[index]!;
    for (const field of ["date", "runId", "budgetId", "start", "end", "maxCalls", "reportReserve", "callCeiling"] as const) {
      if (window[field] !== expected[field]) throw new Error("Frozen date, window or model allowance changed; no replacement campaign is permitted");
    }
    if (typeof window.collected !== "boolean" || typeof window.frozen !== "boolean" || window.frozen && !window.collected
        || !Number.isInteger(window.cursor) || window.cursor < 0 || !Number.isInteger(window.callsObserved) || window.callsObserved < 0 || window.callsObserved > 600
        || window.queue && (!window.frozen || !Array.isArray(window.queue) || window.cursor > window.queue.length
          || dateBackfillHash(window.queue) !== window.queueHash || new Set(window.queue.map(row => row.canonicalKey)).size !== window.queue.length
          || window.queue.some(row => !row.articleId || !row.canonicalKey || !SOURCE_IDS.includes(row.sourceId) || row.sourceDate < window.start || row.sourceDate >= window.end))
        || !window.queue && (window.cursor !== 0 || window.queueHash !== undefined)) throw new Error("Invalid historical queue or budget checkpoint");
  }
  return plan;
}

/** Persist the expected revision before composing. A crash after DB commit is recognized once. */
export async function ensureDateBackfillReport(window: DateBackfillWindow, io: {
  read(): Promise<DateBackfillReport | null>; persist(): Promise<void>; compose(): Promise<unknown>;
  finish?(): Promise<void>;
}): Promise<"saved" | "reused"> {
  let current = await io.read();
  if (!window.report) {
    if (current?.runId === window.runId) throw new Error("Campaign report exists without its prepare checkpoint; preserve it for inspection");
    window.report = { state: "prepared", expectedRevision: current?.revision ?? 0, previousHash: current?.contentHash ?? null };
    await io.persist();
  }
  const checkpoint = window.report;
  if (checkpoint.state === "saved") {
    if (!current || dateBackfillHash(current) !== dateBackfillHash(checkpoint.saved)) throw new Error("Saved campaign report changed after its checkpoint");
    await io.finish?.();
    return "reused";
  }
  if (current?.runId === window.runId && current.revision === checkpoint.expectedRevision + 1) {
    window.report = { ...checkpoint, state: "saved", saved: current }; await io.persist(); await io.finish?.(); return "reused";
  }
  if ((current?.revision ?? 0) !== checkpoint.expectedRevision || (current?.contentHash ?? null) !== checkpoint.previousHash) {
    throw new Error("Daily report changed after prepare; do not overwrite a concurrent revision");
  }
  await io.compose(); current = await io.read();
  if (!current || current.runId !== window.runId || current.revision !== checkpoint.expectedRevision + 1) throw new Error("Composed daily report did not bind the exact new run and expected revision");
  window.report = { ...checkpoint, state: "saved", saved: current }; await io.persist(); await io.finish?.(); return "saved";
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "Date recollection stopped").replace(/postgres(?:ql)?:\/\/[^\s"']+/g, "[database redacted]").slice(0, 1000);
}
async function readPlan(file: string): Promise<DateBackfillPlan | null> {
  try { return validateDateBackfillPlan(JSON.parse(await readFile(file, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = dateBackfillOptions(args), root = path.resolve(import.meta.dirname, ".."), now = new Date();
  if (existsSync(path.join(root, ".env"))) for (const [key, value] of Object.entries(parseEnv(readFileSync(path.join(root, ".env"), "utf8")))) process.env[key] ??= value;
  const directory = path.join(process.env.AIHOT_DATA_DIR ?? path.join(root, ".data"), "research-date-backfills", DATE_BACKFILL_CAMPAIGN);
  const file = path.join(directory, "plan.json");
  if (!options.run) {
    const plan = await readPlan(file);
    console.log(JSON.stringify({ event: "date-backfill-status", campaign: DATE_BACKFILL_CAMPAIGN, state: plan?.status ?? "not-started", maxCalls: 1800,
      checkpointAt: plan?.updatedAt ?? null, dates: plan?.windows.map(({ date, runId, start, end, cursor, queue, callsObserved, summary, report }) =>
        ({ date, runId, start, end, queued: queue?.length ?? null, cursor, callsObserved, summary, report }))
        ?? DATE_BACKFILL_DATES.map(date => ({ date, runId: dateBackfillRunId(date), start: dailyWindow(date).start.toISOString(), end: dailyWindow(date).end.toISOString(), ...LIMITS })),
      note: "Read-only saved checkpoints; no database, source request or model call was started" }));
    return;
  }
  Object.assign(process.env, { COLLECT_ENABLED: "true", MODEL_CALLS_ENABLED: options.collectOnly ? "false" : "true", RESEARCH_ADMISSION_ENABLED: "true",
    RESEARCH_REQUEST_ISOLATION: "true", MODEL_RUN_MAX_CALLS: "600", MODEL_RUN_REPORT_RESERVE: "20", MODEL_RUN_CALL_CEILING: "580",
    FEISHU_CONTENT_PUSH_ENABLED: "false", INDEXNOW_SUBMIT_ENABLED: "false" });
  const [{ sql, closeDb }, { createResearchRun, collectResearchRun }, { freezeAdmissions, researchRunMetrics },
    { ensureModelRun, getModelRun }, { selectedResearchModel, researchModelForRun }, { assertResearchRequestsIdle, processIsolatedResearchArticles },
    { processArticle }, { extractArticleBody }, { generateResearchBrief }, { publishArticle }, { BudgetExceededError },
    { researchEditionCandidates, researchSourceInWindow, selectIllustratedResearch, composeResearchDailyDate }, { getResearchPaperFigure, ensureResearchPaperFigure }, { loadResearchHeat },
    { stopBoss }, { shutdownSignal }, { assertNoProjectProducer }] = await Promise.all([
    import("@aihot/backend/db"), import("@aihot/backend/research/collect"), import("@aihot/backend/research/admission"),
    import("@aihot/backend/providers/model-runs"), import("@aihot/backend/providers/research-model"), import("@aihot/backend/research/request-isolation"),
    import("@aihot/backend/jobs/content"), import("@aihot/backend/content/extract"), import("@aihot/backend/research/brief"), import("@aihot/backend/publication/publish"),
    import("@aihot/backend/providers/receipts"), import("@aihot/backend/reports/compose"), import("@aihot/backend/research/figures"), import("@aihot/backend/publication/research-heat"),
    import("@aihot/backend/jobs/queue"), import("@aihot/backend/lib/shutdown"), import("./research-backfill.ts"),
  ]);
  const readSources = async (): Promise<SourceSnapshot[]> => {
    const sources = await sql<{ id: string; kind: string; config: unknown; participation_mode: string; first_party: boolean }[]>`
      SELECT id,kind,config,participation_mode,first_party FROM sources WHERE id=ANY(${SOURCE_IDS}) ORDER BY id`;
    return sources.map(source => ({ id: source.id, kind: source.kind, sha256: dateBackfillHash(source) }));
  };
  const interrupted = () => shutdownSignal.abort(); process.on("SIGINT", interrupted); process.on("SIGTERM", interrupted);
  try {
    await withDeliveryLock(path.join(root, ".data/daily-delivery"), async () => withBackfillBatchLock(path.join(root, ".data/local"), async () => {
      await assertResearchRequestsIdle();
      let plan = await readPlan(file);
      if (!plan) {
        if (options.resume) throw new Error("--resume requires the original saved date recollection plan");
        const ids = DATE_BACKFILL_DATES.map(date => dateBackfillRunId(date));
        const existing = await sql`SELECT id FROM research_runs WHERE id=ANY(${ids}) UNION SELECT id FROM model_runs WHERE id=ANY(${ids})`;
        if (existing.length) throw new Error("Fixed campaign already has database state without a local plan; preserve it instead of resetting checkpoints");
        const model = await selectedResearchModel(); if (!model) throw new Error("A registered Codex subscription profile is required before date recollection");
        const baseline = await sql<{ id: string }[]>`SELECT article_id AS id FROM publications WHERE visibility='public' AND eligible ORDER BY article_id`;
        plan = newDateBackfillPlan(model, await readSources(), baseline.map(row => row.id), now);
        await mkdir(directory, { recursive: true, mode: 0o700 }); await saveJson(file, plan);
      }
      const frozen = plan;
      const persist = async () => { frozen.updatedAt = new Date().toISOString(); await saveJson(file, frozen); };
      const unchangedSources = async () => { if (dateBackfillHash(await readSources()) !== dateBackfillHash(frozen.sources)) throw new Error("Research source configuration changed after campaign freeze"); };
      try {
        await unchangedSources();
        if (!frozen.heatBefore) { frozen.heatBefore = await loadResearchHeat(new Date(frozen.createdAt)); await persist(); }
        // Freeze all three run/model snapshots before the first collection or model request.
        for (const window of frozen.windows) {
          const budget = await ensureModelRun({ id: window.budgetId, maxCalls: 600, reportReserve: 20 });
          if (budget.callsUsed < window.callsObserved || budget.callsUsed > 600) throw new Error("Campaign model ledger moved backwards or exceeded its frozen ceiling");
          const run = await createResearchRun(window.runId, "pilot", new Date(frozen.createdAt),
            { start: new Date(window.start), end: new Date(window.end), observedAt: new Date(frozen.createdAt) },
            { admissionPolicy: "all-in-window", modelCallCeiling: 580, modelBudgetId: window.budgetId });
          if (run.kind !== "pilot" || run.model_budget_id !== window.budgetId || run.model_call_ceiling !== 580 || run.admission_policy !== "all-in-window"
              || run.window_start.toISOString() !== window.start || run.window_end.toISOString() !== window.end
              || run.collection_cutoff.toISOString() !== frozen.createdAt || dateBackfillHash(await researchModelForRun(window.runId)) !== dateBackfillHash(frozen.model)) {
            throw new Error("Historical run differs from its frozen dates, source policy or Codex model snapshot");
          }
          window.callsObserved = budget.callsUsed;
        }
        await persist();
        const readRows = async (runId: string): Promise<DateBackfillSourceRow[]> => sql<DateBackfillSourceRow[]>`
          SELECT m.article_id AS "articleId",coalesce(a.research->>'canonicalKey',a.identity_key) AS "canonicalKey",m.source_id AS "sourceId",
            a.research->>'arxivId' AS "arxivId",a.research->>'originalPublishedAt' AS "originalPublishedAt",
            to_char(a.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "publishedAt",m.signal_only AS "signalOnly"
          FROM research_members m JOIN articles a ON a.id=m.article_id WHERE m.run_id=${runId} AND m.admitted`;
        for (const window of frozen.windows) {
          shutdownSignal.signal.throwIfAborted(); await assertResearchRequestsIdle(); await unchangedSources();
          process.env.RESEARCH_RUN_ID = window.runId; process.env.MODEL_RUN_ID = window.budgetId;
          if (!window.collected) { frozen.status = "collecting"; await persist(); await collectResearchRun(window.runId, { sourceIds: SOURCE_IDS }); window.collected = true; await persist(); }
          if (!window.frozen) { await freezeAdmissions(window.runId); window.frozen = true; await persist(); }
          if (!window.queue) { window.queue = dateBackfillQueue(await readRows(window.runId), window); window.queueHash = dateBackfillHash(window.queue); await persist(); }
        }
        frozen.status = options.collectOnly ? "collected" : "processing"; await persist();
        for (const window of frozen.windows) {
          process.env.RESEARCH_RUN_ID = window.runId; process.env.MODEL_RUN_ID = window.budgetId;
          const hasBudget = async () => {
            const budget = await getModelRun(window.budgetId);
            if (!budget || budget.maxCalls !== 600 || budget.reportReserve !== 20 || budget.callsUsed < window.callsObserved || budget.callsUsed > 600) throw new Error("Fixed campaign budget ledger is inconsistent");
            window.callsObserved = budget.callsUsed;
            return budget.callsUsed < 580 && budget.remaining > budget.reportReserve;
          };
          if (!options.collectOnly && window.report?.state !== "saved") while (window.cursor < window.queue!.length) {
            shutdownSignal.signal.throwIfAborted(); await assertResearchRequestsIdle();
            if (!(await hasBudget())) break;
            const entry = window.queue![window.cursor]!;
            const current = (await readRows(window.runId)).find(row => row.articleId === entry.articleId);
            if (!current || dateBackfillHash(dateBackfillQueue([current], window)[0]) !== dateBackfillHash(entry)) throw new Error("Original publication identity changed after queue freeze; preserve the cursor");
            const [member] = await sql<{ article_id: string; state: string }[]>`SELECT article_id,state FROM research_members WHERE run_id=${window.runId} AND article_id=${entry.articleId} AND admitted`;
            if (!member) throw new Error("Frozen campaign member disappeared");
            const result = await visitBackfillArticle(checkedBudget => processIsolatedResearchArticles(window.runId, [member], { process: processArticle,
              extract: articleId => extractArticleBody(articleId, false), brief: generateResearchBrief, hasBudget: checkedBudget }), hasBudget,
              error => error instanceof BudgetExceededError && isDateBackfillBudgetStop(error.service, window.budgetId));
            const remaining = await hasBudget();
            if (result === "budget-stopped") {
              if (remaining) throw new Error("Campaign budget stop disagrees with its recorded calls; preserve this resumable cursor");
              await persist(); break;
            }
            await publishArticle(entry.articleId); window.cursor++; await persist();
          }
          await assertResearchRequestsIdle();
          if (!options.collectOnly) {
            // HF rows are separate signal identities. Rebuild related public paper projections even
            // when their model queue was budget-deferred or their original date is outside this issue.
            const related = await sql<DateBackfillProjectionCandidate[]>`
              SELECT p.article_id AS "articleId",(p.visibility='public' AND p.eligible) AS "publicEligible",
                EXISTS(SELECT 1 FROM analyses n WHERE n.article_id=a.id AND n.input_revision=a.revision AND n.relevance='pass') AS "currentPass",
                coalesce(a.research->>'signalOnly','false')='true' AS "signalOnly",
                EXISTS(SELECT 1 FROM research_members m WHERE m.run_id=${window.runId} AND m.article_id=a.id) AS "inRun",
                EXISTS(SELECT 1 FROM research_members hm JOIN articles signal ON signal.id=hm.article_id
                  WHERE hm.run_id=ANY(${frozen.windows.map(item => item.runId)}) AND hm.source_id='research-hf-daily-papers'
                    AND hm.signal_only AND signal.research->>'canonicalKey'=a.research->>'canonicalKey') AS "linkedHf"
              FROM publications p JOIN articles a ON a.id=p.article_id WHERE a.research IS NOT NULL
                AND p.visibility='public' AND p.eligible AND (
                  EXISTS(SELECT 1 FROM research_members m WHERE m.run_id=${window.runId} AND m.article_id=a.id)
                  OR EXISTS(SELECT 1 FROM research_members hm JOIN articles signal ON signal.id=hm.article_id
                    WHERE hm.run_id=ANY(${frozen.windows.map(item => item.runId)}) AND hm.source_id='research-hf-daily-papers'
                      AND hm.signal_only AND signal.research->>'canonicalKey'=a.research->>'canonicalKey'))`;
            const refreshedIds = dateBackfillProjectionIds(related);
            for (const articleId of refreshedIds) { shutdownSignal.signal.throwIfAborted(); await publishArticle(articleId); }
            window.projection = { updatedAt: new Date().toISOString(), refreshedIds, considered: related.length }; await persist();
            window.release = await waitDateBackfillRelease({ signal: shutdownSignal.signal,
              wait: (ms, signal) => sleep(ms, undefined, { signal }),
              waiting: (pending, waitMs) => console.log(JSON.stringify({ event: "date-backfill-release-wait", date: window.date, pending, waitMs })),
              read: async () => {
                const [{ at }] = await sql<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
                const pending = await sql<{ articleId: string; visibleAfter: Date | null; publishedAt: Date | null; research: ResearchMetadata | null }[]>`
                  SELECT article_id AS "articleId",visible_after AS "visibleAfter",published_at AS "publishedAt",research FROM publications
                  WHERE visibility='public' AND eligible AND selected AND research_brief IS NOT NULL
                    AND (visible_after IS NULL OR visible_after>${at})`;
                return { at: at.toISOString(), pending: pending.filter(row => researchSourceInWindow(
                  { research: row.research, publishedAt: row.publishedAt?.toISOString() ?? "" }, new Date(window.start), new Date(window.end)))
                  .map(row => ({ articleId: row.articleId, visibleAfter: row.visibleAfter?.toISOString() ?? null })) };
              },
            }); await persist();
            if (!window.figureMetrics) {
              const admitted = new Set(window.queue!.map(entry => entry.articleId));
              const candidates = await researchEditionCandidates(window.date, window.date, dailyWindow(window.date));
              const selected = await selectIllustratedResearch(candidates, 5, async entry => {
                shutdownSignal.signal.throwIfAborted();
                const input = { itemId: entry.itemId, sourceRevision: entry.researchBrief!.sourceRevision };
                return await getResearchPaperFigure(input) ?? ensureResearchPaperFigure({ ...input, arxivId: entry.research?.arxivId,
                  arxivVersion: entry.research?.arxivVersion, title: entry.originalTitle ?? undefined });
              });
              shutdownSignal.signal.throwIfAborted();
              window.figureScope = "edition";
              window.figureMetrics = { ...selected.metrics, sourceRunCandidates: candidates.filter(entry => admitted.has(entry.itemId)).length,
                outsideRunCandidates: candidates.filter(entry => !admitted.has(entry.itemId)).length,
                outsideRunReused: selected.sections.flatMap(section => section.items).filter(entry => !admitted.has(entry.itemId)).length };
              await persist();
            }
            await ensureDateBackfillReport(window, { persist,
              read: async () => {
                const [report] = await sql<{ revision: number; content: { run?: { id?: string } } }[]>`SELECT revision,content FROM reports WHERE kind='daily' AND key=${window.date}`;
                return report ? { revision: report.revision, runId: report.content.run?.id ?? null, contentHash: dateBackfillHash(report.content) } : null;
              }, compose: () => composeResearchDailyDate(window.date, { revise: true, sourceRunId: window.runId, expectedRevision: window.report!.expectedRevision }),
              // Repair a crash after report commit but before its source-run update, including on reuse.
              finish: async () => { await sql`UPDATE research_runs SET report_key=${window.date},status='partial',updated_at=now() WHERE id=${window.runId}`; },
            });
            window.heatAfter = await loadResearchHeat(); await persist();
          }
          const ledger = await researchRunMetrics(window.runId), budget = await getModelRun(window.budgetId);
          window.callsObserved = budget?.callsUsed ?? window.callsObserved;
          const observations = await sql`SELECT m.article_id,m.source_id,m.in_window,m.signal_only,m.admitted,m.admission_rank,m.state,m.error,
              a.identity_key,a.research->>'arxivId' AS arxiv_id,a.research->>'originalPublishedAt' AS original_published_at,a.published_at,
              p.visibility,p.eligible,p.selected,(p.research_brief IS NOT NULL) AS brief_ready
            FROM research_members m JOIN articles a ON a.id=m.article_id LEFT JOIN publications p ON p.article_id=a.id
            WHERE m.run_id=${window.runId} ORDER BY m.source_id,m.article_id`;
          const fetches = await sql`SELECT * FROM research_fetches WHERE run_id=${window.runId} ORDER BY source_id,url,attempt_number,id`;
          const publicRows = observations.filter(row => row.visibility === "public" && row.eligible), initial = new Set(frozen.publicationBaseline);
          const sourceCoverage = frozen.sources.map(source => ({ sourceId: source.id, snapshotSha256: source.sha256,
            historicalCompleteness: "UNKNOWN", basis: source.id.startsWith("research-arxiv-") ? "Official submittedDate API, bounded 50 x 100 pages; raw responses and truncation retained"
              : source.id === "research-hf-daily-papers" ? "Daily community signal pages; original publication dates remain independent" : "Current RSS snapshot cannot establish complete historical coverage" }));
          window.summary = { ...ledger, queued: window.queue!.length, visited: window.cursor, notVisited: window.queue!.length - window.cursor,
            budgetDeferred: !options.collectOnly && window.callsObserved >= window.callCeiling ? window.queue!.length - window.cursor : 0,
            callsUsed: window.callsObserved, maxCalls: 600, callCeiling: 580, reportReserve: 20,
            publicReused: publicRows.filter(row => initial.has(row.article_id)).length, publicNew: publicRows.filter(row => !initial.has(row.article_id)).length,
            projection: window.projection ?? null, release: window.release ?? null,
            figureScope: window.figureScope ?? null, figureMetrics: window.figureMetrics ?? null, report: window.report ?? null, historicalCompleteness: "UNKNOWN" };
          await saveJson(path.join(directory, `${window.date}-evidence.json`), { campaign: frozen.campaign, window, ...ledger, sourceCoverage, fetches, observations });
          await persist();
          console.log(JSON.stringify({ event: "date-backfill-window", date: window.date, runId: window.runId, callsUsed: window.callsObserved,
            queued: window.queue!.length, visited: window.cursor, admitted: ledger.metrics.admitted, processed: ledger.metrics.processed,
            failed: ledger.metrics.failed, unknownOutcome: ledger.metrics.unknownOutcome, pending: ledger.metrics.pending, reportRevision: window.report?.saved?.revision ?? null }));
        }
        frozen.heatAfter = await loadResearchHeat();
        await saveJson(path.join(directory, "heat-verification.json"), { campaign: frozen.campaign, basis: "Current public projection only; static-site publication is a separate step",
          before: frozen.heatBefore, after: frozen.heatAfter, beforeSha256: dateBackfillHash(frozen.heatBefore), afterSha256: dateBackfillHash(frozen.heatAfter) });
        // Work can finish with pending candidates and UNKNOWN historical source coverage.
        frozen.status = options.collectOnly ? "collected" : frozen.windows.some(window => window.cursor < window.queue!.length
          || ((window.summary?.gaps as string[] | undefined)?.length ?? 0) > 0) ? "partial" : "complete";
        delete frozen.error; await persist();
        console.log(JSON.stringify({ event: "date-backfill-end", campaign: frozen.campaign, state: frozen.status,
          callsUsed: frozen.windows.reduce((sum, window) => sum + window.callsObserved, 0), maxCalls: 1800, publishedToStaticSite: false }));
      } catch (error) { frozen.status = "stopped"; frozen.error = safeError(error); await persist(); throw error; }
    }, assertNoProjectProducer(root)));
  } finally { process.off("SIGINT", interrupted); process.off("SIGTERM", interrupted); await stopBoss(); await closeDb(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
}
