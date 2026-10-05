import { load } from "cheerio";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beijingDate, isValidDate } from "@aihot/contracts/time";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { withArxivRateLimit } from "../lib/arxiv-rate-limit.ts";
import { parseArxivIdentity } from "../sources/research.ts";
import { parseRss } from "../sources/rss.ts";
import type { Candidate, SourceRow } from "../sources/types.ts";
import { parseArxivNewPage } from "./arxiv-new.ts";
import { upsertMaterial } from "../content/materials.ts";
import { publishArticle } from "../publication/publish.ts";
import { researchResponsePath, saveResearchResponse, responseRecordCount } from "./collect-utils.ts";

interface Announcement { id: string; announcedOn: string }
interface AnnouncementPage { entries: Announcement[]; total: number; nextOffset: number | null; oldestDay: string | null }
const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The official recent listing groups by announcement day, unlike API submittedDate. */
export function parseArxivAnnouncementPage(html: string, url: string): AnnouncementPage {
  const $ = load(html);
  const entries: Announcement[] = [];
  let day: string | null = null;
  const content = $("#dlpage");
  if (!content.length) throw new Error("Missing arXiv announcement listing; not a healthy empty response");
  const totalMatch = /Total of\s+([\d,]+)\s+entries/i.exec(content.text());
  const total = totalMatch ? Number(totalMatch[1]!.replaceAll(",", "")) : /No (?:new )?(?:submissions|entries)/i.test(content.text()) ? 0 : NaN;
  if (!Number.isSafeInteger(total)) throw new Error("Missing arXiv listing denominator");
  for (const node of content.find("h3,dt").toArray()) {
    if (node.tagName === "h3") {
      const match = /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+(\d{1,2})\s+([A-Z][a-z]{2})\s+(\d{4})/.exec($(node).text());
      if (!match) { day = null; continue; }
      day = `${match[3]}-${String(months.indexOf(match[2]!) + 1).padStart(2, "0")}-${match[1]!.padStart(2, "0")}`;
      if (!isValidDate(day)) throw new Error("Invalid announcement day");
    } else {
      const href = $(node).find('a[href^="/abs/"]').first().attr("href");
      const identity = href ? parseArxivIdentity(new URL(href, url).href) : null;
      if (!identity || !day) throw new Error("Announcement identity is missing its source date");
      entries.push({ id: identity.id, announcedOn: day });
    }
  }
  const offset = Number(new URL(url).searchParams.get("skip") ?? 0);
  if (total > offset && !entries.length) throw new Error("Nonempty announcement page parsed as empty");
  return { entries, total, nextOffset: offset + entries.length < total ? offset + entries.length : null, oldestDay: entries.at(-1)?.announcedOn ?? null };
}

/** Restrict by source announcement dates; never relabel the original submission timestamp. */
export function announcementInWindow(day: string, start: Date, end: Date): boolean {
  return isValidDate(day) && day >= beijingDate(start) && day <= beijingDate(end);
}

type PageResult<T> = { value: T; returned: number; parsed: number; excluded?: number; truncated?: boolean };
async function recordedPage<T>(id: string, source: SourceRow, url: string, label: string, fetchResponse: typeof guardedFetch,
  consume: (body: string, observed: Date) => Promise<PageResult<T>>): Promise<T | null> {
  const folder = path.join(config.dataDir, "research", id, "responses");
  await mkdir(folder, { recursive: true });
  const [saved] = await sql`SELECT * FROM research_fetches WHERE run_id=${id} AND source_id=${source.id} AND url=${url} ORDER BY attempt_number DESC LIMIT 1`;
  if (saved?.status === "ok") return (await consume(await readFile(saved.response_path, "utf8"), saved.observed_at)).value;
  if (saved && (saved.attempt_number >= 3 || saved.http_status >= 400 && saved.http_status < 500 && saved.http_status !== 429)) return null;
  for (let attempt = Number(saved?.attempt_number ?? 0) + 1; attempt <= 3; attempt++) {
    const observed = new Date();
    const file = researchResponsePath(folder, `${source.id}-${label}-attempt-${attempt}`);
    const [receipt] = await sql`INSERT INTO research_fetches(run_id,source_id,url,status,response_path,observed_at,attempt_number)
      VALUES(${id},${source.id},${url},'pending',${file},${observed},${attempt}) RETURNING id`;
    let status: number | null = null, hash: string | null = null;
    let returned = 0, parsed = 0;
    try {
      const response = await withArxivRateLimit(url, () => fetchResponse(url, { timeoutMs: 30_000, maxBytes: 12 * 1024 * 1024 }));
      status = response.status;
      hash = await saveResearchResponse(file, response.body, { url, finalUrl: response.url, sourceId: source.id, observedAt: observed.toISOString(), status,
        headers: { contentType: response.headers.get("content-type") }, evidence: label.startsWith("listing") ? "announcement-index" : "original-paper-metadata" });
      await sql`UPDATE research_fetches SET http_status=${status},response_sha256=${hash} WHERE id=${receipt.id}`;
      if (status !== 200) throw new Error(`HTTP ${status}`);
      const body = response.text();
      if (label.startsWith("metadata")) {
        returned = responseRecordCount(body, "rss");
        await sql`UPDATE research_fetches SET returned_count=${returned} WHERE id=${receipt.id}`;
        parsed = parseRss(body, source, url, observed).length;
        await sql`UPDATE research_fetches SET parsed_count=${parsed} WHERE id=${receipt.id}`;
      } else if (label.startsWith("abstract-list")) {
        returned = load(body)("#dlpage dt").length;
        await sql`UPDATE research_fetches SET returned_count=${returned} WHERE id=${receipt.id}`;
        parsed = parseArxivNewPage(body, url, source, observed).candidates.length;
        await sql`UPDATE research_fetches SET parsed_count=${parsed} WHERE id=${receipt.id}`;
      }
      const result = await consume(body, observed);
      await sql`UPDATE research_fetches SET status='ok',returned_count=${result.returned},parsed_count=${result.parsed},excluded_count=${result.excluded ?? 0},truncated=${result.truncated ?? false} WHERE id=${receipt.id}`;
      return result.value;
    } catch (error) {
      const message = String(error).slice(0, 1000);
      await sql`UPDATE research_fetches SET status='failed',http_status=${status},response_sha256=${hash},returned_count=${returned},parsed_count=${parsed},error=${message} WHERE id=${receipt.id}`;
      console.log(JSON.stringify({ source: source.id, stage: label, attempt, error: message }));
      if (attempt === 3 || !(status === null || status === 429 || status >= 500)) return null;
      await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
    }
  }
  return null;
}

export async function collectArxivAnnouncements(id: string, run: { window_start: Date; window_end: Date }, source: SourceRow,
  categories: string[], fetchResponse: typeof guardedFetch = guardedFetch) {
  const announcements = new Map<string, string>();
  for (const category of categories) {
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      const url = `https://arxiv.org/list/${category}/recent?skip=${offset}&show=500`;
      const result = await recordedPage(id, source, url, `listing-${category.replaceAll(".", "-")}-${page}`, fetchResponse, async body => {
        const parsed = parseArxivAnnouncementPage(body, url);
        const covered = parsed.oldestDay !== null && parsed.oldestDay < beijingDate(run.window_start);
        // Index references are evidence of discovery; record counts below count original metadata only.
        return { value: parsed, returned: 0, parsed: 0, truncated: page === 19 && parsed.nextOffset !== null && !covered };
      });
      if (!result) break;
      for (const entry of result.entries) if (announcementInWindow(entry.announcedOn, run.window_start, run.window_end)) {
        announcements.set(entry.id, [announcements.get(entry.id) ?? "", entry.announcedOn].sort().at(-1)!);
      }
      if (result.nextOffset === null || result.oldestDay && result.oldestDay < beijingDate(run.window_start)) break;
      if (result.nextOffset <= offset) throw new Error("Announcement pagination did not advance");
      offset = result.nextOffset;
    }
  }
  const ids = [...announcements.keys()].sort();
  console.log(JSON.stringify({ source: source.id, announcements: ids.length, basis: "official-announcement-date" }));
  const remaining = new Set(ids);
  const existing = await sql`SELECT a.research->>'arxivId' AS arxiv_id FROM research_members m JOIN articles a ON a.id=m.article_id
    WHERE m.run_id=${id} AND m.source_id=${source.id} AND a.body_status='ok' AND a.research->>'evidenceBasis'='abstract'`;
  for (const row of existing) remaining.delete(row.arxiv_id);
  async function persist(candidate: Candidate, observed: Date) {
    const identity = parseArxivIdentity(candidate.url);
    if (!identity || !announcements.has(identity.id) || !candidate.research) return false;
    candidate.research.announcedOn = announcements.get(identity.id)!;
    const material = await upsertMaterial({ ...candidate, sourceId: source.id, via: "import", discoveredAt: observed, backfill: null });
    await sql`INSERT INTO research_members(run_id,article_id,source_id,in_window,signal_only)
      VALUES(${id},${material.articleId},${source.id},true,false) ON CONFLICT DO NOTHING`;
    if (material.metadataChanged && !material.created && !material.revised) await publishArticle(material.articleId);
    remaining.delete(identity.id);
    return true;
  }
  const [apiOutage] = await sql`SELECT 1 FROM research_fetches WHERE run_id=${id} AND url LIKE 'https://export.arxiv.org/api/%'
    AND status='failed' AND (http_status IS NULL OR http_status=429 OR http_status>=500) LIMIT 1`;
  for (let offset = 0; !apiOutage && offset < ids.length; offset += 100) {
    const requested = ids.slice(offset, offset + 100);
    const url = `https://export.arxiv.org/api/query?${new URLSearchParams({ id_list: requested.join(","), max_results: "100" })}`;
    const receivedCount = await recordedPage(id, source, url, `metadata-${offset / 100}`, fetchResponse, async (body, observed) => {
      const candidates = parseRss(body, source, url, observed);
      const received = new Set<string>();
      for (const candidate of candidates) {
        const identity = parseArxivIdentity(candidate.url);
        if (!identity || !requested.includes(identity.id) || !candidate.research) continue;
        if (await persist(candidate, observed)) received.add(identity.id);
      }
      const truncated = requested.some(key => !received.has(key));
      console.log(JSON.stringify({ source: source.id, metadataPage: offset / 100, requested: requested.length, parsed: received.size, truncated }));
      return { value: received.size, returned: responseRecordCount(body, "rss"), parsed: received.size, truncated };
    });
    // A source outage is not one fresh retry allowance per hundred identities.
    if (receivedCount === null || receivedCount < requested.length) break;
  }
  if (remaining.size) for (const category of categories) {
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      const url = `https://arxiv.org/list/${category}/new?skip=${offset}&show=500`;
      const result = await recordedPage(id, source, url, `abstract-list-${category.replaceAll(".", "-")}-${page}`, fetchResponse, async (body, observed) => {
        const parsed = parseArxivNewPage(body, url, source, observed);
        let excluded = 0;
        for (const candidate of parsed.candidates) {
          const identity = parseArxivIdentity(candidate.url);
          if (!identity || announcements.get(identity.id) !== parsed.day) { excluded++; continue; }
          await persist(candidate, observed);
        }
        console.log(JSON.stringify({ source: source.id, abstractList: category, page, returned: parsed.candidates.length, excluded, missingMetadata: remaining.size }));
        return { value: parsed, returned: parsed.candidates.length, parsed: parsed.candidates.length, excluded,
          truncated: page === 19 && parsed.nextOffset !== null };
      });
      if (!result || result.nextOffset === null) break;
      if (result.nextOffset <= offset) throw new Error("Abstract listing pagination did not advance");
      offset = result.nextOffset;
    }
  }
  if (remaining.size) await sql`UPDATE research_fetches SET truncated=true WHERE status='ok' AND id=(
    SELECT id FROM research_fetches WHERE run_id=${id} AND source_id=${source.id} ORDER BY id DESC LIMIT 1)`;
  await writeFile(path.join(config.dataDir, "research", id, `${source.id}-announcement-coverage.json`), JSON.stringify({
    runId: id, sourceId: source.id, windowStart: run.window_start, windowEnd: run.window_end,
    announcedIdentities: ids, metadataObtained: ids.filter(key => !remaining.has(key)), missingMetadata: [...remaining],
  }, null, 2), { mode: 0o600 });
}
