import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { addDays, beijingDate, dailyWindow, isValidDate } from "@aihot/contracts/time";
import type { ReviewPolicy } from "@aihot/contracts/review-schedule";
export type { ReviewPolicy };

export const STAGES = ["database", "readers", "generate", "export", "publish", "verify"] as const;
export type Stage = typeof STAGES[number];
/** User/process cancellation is a checkpoint, never an instruction to immediately retry. */
export class DeliveryInterruptedError extends Error {}
/** A public-stage error known to be safe to retry against the same frozen export. */
export class PublicStageRetryableError extends Error {}
/** A public-stage error that must remain held for inspection or explicit operator action. */
export class PublicStageFatalError extends Error {}
const PUBLIC_STAGES = ["export", "publish", "verify"] as const;
export type PublicStage = typeof PUBLIC_STAGES[number];
export interface DailyInspection {
  executionBusy: boolean;
  pendingRequests: number;
  unknownRequests: number;
  callsUsed: number;
  report: null | { status: "complete" | "partial"; published: number; gaps: number; revision: number };
}
export interface StageReceipt {
  status: "running" | "complete" | "failed";
  startedAt: string;
  endedAt?: string;
  attempts: number;
  error?: string;
  reused?: boolean;
}
export interface DeliveryReceipt {
  version: 1;
  date: string;
  runId: string;
  windowStart: string;
  windowEnd: string;
  collectionCutoff?: string;
  siteBase: string;
  repo: string;
  status: "running" | "complete" | "failed";
  updatedAt: string;
  stages: Partial<Record<Stage, StageReceipt>>;
  reviewPolicy?: ReviewPolicy;
  inspection?: DailyInspection;
  publicRecoveryCount?: number;
  /** Earliest time an automatic public retry may be claimed. It is persisted in the same receipt. */
  publicNextRetryAt?: string;
  publicRetryStage?: PublicStage;
  publicRecoveries?: Array<{
    startedAt: string;
    mode: "automatic" | "manual";
    stage: PublicStage;
    priorStatus: DeliveryReceipt["status"];
    priorStage: StageReceipt | null;
  }>;
}
export interface DeliveryOptions {
  now?: Date;
  date?: string;
  resume?: boolean;
  refreshPublic?: boolean;
  refreshSlot?: string;
  autoRecoverPublic?: boolean;
  reviewPolicy?: ReviewPolicy;
  siteBase: string;
  repo: string;
}
export interface DeliveryDependencies {
  stateDir: string;
  now(): Date;
  assertIdle(): Promise<void>;
  inspect(runId: string): Promise<DailyInspection>;
  execute(stage: Stage, date: string, windowEnd: string, reviewPolicy?: ReviewPolicy, collectionCutoff?: string): Promise<void>;
  prepareEditions?(date: string, windowEnd: string): Promise<void>;
  log(value: { date: string; stage?: Stage; status: string }): void;
  /** Unknown, validation, security, and credential failures must return "hold". */
  classifyPublicError?(error: unknown, stage: PublicStage): "retry" | "hold";
}

/** Only the most recently closed 09:00 Beijing window; never iterates missed dates. */
export function dueDaily(now: Date = new Date()): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid clock");
  const today = beijingDate(now);
  return dailyWindow(today).end <= now ? today : addDays(today, -1);
}
export function deliveryDate(value: string | undefined, now: Date): string {
  const date = value ?? dueDaily(now);
  if (!isValidDate(date)) throw new Error("Invalid daily date; expected YYYY-MM-DD");
  if (dailyWindow(date).end > now) throw new Error("The requested daily window has not closed at 09:00 Beijing");
  return date;
}
/** A stable three-hour observation slot; actual cutoff is frozen in its receipt. */
export function currentRefreshSlot(now: Date = new Date()): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid clock");
  const hour = new Date(now.getTime() + 8 * 3600000).getUTCHours();
  return `${beijingDate(now)}-${String(Math.floor(hour / 3) * 3).padStart(2, "0")}`;
}
/** Current scheduled review only; before 09:00 does not catch up yesterday's edition. */
export function currentReviewSlot(now: Date = new Date(), policy: ReviewPolicy = "three-times-daily"): string | null {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid clock");
  const hour = new Date(now.getTime() + 8 * 3600000).getUTCHours();
  return hour < 9 ? null : `${beijingDate(now)}-${hour >= 21 ? "21" : hour >= 15 && policy === "three-times-daily" ? "15" : "09"}`;
}
export function validateRefreshSlot(slot: string, now: Date): string {
  const match = /^(\d{4}-\d{2}-\d{2})-(00|03|06|09|12|15|18|21)(?:-r1)?$/.exec(slot);
  if (!match || !isValidDate(match[1]!) || slot.replace(/-r1$/, "") > currentRefreshSlot(now)) throw new Error("Invalid or future refresh slot");
  return slot;
}
export async function saveJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, file);
}
export async function readReceipt(stateDir: string, date: string): Promise<DeliveryReceipt | null> {
  try {
    const value = JSON.parse(await readFile(path.join(stateDir, `${date}.json`), "utf8")) as DeliveryReceipt;
    if (value.version !== 1 || value.date !== date || value.runId !== (/^\d{4}-\d{2}-\d{2}-\d{2}(?:-r1)?$/.test(date) ? `refresh-${date}` : `daily-${date}`) || !value.stages) throw new Error("Invalid delivery receipt");
    if (value.publicRecoveryCount !== undefined && (!Number.isSafeInteger(value.publicRecoveryCount) || value.publicRecoveryCount < 0)
      || value.publicNextRetryAt !== undefined && !Number.isFinite(Date.parse(value.publicNextRetryAt))
      || value.publicRetryStage !== undefined && !(PUBLIC_STAGES as readonly string[]).includes(value.publicRetryStage)
      || value.publicRecoveries !== undefined && !Array.isArray(value.publicRecoveries)) throw new Error("Invalid public recovery receipt");
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** An atomic project-wide lock also protects the one shared static export directory. */
export async function withDeliveryLock<T>(stateDir: string, action: () => Promise<T>, owner = { pid: process.pid, token: randomUUID() }): Promise<T> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lock = path.join(stateDir, "active.lock");
  let handle;
  try { handle = await open(lock, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error("Daily delivery is locked; inspect the owning process before --recover-lock. No new batch was started.");
  }
  try {
    await handle.writeFile(JSON.stringify({ ...owner, startedAt: new Date().toISOString() }));
    await handle.close();
    return await action();
  } finally {
    await handle.close();
    // A lock is removed only by its exact token owner, never by an unrelated completion.
    const current = JSON.parse(await readFile(lock, "utf8"));
    if (current.token === owner.token) await rm(lock);
  }
}

/** Explicit recovery archives a lock only after the process is certainly gone. */
export async function recoverDeliveryLock(stateDir: string, alive: (pid: number) => boolean): Promise<void> {
  const lock = path.join(stateDir, "active.lock");
  let owner: { pid: number; token: string };
  try { owner = JSON.parse(await readFile(lock, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("Unreadable delivery lock; preserve it for inspection"); }
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 2 || !owner.token) throw new Error("Invalid delivery lock; preserve it for inspection");
  if (alive(owner.pid)) throw new Error("The delivery owner is still alive; its lock was retained");
  // Serialize recovery attempts without ever deleting a concurrent recovery claim.
  const recovery = await open(`${lock}.recovery`, "wx", 0o600);
  try {
    const original = await stat(lock);
    const checked = JSON.parse(await readFile(lock, "utf8"));
    if (checked.token !== owner.token || alive(checked.pid) || (await stat(lock)).ino !== original.ino) throw new Error("Delivery lock changed during recovery");
    await rename(lock, path.join(stateDir, `abandoned-${Date.now()}-${randomUUID()}.json`));
  } finally { await recovery.close(); await rm(`${lock}.recovery`); }
}

/** A receipt interrupted before its next public stage started is recoverable too. */
function unfinishedPublicStage(receipt: DeliveryReceipt): PublicStage | null {
  if (STAGES.slice(0, 3).some(stage => receipt.stages[stage]?.status !== "complete")) return null;
  return PUBLIC_STAGES.find(stage => receipt.stages[stage]?.status !== "complete") ?? null;
}

function publicRecoveriesUsed(receipt: DeliveryReceipt): number {
  // Older receipts had no recovery counter. Repeated public-stage attempts already consumed
  // an explicit recovery; upgrading or refreshing the public files must not grant another one.
  return Math.max(receipt.publicRecoveryCount ?? 0, receipt.publicRecoveries?.length ?? 0,
    ...PUBLIC_STAGES.map(stage => Math.max(0, (receipt.stages[stage]?.attempts ?? 1) - 1)));
}

const PUBLIC_RETRY_BASE_MS = 30_000;
const PUBLIC_RETRY_MAX_MS = 30 * 60_000;
function publicRetryDelay(attempt: number): number {
  return Math.min(PUBLIC_RETRY_MAX_MS, PUBLIC_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
}
function defaultPublicErrorDecision(error: unknown): "retry" | "hold" {
  if (error instanceof PublicStageFatalError || error instanceof DeliveryInterruptedError) return "hold";
  if (error instanceof PublicStageRetryableError) return "retry";
  const message = error instanceof Error ? error.message : String(error);
  // A generic error remains retryable for compatibility with injected stage adapters, except
  // for explicit evidence that the generated bytes, destination, credentials, or safety gate
  // are not trustworthy. Those conditions must never be hidden by repeated public pushes.
  if (/invalid|unsafe|security|credential|permission|unauthori[sz]ed|forbidden|mismatch|manifest|audit|unrecognized|refus|destination|approved|integrity|changed during|missing|unknown|malicious/i.test(message)) return "hold";
  return "retry";
}

export async function deliverDaily(options: DeliveryOptions, deps: DeliveryDependencies): Promise<DeliveryReceipt> {
  const clock = options.now ?? deps.now();
  const date = options.refreshSlot ? validateRefreshSlot(options.refreshSlot, clock) : deliveryDate(options.date, clock);
  return withDeliveryLock(deps.stateDir, async () => {
    const previous = await readReceipt(deps.stateDir, date);
    if (!previous && options.reviewPolicy && options.refreshSlot?.replace(/-r1$/, "") !== currentReviewSlot(clock, options.reviewPolicy)) {
      throw new Error(`Only the current ${options.reviewPolicy === "twice-daily" ? "09:00 or 21:00" : "09:00, 15:00 or 21:00"} review may start; no missed-slot catch-up`);
    }
    if (previous && (previous.repo !== options.repo || previous.siteBase !== options.siteBase)) throw new Error("Frozen delivery destination differs from this request");
    if (previous?.status === "complete" && previous.stages.verify?.status === "complete" && !options.refreshPublic) {
      deps.log({ date, status: "already-delivered" }); return previous;
    }
    const publicResume = previous && previous.status !== "complete" ? unfinishedPublicStage(previous) : null;
    if (previous && previous.status !== "complete" && !options.resume && !(options.autoRecoverPublic && publicResume)) throw new Error("An unfinished delivery exists. Inspect its receipts, then use --resume with the same date.");
    if (options.refreshPublic && previous?.stages.generate?.status !== "complete") throw new Error("--refresh-public requires an already completed generation stage");
    if (options.refreshPublic && previous?.status !== "complete") throw new Error("Finish the unfinished delivery with its same-date recovery before --refresh-public");
    const verifyLegacy = previous?.status === "complete" && !options.refreshPublic;
    if (verifyLegacy && (previous.stages.verify || STAGES.slice(0, -1).some(stage => previous.stages[stage]?.status !== "complete"))) throw new Error("Completed delivery has inconsistent stage receipts; preserve it for inspection");
    const window = dailyWindow(date.slice(0, 10));
    const receipt: DeliveryReceipt = previous ?? {
      version: 1, date, runId: options.refreshSlot ? `refresh-${date}` : `daily-${date}`, windowStart: window.start.toISOString(), windowEnd: options.refreshSlot && !options.reviewPolicy ? clock.toISOString() : window.end.toISOString(),
      collectionCutoff: clock.toISOString(),
      siteBase: options.siteBase, repo: options.repo, status: "running", updatedAt: deps.now().toISOString(), stages: {},
      ...(options.reviewPolicy ? { reviewPolicy: options.reviewPolicy } : {}),
    };
    const persist = async () => { receipt.updatedAt = deps.now().toISOString(); await saveJson(path.join(deps.stateDir, `${date}.json`), receipt); };
    const assertPublicReady = async () => {
      await deps.assertIdle();
      const inspection = await deps.inspect(receipt.runId);
      if (inspection.executionBusy || inspection.pendingRequests > 0) throw new Error("Model requests are still running or unresolved pending; public recovery was held");
      if (!inspection.report || !receipt.inspection?.report || inspection.report.revision !== receipt.inspection.report.revision) throw new Error("Persisted report is missing or its revision differs from the completed generation; public recovery was held");
      receipt.inspection = inspection;
    };
    const recoverPublic = async (stage: PublicStage, mode: "automatic" | "manual") => {
      const next = receipt.publicNextRetryAt ? Date.parse(receipt.publicNextRetryAt) : NaN;
      if (mode === "automatic" && Number.isFinite(next) && deps.now().getTime() < next) {
        throw new Error(`Public retry backoff is active until ${receipt.publicNextRetryAt}; the same receipt will be retried later`);
      }
      await assertPublicReady();
      const priorStage = receipt.stages[stage];
      const recoveryCount = publicRecoveriesUsed(receipt);
      (receipt.publicRecoveries ??= []).push({ startedAt: deps.now().toISOString(), mode, stage,
        priorStatus: receipt.status, priorStage: priorStage ? { ...priorStage } : null });
      receipt.publicRecoveryCount = recoveryCount + 1;
      receipt.publicNextRetryAt = undefined;
      receipt.publicRetryStage = undefined;
      receipt.status = "running";
      // Claim before executing it, so interruption cannot grant a fresh retry without a receipt.
      await persist();
      deps.log({ date, stage, status: `recovering-${mode}` });
    };
    let firstStage: Stage = publicResume ?? (verifyLegacy ? "verify" : options.refreshPublic ? "export" : "database");
    if (publicResume) await recoverPublic(publicResume, options.resume ? "manual" : "automatic");
    else if (verifyLegacy || options.refreshPublic) await assertPublicReady();
    receipt.publicRecoveryCount = publicRecoveriesUsed(receipt);
    if (options.refreshPublic) for (const stage of PUBLIC_STAGES) delete receipt.stages[stage];
    receipt.status = "running";
    await persist();
    while (true) {
      let stage: Stage = firstStage;
      try {
        await deps.assertIdle();
        for (stage of STAGES.slice(STAGES.indexOf(firstStage))) {
          // Infrastructure is revisited only for an explicit pre-public-stage resume.
          if (stage !== "database" && stage !== "readers" && receipt.stages[stage]?.status === "complete") continue;
          receipt.stages[stage] = { status: "running", startedAt: deps.now().toISOString(), attempts: (receipt.stages[stage]?.attempts ?? 0) + 1 };
          await persist(); deps.log({ date, stage, status: "running" });
          if (stage === "generate") {
            await deps.assertIdle();
            receipt.inspection = await deps.inspect(receipt.runId);
            if (receipt.inspection.executionBusy || receipt.inspection.pendingRequests > 0) throw new Error("Model requests are still running or unresolved pending; inspect existing receipts before recovery");
            if (receipt.inspection.report) receipt.stages.generate!.reused = true;
            else {
              // UNKNOWN subjects are quarantined by research-run; unrelated unsubmitted work may
              // proceed under the same frozen admission/budget. In-flight requests still stop above.
              await deps.execute(stage, date, receipt.windowEnd, receipt.reviewPolicy, receipt.collectionCutoff);
              receipt.inspection = await deps.inspect(receipt.runId);
            }
            if (!receipt.inspection.report) throw new Error("Generation returned without a persisted daily report");
            if (receipt.inspection.executionBusy || receipt.inspection.pendingRequests > 0) throw new Error("Generation still has a model request in flight; publication was held");
            // This stays inside the same project delivery lock and generation checkpoint. A
            // resumed daily report still needs any unfinished due weekly/monthly edition.
            if (receipt.reviewPolicy) {
              if (!deps.prepareEditions) throw new Error("Scheduled review delivery requires the due-edition stage");
              await deps.prepareEditions(date, receipt.windowEnd);
            }
          } else await deps.execute(stage, date, receipt.windowEnd, receipt.reviewPolicy, receipt.collectionCutoff);
          receipt.stages[stage]!.status = "complete";
          receipt.stages[stage]!.endedAt = deps.now().toISOString();
          await persist(); deps.log({ date, stage, status: "complete" });
        }
        receipt.status = "complete"; await persist(); deps.log({ date, status: "complete" }); return receipt;
      } catch (error) {
        receipt.status = "failed";
        const current = receipt.stages[stage];
        if (current?.status === "running") { current.status = "failed"; current.endedAt = deps.now().toISOString(); current.error = "Stage failed; see its local private log. No subsequent stage ran before this checkpoint."; }
        await persist(); deps.log({ date, stage, status: "failed" });
        const recoverable = unfinishedPublicStage(receipt);
        if (error instanceof DeliveryInterruptedError || !options.autoRecoverPublic || recoverable !== stage) throw error;
        const decision = deps.classifyPublicError?.(error, recoverable) ?? defaultPublicErrorDecision(error);
        if (decision !== "retry") throw error;
        // A single automatic continuation is attempted in this invocation. Further transient public
        // failures persist their stage and exponential backoff in the same receipt; later heartbeats
        // continue that receipt without rerunning generation or collection.
        if (publicRecoveriesUsed(receipt) > 0) {
          const delay = publicRetryDelay(publicRecoveriesUsed(receipt));
          receipt.publicNextRetryAt = new Date(deps.now().getTime() + delay).toISOString();
          receipt.publicRetryStage = recoverable;
          await persist();
          throw error;
        }
        await recoverPublic(recoverable, "automatic");
        firstStage = recoverable;
      }
    }
  });
}
