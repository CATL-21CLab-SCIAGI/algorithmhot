// Collecting the paper feeds into the engine's single material entrance (content/materials.ts), one feed per
// source row of kind `external`, with the engine's fetch_runs and source health. A feed an operator paused
// in the admin is skipped; a failed fetch never advances its cursor.
import { beijingAt, beijingDate } from "@aihot/contracts/time";
import { sql } from "@aihot/backend/db";
import { upsertMaterial, type MaterialInput } from "@aihot/backend/content/materials";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { logError } from "@aihot/backend/lib/log-error";
import { shutdownSignal } from "@aihot/backend/jobs/queue";
import { ARXIV_ONLINE_TIME, arxivNotes, listingUrl, parseListing } from "./arxiv.ts";
import { crossrefNotes, parseWorks, worksUrl } from "./crossref.ts";
import { feeds, type ArxivFeed, type CrossrefFeed } from "./feeds.ts";

/** arXiv asks automated clients for one request at a time, at least three seconds apart. */
const ARXIV_GAP_MS = 3100;
/** How far back a journal's first collection reaches; older articles would be archived, not news. */
const FIRST_LOOKBACK_DAYS = 3;
/** Re-reading a journal goes back this far, for registrations Crossref indexes late. */
const OVERLAP_DAYS = 2;

export interface FeedRun {
  feed: string;
  status: "ok" | "failed" | "skipped";
  found: number;
  created: number;
  error?: string;
}

type Feed = ArxivFeed | CrossrefFeed;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The feed's source row; created on first use, afterwards the admin's to edit or pause. */
export async function ensureSource(feed: Feed): Promise<{ enabled: boolean; cursor: Record<string, any> | null; last_fetch_at: Date | null }> {
  await sql`
    INSERT INTO sources (id, name, kind, config, tier, participation_mode, interval_minutes, site_fulltext, syndicate_fulltext, tags)
    VALUES (${feed.id}, ${feed.name}, 'external', '{}'::jsonb, ${feed.tier}, 'editorial', 60, false, false, ${feed.tags})
    ON CONFLICT (id) DO NOTHING`;
  const [row] = await sql<{ enabled: boolean; cursor: Record<string, any> | null; last_fetch_at: Date | null }[]>`
    SELECT enabled, cursor, last_fetch_at FROM sources WHERE id = ${feed.id}`;
  return row!;
}

async function store(feed: Feed, materials: Array<Omit<MaterialInput, "sourceId" | "via">>, discoveredAt: Date): Promise<number> {
  let created = 0;
  for (const m of materials) {
    if (shutdownSignal.signal.aborted) break;
    const res = await upsertMaterial({ ...m, sourceId: feed.id, via: "research", discoveredAt });
    if (res.created) created += 1;
    if (res.created || res.revised || res.processingNeeded) await queueProcessing(res.articleId);
  }
  return created;
}

async function run(feed: Feed, collect: (cursor: Record<string, any> | null, at: Date) => Promise<{ found: number; materials: Array<Omit<MaterialInput, "sourceId" | "via">>; cursor: Record<string, unknown> }>): Promise<FeedRun> {
  const source = await ensureSource(feed);
  if (!source.enabled) return { feed: feed.id, status: "skipped", found: 0, created: 0 };
  const [{ id: runId }] = await sql<{ id: number }[]>`INSERT INTO fetch_runs (source_id) VALUES (${feed.id}) RETURNING id`;
  const at = new Date();
  try {
    const got = await collect(source.cursor, at);
    const created = await store(feed, got.materials, at);
    await sql`UPDATE sources SET last_fetch_at = now(), last_ok_at = now(), fail_count = 0, last_error = NULL, health = 'ok',
      cursor = ${sql.json(got.cursor as never)}, updated_at = now() WHERE id = ${feed.id}`;
    await sql`UPDATE fetch_runs SET status = 'ok', finished_at = now(), found_count = ${got.found}, new_count = ${created},
      detail = ${sql.json(got.cursor as never)} WHERE id = ${runId}`;
    return { feed: feed.id, status: "ok", found: got.found, created };
  } catch (error) {
    const message = String((error as Error)?.message ?? error).slice(0, 500);
    await sql`UPDATE sources SET last_fetch_at = now(), fail_count = fail_count + 1, last_error = ${message},
      health = CASE WHEN fail_count + 1 >= 5 THEN 'failing' ELSE 'degraded' END, updated_at = now() WHERE id = ${feed.id}`;
    await sql`UPDATE fetch_runs SET status = 'failed', finished_at = now(), error = ${message} WHERE id = ${runId}`;
    console.error(JSON.stringify({ level: "error", msg: "research feed failed", feed: feed.id, error: logError(error) }));
    return { feed: feed.id, status: "failed", found: 0, created: 0, error: message };
  }
}

let lastArxivRequest = 0;
async function arxivGet(url: string): Promise<string> {
  const wait = lastArxivRequest + ARXIV_GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastArxivRequest = Date.now();
  const res = await guardedFetch(url, { timeoutMs: 60_000, maxBytes: 32 * 1024 * 1024 });
  if (res.status !== 200) throw new Error(`arXiv ${url} answered ${res.status}`);
  return res.text();
}

/** One arXiv feed: each of its categories' listings, a paper once however many of them list it. */
export function collectArxivFeed(feed: ArxivFeed, get: (url: string) => Promise<string> = arxivGet): Promise<FeedRun> {
  return run(feed, async (_cursor) => {
    const seen = new Set<string>();
    const materials: Array<Omit<MaterialInput, "sourceId" | "via">> = [];
    let day = null as string | null;
    let found = 0;
    for (const category of feed.categories) {
      const listing = parseListing(await get(listingUrl(category)));
      // Categories of one feed are announced together; a listing of another day is a page arXiv has not turned yet.
      day = day === null || listing.day < day ? listing.day : day;
      found += listing.papers.length;
      for (const p of listing.papers) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        materials.push({
          identityKey: `arxiv:${p.id}`,
          url: `https://arxiv.org/abs/${p.id}`,
          title: p.title,
          author: p.authors,
          language: "en",
          publishedAt: beijingAt(listing.day, ARXIV_ONLINE_TIME),
          excerpt: p.abstractText.slice(0, 2000),
          bodyText: p.abstractText,
          bodyHtml: p.abstractHtml,
          bodyStatus: "ok",
          raw: { kind: "arxiv", arxivId: p.id, announcedOn: listing.day, categories: p.categories, feedCategory: feed.category ?? null, notes: arxivNotes(p, listing.day) },
        });
      }
    }
    return { found, materials, cursor: { listingDay: day, papers: seen.size } };
  });
}

/** One journal: its articles registered since the last run (with an overlap), newest first. */
export function collectCrossrefFeed(feed: CrossrefFeed, get: (url: string) => Promise<unknown> = crossrefGet): Promise<FeedRun> {
  return run(feed, async (cursor, at) => {
    const today = beijingDate(at);
    const since = typeof cursor?.since === "string" ? addDaysIso(cursor.since, -OVERLAP_DAYS) : addDaysIso(today, -FIRST_LOOKBACK_DAYS);
    const articles = parseWorks(await get(worksUrl(feed.issn[0]!, since, process.env.RESEARCH_CROSSREF_MAILTO)), feed);
    const materials = articles.map((a) => ({
      identityKey: `doi:${a.doi}`,
      url: a.url,
      title: a.title,
      author: a.authors,
      language: "en",
      // No first online date: the day this site found it (the timeline rule's fallback).
      publishedAt: a.onlineDay ? new Date(`${a.onlineDay}T00:00:00Z`) : at,
      publishedAtDay: !!a.onlineDay,
      excerpt: a.abstractText?.slice(0, 2000) ?? null,
      bodyText: a.abstractText,
      bodyHtml: a.abstractHtml,
      bodyStatus: a.abstractText ? "ok" as const : "none" as const,
      raw: { kind: "crossref", doi: a.doi, journal: a.journal, onlineDay: a.onlineDay, license: a.license, feedCategory: feed.category ?? null, notes: crossrefNotes(a) },
    }));
    return { found: articles.length, materials, cursor: { since: today } };
  });
}

async function crossrefGet(url: string): Promise<unknown> {
  const res = await guardedFetch(url, { timeoutMs: 60_000, headers: { accept: "application/json" } });
  if (res.status !== 200) throw new Error(`Crossref ${new URL(url).pathname} answered ${res.status}`);
  return JSON.parse(res.text());
}

function addDaysIso(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Every arXiv feed, one after another (arXiv's request spacing holds across feeds). */
export async function collectArxiv(): Promise<FeedRun[]> {
  const out: FeedRun[] = [];
  for (const f of feeds().arxiv) {
    if (shutdownSignal.signal.aborted) break;
    out.push(await collectArxivFeed(f));
  }
  return out;
}

export async function collectJournals(): Promise<FeedRun[]> {
  const out: FeedRun[] = [];
  for (const f of feeds().crossref) {
    if (shutdownSignal.signal.aborted) break;
    out.push(await collectCrossrefFeed(f));
  }
  return out;
}
