// Publishes only the independently audited reading snapshot, never this application checkout.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, copyFile, stat, lstat, rename } from "node:fs/promises";
import path from "node:path";
import { auditBundle, auditStageFiles, destination, safeGitEnvironment, validateApprovedHeads, verifyApprovedHistory, verifyPushUrls, type ApprovedHeads, type ExportManifest, type StageJournal } from "./pages-publisher.ts";
import { withDeliveryLock, recoverDeliveryLock, saveJson } from "./daily-delivery/core.ts";
const root = path.resolve(import.meta.dirname, "..");
const checkout = path.join(root, ".data/pages-repo");
const state = path.join(root, ".data/pages-publisher");
const repo = option("--repo") || "PKUCY2016/algorithmhot";
const source = path.resolve(root, option("--source") || ".data/public-site");
const registryPath = path.join(state, "approved-heads.json");
const journalPath = path.join(state, "staging.json");
const sha256 = (buffer: string | Buffer) => createHash("sha256").update(buffer).digest("hex");
function option(flag: string) { const i = process.argv.indexOf(flag); return i < 0 ? undefined : process.argv[i + 1]; }
function git(args: string[], optional = false): string {
  const run = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: checkout, env: safeGitEnvironment(), encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  // Git error text can contain credential-bearing proxy/remote configuration; keep stdout private too.
  if (run.status !== 0 && !optional) throw new Error(`Git ${args[0]} failed (${run.status ?? "not started"}); publication halted and its local state retained.`);
  return run.status === 0 ? run.stdout.trim() : "";
}
function gitBytes(args: string[]): Buffer {
  const run = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: checkout, env: safeGitEnvironment(), timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
  if (run.status !== 0) throw new Error("Could not verify staged or previous public bytes");
  return run.stdout;
}
async function registry(): Promise<ApprovedHeads> {
  try { return validateApprovedHeads(JSON.parse(await readFile(registryPath, "utf8")), repo); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, repo, heads: [] }; throw error; }
}
async function assertHistory(upstream: boolean): Promise<void> {
  if (!git(["rev-parse", "--verify", "HEAD"], true)) return;
  const commits = git(["rev-list", "HEAD", ...(upstream ? ["^origin/main"] : [])]).split("\n").filter(Boolean);
  verifyApprovedHistory(commits, await registry());
}
async function snapshotFiles(dir: string, manifest: ExportManifest): Promise<ExportManifest["files"]> {
  const buffer = await readFile(path.join(dir, "export-manifest.json"));
  return [...manifest.files, { path: "export-manifest.json", bytes: buffer.length, sha256: sha256(buffer) }];
}
async function recoverStage(): Promise<void> {
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as StageJournal;
  const files = await auditStageFiles(checkout, journal, repo);
  const head = git(["rev-parse", "--verify", "HEAD"], true) || null;
  if (head !== journal.oldHead) throw new Error("HEAD changed after staging; preserve the journal and review the commit instead of rolling it back");
  if (head && sha256(gitBytes(["show", `${head}:export-manifest.json`])) !== journal.oldManifestSha256) throw new Error("Previous committed manifest differs from the stage journal");
  const entries = [...journal.oldFiles, ...journal.newFiles];
  const tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean);
  for (const file of tracked) {
    const buffer = gitBytes(["show", `:${file}`]);
    if (!entries.some(entry => entry.path === file && entry.sha256 === sha256(buffer) && entry.bytes === buffer.length)) throw new Error("Unrecognized index modification retained; no recovery changes made");
  }
  // All checks above precede mutation. Only the exact generated paths from this journal are touched.
  const oldPaths = new Set(journal.oldFiles.map(file => file.path));
  const newOnly = [...new Set([...files, ...tracked].filter(file => !oldPaths.has(file)))];
  if (newOnly.length) git(["rm", "--cached", "-f", "--ignore-unmatch", "--", ...newOnly]);
  for (const file of files.filter(file => !oldPaths.has(file))) await rm(path.join(checkout, file));
  if (head) {
    git(["restore", `--source=${head}`, "--staged", "--worktree", "--", ...oldPaths]);
    await auditBundle(checkout, repo, true);
  }
  if (git(["status", "--porcelain"])) throw new Error("Recovery did not produce a clean generated tree; journal retained");
  await rename(journalPath, path.join(state, `staging-recovered-${Date.now()}.json`));
  console.log(JSON.stringify({ state: "stage-recovered", repo, previousHead: head, networkRequests: 0 }));
}
async function assertCheckout(remote: string): Promise<void> {
  const metadata = await lstat(path.join(checkout, ".git"));
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || git(["rev-parse", "--absolute-git-dir"]) !== path.join(checkout, ".git")) throw new Error("Public checkout must own its independent Git metadata");
  if (await realpath(checkout) !== checkout || git(["rev-parse", "--show-toplevel"]) !== checkout || git(["remote", "get-url", "origin"]) !== remote
    || git(["branch", "--show-current"]) !== "main") throw new Error("Public Git destination mismatch");
  verifyPushUrls(git(["remote", "get-url", "--push", "--all", "origin"]), remote);
}
async function main() {
  const target = destination(repo);
  if (process.argv.includes("--recover-lock")) {
    await recoverDeliveryLock(state, pid => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } });
    console.log("Dead publisher lock archived if present. No copy, commit or network request was started."); return;
  }
  const recovering = process.argv.includes("--recover-stage");
  let manifest = recovering ? null : await auditBundle(source, repo);
  if (manifest) console.log(JSON.stringify({ audit: "PASS", files: manifest.files.length, bytes: manifest.files.reduce((sum, f) => sum + f.bytes, 0), repo }));
  if (process.argv.includes("--check")) return;
  await withDeliveryLock(state, async () => {
    const marker = path.join(state, "checkout.json");
    let registered: { path: string; repo: string } | null = null;
    try { registered = JSON.parse(await readFile(marker, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!registered) {
      if (recovering) throw new Error("Cannot recover an unregistered public checkout");
      try { await stat(checkout); throw new Error("Unregistered Pages checkout already exists; inspect it before registration"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await mkdir(checkout);
      git(["init", "-b", "main"]); git(["remote", "add", "origin", target.remote]);
      git(["config", "user.name", "AlgorithmHot"]); git(["config", "user.email", "73462655+PKUCY2016@users.noreply.github.com"]);
      git(["config", "core.hooksPath", "/dev/null"]);
      await saveJson(marker, { path: checkout, repo });
    } else if (registered.path !== checkout || registered.repo !== repo) throw new Error("Registered public checkout destination mismatch");
    await assertCheckout(target.remote);
    if (recovering) { await recoverStage(); return; }
    try { await stat(journalPath); throw new Error("Unfinished publisher staging exists. Use --recover-stage to inspect and restore only recognized generated bytes."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (git(["status", "--porcelain"])) throw new Error("Public checkout contains unfinished edits; retain them for inspection");
    const upstream = !!git(["ls-remote", "--heads", "origin", "refs/heads/main"]);
    if (upstream) {
      git(["fetch", "origin", "main"]);
      await assertHistory(true);
      if (!git(["rev-parse", "--verify", "HEAD"], true)) git(["checkout", "-B", "main", "origin/main"]);
      else git(["merge", "--ff-only", "origin/main"]);
    } else await assertHistory(false);
    const tracked = git(["ls-files", "-z"]).split("\0").filter(Boolean);
    let oldFiles: ExportManifest["files"] = [];
    if (tracked.length) {
      const previous = await auditBundle(checkout, repo, true);
      oldFiles = await snapshotFiles(checkout, previous);
      const known = new Set(oldFiles.map(f => f.path));
      if (tracked.some(f => !known.has(f))) throw new Error("Repository contains files outside its export manifest");
    }
    manifest = await auditBundle(source, repo);
    const newFiles = await snapshotFiles(source, manifest);
    const journal: StageJournal = { version: 1, repo, oldHead: git(["rev-parse", "--verify", "HEAD"], true) || null, phase: "copying",
      oldManifestSha256: oldFiles.find(file => file.path === "export-manifest.json")?.sha256 ?? null,
      newManifestSha256: newFiles.find(file => file.path === "export-manifest.json")!.sha256, oldFiles, newFiles };
    await saveJson(journalPath, journal);
    for (const file of tracked) await rm(path.join(checkout, file));
    for (const file of newFiles) {
      await mkdir(path.dirname(path.join(checkout, file.path)), { recursive: true });
      await copyFile(path.join(source, file.path), path.join(checkout, file.path));
    }
    await auditBundle(checkout, repo, true);
    if (sha256(await readFile(path.join(checkout, "export-manifest.json"))) !== journal.newManifestSha256) throw new Error("Export changed during staging; no commit or push was performed");
    git(["add", "--all", "--", "."]);
    const indexed = git(["ls-files", "-z"]).split("\0").filter(Boolean).sort();
    if (JSON.stringify(indexed) !== JSON.stringify(newFiles.map(file => file.path).sort())) throw new Error("Staged Git inventory differs from the audited export");
    for (const file of newFiles) {
      const buffer = gitBytes(["show", `:${file.path}`]);
      if (buffer.length !== file.bytes || sha256(buffer) !== file.sha256) throw new Error("Git transformed generated bytes; no commit or push was performed");
    }
    if (git(["diff", "--cached", "--name-only"])) {
      git(["commit", "-m", `Publish research reading snapshot ${manifest.generatedAt}`]);
      const approved = await registry();
      approved.heads.push({ sha: git(["rev-parse", "HEAD"]), manifestSha256: journal.newManifestSha256, createdAt: new Date().toISOString() });
      await saveJson(registryPath, approved);
    }
    await rename(journalPath, path.join(state, `staging-complete-${Date.now()}.json`));
    const revision = git(["rev-parse", "HEAD"]);
    await assertHistory(upstream);
    if (process.argv.includes("--prepare")) { console.log(JSON.stringify({ state: "prepared-only", repo, revision })); return; }
    await assertCheckout(target.remote);
    git(["push", "--dry-run", "--no-verify", "origin", "HEAD:refs/heads/main"]);
    git(["push", "--set-upstream", "origin", "HEAD:refs/heads/main"]);
    const remoteRevision = git(["ls-remote", "--heads", "origin", "refs/heads/main"]).split(/\s/)[0];
    if (revision !== remoteRevision) throw new Error("Published ref could not be verified; preserve the local commit for reconciliation");
    const receipt = { repo, revision, publicBaseUrl: target.base, exportedAt: manifest.generatedAt, pushedAt: new Date().toISOString(), files: manifest.files.length, state: "remote-ref-verified" };
    await saveJson(path.join(state, "receipt.json"), receipt); console.log(JSON.stringify(receipt));
  });
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Publisher failed; inspect preserved local state"); process.exitCode = 1; });
