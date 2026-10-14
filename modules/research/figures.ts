// Figures for selected papers, attached after the fact and never in the way of publishing: a paper is
// collected, judged and published without one; this job later looks for a figure the licence lets the site
// reuse (CC BY, CC BY-SA, CC0) and, when it finds one, stores it in the material (raw.figure) with its credit,
// which the public read layer shows (publication/items.ts itemFigure). Otherwise the paper keeps "配图 待补",
// saying why. arXiv: the licence on the abstract page, the first figure of the HTML version. Journals: the
// licence Crossref registered, the image the publisher's page announces (og:image).
import { load } from "cheerio";
import type { ItemNote } from "@aihot/contracts/site";
import { sql } from "@aihot/backend/db";
import { emit } from "@aihot/backend/modules";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { collapseWhitespace } from "@aihot/backend/lib/text";
import { logError } from "@aihot/backend/lib/log-error";
import { shutdownSignal } from "@aihot/backend/jobs/queue";
import { licenseLabel } from "./crossref.ts";

/** Papers looked at per run, newest selected first. */
const PER_RUN = 12;
/** A paper is looked at again after this long, at most this many times (an HTML version appears later). */
const RETRY_MS = 12 * 3600_000;
const MAX_ATTEMPTS = 3;
const ARXIV_GAP_MS = 3100;

/** What a lookup found. */
export type Found =
  | { status: "ok"; url: string; alt: string | null; credit: string; href: string; license: string }
  | { status: "license" | "none"; license: string | null; reason: string };
/** What is stored: the last lookup, when it ran and how many there were. */
export type FigureState = Found & { checkedAt: string; attempts: number };

/** Licences that allow reuse with attribution. */
export function reusable(license: string | null): boolean {
  return !!license && /creativecommons\.org\/(licenses\/(by|by-sa)\/|publicdomain\/zero\/)/i.test(license);
}

/** The licence link on an arXiv abstract page. */
export function arxivLicense(html: string): string | null {
  const $ = load(html);
  return $(".abs-license a[href]").first().attr("href") ?? null;
}

/** The first figure (not an algorithm or table float) of an arXiv HTML paper, resolved against its address. */
export function firstArxivFigure(html: string, pageUrl: string): { url: string; caption: string | null } | null {
  const $ = load(html);
  for (const node of $("figure.ltx_figure").toArray()) {
    const img = $(node).find("img[src]").first();
    const src = img.attr("src");
    if (!src) continue;
    const width = Number(img.attr("width") ?? 0);
    if (width && width < 120) continue;
    const caption = $(node).children("figcaption").first().clone();
    caption.find(".ltx_tag").remove();
    const text = collapseWhitespace(caption.text());
    return { url: new URL(src, pageUrl).toString(), caption: text ? text.slice(0, 300) : null };
  }
  return null;
}

/** The image a publisher's article page announces, unless it is plainly a logo, cover or placeholder. */
export function pageImage(html: string, pageUrl: string): string | null {
  const $ = load(html);
  const src = $('meta[property="og:image"]').attr("content") ?? $('meta[name="twitter:image"]').attr("content");
  if (!src) return null;
  const url = new URL(src, pageUrl).toString();
  return /logo|cover|default|placeholder|favicon|share-image|social/i.test(url) ? null : url;
}

/** The paper's "配图" note, as the figure state now says. */
export function figureNote(state: FigureState): ItemNote {
  if (state.status === "ok") return { label: "配图", value: `已附 · ${licenseLabel(state.license)}`, href: state.href };
  if (state.status === "license") return { label: "配图", value: "待补（许可不允许转载）" };
  return { label: "配图", value: "待补" };
}

async function get(url: string): Promise<{ text: string; url: string } | null> {
  const res = await guardedFetch(url, { timeoutMs: 30_000, maxBytes: 16 * 1024 * 1024 });
  return res.status === 200 ? { text: res.text(), url: res.url } : null;
}

let lastArxiv = 0;
async function arxivGet(url: string) {
  const wait = lastArxiv + ARXIV_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastArxiv = Date.now();
  return get(url);
}

type Paper = { id: string; raw: Record<string, any> };

/** What a paper's figure is, looked up now (fetchers injectable for tests). */
export async function lookFor(paper: Paper, fetchers = { arxiv: arxivGet, page: get }): Promise<Found> {
  if (paper.raw.kind === "arxiv") {
    const id = String(paper.raw.arxivId);
    const abs = await fetchers.arxiv(`https://arxiv.org/abs/${id}`);
    const license = abs ? arxivLicense(abs.text) : null;
    if (!reusable(license)) return { status: "license", license, reason: license ? "licence does not allow reuse" : "no licence found" };
    const html = await fetchers.arxiv(`https://arxiv.org/html/${id}`);
    const figure = html ? firstArxivFigure(html.text, html.url) : null;
    if (!figure) return { status: "none", license, reason: html ? "no figure in the HTML version" : "no HTML version yet" };
    return { status: "ok", url: figure.url, alt: figure.caption, credit: `arXiv:${id} 图 1 · ${licenseLabel(license!)}`, href: html!.url, license: license! };
  }
  const doi = String(paper.raw.doi);
  const license = typeof paper.raw.license === "string" ? paper.raw.license : null;
  if (!reusable(license)) return { status: "license", license, reason: license ? "licence does not allow reuse" : "no open licence registered" };
  const page = await fetchers.page(`https://doi.org/${doi}`);
  const url = page ? pageImage(page.text, page.url) : null;
  if (!url) return { status: "none", license, reason: page ? "the page announces no figure" : "the publisher page could not be read" };
  return { status: "ok", url, alt: null, credit: `${paper.raw.journal ?? "原文"} · ${licenseLabel(license!)}`, href: page!.url, license: license! };
}

/** Stores a figure state and the note that says it, and tells the public exits. */
export async function saveFigure(articleId: string, state: FigureState): Promise<void> {
  await sql.begin(async (tx) => {
    const [row] = await tx<{ raw: Record<string, any> }[]>`SELECT raw FROM articles WHERE id = ${articleId} FOR UPDATE`;
    if (!row) return;
    const notes = (Array.isArray(row.raw?.notes) ? row.raw.notes : []).filter((n: ItemNote) => n?.label !== "配图");
    await tx`UPDATE articles SET raw = ${tx.json({ ...row.raw, figure: state, notes: [...notes, figureNote(state)] } as never)} WHERE id = ${articleId}`;
    await emit("articleChanged", { id: articleId, kind: "detail", reason: "research figure" }, tx);
  });
}

/** Selected papers of the last two weeks still without a figure, due for a look. */
async function due(limit: number): Promise<Paper[]> {
  return sql<Paper[]>`
    SELECT a.id, a.raw FROM articles a JOIN publications p ON p.article_id = a.id
    WHERE p.selected AND p.visibility = 'public' AND a.raw->>'kind' IN ('arxiv', 'crossref')
      AND a.timeline_at > now() - interval '14 days'
      AND (a.raw->'figure' IS NULL OR (a.raw->'figure'->>'status' = 'none'
        AND coalesce((a.raw->'figure'->>'attempts')::int, 0) < ${MAX_ATTEMPTS}
        AND (a.raw->'figure'->>'checkedAt')::timestamptz < now() - ${`${RETRY_MS / 1000} seconds`}::interval))
    ORDER BY a.timeline_at DESC LIMIT ${limit}`;
}

export async function attachFigures(limit = PER_RUN): Promise<{ looked: number; attached: number }> {
  let attached = 0;
  const papers = await due(limit);
  for (const paper of papers) {
    if (shutdownSignal.signal.aborted) break;
    const attempts = Number(paper.raw.figure?.attempts ?? 0) + 1;
    let found: Found;
    try {
      found = await lookFor(paper);
    } catch (error) {
      console.error(JSON.stringify({ level: "warn", msg: "research figure lookup failed", article: paper.id, error: logError(error) }));
      found = { status: "none", license: null, reason: "lookup failed" };
    }
    await saveFigure(paper.id, { ...found, checkedAt: new Date().toISOString(), attempts });
    if (found.status === "ok") attached += 1;
  }
  return { looked: papers.length, attached };
}
