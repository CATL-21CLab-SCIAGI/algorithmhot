import { load } from "cheerio";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beijingDate, isValidDate } from "@aihot/contracts/time";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { withArxivRateLimit } from "../lib/arxiv-rate-limit.ts";
import { makeResearchMetadata, parseArxivIdentity, researchLinks } from "../sources/research.ts";
import { sanitizeBody } from "../content/sanitize.ts";
import { collapseWhitespace } from "../lib/text.ts";
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

/** Admission uses the original arXiv submission timestamp, not the later announcement day. */
export function submissionInWindow(value: string | null | undefined, start: Date, end: Date): boolean {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time >= start.getTime() && time < end.getTime();
}

/** The date-only citation metadata is not precise enough for a 09:00 cutoff. Read v1 history. */
export function parseArxivAbstractPage(html: string, url: string, source: SourceRow, observedAt: Date): Candidate {
  const requested = new URL(url), identity = parseArxivIdentity(url), $ = load(html);
  if (requested.protocol !== "https:" || requested.hostname !== "arxiv.org" || !/^\/abs\//.test(requested.pathname) || !identity) throw new Error("Expected official arXiv abstract URL");
  const declared = $('meta[name="citation_arxiv_id"]');
  if (declared.length !== 1 || parseArxivIdentity(declared.attr("content") ?? "")?.id !== identity.id) throw new Error("ArXiv abstract identity mismatch");
  const history = $(".submission-history");
  if (history.length !== 1) throw new Error("Missing unique arXiv submission history");
  const versions = [...collapseWhitespace(history.text()).matchAll(/\[v(\d+)\]\s*((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+(\d{1,2})\s+([A-Z][a-z]{2})\s+(\d{4})\s+(\d{2}:\d{2}:\d{2})\s+UTC)/g)];
  const first = versions.filter(match => match[1] === "1");
  if (first.length !== 1) throw new Error("Missing unique precise arXiv v1 submission timestamp");
  const dates = versions.map(match => {
    const month = months.indexOf(match[4]!);
    const date = `${match[5]}-${String(month + 1).padStart(2, "0")}-${match[3]!.padStart(2, "0")}`;
    const iso = `${date}T${match[6]}Z`, time = Date.parse(iso);
    if (Number(match[1]) < 1 || month < 0 || !isValidDate(date) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== iso.slice(0, 19)
      || time > observedAt.getTime()) throw new Error("Invalid arXiv submission timestamp");
    return { version: Number(match[1]), at: new Date(time) };
  }).sort((a, b) => a.version - b.version);
  const submitted = dates[0]!.at, revised = dates.at(-1)!.at;
  if (dates.some((entry, i) => i > 0 && (entry.version === dates[i - 1]!.version || entry.at < dates[i - 1]!.at))) throw new Error("Inconsistent arXiv version history");
  const titleNode = $("h1.title").clone(), abstract = $("blockquote.abstract").clone();
  if (titleNode.length !== 1 || abstract.length !== 1) throw new Error("Missing unique arXiv title or abstract");
  titleNode.find(".descriptor").remove(); abstract.find(".descriptor").remove();
  const title = collapseWhitespace(titleNode.text()), bodyHtml = sanitizeBody(abstract.html() ?? "", url);
  const bodyText = collapseWhitespace(load(bodyHtml, null, false).text());
  if (!title || !bodyText || title === bodyText) throw new Error("Empty arXiv title or abstract");
  const versioned = { ...identity, version: `v${dates.at(-1)!.version}` };
  return {
    identityKey: identity.canonicalKey, url: identity.canonicalUrl, title,
    author: $(".authors a").map((_, node) => collapseWhitespace($(node).text())).get().join(", ") || null,
    publishedAt: submitted, sourceUpdatedAt: revised, bodyHtml, bodyText, excerpt: bodyText, bodyStatus: "ok", media: [],
    research: makeResearchMetadata({ identity: versioned, originalPublishedAt: submitted, revisedAt: revised, observedAt,
      evidenceBasis: "abstract", signalOnly: source.participation_mode !== "editorial", links: researchLinks(url, [{ kind: "paper", url }], bodyHtml + ($(".comments").html() ?? "")) }),
    raw: { kind: "arxiv-abstract-page", sourceId: source.id, sourceUrl: url, arxivId: identity.id,
      originalPublishedAt: submitted.toISOString(), revisedAt: revised.toISOString() },
  };
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
        headers: { contentType: response.headers.get("content-type"), date: response.headers.get("date"), age: response.headers.get("age"), lastModified: response.headers.get("last-modified") }, evidence: label.startsWith("listing") ? "announcement-index" : "original-paper-metadata" });
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
      } else if (label.startsWith("abstract-page")) {
        returned = 1;
        await sql`UPDATE research_fetches SET returned_count=1 WHERE id=${receipt.id}`;
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
  const [state] = await sql`SELECT admission_frozen FROM research_runs WHERE id=${id}`;
  if (state?.admission_frozen) return;
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
  const complete = new Set<string>();
  async function membership(articleId: string, submitted: string | null | undefined) {
    await sql`INSERT INTO research_members(run_id,article_id,source_id,in_window,signal_only)
      SELECT ${id},${articleId},${source.id},${submissionInWindow(submitted, run.window_start, run.window_end)},false
      WHERE EXISTS(SELECT 1 FROM research_runs WHERE id=${id} AND NOT admission_frozen)
      ON CONFLICT(run_id,article_id) DO UPDATE SET in_window=EXCLUDED.in_window
      WHERE EXISTS(SELECT 1 FROM research_runs WHERE id=${id} AND NOT admission_frozen)`;
  }
  async function reuseKnown() {
    if (!announcements.size) return;
    const existing = await sql`SELECT a.id,a.research->>'arxivId' AS arxiv_id,a.research->>'originalPublishedAt' AS submitted
      FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.research->>'arxivId'=ANY(${[...announcements.keys()]})
      AND s.config->>'researchSourceKind'='arxiv' AND s.participation_mode='editorial'
      AND a.identity_key='arxiv:' || (a.research->>'arxivId') AND a.research->>'canonicalKey'=a.identity_key
      AND a.research->'signalOnly'='false'::jsonb AND a.body_status='ok' AND a.research->>'evidenceBasis'='abstract'`;
    for (const row of existing) if (!complete.has(row.arxiv_id) && row.submitted && Number.isFinite(Date.parse(row.submitted))) {
      // The current listing proves rediscovery; the previously retained source proves submission.
      // Reuse both without moving its publication timestamp or spending another HTTP request.
      await membership(row.id, row.submitted);
      complete.add(row.arxiv_id);
    }
  }
  await reuseKnown();
  async function persist(candidate: Candidate, observed: Date) {
    const identity = parseArxivIdentity(candidate.url);
    if (!identity || !announcements.has(identity.id) || !candidate.research) return false;
    candidate.research.announcedOn = announcements.get(identity.id)!;
    const material = await upsertMaterial({ ...candidate, sourceId: source.id, via: "import", discoveredAt: observed, backfill: null });
    const submitted = candidate.research.originalPublishedAt;
    const precise = !!submitted && Number.isFinite(Date.parse(submitted));
    // Only an unfrozen run can change membership; neither a fallback nor a replay reopens admission.
    await membership(material.articleId, submitted);
    if (precise) {
      // The earlier abstract-list fallback deliberately had no source timestamp. Fill its gap only.
      await sql`UPDATE articles SET published_at=${new Date(submitted!)},published_at_claim=${new Date(submitted!)},updated_at=now()
        WHERE id=${material.articleId} AND published_at IS NULL`;
      complete.add(identity.id);
    }
    if (material.metadataChanged && !material.created && !material.revised) await publishArticle(material.articleId);
    return precise;
  }
  // /recent and /new can be served from different caches. Always read /new as an independent
  // official discovery surface, even when every identity from the older index is complete.
  for (const category of categories) {
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      const url = `https://arxiv.org/list/${category}/new?skip=${offset}&show=500`;
      const result = await recordedPage(id, source, url, `abstract-list-${category.replaceAll(".", "-")}-${page}`, fetchResponse, async (body, observed) => {
        const parsed = parseArxivNewPage(body, url, source, observed);
        let excluded = 0;
        for (const candidate of parsed.candidates) {
          const identity = parseArxivIdentity(candidate.url);
          if (!identity || !announcementInWindow(parsed.day, run.window_start, run.window_end)) { excluded++; continue; }
          announcements.set(identity.id, [announcements.get(identity.id) ?? "", parsed.day].sort().at(-1)!);
          if (!complete.has(identity.id)) await persist(candidate, observed);
        }
        console.log(JSON.stringify({ source: source.id, abstractList: category, page, returned: parsed.candidates.length, excluded,
          missingMetadata: [...announcements.keys()].filter(key => !complete.has(key)).length }));
        return { value: parsed, returned: parsed.candidates.length, parsed: parsed.candidates.length, excluded,
          truncated: page === 19 && parsed.nextOffset !== null };
      });
      if (!result || result.nextOffset === null) break;
      if (result.nextOffset <= offset) throw new Error("Abstract listing pagination did not advance");
      offset = result.nextOffset;
    }
  }
  await reuseKnown();
  const ids = [...announcements.keys()].sort();
  console.log(JSON.stringify({ source: source.id, announcements: ids.length, basis: "official-announcement-date" }));
  const pending = ids.filter(key => !complete.has(key));
  // A 200 response with invalid Atom is an API failure too. Resuming or changing an id-list
  // must not allocate another API retry budget; precise metadata can still be recovered from /abs.
  const [apiFailure] = await sql`SELECT 1 FROM research_fetches WHERE run_id=${id} AND url LIKE 'https://export.arxiv.org/api/%'
    AND status='failed' LIMIT 1`;
  for (let offset = 0; !apiFailure && offset < pending.length; offset += 100) {
    const requested = pending.slice(offset, offset + 100);
    const url = `https://export.arxiv.org/api/query?${new URLSearchParams({ id_list: requested.join(","), max_results: "100" })}`;
    const receivedCount = await recordedPage(id, source, url, `metadata-${offset / 100}`, fetchResponse, async (body, observed) => {
      const candidates = parseRss(body, source, url, observed);
      const received = new Set<string>();
      for (const candidate of candidates) {
        const identity = parseArxivIdentity(candidate.url);
        if (!identity || !requested.includes(identity.id) || !candidate.research) continue;
        if (await persist(candidate, observed)) received.add(identity.id);
      }
      const truncated = requested.some(key => !complete.has(key));
      console.log(JSON.stringify({ source: source.id, metadataPage: offset / 100, requested: requested.length, parsed: received.size, truncated }));
      return { value: received.size, returned: responseRecordCount(body, "rss"), parsed: received.size, truncated };
    });
    // An API outage is not one fresh retry allowance per hundred identities.
    if (receivedCount === null || receivedCount < requested.length) break;
  }
  let consecutiveUnavailable = 0;
  for (const paperId of ids.filter(key => !complete.has(key))) {
    const url = `https://arxiv.org/abs/${paperId}`;
    const result = await recordedPage(id, source, url, `abstract-page-${paperId.replaceAll(".", "-")}`, fetchResponse, async (body, observed) => {
      const candidate = parseArxivAbstractPage(body, url, source, observed);
      await persist(candidate, observed);
      return { value: true, returned: 1, parsed: 1 };
    });
    if (result) consecutiveUnavailable = 0;
    else {
      const [last] = await sql`SELECT http_status FROM research_fetches WHERE run_id=${id} AND source_id=${source.id} AND url=${url} ORDER BY attempt_number DESC LIMIT 1`;
      const unavailable = last && (last.http_status === null || last.http_status === 200 || last.http_status === 403 || last.http_status === 429 || last.http_status >= 500);
      consecutiveUnavailable = unavailable ? consecutiveUnavailable + 1 : 0;
      // Bound a source-wide outage, not the candidate count. Resume keeps every missing identity.
      if (consecutiveUnavailable >= 2) break;
    }
  }
  const remaining = ids.filter(key => !complete.has(key));
  if (remaining.length) await sql`UPDATE research_fetches SET truncated=true WHERE status='ok' AND id=(
    SELECT id FROM research_fetches WHERE run_id=${id} AND source_id=${source.id} AND status='ok' ORDER BY id DESC LIMIT 1)`;
  await writeFile(path.join(config.dataDir, "research", id, `${source.id}-announcement-coverage.json`), JSON.stringify({
    runId: id, sourceId: source.id, windowStart: run.window_start, windowEnd: run.window_end,
    announcedIdentities: ids, metadataObtained: ids.filter(key => complete.has(key)), missingMetadata: remaining,
  }, null, 2), { mode: 0o600 });
}
