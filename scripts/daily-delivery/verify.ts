// Read-only publication verification. No credentials, producer, publish command, or provider is used.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { auditBundle, destination, type ExportManifest } from "../pages-publisher.ts";
import { saveJson } from "./core.ts";

const root = path.resolve(import.meta.dirname, "../..");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type FileEntry = ExportManifest["files"][number];
type Issue = { check: string; code: string; path?: string; httpStatus?: number };
export interface VerificationAttempt {
  number: number; checkedAt: string; status: "PASS" | "WAIT" | "FAIL";
  remoteSha?: string; build?: { id: number; status: string; conclusion: string | null };
  filesChecked: number; filesMatched: number; issues: Issue[];
}
export interface VerificationReceipt {
  version: 1; target: string; repo: string; status: "RUNNING" | "PASS" | "FAIL";
  startedAt: string; checkedAt: string; receiptPath: string;
  revision?: string; publicBaseUrl?: string; generatedAt?: string; manifestSha256?: string;
  report?: { key: string; status: "complete" | "partial"; revision: number };
  counts?: { files: number; html: number; items: number; topics: number; reports: number; excludedDeploymentMarkers: number };
  attempts: VerificationAttempt[]; failure?: string;
}
export interface VerificationOptions {
  target: string; repo: string; source?: string; stateDir?: string; publisherReceiptPath?: string;
  maxAttempts?: number; intervalMs?: number; maxDurationMs?: number;
}
export interface VerificationDependencies {
  fetch: typeof globalThis.fetch;
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
}
interface Plan {
  manifest: ExportManifest; files: FileEntry[]; revision: string;
  report: NonNullable<VerificationReceipt["report"]>; counts: NonNullable<VerificationReceipt["counts"]>;
}
class CheckFailure extends Error {
  readonly issue: Issue;
  readonly terminal: boolean;
  constructor(issue: Issue, terminal = false) { super(issue.code); this.issue = issue; this.terminal = terminal; }
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const validSha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
function targetDate(target: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})(?:-(00|03|06|09|12|15|18|21)(?:-r1)?)?$/.exec(target);
  if (!match || !Number.isFinite(Date.parse(`${match[1]}T00:00:00Z`)) || new Date(`${match[1]}T00:00:00Z`).toISOString().slice(0, 10) !== match[1]) throw new Error("Invalid verification date or slot");
  return match[1];
}
async function planVerification(options: VerificationOptions): Promise<Plan> {
  const source = path.resolve(root, options.source ?? ".data/public-site");
  const manifest = await auditBundle(source, options.repo);
  const manifestBytes = await readFile(path.join(source, "export-manifest.json"));
  // Ensure the bytes read after the audit are the same manifest, even if another export intervened.
  if (JSON.stringify(JSON.parse(manifestBytes.toString("utf8"))) !== JSON.stringify(manifest)) throw new Error("Manifest changed during audit");
  const publisher = record(JSON.parse(await readFile(path.resolve(root, options.publisherReceiptPath ?? ".data/pages-publisher/receipt.json"), "utf8")));
  if (publisher.repo !== options.repo || publisher.branch !== "gh-pages" || publisher.publicBaseUrl !== manifest.publicBaseUrl
    || publisher.exportedAt !== manifest.generatedAt || publisher.state !== "remote-ref-verified" || !validSha(publisher.revision)) throw new Error("Publisher receipt does not match the audited export");
  const snapshotEntry = manifest.files.find(file => file.path === "data/snapshot.json");
  if (!snapshotEntry) throw new Error("Public snapshot missing");
  const snapshotBytes = await readFile(path.join(source, snapshotEntry.path));
  if (snapshotBytes.length !== snapshotEntry.bytes || hash(snapshotBytes) !== snapshotEntry.sha256) throw new Error("Snapshot changed during audit");
  const snapshot = record(JSON.parse(snapshotBytes.toString("utf8")));
  if (snapshot.schemaVersion !== 1 || snapshot.generatedAt !== manifest.generatedAt || snapshot.publicBaseUrl !== manifest.publicBaseUrl
    || !Array.isArray(snapshot.items) || !Array.isArray(snapshot.topics) || !Array.isArray(snapshot.reports)) throw new Error("Snapshot identity does not match export");
  const date = targetDate(options.target), reports = snapshot.reports.map(record);
  const report = reports.find(item => item.kind === "daily" && item.key === date);
  if (!report || (report.status !== "complete" && report.status !== "partial") || !Number.isSafeInteger(report.revision) || Number(report.revision) < 1) throw new Error("Target daily report is missing or invalid");
  const delivery = record(JSON.parse(await readFile(path.join(path.resolve(root, options.stateDir ?? ".data/daily-delivery"), `${options.target}.json`), "utf8")));
  const expectedRun = `${options.target.length > 10 ? "refresh" : "daily"}-${options.target}`;
  const inspectedReport = record(record(delivery.inspection).report);
  if (delivery.version !== 1 || delivery.date !== options.target || delivery.runId !== expectedRun || delivery.repo !== options.repo
    || delivery.siteBase !== manifest.publicBaseUrl || typeof delivery.windowStart !== "string" || typeof delivery.windowEnd !== "string"
    || !Number.isFinite(Date.parse(delivery.windowStart)) || !Number.isFinite(Date.parse(delivery.windowEnd))
    || delivery.windowStart !== report.windowStart || delivery.windowEnd !== report.windowEnd
    || Date.parse(delivery.windowEnd) > Date.parse(manifest.generatedAt)
    || (inspectedReport.revision !== undefined && inspectedReport.revision !== report.revision)) throw new Error("Snapshot does not match the target delivery receipt");
  const required = new Set(["index.html", "hot/index.html", "all/index.html", "topics/index.html", "daily/index.html", "daily/archive/index.html", `daily/${date}/index.html`]);
  for (const item of snapshot.items.map(record)) {
    if (typeof item.category !== "string" || !/^[A-Za-z0-9_-]+$/.test(item.category)) throw new Error("Invalid snapshot category");
    required.add(`category/${item.category}/index.html`); required.add(`all/category/${item.category}/index.html`);
  }
  for (const topic of snapshot.topics.map(record)) {
    if (typeof topic.slug !== "string" || !/^[A-Za-z0-9_-]+$/.test(topic.slug)) throw new Error("Invalid snapshot topic");
    required.add(`topics/${topic.slug}/index.html`);
  }
  for (const item of reports.filter(item => item.kind === "daily")) required.add(`daily/${targetDate(String(item.key))}/index.html`);
  const paths = new Set(manifest.files.map(file => file.path));
  if ([...required].some(file => !paths.has(file))) throw new Error("Required public route missing from audited export");
  // .nojekyll controls the build; it is not a reader-facing asset and Pages may not serve it.
  const files = [{ path: "export-manifest.json", bytes: manifestBytes.length, sha256: hash(manifestBytes) },
    snapshotEntry, ...manifest.files.filter(file => file.path !== ".nojekyll" && file.path !== snapshotEntry.path)];
  return { manifest, files, revision: publisher.revision,
    report: { key: date, status: report.status, revision: Number(report.revision) },
    counts: { files: files.length, html: files.filter(file => file.path.endsWith(".html")).length, items: snapshot.items.length,
      topics: snapshot.topics.length, reports: reports.length, excludedDeploymentMarkers: 1 } };
}

async function readPublic(url: string, limit: number, deps: VerificationDependencies, deadline: number, check: string, file?: string): Promise<Buffer> {
  const remaining = deadline - deps.now().getTime();
  if (remaining <= 0) throw new CheckFailure({ check, code: "DEADLINE", ...(file ? { path: file } : {}) });
  const issue = (code: string, status?: number): Issue => ({ check, code, ...(file ? { path: file } : {}), ...(status ? { httpStatus: status } : {}) });
  try {
    const response = await deps.fetch(url, { method: "GET", redirect: "error", credentials: "omit", cache: "no-store",
      headers: { accept: check === "github" ? "application/vnd.github+json" : "*/*" }, signal: AbortSignal.timeout(Math.max(1, Math.min(15000, remaining))) });
    if (!response.ok) { await response.body?.cancel(); throw new CheckFailure(issue("HTTP_STATUS", response.status), [401, 403].includes(response.status)); }
    const reader = response.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.length;
        if (bytes > limit) { await reader.cancel(); throw new CheckFailure(issue("BODY_TOO_LARGE")); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof CheckFailure) throw error;
    // Never persist network error text, redirect targets, response bodies, or an injected exception.
    throw new CheckFailure(issue("NETWORK_ERROR"));
  }
}
async function githubJson(url: string, deps: VerificationDependencies, deadline: number): Promise<Record<string, unknown>> {
  const bytes = await readPublic(url, 2 * 1024 * 1024, deps, deadline, "github");
  try { return record(JSON.parse(bytes.toString("utf8"))); }
  catch { throw new CheckFailure({ check: "github", code: "INVALID_JSON" }); }
}
async function checkPublication(plan: Plan, options: VerificationOptions, deps: VerificationDependencies, deadline: number, number: number): Promise<VerificationAttempt> {
  const attempt: VerificationAttempt = { number, checkedAt: deps.now().toISOString(), status: "WAIT", filesChecked: 0, filesMatched: 0, issues: [] };
  try {
    const api = `https://api.github.com/repos/${options.repo}`;
    const ref = await githubJson(`${api}/git/ref/heads/gh-pages`, deps, deadline);
    const remote = record(ref.object);
    if (remote.type !== "commit" || !validSha(remote.sha)) throw new CheckFailure({ check: "github", code: "INVALID_REMOTE_REF" });
    attempt.remoteSha = remote.sha;
    if (remote.sha !== plan.revision) throw new CheckFailure({ check: "github", code: "REMOTE_COMMIT_MISMATCH" });
    const runs = await githubJson(`${api}/actions/runs?branch=gh-pages&head_sha=${plan.revision}&per_page=100`, deps, deadline);
    const matching = list(runs.workflow_runs).map(record).filter(run => run.name === "pages build and deployment" && run.head_sha === plan.revision && run.head_branch === "gh-pages")
      .sort((a, b) => Number(b.id) - Number(a.id));
    const build = matching[0];
    if (!build) throw new CheckFailure({ check: "github", code: "PAGES_BUILD_NOT_FOUND" });
    if (!Number.isSafeInteger(build.id) || typeof build.status !== "string" || !["queued", "in_progress", "completed", "waiting", "pending", "requested"].includes(build.status)
      || (build.conclusion !== null && typeof build.conclusion !== "string")) throw new CheckFailure({ check: "github", code: "INVALID_PAGES_BUILD" });
    attempt.build = { id: Number(build.id), status: build.status, conclusion: build.conclusion as string | null };
    if (build.status !== "completed") throw new CheckFailure({ check: "github", code: "PAGES_BUILD_PENDING" });
    if (build.conclusion !== "success") throw new CheckFailure({ check: "github", code: "PAGES_BUILD_FAILED" }, true);
    // All exported HTML (including every pagination route) and public data/assets share one inventory.
    // Verify manifest and snapshot first, then at most four assets at once.
    const verifyFile = async (file: FileEntry): Promise<void> => {
      attempt.filesChecked++;
      try {
        const publicPath = file.path.replace(/(?:^|\/)index\.html$/, match => match.startsWith("/") ? "/" : "");
        const bytes = await readPublic(new URL(publicPath, plan.manifest.publicBaseUrl).href, file.bytes + 1, deps, deadline, "file", file.path);
        if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new CheckFailure({ check: "file", code: "CONTENT_MISMATCH", path: file.path });
        attempt.filesMatched++;
      } catch (error) {
        const failure = error instanceof CheckFailure ? error : new CheckFailure({ check: "file", code: "NETWORK_ERROR", path: file.path });
        attempt.issues.push(failure.issue); if (failure.terminal) attempt.status = "FAIL";
      }
    };
    for (const file of plan.files.slice(0, 2)) await verifyFile(file);
    if (attempt.issues.length === 0) {
      let next = 2;
      await Promise.all(Array.from({ length: Math.min(4, plan.files.length - 2) }, async () => {
        while (next < plan.files.length && deps.now().getTime() < deadline) await verifyFile(plan.files[next++]);
      }));
      if (next < plan.files.length) attempt.issues.push({ check: "file", code: "DEADLINE" });
    }
    if (attempt.filesMatched === plan.files.length && attempt.issues.length === 0) attempt.status = "PASS";
    attempt.issues.sort((a, b) => (a.path ?? a.check).localeCompare(b.path ?? b.check));
  } catch (error) {
    const failure = error instanceof CheckFailure ? error : new CheckFailure({ check: "github", code: "CHECK_FAILED" });
    attempt.issues.push(failure.issue); if (failure.terminal) attempt.status = "FAIL";
  }
  return attempt;
}

/** Throws after saving a private FAIL receipt; an existing automatic attempt is archived, never discarded. */
export async function verifyPublishedSite(options: VerificationOptions, injected: Partial<VerificationDependencies> = {}): Promise<VerificationReceipt> {
  targetDate(options.target); destination(options.repo);
  const deps: VerificationDependencies = { fetch: globalThis.fetch, now: () => new Date(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), ...injected };
  const maxAttempts = options.maxAttempts ?? 12, intervalMs = options.intervalMs ?? 20000, maxDurationMs = options.maxDurationMs ?? 300000;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 12 || !Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 20000
    || !Number.isInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 300000) throw new Error("Invalid bounded verification limits");
  const directory = path.join(path.resolve(root, options.stateDir ?? ".data/daily-delivery"), "verification");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const receiptPath = path.join(directory, `${options.target}-automatic.json`);
  try { await rename(receiptPath, path.join(directory, `${options.target}-automatic-${randomUUID()}.json`)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const start = deps.now(), deadline = start.getTime() + maxDurationMs;
  const receipt: VerificationReceipt = { version: 1, target: options.target, repo: options.repo, status: "RUNNING", startedAt: start.toISOString(), checkedAt: start.toISOString(), receiptPath, attempts: [] };
  const persist = async () => { receipt.checkedAt = deps.now().toISOString(); await saveJson(receiptPath, receipt); };
  await persist();
  let plan: Plan;
  try {
    plan = await planVerification(options);
    Object.assign(receipt, { revision: plan.revision, publicBaseUrl: plan.manifest.publicBaseUrl, generatedAt: plan.manifest.generatedAt,
      manifestSha256: plan.files[0].sha256, report: plan.report, counts: plan.counts });
  } catch {
    receipt.status = "FAIL"; receipt.failure = "LOCAL_EXPORT_OR_PUBLISHER_RECEIPT_INVALID"; await persist();
    throw new Error(`Publication verification failed: ${receipt.failure}; receipt: ${receiptPath}`);
  }
  for (let number = 1; number <= maxAttempts && deps.now().getTime() < deadline; number++) {
    const attempt = await checkPublication(plan, options, deps, deadline, number);
    receipt.attempts.push(attempt); await persist();
    if (attempt.status === "PASS") { receipt.status = "PASS"; await persist(); return receipt; }
    if (attempt.status === "FAIL") { receipt.failure = attempt.issues.find(issue => issue.code === "PAGES_BUILD_FAILED")?.code ?? "PUBLIC_CHECK_FAILED"; break; }
    if (number < maxAttempts && deps.now().getTime() < deadline) await deps.sleep(Math.min(intervalMs, Math.max(0, deadline - deps.now().getTime())));
  }
  receipt.status = "FAIL"; receipt.failure ??= deps.now().getTime() >= deadline ? "VERIFICATION_DEADLINE" : "VERIFICATION_ATTEMPTS_EXHAUSTED"; await persist();
  throw new Error(`Publication verification failed: ${receipt.failure}; receipt: ${receiptPath}`);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && args[0] === "--help") { console.log("node scripts/daily-delivery/verify.ts (--slot YYYY-MM-DD-HH[-r1] | --date YYYY-MM-DD) [--source .data/public-site] [--repo owner/repo]"); return; }
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!["--slot", "--date", "--source", "--repo"].includes(key) || !value || value.startsWith("--") || values.has(key)) throw new Error("Invalid verification arguments");
    values.set(key, value);
  }
  if (values.has("--slot") === values.has("--date")) throw new Error("Supply exactly one verification slot or date");
  const target = values.get("--slot") ?? values.get("--date")!;
  if ((values.has("--date") && target.length !== 10) || (values.has("--slot") && target.length === 10)) throw new Error("Invalid verification slot or date");
  const receipt = await verifyPublishedSite({ target, repo: values.get("--repo") ?? process.env.STATIC_SITE_REPO ?? "CATL-21CLab-SCIAGI/algorithmhot", source: values.get("--source") });
  console.log(JSON.stringify({ status: receipt.status, sha: receipt.revision, counts: receipt.counts, checkedAt: receipt.checkedAt, receiptPath: receipt.receiptPath }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main().catch(error => { console.error(error instanceof Error ? error.message : "Publication verification failed"); process.exitCode = 1; });
}
