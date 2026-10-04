import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { addDays, beijingDate, dailyWindow, isValidDate } from "@aihot/contracts/time";

export const STAGES = ["database", "readers", "generate", "export", "publish"] as const;
export type Stage = typeof STAGES[number];
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
  siteBase: string;
  repo: string;
  status: "running" | "complete" | "failed";
  updatedAt: string;
  stages: Partial<Record<Stage, StageReceipt>>;
  inspection?: DailyInspection;
}
export interface DeliveryOptions {
  now?: Date;
  date?: string;
  resume?: boolean;
  refreshPublic?: boolean;
  siteBase: string;
  repo: string;
}
export interface DeliveryDependencies {
  stateDir: string;
  now(): Date;
  assertIdle(): Promise<void>;
  inspect(runId: string): Promise<DailyInspection>;
  execute(stage: Stage, date: string): Promise<void>;
  log(value: { date: string; stage?: Stage; status: string }): void;
}

/** Only the most recently closed 08:00 Beijing window; never iterates missed dates. */
export function dueDaily(now: Date = new Date()): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid clock");
  const today = beijingDate(now);
  return dailyWindow(today).end <= now ? today : addDays(today, -1);
}
export function deliveryDate(value: string | undefined, now: Date): string {
  const date = value ?? dueDaily(now);
  if (!isValidDate(date)) throw new Error("Invalid daily date; expected YYYY-MM-DD");
  if (dailyWindow(date).end > now) throw new Error("The requested daily window has not closed at 08:00 Beijing");
  return date;
}
export async function saveJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, file);
}
export async function readReceipt(stateDir: string, date: string): Promise<DeliveryReceipt | null> {
  try {
    const value = JSON.parse(await readFile(path.join(stateDir, `${date}.json`), "utf8")) as DeliveryReceipt;
    if (value.version !== 1 || value.date !== date || value.runId !== `daily-${date}` || !value.stages) throw new Error("Invalid delivery receipt");
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

export async function deliverDaily(options: DeliveryOptions, deps: DeliveryDependencies): Promise<DeliveryReceipt> {
  const date = deliveryDate(options.date, options.now ?? deps.now());
  return withDeliveryLock(deps.stateDir, async () => {
    const previous = await readReceipt(deps.stateDir, date);
    if (previous && (previous.repo !== options.repo || previous.siteBase !== options.siteBase)) throw new Error("Frozen delivery destination differs from this request");
    if (previous?.status === "complete" && !options.refreshPublic) {
      deps.log({ date, status: "already-delivered" }); return previous;
    }
    if (previous && previous.status !== "complete" && !options.resume) throw new Error("An unfinished delivery exists. Inspect its receipts, then use --resume with the same date.");
    if (options.refreshPublic && previous?.stages.generate?.status !== "complete") throw new Error("--refresh-public requires an already completed generation stage");
    const window = dailyWindow(date);
    const receipt: DeliveryReceipt = previous ?? {
      version: 1, date, runId: `daily-${date}`, windowStart: window.start.toISOString(), windowEnd: window.end.toISOString(),
      siteBase: options.siteBase, repo: options.repo, status: "running", updatedAt: deps.now().toISOString(), stages: {},
    };
    if (options.refreshPublic) { delete receipt.stages.export; delete receipt.stages.publish; }
    const persist = async () => { receipt.updatedAt = deps.now().toISOString(); await saveJson(path.join(deps.stateDir, `${date}.json`), receipt); };
    receipt.status = "running";
    await persist();
    let stage: Stage = "database";
    try {
      await deps.assertIdle();
      for (stage of STAGES) {
        // Reader processes and the database may have stopped since the last attempt.
        if (stage !== "database" && stage !== "readers" && receipt.stages[stage]?.status === "complete") continue;
        receipt.stages[stage] = { status: "running", startedAt: deps.now().toISOString(), attempts: (receipt.stages[stage]?.attempts ?? 0) + 1 };
        await persist(); deps.log({ date, stage, status: "running" });
        if (stage === "generate") {
          await deps.assertIdle();
          receipt.inspection = await deps.inspect(receipt.runId);
          if (receipt.inspection.executionBusy || receipt.inspection.pendingRequests > 0) throw new Error("Model requests are still running or unresolved pending; inspect existing receipts before recovery");
          if (receipt.inspection.report) receipt.stages.generate!.reused = true;
          else {
            // Same run ID, same frozen admission/budget. UNKNOWN receipts remain held by the backend.
            await deps.execute(stage, date);
            receipt.inspection = await deps.inspect(receipt.runId);
          }
          if (!receipt.inspection.report) throw new Error("Generation returned without a persisted daily report");
          if (receipt.inspection.executionBusy || receipt.inspection.pendingRequests > 0) throw new Error("Generation still has a model request in flight; publication was held");
        } else await deps.execute(stage, date);
        receipt.stages[stage]!.status = "complete";
        receipt.stages[stage]!.endedAt = deps.now().toISOString();
        await persist(); deps.log({ date, stage, status: "complete" });
      }
      receipt.status = "complete"; await persist(); deps.log({ date, status: "complete" }); return receipt;
    } catch (error) {
      receipt.status = "failed";
      const current = receipt.stages[stage];
      if (current?.status === "running") { current.status = "failed"; current.endedAt = deps.now().toISOString(); current.error = "Stage failed; see its local private log. No subsequent stage ran."; }
      await persist(); deps.log({ date, stage, status: "failed" }); throw error;
    }
  });
}
