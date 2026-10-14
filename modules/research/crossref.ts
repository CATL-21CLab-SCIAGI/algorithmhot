// Journal articles from Crossref (https://api.crossref.org/journals/<issn>/works), newest registrations first.
// A journal article goes online on its Crossref "published-online" day (its first online date); without
// one, on the day this site found it. A date is a day, not a time: the timeline rule
// (content/materials.ts decideTimeline) keeps it on that day, at the time it was found when found that day.
import type { ItemNote } from "@aihot/contracts/site";
import { sanitizeBody } from "@aihot/backend/content/sanitize";
import { collapseWhitespace, stripTags } from "@aihot/backend/lib/text";
import type { CrossrefFeed } from "./feeds.ts";

export interface CrossrefArticle {
  doi: string;
  url: string;
  title: string;
  authors: string | null;
  abstractHtml: string | null;
  abstractText: string | null;
  journal: string | null;
  /** First online day (YYYY-MM-DD), or null when Crossref has none to the day. */
  onlineDay: string | null;
  /** A Creative Commons licence the publisher registered, if any. */
  license: string | null;
}

const SELECT = "DOI,title,abstract,author,published-online,URL,license,type,container-title";

export function worksUrl(issn: string, since: string, mailto?: string | null): string {
  const params = new URLSearchParams({
    filter: `from-created-date:${since},type:journal-article`,
    sort: "created", order: "desc", rows: "200", select: SELECT,
  });
  if (mailto) params.set("mailto", mailto);
  return `https://api.crossref.org/journals/${issn}/works?${params}`;
}

function day(parts: unknown): string | null {
  const p = Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0] : null;
  if (!p || p.length < 3 || !p.every((n) => Number.isInteger(n))) return null;
  const [y, m, d] = p as number[];
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m! - 1 && date.getUTCDate() === d ? date.toISOString().slice(0, 10) : null;
}

function licenseOf(list: unknown): string | null {
  if (!Array.isArray(list)) return null;
  const urls = list.map((l) => (l && typeof l === "object" ? String((l as { URL?: unknown }).URL ?? "") : "")).filter((u) => /creativecommons\.org\/licenses\//i.test(u));
  return urls[0] ?? null;
}

/** "CC BY 4.0" from a Creative Commons licence URL. */
export function licenseLabel(url: string): string {
  const m = /licenses\/([a-z-]+)\/(\d(?:\.\d)?)/i.exec(url);
  return m ? `CC ${m[1]!.toUpperCase()} ${m[2]}` : "CC";
}

/** The articles of one works answer this feed keeps: research articles (doiPattern) on its subjects (keywords). */
export function parseWorks(body: unknown, feed: CrossrefFeed): CrossrefArticle[] {
  const items = (body as { message?: { items?: unknown } })?.message?.items;
  if (!Array.isArray(items)) throw new Error("not a Crossref works answer: no message.items");
  const pattern = feed.doiPattern ? new RegExp(feed.doiPattern, "i") : null;
  const keywords = feed.keywords?.map((k) => k.toLowerCase());
  const out: CrossrefArticle[] = [];
  for (const it of items as Array<Record<string, any>>) {
    const doi = typeof it.DOI === "string" ? it.DOI.toLowerCase() : "";
    const title = collapseWhitespace(stripTags(String(it.title?.[0] ?? "")));
    if (!doi || !title || it.type !== "journal-article") continue;
    if (pattern && !pattern.test(doi)) continue;
    // JATS abstracts: their markup is dropped to plain paragraphs.
    const abstractText = typeof it.abstract === "string" ? collapseWhitespace(stripTags(it.abstract.replace(/<jats:title>[^<]*<\/jats:title>/gi, " "))) || null : null;
    if (keywords && !keywords.some((k) => `${title} ${abstractText ?? ""}`.toLowerCase().includes(k))) continue;
    const authors = Array.isArray(it.author)
      ? it.author.slice(0, 8).map((a: Record<string, unknown>) => collapseWhitespace(`${a.given ?? ""} ${a.family ?? a.name ?? ""}`)).filter(Boolean).join(", ") + (it.author.length > 8 ? " 等" : "")
      : "";
    out.push({
      doi,
      url: `https://doi.org/${doi}`,
      title,
      authors: authors || null,
      abstractHtml: abstractText ? sanitizeBody(`<p>${abstractText.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</p>`) : null,
      abstractText,
      journal: typeof it["container-title"]?.[0] === "string" ? it["container-title"][0] : null,
      onlineDay: day(it["published-online"]?.["date-parts"]),
      license: licenseOf(it.license),
    });
  }
  return out;
}

/** What a reader sees beside a journal article. */
export function crossrefNotes(a: CrossrefArticle): ItemNote[] {
  return [
    { label: "DOI", value: a.doi, href: a.url },
    a.onlineDay ? { label: "首次在线", value: a.onlineDay } : { label: "上线日期", value: "未登记，按本站发现时间" },
    ...(a.license ? [{ label: "许可", value: licenseLabel(a.license), href: a.license }] : []),
    { label: "配图", value: "待补" },
  ];
}
