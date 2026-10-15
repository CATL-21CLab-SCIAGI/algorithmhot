// Collecting papers that went online before the site watched (an explicit, one-off catch-up): arXiv
// announcements of past days from each category's past-week listing (identifiers and days, no abstracts)
// with their abstracts from the arXiv API, and journal articles first online since a day. A backfilled
// paper is found "on time": its discovery is the moment it went online, so the timeline rule keeps it on
// its day and in that day's issue instead of archiving it as found late. Each one says so (raw.recollected).
import { load } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import { beijingAt } from "@aihot/contracts/time";
import { sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { collapseWhitespace } from "@aihot/backend/lib/text";
import { publishArticle } from "@aihot/backend/publication/publish";
import { ARXIV_ONLINE_TIME, arxivNotes, type ArxivPaper } from "./arxiv.ts";
import { crossrefNotes, parseWorks } from "./crossref.ts";
import { ensureSource } from "./collect.ts";
import { feeds } from "./feeds.ts";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const API_BATCH = 100;
const ARXIV_GAP_MS = 3100;

/** A category's past-week listing: each announcement day's new submissions (cross-lists left out). */
export function parsePastWeek(html: string): Map<string, string[]> {
  const $ = load(html);
  const out = new Map<string, string[]>();
  let day: string | null = null;
  for (const node of $("#dlpage").find("h3,dt").toArray()) {
    if (node.tagName === "h3") {
      const m = /^\w{3}, (\d{1,2}) (\w{3}) (\d{4})/.exec(collapseWhitespace($(node).text()));
      const month = m ? MONTHS.indexOf(m[2]!) : -1;
      day = m && month >= 0 ? `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[1]!.padStart(2, "0")}` : null;
      if (day && !out.has(day)) out.set(day, []);
      continue;
    }
    if (!day || /cross-list|replaced/i.test($(node).text())) continue;
    const id = /\/abs\/(\d{4}\.\d{4,5})/.exec($(node).find('a[href^="/abs/"]').first().attr("href") ?? "")?.[1];
    if (id) out.get(day)!.push(id);
  }
  return out;
}

const atom = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "#text" });

/** Papers from an arXiv API answer (Atom): title, authors, abstract and categories by identifier. */
export function parseApi(xml: string): ArxivPaper[] {
  const entries = atom.parse(xml)?.feed?.entry;
  const list = Array.isArray(entries) ? entries : entries ? [entries] : [];
  return list.flatMap((e: Record<string, any>) => {
    const id = /abs\/(\d{4}\.\d{4,5})/.exec(String(e.id ?? ""))?.[1];
    const title = collapseWhitespace(String(e.title?.["#text"] ?? e.title ?? ""));
    const abstractText = collapseWhitespace(String(e.summary?.["#text"] ?? e.summary ?? ""));
    if (!id || !title || !abstractText) return [];
    const authors = (Array.isArray(e.author) ? e.author : e.author ? [e.author] : []).map((a: Record<string, unknown>) => String(a.name ?? "")).filter(Boolean);
    const categories = (Array.isArray(e.category) ? e.category : e.category ? [e.category] : []).map((c: Record<string, string>) => c["@term"]).filter(Boolean);
    const escaped = abstractText.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
    return [{ id, title, authors: authors.join(", ") || null, abstractHtml: `<p>${escaped}</p>`, abstractText, categories }];
  });
}

let last = 0;
async function arxivGet(url: string): Promise<string> {
  const wait = last + ARXIV_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const res = await guardedFetch(url, { timeoutMs: 90_000, maxBytes: 32 * 1024 * 1024 });
  if (res.status !== 200) throw new Error(`arXiv ${url} answered ${res.status}`);
  return res.text();
}

export interface BackfillResult { feed: string; days: Record<string, number>; created: number; existing: number }

/** One arXiv feed's announcements on days within [from, to]. */
export async function backfillArxiv(from: string, to: string, get = arxivGet): Promise<BackfillResult[]> {
  const out: BackfillResult[] = [];
  for (const feed of feeds().arxiv) {
    await ensureSource(feed);
    const byDay = new Map<string, Set<string>>();
    for (const category of feed.categories) {
      for (const [day, ids] of parsePastWeek(await get(`https://arxiv.org/list/${encodeURIComponent(category)}/pastweek?skip=0&show=2000`))) {
        if (day < from || day > to) continue;
        const set = byDay.get(day) ?? new Set<string>();
        for (const id of ids) set.add(id);
        byDay.set(day, set);
      }
    }
    const result: BackfillResult = { feed: feed.id, days: {}, created: 0, existing: 0 };
    for (const [day, ids] of [...byDay].sort()) {
      result.days[day] = ids.size;
      const have = new Set((await sql<{ identity_key: string }[]>`SELECT identity_key FROM articles WHERE identity_key IN ${sql([...ids].map((id) => `arxiv:${id}`))}`).map((r) => r.identity_key));
      const wanted = [...ids].filter((id) => !have.has(`arxiv:${id}`));
      result.existing += ids.size - wanted.length;
      const online = beijingAt(day, ARXIV_ONLINE_TIME);
      for (let i = 0; i < wanted.length; i += API_BATCH) {
        const batch = wanted.slice(i, i + API_BATCH);
        const papers = parseApi(await get(`https://export.arxiv.org/api/query?id_list=${batch.join(",")}&max_results=${batch.length}`));
        for (const p of papers) {
          const res = await upsertMaterial({
            sourceId: feed.id, via: "research", identityKey: `arxiv:${p.id}`, url: `https://arxiv.org/abs/${p.id}`,
            title: p.title, author: p.authors, language: "en", publishedAt: online, discoveredAt: online,
            excerpt: p.abstractText.slice(0, 2000), bodyText: p.abstractText, bodyHtml: p.abstractHtml, bodyStatus: "ok",
            raw: { kind: "arxiv", arxivId: p.id, announcedOn: day, categories: p.categories, feedCategory: feed.category ?? null, recollected: true, notes: arxivNotes(p, day) },
          });
          if (res.created) result.created += 1;
          if (res.created || res.revised || res.processingNeeded) await queueProcessing(res.articleId);
        }
      }
    }
    out.push(result);
  }
  return out;
}

/** The last moment of a Beijing day: when a journal article first online that day counts as found. */
const dayEnd = (day: string) => new Date(beijingAt(day, "00:00").getTime() + 86_400_000 - 1);

/**
 * Journal articles first online since `from`: new ones are collected as found on their day; ones already
 * collected but archived as found late are put back on their day.
 */
export async function backfillJournals(from: string, now = new Date()): Promise<BackfillResult[]> {
  const out: BackfillResult[] = [];
  for (const feed of feeds().crossref) {
    await ensureSource(feed);
    const params = new URLSearchParams({ filter: `from-online-pub-date:${from},type:journal-article`, sort: "published-online", order: "desc", rows: "500",
      select: "DOI,title,abstract,author,published-online,URL,license,type,container-title" });
    if (process.env.RESEARCH_CROSSREF_MAILTO) params.set("mailto", process.env.RESEARCH_CROSSREF_MAILTO);
    const res = await guardedFetch(`https://api.crossref.org/journals/${feed.issn[0]}/works?${params}`, { timeoutMs: 90_000, headers: { accept: "application/json" } });
    if (res.status !== 200) throw new Error(`Crossref ${feed.id} answered ${res.status}`);
    const result: BackfillResult = { feed: feed.id, days: {}, created: 0, existing: 0 };
    for (const a of parseWorks(JSON.parse(res.text()), feed)) {
      if (!a.onlineDay || a.onlineDay < from) continue;
      result.days[a.onlineDay] = (result.days[a.onlineDay] ?? 0) + 1;
      const found = new Date(Math.min(dayEnd(a.onlineDay).getTime(), now.getTime()));
      const r = await upsertMaterial({
        sourceId: feed.id, via: "research", identityKey: `doi:${a.doi}`, url: a.url, title: a.title, author: a.authors, language: "en",
        publishedAt: new Date(`${a.onlineDay}T00:00:00Z`), publishedAtDay: true, discoveredAt: found,
        excerpt: a.abstractText?.slice(0, 2000) ?? null, bodyText: a.abstractText, bodyHtml: a.abstractHtml, bodyStatus: a.abstractText ? "ok" : "none",
        raw: { kind: "crossref", doi: a.doi, journal: a.journal, onlineDay: a.onlineDay, license: a.license, feedCategory: feed.category ?? null, recollected: true, notes: crossrefNotes(a) },
      });
      if (r.created) result.created += 1;
      else {
        result.existing += 1;
        // Collected earlier but archived as found late: back on its day, as if found then.
        const [moved] = await sql<{ id: string }[]>`
          UPDATE articles SET backfill = false, backfill_reason = NULL, timeline_at = ${found}, discovered_at = least(discovered_at, ${found}),
            raw = raw || ${sql.json({ recollected: true } as never)}
          WHERE id = ${r.articleId} AND backfill AND backfill_reason = 'stale-on-discovery' RETURNING id`;
        if (moved) await publishArticle(moved.id);
      }
      if (r.created || r.revised || r.processingNeeded) await queueProcessing(r.articleId);
    }
    out.push(result);
  }
  return out;
}
