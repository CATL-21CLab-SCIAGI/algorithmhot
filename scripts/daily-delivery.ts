// One bounded run, triggered by the Codex heartbeat. This file installs no scheduler or daemon.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, closeSync, readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { deliverDaily, deliveryDate, dueDaily, readReceipt, recoverDeliveryLock, type DailyInspection, type Stage } from "./daily-delivery/core.ts";

const root = path.resolve(import.meta.dirname, "..");
const stateDir = path.join(root, ".data/daily-delivery");
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function privateConfig(): Record<string, string | undefined> {
  const file = path.join(root, ".env");
  if (!existsSync(file)) throw new Error("Project configuration is missing; run local init first");
  return parseEnv(readFileSync(file, "utf8"));
}
export function safeSiteOrigin(value: string | undefined): string {
  const url = new URL(value || "http://127.0.0.1:3100");
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("SITE_URL must be an uncredentialed loopback HTTP origin");
  return url.origin;
}
export function publicDestination(base: string, repo: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("Invalid GitHub repository name");
  const [owner, repository] = repo.split("/");
  const url = new URL(base);
  if (url.protocol !== "https:" || url.hostname !== `${owner.toLowerCase()}.github.io` || url.port || url.username || url.password || url.search || url.hash
    || url.pathname !== `/${repository}/`) throw new Error("STATIC_SITE_BASE must match this repository's GitHub Pages project URL");
  return url.href;
}
async function assertIdle(): Promise<void> {
  if (privateConfig().LLM_TRANSPORT !== "codex_cli") throw new Error("Daily delivery requires the configured Codex subscription route; no API fallback was started");
  for (const name of ["scheduler", "batch"]) {
    try {
      const record = JSON.parse(await readFile(path.join(root, `.data/local/${name}.process.json`), "utf8"));
      if (Number.isSafeInteger(record.pid) && record.pid > 1 && processAlive(record.pid)) {
        const command = spawnSync("ps", ["-p", String(record.pid), "-o", "command="], { encoding: "utf8" }).stdout ?? "";
        if (command.includes(path.join(root, "scripts/"))) throw new Error(`Project ${name} is active; daily delivery did not start a second producer`);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
async function command(args: string[], logFile: string): Promise<void> {
  const output = openSync(logFile, "a", 0o600);
  try {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false" }, stdio: ["ignore", output, output] });
    let interrupted = false;
    const interrupt = () => { interrupted = true; child.kill("SIGTERM"); };
    process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
    try {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      if (interrupted || result.code !== 0) throw new Error(`Daily stage stopped (${result.signal ?? result.code}); inspect the private stage log and preserve the same daily ID`);
    } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); }
  } finally { closeSync(output); }
}
async function inspect(runId: string): Promise<DailyInspection> {
  const child = spawn(process.execPath, ["scripts/daily-delivery/inspect.ts", runId], {
    cwd: root, env: { ...process.env, ...privateConfig(), COLLECT_ENABLED: "false", MODEL_CALLS_ENABLED: "false" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => { output += chunk; if (output.length > 64_000) child.kill("SIGTERM"); });
  child.stderr.resume(); // The probe's error is deliberately generic; never echo a private env or driver exception.
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  if (code !== 0) throw new Error("Could not inspect current model receipts; publication held without new model calls");
  return JSON.parse(output) as DailyInspection;
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const flags = new Set(["--date", "--resume", "--refresh-public", "--status", "--recover-lock", "--help"]);
  let date: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (!flags.has(args[index])) throw new Error(`Unsupported argument: ${args[index]}`);
    if (args[index] === "--date") { date = args[++index]; if (!date) throw new Error("--date requires YYYY-MM-DD"); }
  }
  if (args.includes("--help")) {
    console.log("node scripts/daily-delivery.ts [--date YYYY-MM-DD] [--resume] [--refresh-public] [--status] [--recover-lock]"); return;
  }
  const now = new Date();
  const target = deliveryDate(date, now);
  if (args.includes("--status")) {
    console.log(JSON.stringify({ dueDaily: dueDaily(now), target, receipt: await readReceipt(stateDir, target) }, null, 2)); return;
  }
  if (args.includes("--recover-lock")) {
    await assertIdle();
    await recoverDeliveryLock(stateDir, processAlive);
    console.log("Stale delivery lock archived if present. No generation or publication was started; inspect receipts before --resume."); return;
  }
  const repo = process.env.STATIC_SITE_REPO || "PKUCY2016/algorithmhot";
  const base = publicDestination(process.env.STATIC_SITE_BASE || "https://pkucy2016.github.io/algorithmhot/", repo);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await deliverDaily({ date: target, siteBase: base, repo, resume: args.includes("--resume"), refreshPublic: args.includes("--refresh-public") }, {
    stateDir, now: () => new Date(), assertIdle, inspect,
    log: value => console.log(JSON.stringify(value)),
    execute: async (stage: Stage, runDate: string) => {
      const commands: Record<Stage, () => string[]> = {
        database: () => ["scripts/local.ts", "db"],
        readers: () => ["scripts/local.ts", "start"],
        generate: () => ["scripts/local.ts", "daily", runDate],
        export: () => ["scripts/static-site.ts", "--api", safeSiteOrigin(privateConfig().SITE_URL), "--web", safeSiteOrigin(privateConfig().SITE_URL), "--base", base, "--output", ".data/public-site"],
        publish: () => ["scripts/publish-pages.ts", "--source", ".data/public-site", "--repo", repo],
      };
      await command(commands[stage](), path.join(stateDir, `${runDate}-${stage}.log`));
    },
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main().catch(error => { console.error(error instanceof Error ? error.message : "Daily delivery failed"); process.exitCode = 1; });
}
