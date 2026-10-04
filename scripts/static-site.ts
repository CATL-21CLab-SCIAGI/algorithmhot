#!/usr/bin/env node
// Only HTTP publication endpoints may supply public content. No DB or runtime configuration imports.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { identifier, list, number, obj, sanitizeItem, sanitizeReport, sanitizeTopic, str, validateSnapshot } from "./static-site/model.ts";
import type { Snapshot } from "./static-site/model.ts";
import { normalizeBase, renderSite, validateStaticLinks } from "./static-site/render.ts";
import { renderSsrSite, ssrClient } from "./static-site/ssr.ts";

export interface ExportOptions { api: string; web: string; base: string; output: string }
export interface ExportManifest { schemaVersion: 1; publicBaseUrl: string; generatedAt: string; files: Array<{ path: string; sha256: string; bytes: number }> }
type Get = (route: string) => Promise<unknown>;
const sha256 = (text: string | Uint8Array): string => createHash("sha256").update(text).digest("hex");

export function publicationClient(api: string): Get {
  const base = new URL(api);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) throw new Error("Export input must be a local public HTTP API");
  return async (route) => {
    if (!route.startsWith("/api/site/") || route.includes("..")) throw new Error("Only site publication endpoints are allowed");
    const response = await fetch(new URL(route, base), { signal: AbortSignal.timeout(30_000), redirect: "error", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Public API request failed (${response.status}): ${route}`);
    if (!response.headers.get("content-type")?.includes("application/json")) throw new Error(`Expected public JSON: ${route}`);
    return response.json();
  };
}

export async function collectSnapshot(get: Get, publicBaseUrl: string, generatedAt = new Date().toISOString()): Promise<Snapshot> {
  const base = normalizeBase(publicBaseUrl).href;
  const directory = obj(await get("/api/site/topics"));
  const topics: Snapshot["topics"] = [], reports: Snapshot["reports"] = [];
  const ids = new Set<string>(), cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = obj(await get(`/api/site/timeline?limit=40${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`));
    for (const card of list(page.cards)) ids.add(identifier(obj(obj(card).item).id));
    cursor = str(page.nextCursor) || null;
    if (cursor) {
      if (cursors.has(cursor)) throw new Error("Publication cursor did not advance");
      cursors.add(cursor);
    }
    if (cursors.size > 1000) throw new Error("Publication export exceeds 1,000 pages; review scope before increasing");
  } while (cursor);
  for (const value of list(directory.topics)) {
    const t = obj(value), slug = identifier(t.slug), topicIds: string[] = [];
    let pages = 1;
    for (let page = 1; page <= pages; page++) {
      const data = obj(await get(`/api/site/topics/${slug}?page=${page}`));
      const pageCount = number(data.pageCount);
      if (!Number.isInteger(pageCount) || pageCount < page || pageCount > 1000) throw new Error(`Invalid topic pagination: ${slug}`);
      if (page > 1 && pages !== pageCount) throw new Error(`Topic pagination changed during export: ${slug}; rerun`);
      pages = pageCount;
      for (const item of list(data.items)) topicIds.push(identifier(obj(item).id));
    }
    if (new Set(topicIds).size !== topicIds.length || topicIds.length !== number(t.total)) throw new Error(`Topic membership changed or truncated: ${slug}; rerun`);
    topicIds.forEach((id) => ids.add(id));
    topics.push(sanitizeTopic(t, topicIds));
  }
  for (const kind of ["pilot", "daily"] as const) {
    const entries = list(obj(await get(`/api/site/reports/${kind}`)).items);
    // The API index is capped at 400; do not silently drop older public reports.
    if (entries.length >= 400) throw new Error(`The ${kind} index reached its 400-report limit; add archive pagination before publishing`);
    for (const value of entries) {
      const key = identifier(obj(value).key), report = sanitizeReport(await get(`/api/site/reports/${kind}/${key}`));
      if (report.kind !== kind || report.key !== key) throw new Error("Report identity changed during export");
      reports.push(report);
      for (const s of report.sections) for (const i of s.items) if (i.available && i.itemId) ids.add(i.itemId);
    }
  }
  const items: Snapshot["items"] = [];
  for (const id of ids) {
    const item = sanitizeItem(await get(`/api/site/items/${id}`));
    if (item.id !== id) throw new Error("Public item identity mismatch");
    items.push(item);
  }
  items.sort((a, b) => (b.timelineAt ?? "").localeCompare(a.timelineAt ?? "") || a.id.localeCompare(b.id));
  reports.sort((a, b) => b.windowEnd.localeCompare(a.windowEnd) || a.kind.localeCompare(b.kind));
  const snapshot: Snapshot = { schemaVersion: 1, generatedAt, publicBaseUrl: base, mode: "static-snapshot", scope: "当前公开精选、全部主题关联资料与现存试刊/日报归档（每类索引小于 400 期）", items, topics, reports };
  validateSnapshot(snapshot);
  return snapshot;
}

async function inspectPriorFiles(root: string, prefix = ""): Promise<string[]> {
  if ((await lstat(root)).isSymbolicLink()) throw new Error("Refusing output directory symlink");
  const found: string[] = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw new Error(`Refusing output with symlink: ${item.name}`);
    if (item.isDirectory()) found.push(...await inspectPriorFiles(path.join(root, item.name), `${prefix}${item.name}/`));
    else found.push(`${prefix}${item.name}`);
  }
  return found;
}

export function createExport(snapshot: Snapshot): { files: Map<string, string>; manifest: ExportManifest };
export function createExport(snapshot: Snapshot, renderedFiles: Map<string, string | Uint8Array>): { files: Map<string, string | Uint8Array>; manifest: ExportManifest };
export function createExport(snapshot: Snapshot, renderedFiles?: Map<string, string | Uint8Array>): { files: Map<string, string | Uint8Array>; manifest: ExportManifest } {
  validateSnapshot(snapshot);
  const files = renderedFiles ?? renderSite(snapshot);
  files.set(".nojekyll", "");
  files.set("LICENSE.txt", readFileSync(new URL("../LICENSE", import.meta.url), "utf8"));
  files.set("README.md", `# AlgorithmHot · 科研热点\n\n公开静态阅读站：${snapshot.publicBaseUrl}\n\n此仓库只含公开网页与摘要数据。生成时间：${snapshot.generatedAt}。模型调用、采集、数据库和登录信息保留在本机，GitHub Pages 不运行这些任务。\n\n报告保留来源、实际窗口、研究依据与处理缺口。作者报告不等于独立复现。资料与第三方材料的权利归原作者；请参阅站点的来源与隐私说明。\n\n通过仓库 Settings → Pages，选择 Deploy from a branch，选择 main / (root) 发布。已含 .nojekyll，无需构建工作流或服务器。\n\nexport-manifest.json 记录本次发布文件的 SHA-256、字节数与公开基址。静态数据位于 data/snapshot.json。\n`);
  validateStaticLinks(new Map([...files].map(([file, content]) => [file, typeof content === "string" ? content : ""])), snapshot.publicBaseUrl);
  const manifest: ExportManifest = {
    schemaVersion: 1, publicBaseUrl: snapshot.publicBaseUrl, generatedAt: snapshot.generatedAt,
    files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([file, content]) => ({ path: file, sha256: sha256(content), bytes: Buffer.byteLength(content) })),
  };
  return { files, manifest };
}

export async function writeExport(output: string, files: Map<string, string | Uint8Array>, manifest: ExportManifest): Promise<void> {
  const target = path.resolve(output), staging = `${target}.staging-${process.pid}`, old = `${target}.previous-${process.pid}`;
  if (target === path.parse(target).root || target === process.cwd()) throw new Error("Refusing to replace a root or working directory");
  let existing = false;
  try {
    const prior = JSON.parse(await readFile(path.join(target, "export-manifest.json"), "utf8"));
    if (prior.schemaVersion !== 1 || !Array.isArray(prior.files)) throw new Error("Unrecognized prior export");
    const found = await inspectPriorFiles(target);
    const expected = new Set([...prior.files.map((file: { path: string }) => file.path), "export-manifest.json"]);
    if (found.some((file) => !expected.has(file))) throw new Error("Output contains files outside its previous manifest; refusing replacement");
    for (const file of prior.files) {
      if (!found.includes(file.path)) throw new Error("Prior export is missing a generated file; preserve it for inspection");
      const bytes = await readFile(path.join(target, file.path));
      if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error("Prior export has modified content; refusing replacement");
    }
    existing = true;
  } catch (error) {
    if (obj(error).code !== "ENOENT") throw error;
    try { await readdir(target); throw new Error("Output exists without an export manifest; refusing replacement"); } catch (err) { if (obj(err).code !== "ENOENT") throw err; }
  }
  await mkdir(path.dirname(target), { recursive: true });
  await mkdir(staging);
  try {
    for (const [file, content] of files) {
      if (file.startsWith("/") || file.split("/").some((part) => part === ".." || part === ".")) throw new Error("Unsafe generated path");
      const destination = path.join(staging, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content, { flag: "wx" });
    }
    await writeFile(path.join(staging, "export-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    if (existing) await rename(target, old);
    try { await rename(staging, target); } catch (error) { if (existing) await rename(old, target); throw error; }
    if (existing) await rm(old, { recursive: true });
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}

async function main(): Promise<void> {
  const options: ExportOptions = { api: "http://127.0.0.1:3101", web: "http://127.0.0.1:3102", base: "https://pkucy2016.github.io/algorithmhot/", output: ".data/public-site" };
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1];
    if (!["--api", "--web", "--base", "--output"].includes(key) || !value) throw new Error("Usage: node scripts/static-site.ts [--api local-public-api] [--web local-reader-site] [--base public-https-url] [--output directory]");
    options[key.slice(2) as keyof ExportOptions] = value;
  }
  const snapshot = await collectSnapshot(publicationClient(options.api), options.base);
  const { PAPER_FIGURES } = await import("../industry/paper-figures.ts");
  const { files, manifest } = createExport(snapshot, await renderSsrSite(snapshot, ssrClient(options.web), PAPER_FIGURES, async url => {
    if (!/^\/paper-figures\/[A-Za-z0-9_-]+\.png$/.test(url)) throw new Error("Unsafe local paper figure path");
    const file = new URL(`../apps/web/public${url}`, import.meta.url);
    if ((await lstat(file)).isSymbolicLink()) throw new Error("Local paper figure cannot be a symbolic link");
    return readFile(file);
  }));
  await writeExport(options.output, files, manifest);
  console.log(JSON.stringify({ status: "ready", output: path.resolve(options.output), publicBaseUrl: snapshot.publicBaseUrl, items: snapshot.items.length, topics: snapshot.topics.length, reports: snapshot.reports.length, roadmaps: snapshot.items.filter((i) => i.researchRoadmap).length, files: files.size, manifestSha256: sha256(JSON.stringify(manifest)) }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
