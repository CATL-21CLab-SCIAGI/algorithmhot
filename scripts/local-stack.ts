// Running the site on this machine without Docker Compose (docs/local-daily.md): the database in a local
// container, api, web and worker as resident processes. The worker schedules everything itself (pg-boss,
// missed slots run once), so a daily task only has to keep the processes up and report.
//
//   node scripts/local-stack.ts up       database ready, migrations, then any process not running is started
//   node scripts/local-stack.ts status   what runs, the last scheduled runs, today's daily; exit 1 on a problem
//   node scripts/local-stack.ts daily    up, then status (what a daily scheduled task runs)
//   node scripts/local-stack.ts down     stop the processes (the worker gets its 210 s to finish a paid call)
//
// Everything is read from .env; nothing here changes code or configuration.
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseEnv } from "node:util";

const ROOT = path.resolve(import.meta.dirname, "..");
const ENV_FILE = path.join(ROOT, ".env");
if (!existsSync(ENV_FILE)) throw new Error(`${ENV_FILE} is missing: copy .env.example and fill it in (docs/local-daily.md)`);
const env: Record<string, string> = { ...(parseEnv(readFileSync(ENV_FILE, "utf8")) as Record<string, string>) };
const STATE = path.join(env.AIHOT_DATA_DIR ? path.resolve(ROOT, env.AIHOT_DATA_DIR) : path.join(ROOT, ".data"), "local");
const LOGS = path.join(STATE, "logs");
const LOG_MAX_BYTES = 20 * 1024 * 1024;

const DB = {
  container: env.LOCAL_DB_CONTAINER || "algorithmhot-db-local",
  volume: env.LOCAL_DB_VOLUME || "algorithmhot-db-local",
  port: env.LOCAL_DB_PORT || "55434",
  image: env.LOCAL_DB_IMAGE || "postgres:17-alpine",
  colima: env.LOCAL_COLIMA_PROFILE || "",
};
const DOCKER = env.LOCAL_DOCKER_BIN || "docker";
const dockerEnv = { ...process.env, ...(env.LOCAL_DOCKER_HOST ? { DOCKER_HOST: env.LOCAL_DOCKER_HOST } : {}) };
const API_PORT = env.API_PORT || "3001";
const WEB_PORT = env.WEB_PORT || "3000";

interface Proc { name: "api" | "web" | "worker"; entry: string; health?: string; extraEnv?: Record<string, string> }
const PROCS: Proc[] = [
  { name: "api", entry: "apps/api/src/main.ts", health: `http://127.0.0.1:${API_PORT}/api/health` },
  { name: "worker", entry: "apps/worker/src/main.ts",
    // The worker's model calls use this machine's HTTP(S) proxy when .env names one (HTTPS_PROXY), like curl.
    extraEnv: env.HTTPS_PROXY ? { NODE_USE_ENV_PROXY: "1" } : {} },
  { name: "web", entry: "apps/web/server.ts", health: `http://127.0.0.1:${WEB_PORT}/` },
];

const docker = (args: string[], opts: { input?: string } = {}) =>
  execFileSync(DOCKER, args, { env: dockerEnv, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts }).trim();

function dockerReady(): boolean {
  try { docker(["info", "--format", "{{.ServerVersion}}"]); return true; } catch { return false; }
}

/** Whether the database in DATABASE_URL answers a query. */
async function databaseAnswers(): Promise<boolean> {
  const { default: postgres } = await import("postgres");
  const db = postgres(env.DATABASE_URL!, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try { await db`SELECT 1`; return true; } catch { return false; } finally { await db.end({ timeout: 2 }); }
}

/**
 * The database ready: when it already answers, Docker is not touched at all (a scheduled task may run
 * where the Docker socket and colima's files are off limits); otherwise its container is started.
 */
async function ensureDatabase(): Promise<void> {
  if (await databaseAnswers()) return;
  if (!dockerReady()) {
    if (!DB.colima) throw new Error("Docker is not reachable (set LOCAL_DOCKER_HOST, or LOCAL_COLIMA_PROFILE to start a colima VM)");
    console.error(`starting colima profile ${DB.colima}`);
    execFileSync(env.LOCAL_COLIMA_BIN || "colima", ["start", DB.colima], { stdio: "inherit" });
    if (!dockerReady()) throw new Error("Docker is still not reachable after starting colima");
  }
  const state = (() => { try { return docker(["inspect", "-f", "{{.State.Running}}", DB.container]); } catch { return "missing"; } })();
  if (state === "missing") {
    if (!env.POSTGRES_PASSWORD) throw new Error("POSTGRES_PASSWORD is not set in .env");
    docker(["run", "-d", "--name", DB.container, "--restart", "unless-stopped", "-e", `POSTGRES_PASSWORD=${env.POSTGRES_PASSWORD}`,
      "-e", "POSTGRES_USER=aihot", "-e", "POSTGRES_DB=aihot", "-v", `${DB.volume}:/var/lib/postgresql/data`, "-p", `127.0.0.1:${DB.port}:5432`, DB.image]);
  } else if (state !== "true") docker(["start", DB.container]);
  for (let i = 0; i < 60; i++) {
    try { docker(["exec", DB.container, "pg_isready", "-U", "aihot", "-d", "aihot"]); return; } catch { await sleep(1000); }
  }
  throw new Error(`database container ${DB.container} did not become ready`);
}

const pidFile = (p: Proc) => path.join(STATE, `${p.name}.pid`);

/** The recorded process, when it is still this site's process (a reused pid running something else is not). */
function running(p: Proc): number | null {
  if (!existsSync(pidFile(p))) return null;
  const { pid } = JSON.parse(readFileSync(pidFile(p), "utf8")) as { pid: number };
  try {
    process.kill(pid, 0);
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return command.includes(p.entry) ? pid : null;
  } catch {
    return null;
  }
}

async function healthy(url: string, tries = 1): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.status < 500) return true;
    } catch { /* not up yet */ }
    if (i < tries - 1) await sleep(1000);
  }
  return false;
}

function logFor(p: Proc): number {
  mkdirSync(LOGS, { recursive: true });
  const file = path.join(LOGS, `${p.name}.log`);
  if (existsSync(file) && statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`);
  return openSync(file, "a");
}

function runNode(script: string): void {
  execFileSync(process.execPath, [script], { cwd: ROOT, env: { ...process.env, ...env }, stdio: "inherit" });
}

async function start(p: Proc): Promise<number> {
  const log = logFor(p);
  const child = spawn(process.execPath, [p.entry], {
    cwd: ROOT, detached: true, stdio: ["ignore", log, log],
    env: { ...process.env, ...env, ...(p.extraEnv ?? {}) },
  });
  closeSync(log);
  child.unref();
  writeFileSync(pidFile(p), JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), entry: p.entry }));
  if (p.health && !(await healthy(p.health, 30))) throw new Error(`${p.name} did not answer ${p.health}; see ${path.join(LOGS, `${p.name}.log`)}`);
  return child.pid!;
}

async function up(): Promise<void> {
  mkdirSync(STATE, { recursive: true });
  await ensureDatabase();
  runNode("scripts/migrate.ts");
  runNode("scripts/seed.ts");
  for (const p of PROCS) {
    const pid = running(p);
    if (pid && (!p.health || (await healthy(p.health, 3)))) continue;
    if (pid) { process.kill(pid, "SIGTERM"); await sleep(2000); }
    console.error(`starting ${p.name}`);
    await start(p);
  }
}

async function down(): Promise<void> {
  for (const p of [...PROCS].reverse()) {
    const pid = running(p);
    if (!pid) { rmSync(pidFile(p), { force: true }); continue; }
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 220 && running(p); i++) await sleep(1000);
    if (running(p)) process.kill(pid, "SIGKILL");
    rmSync(pidFile(p), { force: true });
    console.error(`stopped ${p.name}`);
  }
}

/** Whether the HTTP(S) proxy .env names accepts connections; null when none is named. */
async function proxyReachable(): Promise<boolean | null> {
  if (!env.HTTPS_PROXY) return null;
  const { hostname, port } = new URL(env.HTTPS_PROXY);
  const net = await import("node:net");
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port: Number(port || 80), timeout: 3000 });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}

async function status(): Promise<boolean> {
  const { default: postgres } = await import("postgres");
  const db = postgres(env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  const problems: string[] = [];
  try {
    const processes: Record<string, unknown> = {};
    for (const p of PROCS) {
      const pid = running(p);
      const ok = !!pid && (!p.health || (await healthy(p.health, 2)));
      processes[p.name] = { pid, ok };
      if (!ok) problems.push(`${p.name} is not running`);
    }
    const [{ today, now_time }] = await db<{ today: string; now_time: string }[]>`
      SELECT to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS today, to_char(now() AT TIME ZONE 'Asia/Shanghai', 'HH24:MI') AS now_time`;
    const daily = await db`SELECT key, generated_at, (content->'metrics'->>'totalEvents')::int AS entries FROM reports WHERE kind = 'daily' ORDER BY key DESC LIMIT 3`;
    if (now_time >= "13:00" && daily[0]?.key !== today) problems.push(`daily ${today} is not out yet`);
    const runs = await db`
      SELECT DISTINCT ON (job) job, status, started_at, left(coalesce(error, ''), 200) AS error FROM job_runs
      WHERE job IN ('reports.compose', 'research.arxiv', 'research.journals', 'research.figures', 'sources.schedule', 'content.sweep', 'pages-mirror.publish')
      ORDER BY job, started_at DESC`;
    const sources = await db`SELECT id, health, last_ok_at, left(coalesce(last_error, ''), 160) AS last_error FROM sources WHERE enabled AND health IN ('degraded', 'failing') ORDER BY id`;
    const [modelLedger] = await db`
      SELECT (SELECT count(*)::int FROM receipt_attempts WHERE service = 'llm' AND origin = 'live' AND started_at > now() - interval '1 day') AS used_24h,
             (SELECT per_day FROM budgets WHERE service = 'llm') AS per_day,
             (SELECT count(*)::int FROM receipts WHERE status = 'unknown') AS unknown`;
    const { getBudgetStatus } = await import("@aihot/backend/providers/budgets");
    const modelBudget = await getBudgetStatus("llm", db);
    const model = { ...modelLedger, used_budget_day: modelBudget?.usedDay ?? null, reset_at: modelBudget?.resetAt ?? null };
    const [work] = await db`SELECT count(*) FILTER (WHERE processing_state = 'new')::int AS waiting, count(*) FILTER (WHERE processing_state = 'failed')::int AS failed FROM articles`;
    if (sources.some((s) => s.health === "failing")) problems.push("a source is failing");
    // Model calls in the last hour: many attempts and none answered means the model cannot be reached.
    const [calls] = await db`
      SELECT count(*)::int AS attempts, count(*) FILTER (WHERE status IN ('received', 'completed'))::int AS answered,
             max(left(error, 160)) FILTER (WHERE status = 'failed') AS last_error
      FROM receipt_attempts WHERE service = 'llm' AND started_at > now() - interval '1 hour'`;
    if (calls!.attempts >= 10 && calls!.answered === 0) problems.push(`model calls are failing: ${calls!.last_error ?? "no answer"}`);
    const proxy = await proxyReachable();
    if (proxy === false) problems.push(`the proxy in .env (HTTPS_PROXY ${env.HTTPS_PROXY}) is not reachable: model calls through it fail`);
    console.log(JSON.stringify({ ok: problems.length === 0, problems, now: `${today} ${now_time}`, processes, daily, runs, sources, model, calls, work }, null, 2));
  } finally {
    await db.end();
  }
  return problems.length === 0;
}

const command = process.argv[2];
if (command === "up") await up();
else if (command === "down") await down();
else if (command === "status") process.exitCode = (await status()) ? 0 : 1;
else if (command === "daily") {
  await up();
  // Give a freshly started worker a minute to run what it missed before reporting.
  await sleep(Number(env.LOCAL_DAILY_SETTLE_SECONDS ?? 60) * 1000);
  process.exitCode = (await status()) ? 0 : 1;
} else {
  console.error("usage: node scripts/local-stack.ts up | status | daily | down");
  process.exitCode = 2;
}
