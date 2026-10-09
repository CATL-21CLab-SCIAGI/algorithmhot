import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import sharp from "sharp";
import { z } from "zod";
import type { ResearchPaperFigure } from "@aihot/contracts/research";
import { PAPER_FIGURES } from "@aihot/industry/paper-figures";
import { config, REPO_ROOT } from "../config.ts";
import { guardedFetch, type GuardedResponse } from "../lib/http-fetch.ts";
import { withArxivRateLimit } from "../lib/arxiv-rate-limit.ts";

export interface ResearchFigureInput {
  itemId: string;
  sourceRevision: number;
  arxivId?: string | null;
  arxivVersion?: string | null;
  title?: string | null;
}
export interface ResearchFigureOptions {
  cacheDir?: string;
  /** Public destination for explicitly reviewed PDF extractions; tests use a temporary directory. */
  publicImageDir?: string;
  /** Tests use a stub. Production defaults to the project's shared arXiv rate limiter. */
  fetch?: typeof guardedFetch;
  now?: Date;
}
export interface ResearchFigureCandidate {
  figure: ResearchPaperFigure;
  arxivId: string;
  arxivVersion: string;
  paperTitle: string;
  confidence: "high" | "medium";
  selectionReason: string;
  /** Exact HTML and image hashes retain the source binding without publishing source responses. */
  htmlSha256: string;
  abstractSha256: string;
  licenseAllowsReuse: boolean;
  titleMatches: boolean;
  pdfExtraction?: {
    pdfSha256: string;
    pageNumber: number;
    /** PDF points, measured from the page's top left: x0, top, x1, bottom. */
    bounds: [number, number, number, number];
    dpi: number;
    htmlFigureId: string;
  };
}
export interface ResearchFigureResult {
  schemaVersion: 1;
  itemId: string;
  sourceRevision: number;
  inputHash: string;
  checkedAt: string;
  status: "verified" | "review_required" | "missing" | "unavailable";
  reason: string;
  verificationBasis: "legacy-audit" | "source-caption" | "editorial-review" | null;
  figure: ResearchPaperFigure | null;
  candidate: ResearchFigureCandidate | null;
  /** Retained provenance for audited artwork that is unsuitable as a method cover. */
  excludedFigure?: ResearchPaperFigure;
  review?: { reviewer: string; note: string; reviewedAt: string };
}

const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const words = (text: string) => text.replace(/\s+/g, " ").trim();
const titleKey = (text: string) => text.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "");
const date = z.iso.datetime();
const figureSchema = z.object({
  itemId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), sourceRevision: z.number().int().positive(),
  imageOrigin: z.enum(["remote", "pdf-extract"]), imageUrl: z.string().min(1), sourceUrl: z.url(),
  figureLabel: z.string().min(1).max(10000), caption: z.string().min(1).max(10000), attribution: z.string().min(1).max(10000),
  licenseName: z.string().min(1), licenseUrl: z.url(), verifiedAt: date,
  width: z.number().int().positive().max(50000), height: z.number().int().positive().max(50000),
  contentType: z.enum(["image/png", "image/jpeg", "image/webp", "image/svg+xml", "image/gif"]), sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const candidateSchema = z.object({
  figure: figureSchema, arxivId: z.string(), arxivVersion: z.string().regex(/^v[1-9]\d*$/), paperTitle: z.string(),
  confidence: z.enum(["high", "medium"]), selectionReason: z.string(), htmlSha256: z.string().length(64),
  abstractSha256: z.string().length(64), licenseAllowsReuse: z.boolean(), titleMatches: z.boolean(),
  pdfExtraction: z.object({
    pdfSha256: z.string().regex(/^[a-f0-9]{64}$/), pageNumber: z.number().int().positive(),
    bounds: z.tuple([z.number().nonnegative(), z.number().nonnegative(), z.number().positive(), z.number().positive()]),
    dpi: z.number().int().min(72).max(600), htmlFigureId: z.string().min(1),
  }).strict().optional(),
}).strict();
const resultSchema = z.object({
  schemaVersion: z.literal(1), itemId: z.string(), sourceRevision: z.number().int().positive(), inputHash: z.string().length(64),
  checkedAt: date, status: z.enum(["verified", "review_required", "missing", "unavailable"]), reason: z.string(),
  verificationBasis: z.enum(["legacy-audit", "source-caption", "editorial-review"]).nullable(),
  figure: figureSchema.nullable(), candidate: candidateSchema.nullable(),
  excludedFigure: figureSchema.optional(),
  review: z.object({ reviewer: z.string().min(1), note: z.string().min(1), reviewedAt: date }).strict().optional(),
}).strict();

function identity(input: ResearchFigureInput) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(input.itemId) || !Number.isSafeInteger(input.sourceRevision) || input.sourceRevision < 1) throw new Error("Invalid paper figure identity");
  const id = input.arxivId?.replace(/v\d+$/, "") ?? null;
  const embeddedVersion = input.arxivId?.match(/(v\d+)$/)?.[1] ?? null;
  if (embeddedVersion && input.arxivVersion && embeddedVersion !== input.arxivVersion) throw new Error("Conflicting original paper versions");
  const version = input.arxivVersion ?? embeddedVersion;
  const valid = !!id && /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})$/.test(id) && !!version && /^v[1-9]\d*$/.test(version);
  return { id, version, valid, hash: digest(JSON.stringify([input.itemId, input.sourceRevision, id, version, input.title ?? null])) };
}
function cacheFile(input: ResearchFigureInput, options: ResearchFigureOptions) {
  identity(input);
  return path.join(options.cacheDir ?? path.join(config.dataDir, "research-figures"), `${input.itemId}-r${input.sourceRevision}.json`);
}
async function save(input: ResearchFigureInput, value: ResearchFigureResult, options: ResearchFigureOptions) {
  resultSchema.parse(value);
  const file = cacheFile(input, options), temp = `${file}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temp, file);
  return value;
}
function legacy(input: ResearchFigureInput, now: Date): ResearchFigureResult | null {
  const figure = PAPER_FIGURES.find(f => f.itemId === input.itemId && f.sourceRevision === input.sourceRevision);
  // The legacy registry attests source/permission; it did not require every image to explain
  // the method. Preserve the original results figure while excluding it from method covers.
  if (figure?.itemId === "rmujtpniv4b0wgn8q2tustjac") return {
    schemaVersion: 1, itemId: input.itemId, sourceRevision: input.sourceRevision, inputHash: identity(input).hash,
    checkedAt: now.toISOString(), status: "review_required",
    reason: "The audited original figure shows solver scalability results, not a method or research-route overview",
    verificationBasis: null, figure: null, candidate: null, excludedFigure: { ...figure },
  };
  return figure ? { schemaVersion: 1, itemId: input.itemId, sourceRevision: input.sourceRevision, inputHash: identity(input).hash,
    checkedAt: now.toISOString(), status: "verified", reason: "Previously audited original figure for this exact source revision",
    verificationBasis: "legacy-audit", figure: { ...figure }, candidate: null } : null;
}
/** Read-only: never fetches, starts a model, or turns a candidate into an approved public figure. */
export async function getResearchPaperFigure(input: ResearchFigureInput, options: ResearchFigureOptions = {}): Promise<ResearchFigureResult | null> {
  const old = legacy(input, options.now ?? new Date());
  if (old) return old;
  let text: string;
  try { text = await readFile(cacheFile(input, options), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const value = resultSchema.parse(JSON.parse(text));
  const checksSourceInput = input.arxivId !== undefined || input.arxivVersion !== undefined || input.title !== undefined;
  if ((checksSourceInput && value.inputHash !== identity(input).hash) || value.itemId !== input.itemId || value.sourceRevision !== input.sourceRevision) throw new Error("Paper figure cache input changed; preserve the old record for review");
  if (value.status === "verified" && (!value.figure || !value.verificationBasis)) throw new Error("Verified paper figure is missing its evidence");
  if (value.figure && (value.status !== "verified" || !value.verificationBasis || value.figure.itemId !== input.itemId || value.figure.sourceRevision !== input.sourceRevision)) throw new Error("Invalid verified paper figure binding");
  return value;
}
export async function getVerifiedResearchPaperFigure(input: ResearchFigureInput, options: ResearchFigureOptions = {}): Promise<ResearchPaperFigure | null> {
  const saved = await getResearchPaperFigure(input, options);
  return saved?.status === "verified" ? saved.figure : null;
}

/** Caption matching is source attribution, not semantic or scientific validation of artwork. */
export function figureCaptionConfidence(caption: string): { confidence: "high" | "medium"; reason: string } | null {
  const text = words(caption).replace(/^(?:Figure|Fig\.)\s*\d+[.:]?\s*/i, "");
  if (/\b(?:overall|proposed|our|system|model)\s+(?:\w+\s+){0,3}(?:framework|pipeline|architecture|workflow)\b/i.test(text)
    || /\b(?:overview|schematic(?:\s+illustration)?)\s+of\s+(?:\w+[\s-]+){0,8}(?:framework|pipeline|architecture|workflow|method|approach)\b/i.test(text)
    || /^(?:The\s+)?(?:framework|pipeline|architecture|workflow)\s+(?:of|for)\b/i.test(text)) {
    return { confidence: "high", reason: "The original caption explicitly identifies a method/framework/pipeline/architecture overview" };
  }
  if (/\b(?:overview|framework|pipeline|architecture|workflow|method)\b/i.test(text)) return { confidence: "medium", reason: "Method-related caption; the figure's role requires editorial review" };
  return null;
}

function arxivUrl(value: string, prefix?: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "arxiv.org" || url.username || url.password || url.port || url.search || url.hash
    || (prefix && !url.pathname.startsWith(prefix))) throw new Error("Paper figure URL is not bound to the official arXiv version");
  return url.href;
}
function documentText(html: string, selector: string): string {
  const $ = load(html), node = $(selector).first().clone();
  node.find("math").each((_, math) => { $(math).replaceWith($(math).attr("alttext") ?? $(math).text()); });
  return words(node.text());
}
/** arXiv may render only the short title in h1 while retaining the complete title in RDF. */
function htmlPaperTitle(html: string): string {
  const $ = load(html), declared = $('div.ltx_rdf[about=""][property="dcterms:title"]');
  if (declared.length) return declared.length === 1 ? words(declared.attr("content") ?? "") : "";
  return documentText(html, "h1.ltx_title_document");
}
function licenseInfo(html: string): { name: string; url: string; reusable: boolean } | null {
  const $ = load(html), href = $(".abs-license a[href]").first().attr("href");
  if (!href) return null;
  const url = new URL(href); url.protocol = "https:";
  if (url.hostname === "creativecommons.org" && /^\/licenses\/by(?:-nc)?(?:-sa|-nd)?\/[1-4]\.0\/$/.test(url.pathname)) {
    const terms = url.pathname.split("/")[2]!;
    return { name: `CC ${terms.toUpperCase()} ${url.pathname.split("/")[3]}`, url: url.href, reusable: terms === "by" || terms === "by-sa" };
  }
  if (url.hostname === "creativecommons.org" && url.pathname === "/publicdomain/zero/1.0/") return { name: "CC0 1.0", url: url.href, reusable: true };
  if (url.hostname === "arxiv.org" && url.pathname === "/licenses/nonexclusive-distrib/1.0/") return { name: "arXiv 发布许可 · 作者保留版权", url: url.href, reusable: false };
  if (url.hostname === "creativecommons.org" || url.hostname === "arxiv.org") return { name: "原文许可（需核对图片使用权限）", url: url.href, reusable: false };
  return null;
}
const contentTypes: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml" };
export async function inspectFigureBytes(bytes: Buffer): Promise<{ width: number; height: number; contentType: string; sha256: string }> {
  if (bytes.length > 12 * 1024 * 1024) throw new Error("Paper figure exceeds the bounded image size");
  if (/<svg\b/i.test(bytes.subarray(0, 2000).toString("utf8"))) {
    const xml = bytes.toString("utf8");
    if (/<(?:script|foreignObject|image)\b|\bon\w+\s*=|<!ENTITY|\b(?:href|src)\s*=\s*["'](?!#)|url\(\s*(?!#)/i.test(xml)) throw new Error("SVG figure contains active or external content");
  }
  const meta = await sharp(bytes, { limitInputPixels: 40_000_000 }).metadata();
  const contentType = contentTypes[meta.format ?? ""];
  if (!contentType || !meta.width || !meta.height || meta.width < 240 || meta.height < 100 || (meta.pages ?? 1) !== 1) throw new Error("Figure is not a complete, readable single image");
  await sharp(bytes, { limitInputPixels: 40_000_000 }).stats(); // Decode all pixels, not only a plausible image header.
  return { width: meta.width, height: meta.height, contentType, sha256: digest(bytes) };
}

/** At most three bounded HTTP requests (abs, HTML, one complete figure); no retries, PDF crops,
 * paid services, or model calls. Missing/failed results are cached and require explicit review. */
export async function ensureResearchPaperFigure(input: ResearchFigureInput, options: ResearchFigureOptions = {}): Promise<ResearchFigureResult> {
  const existing = await getResearchPaperFigure(input, options);
  if (existing) {
    if (existing.verificationBasis !== "legacy-audit" && existing.inputHash !== identity(input).hash) throw new Error("Paper figure cache input changed; preserve the old record for review");
    return existing;
  }
  const key = identity(input), now = options.now ?? new Date();
  const base: ResearchFigureResult = { schemaVersion: 1, itemId: input.itemId, sourceRevision: input.sourceRevision, inputHash: key.hash,
    checkedAt: now.toISOString(), status: "missing", reason: "No exact arXiv paper version; original figure not inferred", verificationBasis: null, figure: null, candidate: null };
  if (!key.valid) return save(input, base, options);
  const versioned = `${key.id}${key.version}`, absUrl = `https://arxiv.org/abs/${versioned}`, htmlUrl = `https://arxiv.org/html/${versioned}`;
  async function request(url: string, maxBytes: number): Promise<GuardedResponse> {
    const fetchOptions = { timeoutMs: 25_000, maxBytes, maxRedirects: 0, headers: { accept: "text/html,image/*;q=0.9" } };
    const response = options.fetch ? await options.fetch(url, fetchOptions) : await withArxivRateLimit(url, () => guardedFetch(url, fetchOptions));
    if (response.status !== 200 || response.url !== url) throw new Error(`Original figure request did not return its exact official URL (HTTP ${response.status})`);
    return response;
  }
  try {
    const abs = await request(absUrl, 2 * 1024 * 1024), $abs = load(abs.text());
    const paperTitle = words($abs('meta[name="citation_title"]').attr("content") ?? "");
    const declaredId = $abs('meta[name="citation_arxiv_id"]').attr("content")?.replace(/v\d+$/, "");
    const authors = $abs('meta[name="citation_author"]').map((_, n) => words($abs(n).attr("content") ?? "")).get().filter(Boolean);
    const license = licenseInfo(abs.text());
    if (declaredId !== key.id || !paperTitle || !authors.length || !license) return save(input, { ...base, reason: "Official identity, title, authors, or paper license could not be established" }, options);
    const html = await request(htmlUrl, 8 * 1024 * 1024), $ = load(html.text());
    const htmlTitle = htmlPaperTitle(html.text());
    const titleMatches = !!htmlTitle && titleKey(htmlTitle) === titleKey(paperTitle) && (!input.title || titleKey(input.title) === titleKey(paperTitle));
    const baseHref = $("base[href]").first().attr("href");
    const imageBase = baseHref ? arxivUrl(new URL(baseHref, htmlUrl).href, `/html/${versioned}/`) : htmlUrl;
    const candidates = $("figure.ltx_figure").toArray().flatMap(node => {
      const f = $(node), caption = documentText($.html(f), "figcaption"), label = words(f.find(".ltx_tag_figure").first().text()).replace(/[:.]\s*$/, "");
      const score = figureCaptionConfidence(caption), id = f.attr("id");
      const visuals = f.find("img,object,svg,canvas,video");
      if (!score || !caption || caption.length > 10000 || !label || !id || visuals.length !== 1 || f.find("figure").length) return [];
      const visual = visuals.first(), src = visual.is("img") ? visual.attr("src") : visual.is('object[type="image/svg+xml"]') ? visual.attr("data") : null;
      if (!src) return [];
      try {
        const imageUrl = arxivUrl(new URL(src, imageBase).href, `/html/${versioned}/`);
        return [{ caption, label, id, score, imageUrl }];
      } catch { return []; }
    }).sort((a, b) => Number(b.score.confidence === "high") - Number(a.score.confidence === "high"));
    const chosen = candidates[0];
    if (!chosen) return save(input, { ...base, reason: "No intact single-image method figure with an explicit caption; PDF extraction was not attempted" }, options);
    const image = await request(chosen.imageUrl, 12 * 1024 * 1024), inspected = await inspectFigureBytes(image.body);
    const figure: ResearchPaperFigure = { itemId: input.itemId, sourceRevision: input.sourceRevision, imageOrigin: "remote", imageUrl: chosen.imageUrl,
      sourceUrl: `${htmlUrl}#${encodeURIComponent(chosen.id)}`, figureLabel: `原文 ${chosen.label}`, caption: chosen.caption,
      attribution: `${authors.slice(0, 3).join("; ")}${authors.length > 3 ? " et al." : ""} · ${paperTitle} (arXiv ${key.version})`,
      licenseName: license.name, licenseUrl: license.url, verifiedAt: now.toISOString(), ...inspected };
    const candidate: ResearchFigureCandidate = { figure, arxivId: key.id!, arxivVersion: key.version!, paperTitle,
      confidence: chosen.score.confidence, selectionReason: chosen.score.reason, htmlSha256: digest(html.body), abstractSha256: digest(abs.body),
      licenseAllowsReuse: license.reusable, titleMatches };
    const verified = titleMatches && license.reusable && chosen.score.confidence === "high";
    // The private image is for editorial inspection; the public contract retains the original host.
    const assets = path.join(path.dirname(cacheFile(input, options)), "images");
    await mkdir(assets, { recursive: true, mode: 0o700 });
    await writeFile(path.join(assets, inspected.sha256), image.body, { mode: 0o600 });
    return save(input, { ...base, status: verified ? "verified" : "review_required", reason: verified ? chosen.score.reason : "Caption role, title binding, or image reuse permission needs editorial review",
      verificationBasis: verified ? "source-caption" : null, figure: verified ? figure : null, candidate }, options);
  } catch (error) {
    return save(input, { ...base, status: "unavailable", reason: error instanceof Error ? error.message : String(error) }, options);
  }
}

/** Register one complete original HTML image explicitly selected by an editor, including
 * captions the automatic method heuristic does not recognize. No network or automatic approval. */
export async function registerResearchHtmlFigureCandidate(input: ResearchFigureInput, source: {
  abstractHtml: Buffer; html: Buffer; image: Buffer; figureId: string; imageUrl: string;
}, options: ResearchFigureOptions = {}): Promise<ResearchFigureResult> {
  const key = identity(input), previous = await getResearchPaperFigure(input, options);
  if (!key.valid || !input.title || source.abstractHtml.length > 2 * 1024 * 1024 || source.html.length > 8 * 1024 * 1024) {
    throw new Error("HTML figure lacks bounded, version-bound source evidence");
  }
  if (previous && (previous.status === "verified" || previous.inputHash !== key.hash)) throw new Error("Preserve the already verified or differently bound figure record");
  const $abs = load(source.abstractHtml.toString("utf8")), $ = load(source.html.toString("utf8"));
  const titles = $abs('meta[name="citation_title"]'), ids = $abs('meta[name="citation_arxiv_id"]');
  const paperTitle = words(titles.attr("content") ?? ""), declaredId = ids.attr("content") ?? "";
  const declaredVersion = declaredId.match(/(v\d+)$/)?.[1];
  const authors = $abs('meta[name="citation_author"]').map((_, n) => words($abs(n).attr("content") ?? "")).get().filter(Boolean);
  const titleMatches = titleKey(htmlPaperTitle(source.html.toString("utf8"))) === titleKey(paperTitle)
    && titleKey(input.title) === titleKey(paperTitle);
  if (titles.length !== 1 || ids.length !== 1 || declaredId.replace(/v\d+$/, "") !== key.id || (declaredVersion && declaredVersion !== key.version)
    || !titleKey(paperTitle) || !authors.length || !titleMatches) throw new Error("HTML figure source identity or title does not match");
  const license = licenseInfo(source.abstractHtml.toString("utf8"));
  const licenseUrl = license ? new URL(license.url) : null;
  if (!license?.reusable || !licenseUrl || licenseUrl.username || licenseUrl.password || licenseUrl.port || licenseUrl.search || licenseUrl.hash
    || $abs(".abs-license a[href]").length !== 1) throw new Error("HTML figure source does not establish reusable image permission");
  const versioned = `${key.id}${key.version}`, htmlUrl = `https://arxiv.org/html/${versioned}`;
  const nodes = $("figure.ltx_figure").toArray().filter(node => $(node).attr("id") === source.figureId);
  const figureNode = $(nodes[0]), captionNode = figureNode.children("figcaption");
  const visuals = figureNode.find("img,object,svg,canvas,video"), visual = visuals.first();
  const src = visual.is("img") ? visual.attr("src") : visual.is('object[type="image/svg+xml"]') ? visual.attr("data") : null;
  const caption = documentText($.html(captionNode), "figcaption"), label = words(captionNode.find(".ltx_tag_figure").first().text()).replace(/[:.]\s*$/, "");
  if (!source.figureId || nodes.length !== 1 || captionNode.length !== 1 || !caption || !label || visuals.length !== 1 || !src
    || figureNode.find("figure,picture,source").length || visual.attr("srcset")) throw new Error("HTML figure must be one complete image with an unambiguous caption");
  const bases = $("base[href]"), baseHref = bases.attr("href");
  if (bases.length > 1) throw new Error("HTML figure has ambiguous source URL bases");
  const imageBase = baseHref ? arxivUrl(new URL(baseHref, htmlUrl).href, `/html/${versioned}/`) : htmlUrl;
  const imageUrl = arxivUrl(new URL(src, imageBase).href, `/html/${versioned}/`);
  if (arxivUrl(source.imageUrl, `/html/${versioned}/`) !== imageUrl) throw new Error("HTML figure image URL does not match the selected original image");
  const inspected = await inspectFigureBytes(source.image);
  if (visual.is("object") && inspected.contentType !== "image/svg+xml") throw new Error("HTML SVG object bytes do not match the declared image type");
  const now = (options.now ?? new Date()).toISOString();
  const figure: ResearchPaperFigure = { itemId: input.itemId, sourceRevision: input.sourceRevision, imageOrigin: "remote", imageUrl,
    sourceUrl: `${htmlUrl}#${encodeURIComponent(source.figureId)}`, figureLabel: `原文 ${label}`, caption,
    attribution: `${authors.slice(0, 3).join("; ")}${authors.length > 3 ? " et al." : ""} · ${paperTitle} (arXiv ${key.version})`,
    licenseName: license.name, licenseUrl: license.url, verifiedAt: now, ...inspected };
  const candidate: ResearchFigureCandidate = { figure, arxivId: key.id!, arxivVersion: key.version!, paperTitle,
    confidence: "medium", selectionReason: "Explicitly selected complete HTML figure requires visual editorial review",
    htmlSha256: digest(source.html), abstractSha256: digest(source.abstractHtml), licenseAllowsReuse: license.reusable, titleMatches };
  candidateSchema.parse(candidate);
  const root = path.dirname(cacheFile(input, options));
  await mkdir(path.join(root, "images"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, "sources"), { recursive: true, mode: 0o700 });
  if (previous) await writeFile(path.join(root, "sources", `${input.itemId}-r${input.sourceRevision}-${randomUUID()}.prior.json`), JSON.stringify(previous, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  for (const [name, bytes] of [[`${candidate.abstractSha256}.abs.html`, source.abstractHtml], [`${candidate.htmlSha256}.html`, source.html]] as const) {
    await writeFile(path.join(root, "sources", name), bytes, { mode: 0o600 });
  }
  await writeFile(path.join(root, "images", inspected.sha256), source.image, { mode: 0o600 });
  return save(input, { schemaVersion: 1, itemId: input.itemId, sourceRevision: input.sourceRevision, inputHash: key.hash,
    checkedAt: now, status: "review_required", reason: "Complete original HTML figure selected; exact image requires editorial review",
    verificationBasis: null, figure: null, candidate }, options);
}

/** Register an editor-extracted complete PDF figure against the exact official source files.
 * No network, model, inferred crop, or automatic approval. The original failed selection is
 * retained, and publication still requires visual review of the resulting PNG's exact hash. */
export async function registerResearchPdfFigureCandidate(input: ResearchFigureInput, source: {
  abstractHtml: Buffer; html: Buffer; pdf: Buffer; png: Buffer;
  figureId: string; pageNumber: number; bounds: [number, number, number, number]; dpi: number;
}, options: ResearchFigureOptions = {}): Promise<ResearchFigureResult> {
  const key = identity(input), previous = await getResearchPaperFigure(input, options);
  if (!key.valid || !input.title || !source.pdf.subarray(0, 5).equals(Buffer.from("%PDF-")) || source.pdf.length > 30 * 1024 * 1024
    || source.abstractHtml.length > 2 * 1024 * 1024 || source.html.length > 8 * 1024 * 1024) throw new Error("PDF extraction lacks bounded, version-bound source evidence");
  if (previous && (previous.status === "verified" || previous.inputHash !== key.hash)) throw new Error("Preserve the already verified or differently bound figure record");
  const $abs = load(source.abstractHtml.toString("utf8")), $ = load(source.html.toString("utf8"));
  const paperTitle = words($abs('meta[name="citation_title"]').attr("content") ?? "");
  const declaredId = $abs('meta[name="citation_arxiv_id"]').attr("content")?.replace(/v\d+$/, "");
  const authors = $abs('meta[name="citation_author"]').map((_, n) => words($abs(n).attr("content") ?? "")).get().filter(Boolean);
  const license = licenseInfo(source.abstractHtml.toString("utf8"));
  const nodes = $("figure.ltx_figure").toArray().filter(node => $(node).attr("id") === source.figureId);
  const captionNode = $(nodes[0]).children("figcaption");
  const caption = documentText($.html(captionNode), "figcaption");
  const label = words(captionNode.find(".ltx_tag_figure").first().text()).replace(/[:.]\s*$/, "");
  const titleMatches = titleKey(htmlPaperTitle(source.html.toString("utf8"))) === titleKey(paperTitle)
    && titleKey(input.title) === titleKey(paperTitle);
  if (declaredId !== key.id || !paperTitle || !authors.length || !license || !titleMatches || nodes.length !== 1 || !caption || !label
    || source.bounds[0] >= source.bounds[2] || source.bounds[1] >= source.bounds[3]) throw new Error("PDF extraction source identity, title, caption, or bounds do not match");
  const inspected = await inspectFigureBytes(source.png);
  if (inspected.contentType !== "image/png") throw new Error("PDF extraction must be a decoded PNG");
  const now = (options.now ?? new Date()).toISOString(), versioned = `${key.id}${key.version}`;
  const figure: ResearchPaperFigure = { itemId: input.itemId, sourceRevision: input.sourceRevision, imageOrigin: "pdf-extract",
    imageUrl: `/paper-figures/${input.itemId}-r${input.sourceRevision}-${inspected.sha256.slice(0, 16)}.png`,
    sourceUrl: `https://arxiv.org/pdf/${versioned}#page=${source.pageNumber}`, figureLabel: `原文 ${label} · PDF 第 ${source.pageNumber} 页`, caption,
    attribution: `${authors.slice(0, 3).join("; ")}${authors.length > 3 ? " et al." : ""} · ${paperTitle} (arXiv ${key.version})`,
    licenseName: license.name, licenseUrl: license.url, verifiedAt: now, ...inspected };
  const candidate: ResearchFigureCandidate = { figure, arxivId: key.id!, arxivVersion: key.version!, paperTitle,
    confidence: "medium", selectionReason: "Complete PDF figure extraction requires explicit visual editorial review",
    htmlSha256: digest(source.html), abstractSha256: digest(source.abstractHtml), licenseAllowsReuse: license.reusable, titleMatches,
    pdfExtraction: { pdfSha256: digest(source.pdf), pageNumber: source.pageNumber, bounds: source.bounds, dpi: source.dpi, htmlFigureId: source.figureId } };
  candidateSchema.parse(candidate);
  const root = path.dirname(cacheFile(input, options));
  await mkdir(path.join(root, "images"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, "sources"), { recursive: true, mode: 0o700 });
  if (previous) await writeFile(path.join(root, "sources", `${input.itemId}-r${input.sourceRevision}-${randomUUID()}.prior.json`), JSON.stringify(previous, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  for (const [name, bytes] of [[`${candidate.pdfExtraction!.pdfSha256}.pdf`, source.pdf], [`${candidate.abstractSha256}.abs.html`, source.abstractHtml], [`${candidate.htmlSha256}.html`, source.html]] as const) {
    await writeFile(path.join(root, "sources", name), bytes, { mode: 0o600 });
  }
  await writeFile(path.join(root, "images", inspected.sha256), source.png, { mode: 0o600 });
  return save(input, { schemaVersion: 1, itemId: input.itemId, sourceRevision: input.sourceRevision, inputHash: key.hash,
    checkedAt: now, status: "review_required", reason: "Complete PDF figure extracted; source permission and exact image require editorial review",
    verificationBasis: null, figure: null, candidate }, options);
}

/** An editor must inspect the exact cached bytes and source before approving a weaker caption.
 * This entry point cannot grant missing copyright permission. */
export async function approveResearchPaperFigure(input: ResearchFigureInput, review: { sha256: string; reviewer: string; note: string }, options: ResearchFigureOptions = {}): Promise<ResearchFigureResult> {
  const saved = await getResearchPaperFigure(input, options), candidate = saved?.candidate;
  if (!saved || saved.status !== "review_required" || !candidate || !candidate.licenseAllowsReuse || !candidate.titleMatches
    || candidate.figure.sha256 !== review.sha256 || !review.reviewer.trim() || !review.note.trim()) throw new Error("Paper figure review does not match a reusable, source-bound candidate");
  const bytes = await readFile(path.join(path.dirname(cacheFile(input, options)), "images", review.sha256));
  if (digest(bytes) !== review.sha256) throw new Error("Reviewed original figure bytes changed");
  if (candidate.figure.imageOrigin === "pdf-extract") {
    if (!candidate.pdfExtraction || !/^\/paper-figures\/[A-Za-z0-9_-]+\.png$/.test(candidate.figure.imageUrl)) throw new Error("Reviewed PDF extraction lacks provenance or a bounded public path");
    const publicDir = options.publicImageDir ?? path.join(REPO_ROOT, "apps/web/public/paper-figures");
    await mkdir(publicDir, { recursive: true });
    const file = path.join(publicDir, path.basename(candidate.figure.imageUrl));
    try { await writeFile(file, bytes, { flag: "wx", mode: 0o644 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || digest(await readFile(file)) !== review.sha256) throw error;
    }
  }
  const reviewedAt = (options.now ?? new Date()).toISOString();
  return save(input, { ...saved, status: "verified", verificationBasis: "editorial-review", reason: review.note.trim(), figure: { ...candidate.figure, verifiedAt: reviewedAt },
    review: { reviewer: review.reviewer.trim(), note: review.note.trim(), reviewedAt } }, options);
}
