// Opt-in local scheduler; normal web/API startup never executes this file.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { startClock, takeDue, type ScheduleClock, type ScheduledJob } from "./scheduler-clock.ts";

const root = path.resolve(import.meta.dirname, "..");
const dir = path.join(root, ".data/local");
const checkpoint = path.join(dir, "scheduler.json");
interface State { version: 1; status: string; clock: ScheduleClock; pending: ScheduledJob[]; active: (ScheduledJob & { startedAt: string; pid?: number }) | null; updatedAt: string }
function read<T>(file: string): T | null { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } }
function save(file: string, value: unknown) { const temp = `${file}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); renameSync(temp, file); }
function receipt(value: Record<string, unknown>) { appendFileSync(path.join(dir, "scheduler-receipts.jsonl"), JSON.stringify({ observedAt: new Date().toISOString(), ...value }) + "\n", { mode: 0o600 }); }

async function collectOnce(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("Invalid source-check receipt ID");
  process.env.MODEL_CALLS_ENABLED = "false";
  process.env.RESEARCH_ADMISSION_ENABLED = "true";
  delete process.env.MODEL_RUN_ID;
  const [{ collectSource }, { closeDb }, { stopBoss }] = await Promise.all([
    import("@aihot/backend/sources/collect"), import("@aihot/backend/db"), import("@aihot/backend/jobs/queue"),
  ]);
  const pack = JSON.parse(readFileSync(path.join(root, "industry/sources.json"), "utf8")) as { sources: Array<{ id: string }> };
  if (pack.sources.length !== 6) throw new Error("Expected the six-source research pack");
  const startedAt = new Date().toISOString();
  const results: Array<{ sourceId: string; status: string; found?: number; created?: number; revised?: number; error?: string }> = [];
  try {
    for (const source of pack.sources) {
      try { results.push(await collectSource(source.id, { force: true })); }
      catch (error) { results.push({ sourceId: source.id, status: "failed", error: String(error).slice(0, 1000) }); }
      save(path.join(dir, `source-check-${id}.json`), { id, startedAt, updatedAt: new Date().toISOString(), modelCallsEnabled: false, planned: 6, results });
    }
    const failed = results.filter(result => result.status === "failed" || result.status === "skipped").length;
    console.log(JSON.stringify({ id, sources: results.length, failed, modelCalls: 0 }));
    if (failed) process.exitCode = 1;
  } finally { await stopBoss(); await closeDb(); }
}

async function schedule() {
  const old = read<State>(checkpoint);
  const nowArg = process.argv.indexOf("--now");
  const now = nowArg >= 0 ? new Date(process.argv[nowArg + 1]!) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid --now timestamp");
  if (process.argv.includes("--once")) {
    console.log(JSON.stringify({ mode: "preview-only", modelCalls: 0, sourceRequests: 0, clock: startClock(now, old?.clock), skippedHistoricalJobs: (old?.pending.length ?? 0) + (old?.active ? 1 : 0) }));
    return;
  }
  if (nowArg >= 0) throw new Error("--now is only permitted with the read-only --once preview");
  mkdirSync(dir, { recursive: true });
  const guard = path.join(dir, "scheduler.guard");
  const stamp = (pid: number) => spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).stdout?.trim() ?? "";
  if (existsSync(guard)) {
    const owner = read<{ pid: number; stamp: string }>(guard);
    if ((owner && owner.stamp && stamp(owner.pid) === owner.stamp) || (!owner && Date.now() - statSync(guard).mtimeMs < 5000)) throw new Error("A project scheduler is already running or starting");
    rmSync(guard, { force: true });
  }
  writeFileSync(guard, JSON.stringify({ pid: process.pid, stamp: stamp(process.pid) }), { flag: "wx", mode: 0o600 });
  const state: State = { version: 1, status: "running", clock: startClock(now, old?.clock), pending: [], active: null, updatedAt: now.toISOString() };
  if (old?.active) receipt({ job: old.active, status: "interrupted-unknown", note: "Previous process ended with an active job; inspect source/model receipts. No automatic replay." });
  for (const job of old?.pending ?? []) receipt({ job, status: "skipped-on-start", note: "Startup does not replay historical jobs." });
  const persist = () => { state.updatedAt = new Date().toISOString(); save(checkpoint, state); };
  let stopping = false;
  let child: ChildProcess | null = null;
  let wake: (() => void) | null = null;
  const wait = (ms: number) => new Promise<void>(resolve => { const timer = setTimeout(() => { wake = null; resolve(); }, ms); wake = () => { clearTimeout(timer); wake = null; resolve(); }; });
  const shutdown = () => { stopping = true; wake?.(); child?.kill("SIGTERM"); };
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
  persist();
  console.log(JSON.stringify({ scheduler: "started", ...state.clock, startupCatchup: false }));
  try {
    while (!stopping) {
      const due = takeDue(state.clock, new Date()); state.clock = due.clock;
      for (const job of due.jobs) if (!state.pending.some(p => p.id === job.id)) state.pending.push(job);
      state.pending.sort((a, b) => a.dueAt.localeCompare(b.dueAt) || (a.kind === "daily" ? -1 : 1));
      persist();
      const job = state.pending.shift();
      if (!job) { await wait(Math.min(30_000, Math.max(100, Math.min(Date.parse(state.clock.nextDailyAt), Date.parse(state.clock.nextSourcesAt)) - Date.now()))); continue; }
      state.active = { ...job, startedAt: new Date().toISOString() }; persist();
      const args = job.kind === "daily" ? ["daily", job.date] : ["check-sources", job.id];
      child = spawn(process.execPath, [path.join(root, "scripts/local.ts"), ...args], { cwd: root, env: process.env, stdio: "inherit" });
      state.active.pid = child.pid; persist();
      const result = await new Promise<{ code: number | null; signal: string | null; error?: string }>(resolve => {
        child!.once("error", error => resolve({ code: null, signal: null, error: error.message }));
        child!.once("exit", (code, signal) => resolve({ code, signal }));
      });
      child = null;
      const status = result.code === 0 ? "complete" : result.code === 75 ? "deferred-busy" : result.signal ? "interrupted" : "failed";
      receipt({ job: state.active, status, ...result });
      if (result.code === 75 && !stopping) state.pending.unshift(job); // confirmed no submission: another owned batch held the lock.
      state.active = null; persist();
      if (result.code === 75 && !stopping) await wait(30_000);
    }
  } finally {
    state.status = "stopped"; persist();
    process.off("SIGTERM", shutdown); process.off("SIGINT", shutdown);
    if (read<{ pid: number }>(guard)?.pid === process.pid) rmSync(guard, { force: true });
  }
}
if (process.argv[2] === "--collect-once") { mkdirSync(dir, { recursive: true }); await collectOnce(process.argv[3] ?? ""); }
else await schedule();
