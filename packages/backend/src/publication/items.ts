// Public read layer, item level. Every exit (site API, v1, RSS, MCP, sitemap) reads
// items through these columns and views; which rows are public is decided by scope.ts.
import { CATEGORY_KEYS, toPublicApiCategory, type CategoryKey, type ChannelKey, type PublicApiCategoryKey } from "@aihot/contracts/taxonomy";
import { ITEM_NOTES_MAX, type FeedItemSummary, type ItemFigure, type ItemNote, type ItemSummary, type MediaView, type XPostView } from "@aihot/contracts/site";
import { POLICY } from "@aihot/site";
import { sql, type Db } from "../db.ts";
import { isEmptyOrLinkOnly } from "../content/posts.ts";
import { proxiedImage, proxiedImageSet } from "../media/imgproxy.ts";
import { sourceOwnsPost } from "../sources/account.ts";
import { displayTags, publicSourceName } from "./rules.ts";
import { foldableSelectionCondition, seatedCondition } from "./scope.ts";

export interface ItemRow {
  id: string;
  title: string;
  original_title: string | null;
  summary: string | null;
  reason: string | null;
  category: string | null;
  tags: string[];
  score: number | null;
  selected: boolean;
  channel: "news" | "x";
  url: string;
  published_at: Date | null;
  discovered_at: Date;
  timeline_at: Date;
  /** Holds its fact's selected seat (publish.ts settleSeats). */
  seat: boolean;
  visibility: string;
  body_mode: "full" | "summary";
  indexable: boolean;
  fact_id: number | null;
  source_name: string;
  /** Participation mode of the source now (editorial, hot_signal, isolated). */
  source_mode: string;
  x_post: Record<string, any> | null;
  /** Current source icon only when that account is this post's author. */
  author_avatar_url?: string | null;
  author: string | null;
  language: string | null;
  story_public_id: string | null;
  story_title: string | null;
  zh_text: string | null;
  /** Chinese translation of the post an X post quotes. */
  quoted_zh: string | null;
  /** The material's notes as its entrance stored them (raw.notes), checked by itemNotes. */
  notes: unknown;
  /** The figure its entrance attached (raw.figure), checked by itemFigure. */
  figure: unknown;
}

/** Columns every item listing selects. Internal judgement details never leave this layer. */
export const ITEM_COLUMNS = sql`
  p.article_id AS id, p.title, p.original_title, p.summary, p.reason, p.category, p.tags, p.score,
  p.selected, p.seat, p.channel, p.url, p.published_at, p.discovered_at, p.timeline_at, p.visibility,
  p.body_mode, p.indexable, p.fact_id, s.name AS source_name, s.participation_mode AS source_mode,
  a.x_post, a.author, a.language,
  CASE WHEN s.kind = 'x_search' AND ${sourceOwnsPost(sql`s.name`, sql`a.x_post->>'handle'`)} THEN s.icon_url END AS author_avatar_url,
  st.public_id::text AS story_public_id, st.title AS story_title,
  CASE WHEN p.channel = 'x' THEN tr.body_text END AS zh_text, qt.text_zh AS quoted_zh, a.raw->'notes' AS notes, a.raw->'figure' AS figure`;

/** Public API listings never render article bodies, X media or story metadata. */
export type ApiItemRow = Pick<ItemRow, "id" | "title" | "original_title" | "summary" | "source_name" | "url" | "published_at" | "discovered_at" | "category" | "score" | "selected" | "reason">;
/** `selected` is the machine meaning: the report holds its fact's selected seat (scope.ts seatedCondition). */
export const API_ITEM_COLUMNS = sql`
  p.article_id AS id, p.title, p.original_title, p.summary, s.name AS source_name, p.url,
  p.published_at, p.discovered_at, p.category, p.score, (p.selected AND p.seat) AS selected, p.reason`;
export const API_ITEM_FROM = sql`FROM publications p JOIN sources s ON s.id = p.source_id`;

/** A translation of an older revision is left out: the original changed after it (the worker translates it again). */
export const ITEM_FROM = sql`
  FROM publications p
  JOIN sources s ON s.id = p.source_id
  JOIN articles a ON a.id = p.article_id
  LEFT JOIN stories st ON st.id = p.story_id AND st.merged_into IS NULL
  LEFT JOIN translations tr ON tr.article_id = p.article_id AND tr.lang = 'zh' AND tr.revision >= a.revision
  LEFT JOIN quote_translations qt ON p.channel = 'x' AND qt.tweet_id = substring(a.x_post->'quoted'->>'url' from '/status/([0-9]+)')`;

export function channelCondition(channel: ChannelKey | null | undefined) {
  if (!channel || channel === "all") return sql``;
  if (channel === "firstParty") return sql`AND p.source_id IN (SELECT id FROM sources WHERE tier = 'T1')`;
  return sql`AND p.channel = ${channel}`;
}

/** The website's filter: one of its own categories. */
export function categoryCondition(category: CategoryKey | null | undefined) {
  if (!category) return sql``;
  return sql`AND p.category = ${category}`;
}

/** The public API's, RSS's and MCP's filter: every category the site publishes as this one (PUBLIC_CATEGORIES). */
export function publicCategoryCondition(category: PublicApiCategoryKey | null | undefined) {
  if (!category) return sql``;
  return sql`AND p.category IN ${sql(CATEGORY_KEYS.filter((k) => toPublicApiCategory(k) === category))}`;
}

export function tagCondition(tag: string | null | undefined) {
  if (!tag) return sql``;
  return sql`AND p.tags @> ${[tag]}::text[]`;
}

function mediaView(m: Record<string, any>, mode: "card" | "thumb" | "full" = "thumb", responsive = false): MediaView | null {
  const url = proxiedImage(m.url, mode);
  if (!url) return null;
  const srcSet = responsive ? proxiedImageSet(m.poster ?? m.url, mode === "full" ? "body" : "card") : null;
  return {
    kind: m.kind === "video" ? "video" : "image",
    url,
    ...(responsive && mode !== "full" ? { fullUrl: proxiedImage(m.url, "full")! } : {}),
    ...(srcSet ? { srcSet } : {}),
    width: typeof m.width === "number" ? m.width : null,
    height: typeof m.height === "number" ? m.height : null,
    alt: m.alt ?? null,
    poster: m.poster ? proxiedImage(m.poster, mode === "card" ? "card" : "thumb") : null,
  };
}

export function xView(row: Pick<ItemRow, "x_post" | "zh_text"> & Partial<Pick<ItemRow, "quoted_zh" | "author_avatar_url">>, compact = false, responsive = compact): XPostView | null {
  const x = row.x_post;
  if (!x) return null;
  const quoted = x.quoted && typeof x.quoted === "object"
    ? {
      authorName: String(x.quoted.authorName ?? ""), handle: String(x.quoted.handle ?? ""), text: String(x.quoted.text ?? ""), url: String(x.quoted.url ?? ""),
      translation: !isEmptyOrLinkOnly(String(x.quoted.text ?? "")) && row.quoted_zh && row.quoted_zh.trim() !== String(x.quoted.text ?? "").trim() ? row.quoted_zh : null,
    }
    : null;
  const media = ((x.media ?? []) as Array<Record<string, any>>)
    .map((raw) => ({ raw, view: mediaView(raw, compact || !responsive ? "thumb" : "full", responsive) }))
    .filter((entry): entry is { raw: Record<string, any>; view: MediaView } => entry.view !== null);
  const avatarUrl = row.author_avatar_url ?? x.avatarUrl;
  const avatarSrcSet = responsive ? proxiedImageSet(avatarUrl, "avatar") : null;
  return {
    authorName: String(x.authorName ?? x.handle ?? ""),
    handle: String(x.handle ?? ""),
    avatarUrl: proxiedImage(avatarUrl, "avatar"),
    ...(avatarSrcSet ? { avatarSrcSet } : {}),
    text: String(x.text ?? ""),
    translation: !isEmptyOrLinkOnly(String(x.text ?? "")) && row.zh_text && row.zh_text.trim() !== String(x.text ?? "").trim() ? row.zh_text : null,
    quoted,
    // A multi-image list grid is 112 CSS px wide; one image can be 240 px. Keep 3x pixels for both.
    // Detail retains full media for the lightbox; srcSet bounds the displayed image.
    media: media.map(({ raw, view }) => compact && media.length > 1 ? mediaView(raw, "card", responsive)! : view),
  };
}

/**
 * Whether pages show an X post's own text and media. A site that counts them as full text shows them
 * only where the source allows full text, as it does an article's body.
 */
export function showsPost(row: { channel: string; body_mode: string }): boolean {
  return row.channel === "x" && (!POLICY.xPostIsFullText || row.body_mode === "full");
}

const NOTE_TEXT_MAX = 80;

/**
 * The notes an entrance stored with the material (raw.notes): only short text and http(s) links leave this
 * layer, whatever the raw payload holds.
 */
export function itemNotes(value: unknown): ItemNote[] {
  if (!Array.isArray(value)) return [];
  const out: ItemNote[] = [];
  for (const n of value) {
    if (!n || typeof n !== "object" || typeof n.label !== "string" || !n.label.trim()) continue;
    const note: ItemNote = { label: n.label.trim().slice(0, NOTE_TEXT_MAX) };
    if (typeof n.value === "string" && n.value.trim()) note.value = n.value.trim().slice(0, NOTE_TEXT_MAX);
    if (typeof n.href === "string" && /^https?:\/\//.test(n.href)) {
      try { note.href = new URL(n.href).toString(); } catch { /* not a link */ }
    }
    out.push(note);
    if (out.length >= ITEM_NOTES_MAX) break;
  }
  return out;
}

/**
 * The figure an entrance attached (raw.figure, status "ok"): an http(s) image, its credit and the page it
 * is from, shown through the image proxy. Anything else shows no figure.
 */
export function itemFigure(value: unknown): ItemFigure | null {
  const f = value as { status?: unknown; url?: unknown; alt?: unknown; credit?: unknown; href?: unknown } | null;
  if (!f || f.status !== "ok" || typeof f.url !== "string" || typeof f.credit !== "string" || !f.credit.trim()) return null;
  const url = proxiedImage(f.url, "full");
  const card = proxiedImage(f.url, "card");
  if (!url || !card) return null;
  const srcSet = proxiedImageSet(f.url, "card");
  return {
    url: card, fullUrl: url, ...(srcSet ? { srcSet } : {}),
    alt: typeof f.alt === "string" && f.alt.trim() ? f.alt.trim().slice(0, 300) : null,
    credit: f.credit.trim().slice(0, 200),
    href: typeof f.href === "string" && /^https?:\/\//.test(f.href) ? f.href : null,
  };
}

/** The shared public article; its X post is added as each answer shows it. */
export function toItemSummary(row: ItemRow): ItemSummary {
  return {
    id: row.id,
    title: row.title,
    originalTitle: row.original_title,
    summary: row.summary,
    reason: row.selected ? row.reason : null,
    source: { name: publicSourceName(row.source_name) },
    links: { original: row.url },
    publishedAt: row.published_at?.toISOString() ?? null,
    discoveredAt: row.discovered_at.toISOString(),
    timelineAt: row.timeline_at.toISOString(),
    category: (row.category as CategoryKey | null) ?? null,
    tags: displayTags(row.tags),
    score: row.score === null ? null : Math.round(Number(row.score)),
    selected: row.selected,
    channel: row.channel,
    story: row.story_public_id ? { publicId: row.story_public_id, title: row.story_title ?? "" } : null,
    notes: itemNotes(row.notes),
    ...withFigure(row.figure),
  };
}

const withFigure = (raw: unknown) => {
  const figure = itemFigure(raw);
  return figure ? { figure } : {};
};

/** Project the shared public article into the exact fields a site card renders. */
export function toFeedItemSummary(row: ItemRow): FeedItemSummary {
  const item = toItemSummary(row);
  const x = showsPost(row) ? xView(row, true) : null;
  return {
    id: item.id, title: item.title, summary: item.summary ?? (x?.text || null), reason: item.reason,
    source: item.source, publishedAt: item.publishedAt, timelineAt: item.timelineAt,
    category: item.category, tags: item.tags, score: item.score, selected: item.selected, channel: item.channel, notes: item.notes, ...(item.figure ? { figure: item.figure } : {}),
    x: x ? {
      authorName: x.authorName, handle: x.handle, avatarUrl: x.avatarUrl,
      ...(x.avatarSrcSet ? { avatarSrcSet: x.avatarSrcSet } : {}), media: x.media,
      quoted: x.quoted ? { authorName: x.quoted.authorName, handle: x.quoted.handle, text: x.quoted.text, translation: x.quoted.translation } : null,
    } : null,
  };
}

/**
 * An article written in Chinese: its language says so, or its text opens in Chinese and it is not marked
 * English (the translator's rule, editorial/translate.ts). Every exit shows such a body as it is.
 */
export function isChineseBody(a: { language?: string | null; body_text?: string | null }): boolean {
  return a.language === "zh" || (/[一-鿿]/.test(a.body_text?.slice(0, 400) ?? "") && a.language !== "en");
}

/** The complete Chinese translation an export (Markdown, full RSS) carries; a page also shows a partial one. */
export function exportTranslation(a: { language?: string | null; body_text?: string | null; tr_html?: string | null; tr_complete?: boolean | null }): string | null {
  return !isChineseBody(a) && a.tr_html && a.tr_complete ? a.tr_html : null;
}

/**
 * For listed rows that are selected but yield their fact's seat: the report holding it, by row id.
 * (The home timeline folds these into reading groups; flat lists say which report stands for them.)
 */
export async function seatHolders(rows: ItemRow[], now: Date, db: Db = sql): Promise<Map<string, { id: string; title: string }>> {
  const yielding = rows.filter((r) => r.selected && !r.seat && r.fact_id !== null);
  if (!yielding.length) return new Map();
  const holders = await db<{ fact_id: number; id: string; title: string }[]>`
    SELECT p.fact_id, p.article_id AS id, p.title FROM publications p
    WHERE p.fact_id IN ${db([...new Set(yielding.map((r) => r.fact_id!))])} AND ${seatedCondition(now)} AND ${foldableSelectionCondition()}`;
  const byFact = new Map(holders.map((h) => [Number(h.fact_id), { id: h.id, title: h.title }]));
  return new Map(yielding.flatMap((r) => (byFact.has(Number(r.fact_id)) ? [[r.id, byFact.get(Number(r.fact_id))!] as const] : [])));
}
