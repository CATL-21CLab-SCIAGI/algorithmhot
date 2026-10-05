import { mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { load } from "cheerio";
import path from "node:path";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { guardedFetch } from "../lib/http-fetch.ts";
import { withArxivRateLimit } from "../lib/arxiv-rate-limit.ts";
import { upsertMaterial } from "../content/materials.ts";
import { publishArticle } from "../publication/publish.ts";
import { parseRss } from "../sources/rss.ts";
import { parseJsonList } from "../sources/json-list.ts";
import type { SourceRow } from "../sources/types.ts";
import { collectArxivAnnouncements } from "./arxiv-announcements.ts";
import { parseArxivNewPage } from "./arxiv-new.ts";
import { dailyWindow } from "@aihot/contracts/time";
import { researchUtcDays, hfPageDecision, responseRecordCount, researchResponsePath, saveResearchResponse } from "./collect-utils.ts";

const ARXIV: Record<string, string[]> = {
  "research-arxiv-ml-ai": ["cs.LG", "cs.AI"],
  "research-arxiv-physical-science": ["physics.comp-ph", "cond-mat.mtrl-sci"],
  "research-arxiv-molecular": ["q-bio.BM", "q-bio.QM"],
};
const stamp = (d: Date) => d.toISOString().replace(/[-:T]/g, "").slice(0, 12);

export async function createResearchRun(id: string, kind: "pilot" | "daily" = "pilot", now = new Date(), window?: { start: Date; end: Date }) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("invalid research run id");
  const daily = !window && kind === "daily" ? dailyWindow(process.env.RESEARCH_RUN_DATE ?? new Date(now.getTime()+8*3600000).toISOString().slice(0,10)) : null;
  const start = window?.start ?? daily?.start ?? new Date(now.getTime() - 7 * 86400000);
  const end = window?.end ?? daily?.end ?? now;
  if (![start, end, now].every(d => Number.isFinite(d.getTime())) || start >= end) throw new Error("Invalid research window");
  if (end > now) throw new Error("Research window has not closed yet");
  await sql`INSERT INTO research_runs(id,kind,window_start,window_end) VALUES(${id},${kind},${start},${end}) ON CONFLICT DO NOTHING`;
  return (await sql<{ id: string; kind: "pilot" | "daily"; window_start: Date; window_end: Date; admission_frozen: boolean }[]>`SELECT * FROM research_runs WHERE id = ${id}`)[0]!;
}

/** A process that stopped after saving a body still contributes its returned/parsed records. */
async function recoverInterruptedFetches(id: string, source: SourceRow) {
  const pending = await sql`SELECT * FROM research_fetches WHERE run_id=${id} AND source_id=${source.id} AND status='pending'`;
  for (const f of pending) {
    let returned = Number(f.returned_count), parsed = Number(f.parsed_count), httpStatus = f.http_status;
    let hash = f.response_sha256;
    try {
      const metadata = JSON.parse(await readFile(`${f.response_path}.json`, "utf8"));
      httpStatus = metadata.status; hash = metadata.sha256;
    } catch { /* A crash may occur between the body and its sidecar. */ }
    try {
      const bytes = await readFile(f.response_path);
      hash = createHash('sha256').update(bytes).digest('hex');
      if (httpStatus === 200) {
        const body = bytes.toString('utf8');
        if (/^https:\/\/arxiv\.org\/list\/[^/]+\/new\?/.test(f.url)) {
          returned = load(body)("#dlpage dt").length;
          parsed = parseArxivNewPage(body, f.url, source, f.observed_at).candidates.length;
        } else if (/^https:\/\/arxiv\.org\/list\//.test(f.url)) {
          returned = 0; parsed = 0; // Discovery identities are retained separately from metadata records.
        } else {
          returned = responseRecordCount(body, source.kind === "json_list" ? "json_list" : "rss");
          parsed = (source.kind === "json_list" ? parseJsonList(body, source, f.observed_at) : parseRss(body, source, f.url, f.observed_at)).length;
        }
      }
    } catch { /* Keep the interrupted attempt and any incomplete raw file; the next attempt is new. */ }
    await sql`UPDATE research_fetches SET status='failed',http_status=${httpStatus},response_sha256=${hash},returned_count=${returned},parsed_count=${parsed},error='Collector interrupted before committing the complete page; raw evidence retained' WHERE id=${f.id}`;
  }
}

/** Health describes all current page results, so a later successful date cannot hide a failed one. */
async function finishSourceHealth(id: string, sourceId: string) {
  const [result] = await sql`WITH latest AS (
    SELECT DISTINCT ON(url) status,truncated FROM research_fetches WHERE run_id=${id} AND source_id=${sourceId} ORDER BY url,attempt_number DESC
  ) SELECT count(*)::int AS total,count(*) FILTER(WHERE status NOT IN ('ok','not_modified') OR truncated)::int AS failed FROM latest`;
  if (result?.total) await sql`UPDATE sources SET health=${result.failed ? 'degraded' : 'ok'},fail_count=${result.failed} WHERE id=${sourceId}`;
}

/** Public responses are persisted before parsing. A resumed batch never silently changes its window. */
export async function collectResearchRun(id: string, options: { fetch?: typeof guardedFetch; sourceIds?: string[] } = {}) {
  const fetchResponse = options.fetch ?? guardedFetch;
  const run = await createResearchRun(id);
  if (run.admission_frozen) return;
  const sources = await sql<SourceRow[]>`SELECT * FROM sources WHERE config ? 'researchSourceKind' AND ${options.sourceIds ? sql`id = ANY(${options.sourceIds})` : sql`true`} ORDER BY id`;
  const folder = path.join(config.dataDir, "research", id, "responses");
  await mkdir(folder, { recursive: true });
  for (const source of sources) {
    await recoverInterruptedFetches(id, source);
    if (id.startsWith("refresh-") && ARXIV[source.id]) {
      try { await collectArxivAnnouncements(id, run, source, ARXIV[source.id]!, fetchResponse); }
      finally { await finishSourceHealth(id, source.id); }
      continue;
    }
    if (source.config.researchSourceKind === "huggingface") {
      try { await collectHuggingFace(id, run, source, folder, fetchResponse); }
      finally { await finishSourceHealth(id, source.id); }
      continue;
    }
    const cats = ARXIV[source.id];
    const pages = cats ? 50 : source.kind === "json_list" ? 10 : 1;
    for (let page = 0; page < pages; page++) {
      let url = String(source.config.feedUrl ?? source.config.url);
      if (cats) {
        const q = new URLSearchParams({ search_query: `(${cats.map((c) => `cat:${c}`).join(" OR ")}) AND submittedDate:[${stamp(run.window_start)} TO ${stamp(run.window_end)}]`, start: String(page * 100), max_results: "100", sortBy: "submittedDate", sortOrder: "descending" });
        url = `https://export.arxiv.org/api/query?${q}`;
      } else if (source.kind === "json_list") {
        const u = new URL(url); u.searchParams.set("limit", "100"); u.searchParams.set("p", String(page)); u.searchParams.set("sort", "publishedAt"); url = u.toString();
      }
      const [saved] = await sql<{ status: string; returned_count: number; attempt_number: number; http_status: number | null; response_path: string | null }[]>`SELECT status, returned_count, attempt_number, http_status, response_path FROM research_fetches WHERE run_id = ${id} AND source_id = ${source.id} AND url = ${url} ORDER BY attempt_number DESC LIMIT 1`;
      if (saved?.status === "ok") {
        if (!cats && saved.response_path) {
          const text = await readFile(saved.response_path, "utf8");
          const parsed = source.kind === "json_list" ? parseJsonList(text, source) : parseRss(text, source);
          const reachesStart = parsed.some(c => c.publishedAt && c.publishedAt < run.window_start);
          if (reachesStart) await sql`UPDATE research_fetches SET truncated=false WHERE run_id=${id} AND source_id=${source.id} AND url=${url}`;
          if (reachesStart || source.kind !== "json_list") break;
        }
        if (saved.returned_count < 100) break; else continue;
      }
      if (saved && (saved.attempt_number >= 3 || saved.http_status && saved.http_status >= 400 && saved.http_status < 500 && saved.http_status !== 429)) break;
      const attempt = (saved?.attempt_number ?? 0) + 1;
      const observedAt = new Date();
      const responsePath = researchResponsePath(folder, `${source.id}-${page}-attempt-${attempt}`);
      let responseHash: string | null = null;
      let httpStatus: number | null = null;
      let returned = 0, parsed = 0;
      const [receipt] = await sql`INSERT INTO research_fetches(run_id,source_id,url,observed_at,status,response_path,attempt_number)
        VALUES(${id},${source.id},${url},${observedAt},'pending',${responsePath},${attempt}) RETURNING id`;
      try {
        const response = await withArxivRateLimit(url, () => fetchResponse(url, { timeoutMs: 30_000, maxBytes: 12 * 1024 * 1024 }));
        httpStatus = response.status;
        await sql`UPDATE research_fetches SET http_status=${httpStatus} WHERE id=${receipt!.id}`;
        responseHash = await saveResearchResponse(responsePath, response.body, { sourceId: source.id, url, finalUrl: response.url, observedAt: observedAt.toISOString(), status: response.status, headers: { contentType: response.headers.get("content-type"), etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified") } });
        if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
        const text = response.text();
        returned = responseRecordCount(text, source.kind === "json_list" ? "json_list" : "rss");
        const candidates = source.kind === "json_list" ? parseJsonList(text, source, observedAt) : parseRss(text, source, response.url, observedAt);
        parsed = candidates.length;
        let earliest = run.window_end.getTime();
        for (const c of candidates) {
          const material = await upsertMaterial({ ...c, sourceId: source.id, via: "import", discoveredAt: observedAt, backfill: run.kind === "pilot" ? "research-bootstrap" : null });
          const t = c.publishedAt?.getTime();
          if (t) earliest = Math.min(earliest, t);
          await sql`INSERT INTO research_members(run_id,article_id,source_id,in_window,signal_only)
            VALUES(${id},${material.articleId},${source.id},${t !== undefined && t >= run.window_start.getTime() && t < run.window_end.getTime()},${source.participation_mode !== "editorial"}) ON CONFLICT DO NOTHING`;
          if (material.metadataChanged && !material.created && !material.revised) await publishArticle(material.articleId);
        }
        const truncated = page === pages - 1 && returned >= 100 && earliest >= run.window_start.getTime();
        await sql`UPDATE research_fetches SET status='ok',http_status=${httpStatus},response_sha256=${responseHash},returned_count=${returned},parsed_count=${parsed},truncated=${truncated} WHERE id=${receipt!.id}`;
        if (!truncated) await sql`UPDATE research_fetches SET truncated=false WHERE run_id=${id} AND source_id=${source.id} AND truncated`;
        await sql`UPDATE sources SET health = 'ok', fail_count = 0 WHERE id = ${source.id}`;
        console.log(JSON.stringify({ source: source.id, page, returned, parsed: candidates.length, truncated }));
        if (returned < 100 || !cats && (source.kind !== "json_list" || earliest < run.window_start.getTime())) break;
      } catch (error) {
        const message = String(error).slice(0, 1000);
        await sql`UPDATE research_fetches SET status='failed',http_status=${httpStatus},response_sha256=${responseHash},returned_count=${returned},parsed_count=${parsed},error=${message} WHERE id=${receipt!.id}`;
        await sql`UPDATE sources SET health = 'degraded', fail_count = fail_count + 1 WHERE id = ${source.id}`;
        console.log(JSON.stringify({ source: source.id, page, status: "failed", error: message }));
        const retryable = httpStatus === null || httpStatus === 429 || httpStatus >= 500;
        if (retryable && attempt < 3) { await new Promise(resolve => setTimeout(resolve, 1500 * attempt)); page--; continue; }
        break;
      }
    }
    await finishSourceHealth(id, source.id);
  }
}

/** HF's explicit date endpoint is ordered by community submission day, independently of paper age.
 * Its Link header can advertise a next page even when the current page contains fewer than limit.
 */
async function collectHuggingFace(id: string, run: Awaited<ReturnType<typeof createResearchRun>>, source: SourceRow, folder: string, fetchResponse: typeof guardedFetch) {
  for (const date of researchUtcDays(run.window_start, run.window_end)) {
    const seen = new Set<string>();
    for (let page=0; page<10; page++) {
      const url = `https://huggingface.co/api/daily_papers?date=${date}&limit=100&p=${page}`;
      const [saved] = await sql`SELECT * FROM research_fetches WHERE run_id=${id} AND source_id=${source.id} AND url=${url} ORDER BY attempt_number DESC LIMIT 1`;
      let text: string, headers: { link?: string | null } = {}, hash: string;
      if (saved?.status === 'ok') {
        text = await readFile(saved.response_path,'utf8'); hash=saved.response_sha256;
        headers=JSON.parse(await readFile(`${saved.response_path}.json`,'utf8')).headers;
      } else {
        const attempt=Number(saved?.attempt_number??0)+1;
        if(attempt>3 || saved?.http_status>=400 && saved?.http_status<500 && saved?.http_status!==429)break;
        const observedAt=new Date();
        const responsePath=researchResponsePath(folder,`${source.id}-${date}-${page}-attempt-${attempt}`);
        let responseHash:string|null=null, status:number|null=null, returned=0, parsed=0;
        const [receipt]=await sql`INSERT INTO research_fetches(run_id,source_id,url,observed_at,status,response_path,attempt_number)
          VALUES(${id},${source.id},${url},${observedAt},'pending',${responsePath},${attempt}) RETURNING id`;
        try {
          const r=await fetchResponse(url,{timeoutMs:30000,maxBytes:12*1024*1024});status=r.status;
          await sql`UPDATE research_fetches SET http_status=${status} WHERE id=${receipt!.id}`;
          headers={link:r.headers.get('link')};
          hash=responseHash=await saveResearchResponse(responsePath,r.body,{url,finalUrl:r.url,sourceId:source.id,observedAt,status,headers});
          if(status!==200)throw new Error(`HTTP ${status}`);
          text=r.text(); returned=responseRecordCount(text,'json_list');
          const cs=parseJsonList(text,source,observedAt); parsed=cs.length;
          for(const c of cs){
            const m=await upsertMaterial({...c,sourceId:source.id,via:'import',discoveredAt:observedAt,backfill:run.kind==='pilot'?'research-bootstrap':null});
            const t=c.publishedAt?.getTime();
            await sql`INSERT INTO research_members(run_id,article_id,source_id,in_window,signal_only)
              VALUES(${id},${m.articleId},${source.id},${t!==undefined&&t>=run.window_start.getTime()&&t<run.window_end.getTime()},true) ON CONFLICT DO NOTHING`;
          }
          const next=!!headers.link && /rel=["']?next/.test(headers.link);
          const decision=hfPageDecision({page,returned,hasNext:next,repeated:seen.has(hash)});
          await sql`UPDATE research_fetches SET status='ok',http_status=${status},response_sha256=${hash},returned_count=${returned},parsed_count=${parsed},truncated=${decision.truncated} WHERE id=${receipt!.id}`;
          await sql`UPDATE sources SET health='ok',fail_count=0 WHERE id=${source.id}`;
          console.log(JSON.stringify({source:source.id,date,page,returned,parsed}));
        } catch(error) {
          const message=String(error).slice(0,1000);
          await sql`UPDATE research_fetches SET status='failed',http_status=${status},response_sha256=${responseHash},returned_count=${returned},parsed_count=${parsed},error=${message} WHERE id=${receipt!.id}`;
          console.log(JSON.stringify({source:source.id,date,page,status:'failed',error:message}));
          if(attempt<3&&(status===null||status>=500||status===429)){page--;continue;} break;
        }
      }
      const records=JSON.parse(text);
      if(hfPageDecision({page,returned:records.length,hasNext:!!headers.link&&/rel=["']?next/.test(headers.link),repeated:seen.has(hash)}).stop)break;
      seen.add(hash);
    }
  }
}
