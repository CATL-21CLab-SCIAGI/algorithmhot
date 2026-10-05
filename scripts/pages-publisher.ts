import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import type { CheerioAPI } from "cheerio";

/** Reviewed source figures; local PDF extracts require exact PNG dimensions and hash. */
export interface PublicPaperFigure {
  itemId: string; sourceRevision: number; imageUrl: string; sourceUrl: string; imageOrigin: "remote" | "pdf-extract";
  figureLabel: string; caption: string; attribution: string; licenseName: string; licenseUrl: string;
  verifiedAt: string; width: number; height: number; contentType: string; sha256: string;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const paperFigureKey = (figure: Pick<PublicPaperFigure, "itemId" | "sourceRevision">): string => `${figure.itemId}:${figure.sourceRevision}`;
export const paperFigureAsset = (figure: PublicPaperFigure): string => `assets${figure.imageUrl}`;
export const paperFigureSrc = (figure: PublicPaperFigure, base: string): string => figure.imageOrigin === "remote" ? figure.imageUrl : `${new URL(base).pathname}${paperFigureAsset(figure)}`;
export function assertPaperFigurePng(bytes: Uint8Array, figure: PublicPaperFigure): void {
  const b = Buffer.from(bytes);
  if (figure.imageOrigin !== "pdf-extract" || figure.contentType !== "image/png" || b.length < 33
    || b.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || b.readUInt32BE(8) !== 13 || b.toString("ascii", 12, 16) !== "IHDR"
    || b.readUInt32BE(16) !== figure.width || b.readUInt32BE(20) !== figure.height
    || createHash("sha256").update(b).digest("hex") !== figure.sha256) throw new Error("Paper figure PNG signature, dimensions or hash mismatch");
}
function figureUrl(value: unknown, allowFragment = true): boolean {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value), host = url.hostname;
    return url.href === value && url.protocol === "https:" && !url.username && !url.password && !url.port
      && (allowFragment || !url.hash) && host.includes(".") && /^[a-z0-9.-]+$/.test(host) && !/^[\d.]+$/.test(host)
      && !host.endsWith(".") && !/\.(?:local|localhost|internal|test|invalid)$/.test(host);
  } catch { return false; }
}
export function validatePaperFigures(value: unknown): { schemaVersion: 1; figures: PublicPaperFigure[] } {
  if (!exactKeys(value, ["schemaVersion", "figures"]) || value.schemaVersion !== 1 || !Array.isArray(value.figures) || value.figures.length > 10000) throw new Error("Invalid paper figure manifest");
  const fields = ["itemId", "sourceRevision", "imageUrl", "imageOrigin", "sourceUrl", "figureLabel", "caption", "attribution", "licenseName", "licenseUrl", "verifiedAt", "width", "height", "contentType", "sha256"];
  const keys = new Set<string>();
  for (const figure of value.figures) {
    if (!exactKeys(figure, fields) || typeof figure.itemId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(figure.itemId)
      || ![figure.sourceRevision, figure.width, figure.height].every(n => Number.isSafeInteger(n) && Number(n) > 0)
      || Number(figure.width) > 50000 || Number(figure.height) > 50000
      || ![figure.sourceUrl, figure.licenseUrl].every(url => figureUrl(url))
      || !(figure.imageOrigin === "remote" ? figureUrl(figure.imageUrl, false) : figure.imageOrigin === "pdf-extract" && typeof figure.imageUrl === "string" && /^\/paper-figures\/[A-Za-z0-9_-]+\.png$/.test(figure.imageUrl) && figure.contentType === "image/png")
      || ![figure.figureLabel, figure.caption, figure.attribution, figure.licenseName].every(s => typeof s === "string" && s.trim() === s && s.length > 0 && s.length <= 10000 && !/[<>\u0000-\u0008]/.test(s))
      || typeof figure.verifiedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(figure.verifiedAt) || !Number.isFinite(Date.parse(figure.verifiedAt))
      || !["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/gif"].includes(String(figure.contentType))
      || typeof figure.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(figure.sha256)) throw new Error("Invalid paper figure fields or URL");
    const key = `${figure.itemId}:${figure.sourceRevision}`;
    if (keys.has(key)) throw new Error("Duplicate paper figure identity");
    keys.add(key);
  }
  return value as unknown as { schemaVersion: 1; figures: PublicPaperFigure[] };
}
function citationKeys(report: unknown): Set<string> {
  return new Set(array(record(report).sections).flatMap(section => array(record(section).items)).flatMap(value => {
    const c = record(value), revision = record(c.researchBrief).sourceRevision;
    return c.available === true && typeof c.itemId === "string" && Number.isSafeInteger(revision) && Number(revision) > 0 ? [`${c.itemId}:${revision}`] : [];
  }));
}
export function assertPaperFigureBindings(figures: readonly PublicPaperFigure[], snapshot: unknown): void {
  const s = record(snapshot), ids = new Set(array(s.items).map(item => record(item).id));
  const citations = new Set(array(s.reports).flatMap(report => [...citationKeys(report)]));
  if (figures.some(figure => !ids.has(figure.itemId) || !citations.has(paperFigureKey(figure)))) throw new Error("Paper figure is not bound to a published citation revision");
}
export function paperFiguresForRoute(figures: readonly PublicPaperFigure[], snapshot: unknown, route: string): PublicPaperFigure[] {
  const s = record(snapshot), parts = route.split("/").filter(Boolean);
  let keys = new Set<string>();
  if (["pilot", "daily"].includes(parts[0] ?? "") && parts.length <= 2) {
    const reports = array(s.reports).map(record).filter(r => r.kind === parts[0] && (!parts[1] || r.key === parts[1]));
    reports.sort((a, b) => String(b.key).localeCompare(String(a.key)) || Number(b.revision) - Number(a.revision));
    if (reports[0]) keys = citationKeys(reports[0]);
  } else if (parts[0] === "items" && parts.length === 2) {
    const item = array(s.items).map(record).find(i => i.id === parts[1]);
    if (item) keys.add(`${item.id}:${record(item.researchBrief).sourceRevision}`);
  }
  return figures.filter(figure => keys.has(paperFigureKey(figure)));
}
const words = (text: string) => text.replace(/\s+/g, " ").trim();
/** Both exporter and publisher enforce the attribution and per-page image ownership boundary. */
export function assertPaperFigureMarkup($: CheerioAPI, figures: readonly PublicPaperFigure[], publicBaseUrl: string): Set<string> {
  const origins = new Set<string>(), used = new Set<string>();
  $("img").each((_, node) => {
    const img = $(node), figure = img.closest('figure[data-paper-figure="true"]');
    const found = figures.find(f => f.itemId === img.attr("data-paper-figure") && f.itemId === figure.attr("data-item-id") && String(f.sourceRevision) === figure.attr("data-source-revision") && paperFigureSrc(f, publicBaseUrl) === img.attr("src"));
    if (!found || figure.find("img").length !== 1 || used.has(paperFigureKey(found))) throw new Error("Unapproved paper figure image or revision");
    const permitted = ["src", "alt", "class", "width", "height", "loading", "decoding", "referrerpolicy", "data-paper-figure"];
    if (Object.keys(node.attribs).some(attr => !permitted.includes(attr)) || img.attr("referrerpolicy") !== "no-referrer"
      || img.attr("loading") !== "lazy" || img.attr("decoding") !== "async" || !img.attr("alt")
      || img.attr("width") !== String(found.width) || img.attr("height") !== String(found.height)) throw new Error("Unsafe paper figure image attributes");
    const caption = figure.find("figcaption"), text = words(caption.text()), links = caption.find("a[href]").map((_, a) => $(a).attr("href")!).get();
    if (![found.figureLabel, found.caption, found.attribution, found.licenseName].every(value => text.includes(words(value)))
      || !links.includes(found.sourceUrl) || !links.includes(found.licenseUrl)) throw new Error("Paper figure attribution or source link missing");
    if (found.imageOrigin === "remote") origins.add(new URL(found.imageUrl).origin);
    used.add(paperFigureKey(found));
  });
  if ($('figure[data-paper-figure="true"]').length !== used.size) throw new Error("Paper figure has no approved image");
  return origins;
}

export interface ExportManifest {
  schemaVersion: 1; publicBaseUrl: string; generatedAt: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
}
export function destination(repo: string): { remote: string; base: string } {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_-]+$/.test(repo)) throw new Error("Invalid public repository");
  const [owner, name] = repo.split("/");
  return { remote: `https://github.com/${repo}.git`, base: `https://${owner!.toLowerCase()}.github.io/${name}/` };
}
export function safeGitEnvironment(input: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Git location, injected config, index, hooks and transport overrides must not escape this checkout.
  const env = Object.fromEntries(Object.entries(input).filter(([key]) => !key.startsWith("GIT_")));
  // Keep trusted installed Git configuration: macOS's existing osxkeychain helper lives there.
  // Hooks are disabled per command and both resolved remote URLs are independently verified.
  return { ...env, GIT_TERMINAL_PROMPT: "0" };
}
export function verifyPushUrls(urls: string, remote: string): void {
  if (urls.split(/\r?\n/).filter(Boolean).length !== 1 || urls.trim() !== remote) throw new Error("Public Git push destination mismatch");
}
export const PAGES_BRANCH = "gh-pages" as const;
export function assertPagesBranch(branch: unknown, context: string): asserts branch is typeof PAGES_BRANCH {
  if (branch !== PAGES_BRANCH) throw new Error(`${context} is not bound to gh-pages; controlled migration of the legacy main checkout and publisher records is required. No automatic branch migration or push was attempted.`);
}
export interface ApprovedHeads { version: 1; repo: string; branch: typeof PAGES_BRANCH; heads: Array<{ sha: string; manifestSha256: string; createdAt: string }> }
export function validateApprovedHeads(value: unknown, repo: string): ApprovedHeads {
  const record = value as ApprovedHeads;
  assertPagesBranch(record?.branch, "Approved publisher history");
  if (!record || record.version !== 1 || record.repo !== repo || !Array.isArray(record.heads)
    || record.heads.some(head => !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head.sha) || !/^[a-f0-9]{64}$/.test(head.manifestSha256)
      || !Number.isFinite(Date.parse(head.createdAt)))) throw new Error("Invalid approved publisher history");
  return record;
}
export function verifyApprovedHistory(shas: string[], registry: ApprovedHeads): void {
  assertPagesBranch(registry.branch, "Approved publisher history");
  const approved = new Set(registry.heads.map(head => head.sha));
  if (shas.some(sha => !approved.has(sha))) throw new Error("Unregistered unpublished commit; preserve it for manual review. No push was attempted.");
}
function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function checkPublicText(text: string, file: string): void {
  if (/(?:postgres(?:ql)?:\/\/|https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])|\/Users\/|file:\/\/|PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|(?:DATABASE_URL|OPENAI_API_KEY|CODEX_HOME)["']?\s*[=:]|\.codex\/auth\.json)/i.test(text)) throw new Error(`Private configuration marker found: ${file}`);
  if (/\.(?:html|svg)$/i.test(file) && /<script\b|\son[a-z]+\s*=|javascript\s*:/i.test(text)) throw new Error(`Executable markup not allowed: ${file}`);
}
function allowed(file: string): boolean {
  if (file === ".nojekyll") return true;
  if (/^assets\/paper-figures\/[A-Za-z0-9_-]+\.png$/.test(file)) return true;
  return file.split("/").every(part => /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(part) && part !== "..")
    && /\.(?:html|css|svg|json|xml|txt|md)$/.test(file)
    && !/(?:^|\/)(?:node_modules|raw|receipts|admin|credentials|logs)(?:\/|$)/.test(file);
}
async function walk(dir: string, prefix = "", gitCheckout = false): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (gitCheckout && !prefix && entry.name === ".git" && entry.isDirectory()) continue;
    const file = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error("Public bundle contains a symbolic link");
    if (entry.isDirectory()) result.push(...await walk(path.join(dir, entry.name), file + "/"));
    else if (entry.isFile()) result.push(file);
    else throw new Error("Unsupported public bundle entry");
  }
  return result.sort();
}
/** Reviewable boundary: a complete hash inventory and only generated public document formats. */
export async function auditBundle(source: string, repo: string, gitCheckout = false): Promise<ExportManifest> {
  if ((await lstat(source)).isSymbolicLink()) throw new Error("Public source must not be a symbolic link");
  const all = await walk(source, "", gitCheckout);
  if (!all.includes("export-manifest.json")) throw new Error("No export manifest");
  const manifestText = await readFile(path.join(source, "export-manifest.json"), "utf8");
  if (Buffer.byteLength(manifestText) > 4 * 1024 * 1024) throw new Error("Export manifest exceeds size limit");
  checkPublicText(manifestText, "export-manifest.json");
  const value: unknown = JSON.parse(manifestText);
  if (!exactKeys(value, ["schemaVersion", "publicBaseUrl", "generatedAt", "files"]) || !Array.isArray(value.files)
    || value.files.some(file => !exactKeys(file, ["path", "sha256", "bytes"]) || typeof file.path !== "string"
      || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || Number(file.bytes) < 0)) throw new Error("Invalid export manifest fields");
  const manifest = value as unknown as ExportManifest;
  if (typeof manifest.generatedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(manifest.generatedAt)
    || manifest.schemaVersion !== 1 || manifest.publicBaseUrl !== destination(repo).base || !Number.isFinite(Date.parse(manifest.generatedAt))
    || !Array.isArray(manifest.files) || manifest.files.length > 10000) throw new Error("Invalid public export identity");
  const paths = manifest.files.map(f => f.path);
  if (new Set(paths).size !== paths.length || paths.some(f => !allowed(f) || f === "export-manifest.json")) throw new Error("Unsafe manifest path");
  if (JSON.stringify([...paths, "export-manifest.json"].sort()) !== JSON.stringify(all)) throw new Error("Public bundle differs from its complete inventory");
  if (!paths.includes("index.html") || !paths.includes(".nojekyll")) throw new Error("Incomplete Pages bundle");
  let total = Buffer.byteLength(manifestText);
  const contents = new Map<string, Buffer>();
  for (const file of manifest.files) {
    const buffer = await readFile(path.join(source, file.path));
    total += buffer.length;
    if (total > 100 * 1024 * 1024 || buffer.length > 20 * 1024 * 1024) throw new Error("Public bundle exceeds size limit");
    if (buffer.length !== file.bytes || createHash("sha256").update(buffer).digest("hex") !== file.sha256) throw new Error(`Export checksum mismatch: ${file.path}`);
    if (!file.path.endsWith(".png")) checkPublicText(buffer.toString("utf8"), file.path);
    contents.set(file.path, buffer);
  }
  const figureText = contents.get("data/paper-figures.json");
  const figures = figureText ? validatePaperFigures(JSON.parse(figureText.toString("utf8"))).figures : [];
  const snapshot = contents.has("data/snapshot.json") ? JSON.parse(contents.get("data/snapshot.json")!.toString("utf8")) : null;
  assertPaperFigureBindings(figures, snapshot);
  for (const [file, buffer] of contents) {
    if (file.endsWith(".png")) {
      const figure = figures.find(f => f.imageOrigin === "pdf-extract" && paperFigureAsset(f) === file);
      if (!figure) throw new Error("Unregistered local paper figure PNG");
      assertPaperFigurePng(buffer, figure);
    }
    if (!file.endsWith(".html")) continue;
    const $ = load(buffer.toString("utf8")), route = file === "index.html" ? "/" : `/${file.replace(/\/index\.html$/, "")}`;
    const origins = assertPaperFigureMarkup($, paperFiguresForRoute(figures, snapshot, route), manifest.publicBaseUrl);
    if ($("picture,source,svg image").length) throw new Error("Unapproved alternative image source");
    if ($("img").length) {
      const policies = $('meta[http-equiv="Content-Security-Policy"]');
      const expected = ["'self'", "data:", ...[...origins].sort()];
      const directives = (policies.attr("content") ?? "").split(";").map(s => s.trim().split(/\s+/));
      const imagePolicies = directives.filter(d => d[0] === "img-src");
      if (policies.length !== 1 || imagePolicies.length !== 1 || JSON.stringify(imagePolicies[0].slice(1)) !== JSON.stringify(expected)
        || !directives.some(d => d.join(" ") === "default-src 'none'")) throw new Error("Paper figure CSP is not restricted to its exact image origins");
    }
  }
  for (const figure of figures) if (figure.imageOrigin === "pdf-extract" && !contents.has(paperFigureAsset(figure))) throw new Error("Missing local paper figure PNG");
  return manifest;
}

export interface StageJournal {
  version: 1; repo: string; branch: typeof PAGES_BRANCH; oldHead: string | null; phase: "copying";
  oldManifestSha256: string | null; newManifestSha256: string;
  oldFiles: ExportManifest["files"]; newFiles: ExportManifest["files"];
}
/** Recovery may touch only byte-identical old/new generated files; unknown changes are preserved. */
export async function auditStageFiles(checkout: string, journal: StageJournal, repo: string): Promise<string[]> {
  assertPagesBranch(journal?.branch, "Publisher recovery journal");
  if (!journal || journal.version !== 1 || journal.repo !== repo || journal.phase !== "copying"
    || (journal.oldHead !== null && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(journal.oldHead))
    || !Array.isArray(journal.oldFiles) || !Array.isArray(journal.newFiles)) throw new Error("Invalid stage recovery journal");
  const entries = [...journal.oldFiles, ...journal.newFiles];
  if (entries.some(file => !allowed(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0)) throw new Error("Unsafe stage recovery inventory");
  if ((journal.oldFiles.find(f => f.path === "export-manifest.json")?.sha256 ?? null) !== journal.oldManifestSha256
    || journal.newFiles.find(f => f.path === "export-manifest.json")?.sha256 !== journal.newManifestSha256) throw new Error("Stage manifest hashes do not match");
  if ((await lstat(checkout)).isSymbolicLink()) throw new Error("Recovery checkout cannot be a symbolic link");
  const files = await walk(checkout, "", true);
  for (const file of files) {
    const buffer = await readFile(path.join(checkout, file));
    const hash = createHash("sha256").update(buffer).digest("hex");
    if (!entries.some(entry => entry.path === file && entry.sha256 === hash && entry.bytes === buffer.length)) throw new Error(`Unrecognized file or user modification retained: ${file}`);
  }
  return files;
}
