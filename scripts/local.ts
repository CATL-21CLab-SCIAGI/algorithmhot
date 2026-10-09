// Project-owned local lifecycle. Credentials stay in ignored files, never command arguments.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, renameSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { parseEnv } from "node:util";
import { reviewCallCeiling } from "@aihot/contracts/review-schedule";

const root = path.resolve(import.meta.dirname, "..");
const dir = path.join(root, ".data/local");
mkdirSync(dir, { recursive: true });
const envPath = path.join(root, ".env");
const context = "colima-algorithmhot";
const profile = "algorithmhot";
const database = "algorithmhot-db";
const entries = { api: "apps/api/src/main.ts", web: "apps/web/server.ts", scheduler: "scripts/research-scheduler.ts" };
type Service = keyof typeof entries;
interface ProcessRecord { pid: number; entry: string; startedAt: string; runId?: string; port?: number; siteUrl?: string; apiBaseUrl?: string }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const token = () => randomBytes(32).toString("hex");
function json(file: string): any { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } }
function save(file: string, value: unknown) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}
function commandLine(pid: number): string { return spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).stdout?.trim() ?? ""; }
function fingerprint(pid: number): string { return spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).stdout?.trim() ?? ""; }
function run(bin: string, args: string[], vars: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(bin, args, { cwd: root, env: vars, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(bin)} failed (${result.status})`);
}
function env(): NodeJS.ProcessEnv {
  if (!existsSync(envPath)) throw new Error("Run node scripts/local.ts init first.");
  return { ...process.env, ...parseEnv(readFileSync(envPath, "utf8")) };
}
function updateEnv(patch: Record<string, string>) {
  let text = readFileSync(envPath, "utf8");
  for (const [key, value] of Object.entries(patch)) {
    const pattern = new RegExp(`^(?:export\\s+)?${key}=.*$`, "gm");
    text = pattern.test(text) ? text.replace(pattern, `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
  }
  const temp = `${envPath}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 }); renameSync(temp, envPath);
}
function processRecord(name: Service | "batch"): ProcessRecord | null {
  const record = json(path.join(dir, `${name}.process.json`)) as ProcessRecord | null;
  const legacyPid = existsSync(path.join(dir, `${name}.pid`)) ? Number(readFileSync(path.join(dir, `${name}.pid`), "utf8")) : 0;
  const pid = record?.pid ?? legacyPid;
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const entry = name === "batch" ? record?.entry : entries[name];
  if (!entry || ![...Object.values(entries), "scripts/research-run.ts", "scripts/research-editions.ts"].includes(entry)) return null;
  if (!commandLine(pid).includes(path.join(root, entry))) return null;
  if (record?.startedAt && fingerprint(pid) !== record.startedAt) return null;
  return record ?? { pid, entry, startedAt: fingerprint(pid) };
}
function writeProcess(name: Service | "batch", record: ProcessRecord) {
  save(path.join(dir, `${name}.process.json`), record);
  writeFileSync(path.join(dir, `${name}.pid`), String(record.pid), { mode: 0o600 });
}
function clearProcess(name: Service | "batch", pid: number) {
  const recorded = json(path.join(dir, `${name}.process.json`)) as ProcessRecord | null;
  if (!recorded || recorded.pid === pid) {
    rmSync(path.join(dir, `${name}.process.json`), { force: true });
    rmSync(path.join(dir, `${name}.pid`), { force: true });
  }
}
function signalOwned(record: ProcessRecord, signal: NodeJS.Signals) {
  if (!commandLine(record.pid).includes(path.join(root, record.entry))) return;
  if (record.startedAt && fingerprint(record.pid) !== record.startedAt) return;
  const group = Number(spawnSync("ps", ["-p", String(record.pid), "-o", "pgid="], { encoding: "utf8" }).stdout?.trim());
  try { process.kill(group === record.pid ? -record.pid : record.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
async function stop(name: Service | "batch", requiredId?: string) {
  const record = processRecord(name);
  if (!record) { console.log(`${name}: stopped`); return; }
  if (requiredId && record.runId !== requiredId) { console.log(`${name}: ${requiredId} is not active; current ${record.runId ?? record.pid} was not signalled`); return; }
  signalOwned(record, "SIGTERM");
  for (let i = 0; i < 100 && processRecord(name); i++) await sleep(100);
  if (processRecord(name)) throw new Error(`${name} still stopping (${record.pid}); keep its receipt and retry status. No unrelated process was signalled.`);
  clearProcess(name, record.pid);
  console.log(`${name}: stopped ${record.pid}`);
}
async function locked<T>(name: string, action: () => Promise<T>): Promise<T> {
  const lock = path.join(dir, `${name}.lock`);
  const owner = { pid: process.pid, startedAt: fingerprint(process.pid), token: token() };
  try { mkdirSync(lock); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const old = json(path.join(lock, "owner.json"));
    if ((old?.pid && fingerprint(old.pid) === old.startedAt) || (!old && Date.now() - statSync(lock).mtimeMs < 5000)) {
      const busy = new Error(`${name} busy: another project command owns the lock`); Object.assign(busy, { exitCode: 75 }); throw busy;
    }
    // Only stale project lock data is removed; no process is killed to take a lock.
    rmSync(lock, { recursive: true, force: true }); mkdirSync(lock);
  }
  save(path.join(lock, "owner.json"), owner);
  try { return await action(); } finally {
    if (json(path.join(lock, "owner.json"))?.token === owner.token) rmSync(lock, { recursive: true, force: true });
  }
}
function docker(args: string[]) { return spawnSync("docker", ["--context", context, ...args], { cwd: root, encoding: "utf8", timeout: 15_000 }); }
async function healthyDb() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (docker(["exec", database, "pg_isready", "-U", "algorithmhot", "-d", "algorithmhot"]).status === 0) return;
    await sleep(1000);
  }
  throw new Error("Project PostgreSQL is not ready after 45 seconds; inspect its container logs.");
}
async function ensureDb() {
  if (docker(["info", "--format", "{{.ServerVersion}}"]).status !== 0) run("colima", ["start", "--profile", profile, "--cpus", "2", "--memory", "4", "--activate=false"]);
  if (docker(["container", "inspect", database]).status === 0) run("docker", ["--context", context, "start", database]);
  else {
    if (!existsSync(path.join(dir, "postgres.env"))) throw new Error("Missing private postgres.env; run init to derive it from this project's local database URL.");
    const u = new URL(env().DATABASE_URL!);
    if (!["127.0.0.1", "localhost"].includes(u.hostname) || u.username !== "algorithmhot" || u.pathname !== "/algorithmhot") throw new Error("Local db requires this project's algorithmhot database on loopback.");
    const port = u.port || "55432";
    run("docker", ["--context", context, "run", "-d", "--name", database, "--env-file", path.join(dir, "postgres.env"), "-p", `127.0.0.1:${port}:5432`, "-v", "algorithmhot-pg:/var/lib/postgresql/data", "--health-cmd", "pg_isready -U algorithmhot -d algorithmhot", "--health-interval", "2s", "postgres:17-alpine"]);
  }
  await healthyDb();
}
async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once("error", error => (error as NodeJS.ErrnoException).code === "EADDRINUSE" ? resolve(false) : reject(error));
    socket.listen(port, "127.0.0.1", () => socket.close(() => resolve(true)));
  });
}
async function choosePort(preferred: number, reserved: Set<number>): Promise<number> {
  if (!Number.isInteger(preferred) || preferred < 1024 || preferred > 65535) throw new Error("Project ports must be integers from 1024 to 65535.");
  for (let port = preferred; port < preferred + 100 && port < 65536; port++) if (!reserved.has(port) && await portFree(port)) return port;
  throw new Error(`No free project port in the range starting ${preferred}`);
}
async function startService(name: Service, vars: NodeJS.ProcessEnv, port?: number) {
  if (processRecord(name)) { console.log(`${name}: already running`); return; }
  const log = openSync(path.join(dir, `${name}.log`), "a", 0o600);
  const child = spawn(process.execPath, [path.join(root, entries[name])], { cwd: root, env: vars, detached: true, stdio: ["ignore", log, log] });
  closeSync(log);
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  writeProcess(name, { pid: child.pid!, entry: entries[name], startedAt: fingerprint(child.pid!), port, siteUrl: vars.SITE_URL, apiBaseUrl: vars.API_BASE_URL });
  child.unref(); console.log(`${name}: started ${child.pid}`);
}
async function ready(name: Service, url: string) {
  for (let i = 0; i < 60; i++) {
    if (!processRecord(name)) throw new Error(`${name} exited before readiness; inspect .data/local/${name}.log`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await sleep(250);
  }
  throw new Error(`Project endpoint is not ready: ${url}`);
}
async function startReading() {
  await ensureDb();
  const vars = env();
  const api = processRecord("api"), web = processRecord("web");
  const reserved = new Set<number>();
  const apiPort = api?.port ?? (api ? Number(vars.API_PORT || 3101) : await choosePort(Number(vars.API_PORT || 3101), reserved));
  reserved.add(apiPort);
  const webPort = web?.port ?? (web ? Number(vars.WEB_PORT || 3100) : await choosePort(Number(vars.WEB_PORT || 3100), reserved));
  const patch = { API_HOST: "127.0.0.1", WEB_HOST: "127.0.0.1", API_PORT: String(apiPort), WEB_PORT: String(webPort), SITE_URL: `http://127.0.0.1:${webPort}`, API_BASE_URL: `http://127.0.0.1:${apiPort}` };
  const changed = patch.SITE_URL !== vars.SITE_URL || patch.API_BASE_URL !== vars.API_BASE_URL;
  if (changed) { await stop("web"); await stop("api"); }
  updateEnv(patch);
  const readingEnv = { ...env(), NODE_ENV: "production", COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false" };
  await startService("api", readingEnv, apiPort); await ready("api", `${patch.API_BASE_URL}/api/health`);
  await startService("web", readingEnv, webPort); await ready("web", patch.SITE_URL);
  console.log(`Site: ${patch.SITE_URL}; API: ${patch.API_BASE_URL}. Collection and model processing remain off.`);
}
function validId(id: string | undefined): string { if (!id || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("A stable run ID (letters, digits, hyphen, underscore; max 80) is required."); return id; }
async function batch(id: string, entry: string, args: string[], vars: NodeJS.ProcessEnv) {
  return locked("batch", async () => {
    if (processRecord("batch")) throw Object.assign(new Error("batch busy: an owned child is still running"), { exitCode: 75 });
    const child = spawn(process.execPath, [path.join(root, entry), ...args], { cwd: root, env: vars, detached: true, stdio: "inherit" });
    const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const record: ProcessRecord = { pid: child.pid!, entry, startedAt: fingerprint(child.pid!), runId: id };
    writeProcess("batch", record);
    // Keep only an active macOS batch awake; release the assertion when its child exits.
    const awake = process.platform === "darwin" ? spawn("/usr/bin/caffeinate", ["-i", "-w", String(child.pid!)], { stdio: "ignore" }) : null;
    awake?.on("error", () => console.warn("Could not inhibit idle sleep; keep the machine awake for this batch."));
    const startedAt = new Date().toISOString();
    save(path.join(dir, `batch-${id}.json`), { id, pid: child.pid, status: "running", startedAt });
    const interrupt = () => signalOwned(record, "SIGTERM");
    process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
    const result = await exited;
    awake?.kill("SIGTERM");
    process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
    clearProcess("batch", record.pid);
    save(path.join(dir, `batch-${id}.json`), { id, pid: child.pid, startedAt, status: result.code === 0 ? "complete" : result.signal ? "interrupted" : "failed", endedAt: new Date().toISOString(), ...result });
    if (result.code !== 0) throw new Error(`Batch ${id} ended (${result.signal ?? result.code}); inspect its saved model/source receipts before recovery.`);
  });
}
async function main() {
  const command = process.argv[2] ?? "status";
  if (command === "init") {
    if (!existsSync(envPath)) {
      const password = token();
      writeFileSync(envPath, ["SITE_URL=http://127.0.0.1:3100", "API_BASE_URL=http://127.0.0.1:3101", "API_HOST=127.0.0.1", "WEB_HOST=127.0.0.1", "API_PORT=3101", "WEB_PORT=3100", `DATABASE_URL=postgres://algorithmhot:${password}@127.0.0.1:55432/algorithmhot`, `ADMIN_PASSWORD=${token()}`, `SESSION_SECRET=${token()}`, `IMG_PROXY_SIGN_SECRET=${token()}`, "COLLECT_ENABLED=false", "MODEL_CALLS_ENABLED=false", "RESEARCH_ADMISSION_ENABLED=true", "ANALYZE_CONCURRENCY=1", "FEISHU_CONTENT_PUSH_ENABLED=false", "FEISHU_INTERNAL_ENABLED=false", "INDEXNOW_SUBMIT_ENABLED=false", "EMBEDDINGS_ENABLED=false", "LLM_TRANSPORT=codex_cli", "CODEX_BIN=/opt/homebrew/bin/codex", "CODEX_MODEL=gpt-6-astra", "CODEX_REASONING_EFFORT=medium", "LLM_MODEL=gpt-6-astra", "MODEL_RUN_MAX_CALLS=600", "MODEL_RUN_REPORT_RESERVE=20", "AIHOT_ENVIRONMENT=local", "SELECTED_VISIBLE_AFTER_SECONDS=0", "RESEARCH_REPORTS_ENABLED=true", "RESEARCH_ON_DEMAND=true", ""].join("\n"), { mode: 0o600 });
    }
    if (!existsSync(path.join(dir, "postgres.env"))) {
      const u = new URL(env().DATABASE_URL!);
      if (!["127.0.0.1", "localhost"].includes(u.hostname) || u.username !== "algorithmhot" || !u.password) throw new Error("Cannot derive project PostgreSQL credentials from the current DATABASE_URL.");
      writeFileSync(path.join(dir, "postgres.env"), `POSTGRES_USER=algorithmhot\nPOSTGRES_DB=algorithmhot\nPOSTGRES_PASSWORD=${decodeURIComponent(u.password)}\n`, { mode: 0o600 });
    }
    console.log("Private local configuration ready; existing values preserved, credentials not printed.");
  } else if (command === "db") await locked("lifecycle", ensureDb);
  else if (command === "migrate") await locked("batch", async () => {
    if (processRecord("batch") || processRecord("scheduler")) throw new Error("Stop the project batch and scheduler before schema migration; preserved receipts allow recovery.");
    await healthyDb();
    // Rebuild reader connections after DDL so old prepared SELECT * plans cannot survive a new column.
    const reading = !!processRecord("api") || !!processRecord("web");
    if (reading) { await stop("web"); await stop("api"); }
    run(process.execPath, ["scripts/migrate.ts"], env()); run(process.execPath, ["scripts/seed.ts"], env());
    if (reading) await startReading();
  });
  else if (command === "test-db") {
    await healthyDb(); const vars = env(); const url = new URL(vars.DATABASE_URL!); url.pathname = "/algorithmhot_test";
    const probe = docker(["exec", database, "psql", "-U", "algorithmhot", "-tAc", "SELECT 1 FROM pg_database WHERE datname='algorithmhot_test'"]);
    if (probe.status !== 0) throw new Error("Test database probe failed");
    if (probe.stdout.trim() !== "1") run("docker", ["--context", context, "exec", database, "createdb", "-U", "algorithmhot", "algorithmhot_test"]);
    run(process.execPath, ["scripts/migrate.ts"], { ...vars, DATABASE_URL: url.toString() });
    writeFileSync(path.join(dir, "test.env"), `DATABASE_URL=${url}\nCOLLECT_ENABLED=false\nMODEL_CALLS_ENABLED=false\n`, { mode: 0o600 });
    console.log("Isolated test database ready; connection stored in .data/local/test.env.");
  } else if (command === "start") await locked("lifecycle", startReading);
  else if (command === "restart-reading") await locked("lifecycle", async () => { await stop("web"); await stop("api"); await startReading(); });
  else if (command === "scheduler-start") await locked("lifecycle", async () => { await healthyDb(); await startService("scheduler", { ...env(), COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false", MODEL_RUN_ID: "", RESEARCH_ADMISSION_ENABLED: "true" }); });
  else if (command === "scheduler-stop") await stop("scheduler");
  else if (command === "stop-batch") await stop("batch", validId(process.argv[3]));
  else if (command === "stop" || command === "stop-all") await locked("lifecycle", async () => {
    await stop("scheduler"); await stop("batch"); await stop("web"); await stop("api");
    if (command === "stop-all") { if (docker(["container", "inspect", database]).status === 0) run("docker", ["--context", context, "stop", database]); run("colima", ["stop", "--profile", profile]); console.log("Project database/profile stopped; database volume and local data retained."); }
  });
  else if (command === "status") {
    for (const name of [...Object.keys(entries), "batch"] as Array<Service | "batch">) { const r = processRecord(name); console.log(`${name}: ${r ? `running ${r.pid}${r.runId ? ` (${r.runId})` : ""}` : "stopped"}`); }
    const db = docker(["ps", "-a", "--filter", `name=^/${database}$`, "--format", "{{.Names}}: {{.Status}}"]); console.log(db.status === 0 ? db.stdout.trim() || "database: absent" : "database: Docker context unavailable");
    if (existsSync(envPath)) console.log(`Site: ${env().SITE_URL}`);
    const schedule = json(path.join(dir, "scheduler.json")); if (schedule) console.log(JSON.stringify({ schedule: schedule.clock, active: schedule.active ?? null, pending: schedule.pending?.length ?? 0 }));
  } else if (command === "refresh") {
    const slot = process.argv[3];
    const end = process.argv[4];
    if (!slot || !/^\d{4}-\d{2}-\d{2}-(00|03|06|09|12|15|18|21)(?:-r1)?$/.test(slot) || !end || !Number.isFinite(Date.parse(end))) throw new Error("Usage: local.ts refresh YYYY-MM-DD-HH frozen-cutoff-ISO");
    const id = `refresh-${slot}`;
    const review = process.argv[5] === "--review";
    if (process.argv[5] && !review || review && !/^\d{4}-\d{2}-\d{2}-(09|15|21)(?:-r1)?$/.test(slot)) throw new Error("New reviews run only at 09:00, 15:00 and 21:00 Beijing");
    await batch(id, "scripts/research-run.ts", [id, "refresh"], { ...env(), MODEL_RUN_ID: `daily-${slot.slice(0,10)}`, RESEARCH_RUN_ID: id,
      RESEARCH_REFRESH_END: end, MODEL_CALLS_ENABLED: "true", COLLECT_ENABLED: "true", RESEARCH_ADMISSION_ENABLED: "true",
      RESEARCH_ADMISSION_POLICY: review ? "all-in-window" : "legacy-capped", RESEARCH_MODEL_CALL_CEILING: review ? String(reviewCallCeiling(Number(slot.slice(11,13)), slot.endsWith("-r1"))) : "" });
  } else if (command === "editions") {
    const slot = process.argv[3], end = process.argv[4];
    if (!slot || !/^\d{4}-\d{2}-\d{2}-(09|15|21)(?:-r1)?$/.test(slot) || !end || !Number.isFinite(Date.parse(end))) throw new Error("Usage: local.ts editions YYYY-MM-DD-HH frozen-cutoff-ISO");
    await batch(`editions-${slot}`, "scripts/research-editions.ts", ["--due", `--now=${end}`],
      { ...env(), COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false", MODEL_RUN_ID: "", RESEARCH_RUN_ID: "" });
  } else if (command === "run" || command === "daily") {
    const date = process.argv[3];
    if (command === "daily" && (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)) throw new Error("Usage: node scripts/local.ts daily YYYY-MM-DD");
    const id = validId(command === "daily" ? `daily-${date}` : date); const action = command === "daily" ? "all" : process.argv[4] ?? "all";
    const vars = { ...env(), MODEL_RUN_ID: id, MODEL_CALLS_ENABLED: "true", COLLECT_ENABLED: "true", RESEARCH_ADMISSION_ENABLED: "true", ...(command === "daily" ? { RESEARCH_RUN_KIND: "daily", RESEARCH_RUN_DATE: date } : {}) };
    if (action === "status") run(process.execPath, ["scripts/research-run.ts", id, "status"], { ...vars, MODEL_CALLS_ENABLED: "false", COLLECT_ENABLED: "false" });
    else await batch(id, "scripts/research-run.ts", [id, action], vars);
  } else if (command === "check-sources") {
    const id = validId(process.argv[3] ?? `sources-${Date.now()}`);
    await batch(id, "scripts/research-scheduler.ts", ["--collect-once", id], { ...env(), MODEL_CALLS_ENABLED: "false", MODEL_RUN_ID: "", COLLECT_ENABLED: "true", RESEARCH_ADMISSION_ENABLED: "true" });
  } else throw new Error("Commands: init, db, migrate, test-db, start, restart-reading, stop, stop-all, status, run <id> [action], daily YYYY-MM-DD, refresh YYYY-MM-DD-HH frozen-cutoff-ISO, stop-batch <id>, check-sources [id], scheduler-start, scheduler-stop");
}
await main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = Number(error?.exitCode) || 1; });
