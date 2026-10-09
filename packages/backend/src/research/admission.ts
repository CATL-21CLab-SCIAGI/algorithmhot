import { sql, type Db } from "../db.ts";
import { dailyWindow } from "@aihot/contracts/time";
import { refreshFamilyPattern, researchFamilyDate, researchSnapshotRank } from "./refresh.ts";

/** When enabled, every queue and direct processing entrance uses the same frozen admission list. */
export async function admittedForProcessing(articleId: string, db: Db = sql): Promise<boolean> {
  if (process.env.RESEARCH_ADMISSION_ENABLED !== "true") return true;
  const runId = process.env.RESEARCH_RUN_ID || process.env.MODEL_RUN_ID;
  if (!runId) return false;
  const [row] = await db`SELECT 1 FROM research_members m JOIN research_runs r ON r.id = m.run_id
    WHERE m.run_id = ${runId} AND m.article_id = ${articleId} AND m.admitted AND r.admission_frozen`;
  return !!row;
}

export interface AdmissionCandidate {
  id: string;
  sourceId: string;
  canonicalKey: string;
  publishedAt: string;
}

interface AdmissionSourceDate {
  published_at: Date | null;
  backfill: boolean;
  research: { arxivId?: string | null; originalPublishedAt?: string | null } | null;
}

/** A prior admission is evidence of processing, not evidence that its source date fits a new issue. */
export function admissionSourceInWindow(row: AdmissionSourceDate, start: Date, end: Date, allowBackfill = false): boolean {
  if (row.backfill && !allowBackfill) return false;
  const time = row.research?.arxivId ? Date.parse(row.research.originalPublishedAt ?? "") : row.published_at?.getTime() ?? NaN;
  return Number.isFinite(time) && time >= start.getTime() && time < end.getTime();
}

const GROUPS = [
  { sources: ["research-arxiv-ml-ai"], quota: 20 },
  { sources: ["research-arxiv-physical-science"], quota: 15 },
  { sources: ["research-arxiv-molecular"], quota: 15 },
  { sources: ["rss-google-deepmind", "rss-bair"], quota: 10 },
];

/** Deterministic stratified admission, then redistribute unused slots by date and canonical identity. */
export function chooseAdmissions(input: AdmissionCandidate[], limit = 60): AdmissionCandidate[] {
  return chooseAdditionalAdmissions(input, [], limit);
}

/** Never displace prior admissions when a later slot brings newer material. */
export function chooseAdditionalAdmissions(input: AdmissionCandidate[], previous: AdmissionCandidate[], limit = 60): AdmissionCandidate[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 60) throw new Error("admission limit must be 1..60");
  const chosen = new Set(previous.map(a => a.canonicalKey));
  if (chosen.size > limit) throw new Error("Existing daily admissions exceed the frozen limit");
  const sorted = [...input].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.canonicalKey.localeCompare(b.canonicalKey) || a.id.localeCompare(b.id));
  const unique = sorted.filter((a, i) => !chosen.has(a.canonicalKey) && sorted.findIndex((b) => b.canonicalKey === a.canonicalKey) === i);
  const selected: AdmissionCandidate[] = [];
  for (const group of GROUPS) {
    const used = new Set(previous.filter(a => group.sources.includes(a.sourceId)).map(a => a.canonicalKey)).size;
    for (const a of unique.filter((a) => group.sources.includes(a.sourceId)).slice(0, Math.max(0, group.quota - used))) {
      if (chosen.size >= limit) break;
      chosen.add(a.canonicalKey);
      selected.push(a);
    }
  }
  for (const a of unique) {
    if (chosen.size >= limit) break;
    if (!chosen.has(a.canonicalKey)) { chosen.add(a.canonicalKey); selected.push(a); }
  }
  return selected;
}

/** No item count cap: every eligible identity is admitted once, while prior identities stay bound. */
export function chooseOpenAdmissions(input: AdmissionCandidate[], previous: AdmissionCandidate[] = []): AdmissionCandidate[] {
  const seen = new Set(previous.map(a => a.canonicalKey));
  return [...input].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.canonicalKey.localeCompare(b.canonicalKey) || a.id.localeCompare(b.id))
    .filter(a => { if (seen.has(a.canonicalKey)) return false; seen.add(a.canonicalKey); return true; });
}

/** New editions spend their bounded model allowance on the newest unprocessed announcements first. */
export async function researchProcessingQueue(runId: string, db: Db = sql) {
  const rows = await db<{ article_id: string; state: string; error: string | null; admission_rank: number; admission_policy: string;
    published_at: Date | null; research: { arxivId?: string; announcedOn?: string | null; originalPublishedAt?: string | null } | null; previously_admitted: boolean }[]>`
    SELECT m.article_id,m.state,m.error,m.admission_rank,r.admission_policy,a.published_at,a.research,
      EXISTS(SELECT 1 FROM research_members prior JOIN research_runs pr ON pr.id=prior.run_id
        WHERE prior.article_id=m.article_id AND prior.admitted AND pr.id<>r.id AND
          CASE WHEN r.admission_policy='all-in-window'
            THEN pr.collection_cutoff<r.collection_cutoff OR pr.id||'-r1'=r.id
            ELSE pr.window_end<r.window_end END) AS previously_admitted
    FROM research_members m JOIN research_runs r ON r.id=m.run_id JOIN articles a ON a.id=m.article_id
    WHERE m.run_id=${runId} AND m.admitted ORDER BY m.admission_rank`;
  if (rows[0]?.admission_policy === "all-in-window") {
    const date = (row: typeof rows[number]) => row.research?.arxivId
      ? row.research.originalPublishedAt ?? "" : row.published_at?.toISOString() ?? "";
    const terminal = (row: typeof rows[number]) => ["pass", "block", "unknown", "unknown-receipt", "failed"].includes(row.state);
    rows.sort((a, b) => Number(terminal(a)) - Number(terminal(b)) || date(b).localeCompare(date(a))
      || Number(a.previously_admitted) - Number(b.previously_admitted) || a.admission_rank - b.admission_rank);
  }
  return rows.map(({ article_id, state, error }) => ({ article_id, state, error }));
}

export async function freezeAdmissions(runId: string): Promise<number> {
  return sql.begin(async (tx) => {
    const familyDate = researchFamilyDate(runId);
    if (runId.startsWith("refresh-") && !familyDate) throw new Error("Invalid research refresh ID");
    if (familyDate) await tx`SELECT pg_advisory_xact_lock(hashtext(${`research-admission:${familyDate}`}))`;
    const [run] = await tx<{ kind: string; admission_frozen: boolean; max_candidates: number | null; admission_policy: string; window_start: Date; window_end: Date }[]>`SELECT kind, admission_frozen, max_candidates, admission_policy, window_start, window_end FROM research_runs WHERE id = ${runId} FOR UPDATE`;
    if (!run) throw new Error("research run missing");
    interface PreviousRow extends AdmissionSourceDate {
      article_id: string; source_id: string; canonical_key: string; published_at: Date | null; state: string; error: string | null;
      admission_rank: number; window_end: Date; current_analysis: boolean; run_id: string;
    }
    const inherited = new Map<string, PreviousRow>();
    let limit = run.max_candidates;
    if (familyDate) {
      if (run.kind !== "daily" || run.window_start.getTime() !== dailyWindow(familyDate).start.getTime()) throw new Error("Daily admission family has incompatible window metadata");
      const familyPattern = refreshFamilyPattern(familyDate);
      const relatives = await tx<{ id: string; window_end: Date; max_candidates: number | null }[]>`SELECT id,window_end,max_candidates FROM research_runs
        WHERE id<>${runId} AND admission_frozen AND (id=${`daily-${familyDate}`} OR id ~ ${familyPattern})`;
      if (relatives.some(r => run.admission_policy === "all-in-window"
        ? researchSnapshotRank(r.id) > researchSnapshotRank(runId)
        : r.window_end > run.window_end || r.id === `${runId}-r1`)) throw new Error("A later daily snapshot is already frozen; an older slot cannot admit or replace it");
      if (limit !== null) limit = Math.min(limit, ...relatives.flatMap(r => r.max_candidates === null ? [] : [r.max_candidates]));
      const previous = await tx<PreviousRow[]>`SELECT m.article_id,m.source_id,coalesce(a.research->>'canonicalKey',a.identity_key) AS canonical_key,
        a.published_at,a.research,a.backfill,m.state,m.error,m.admission_rank,r.window_end,r.id AS run_id,
        (a.processing_state=CASE WHEN m.state='block' THEN 'blocked' ELSE 'analyzed' END AND EXISTS(
          SELECT 1 FROM analyses n WHERE n.article_id=a.id AND n.input_revision=a.revision AND n.relevance=m.state)) AS current_analysis
        FROM research_members m
        JOIN research_runs r ON r.id=m.run_id JOIN articles a ON a.id=m.article_id
        WHERE r.id<>${runId} AND r.admission_frozen AND m.admitted
          AND (r.id=${`daily-${familyDate}`} OR r.id ~ ${familyPattern})
        ORDER BY r.window_end,m.admission_rank,a.id,r.id`;
      if (run.admission_policy === "all-in-window") previous.sort((a, b) => researchSnapshotRank(a.run_id) - researchSnapshotRank(b.run_id)
        || a.admission_rank - b.admission_rank || a.article_id.localeCompare(b.article_id));
      for (const member of previous) {
        if (run.admission_policy === "all-in-window" && !admissionSourceInWindow(member, run.window_start, run.window_end)) continue;
        const prior = inherited.get(member.canonical_key);
        if (!prior) inherited.set(member.canonical_key, member);
        // Carry the latest checkpoint for the original identity; UNKNOWN remains a held state.
        else if (prior.article_id === member.article_id) inherited.set(member.canonical_key, { ...member, admission_rank: prior.admission_rank });
      }
    }
    if (run.admission_frozen) return Number((await tx`SELECT count(*) AS n FROM research_members WHERE run_id = ${runId} AND admitted`)[0]!.n);
    const rows = await tx<{ id: string; source_id: string; identity_key: string; published_at: Date | null; backfill: boolean; research: { canonicalKey?: string; arxivId?: string; announcedOn?: string | null; originalPublishedAt?: string | null } | null }[]>`
      SELECT a.id, m.source_id, a.identity_key, a.published_at, a.research,a.backfill FROM research_members m JOIN articles a ON a.id = m.article_id
      WHERE m.run_id = ${runId} AND m.in_window AND NOT m.signal_only AND (${run.kind}='pilot' OR NOT a.backfill)`;
    const prior = [...inherited.values()];
    const candidates = rows.filter(r => run.admission_policy !== "all-in-window"
      || admissionSourceInWindow(r, run.window_start, run.window_end, run.kind === "pilot")).map((r) => {
      return { id: r.id, sourceId: r.source_id, canonicalKey: r.research?.canonicalKey ?? r.identity_key,
        publishedAt: r.research?.arxivId ? r.research.originalPublishedAt ?? "" : r.published_at?.toISOString() ?? "" };
    });
    const previous = prior.map(r => ({ id: r.article_id, sourceId: r.source_id, canonicalKey: r.canonical_key, publishedAt: r.published_at?.toISOString() ?? "" }));
    const chosen = run.admission_policy === "all-in-window" ? chooseOpenAdmissions(candidates, previous)
      : chooseAdditionalAdmissions(candidates, previous, limit ?? 60);
    for (const [i, member] of prior.entries()) {
      // A source revision needs its own analysis. Held/failed calls remain held, even across revisions.
      const changed = ["pass", "block", "unknown"].includes(member.state) && !member.current_analysis;
      await tx`INSERT INTO research_members(run_id,article_id,source_id,in_window,signal_only,admitted,admission_rank,state,error)
        VALUES(${runId},${member.article_id},${member.source_id},true,false,true,${i + 1},${changed ? "pending" : member.state},${changed ? null : member.error})
        ON CONFLICT(run_id,article_id) DO UPDATE SET admitted=true,admission_rank=excluded.admission_rank,state=excluded.state,error=excluded.error,in_window=true,signal_only=false`;
    }
    for (const [i, a] of chosen.entries()) await tx`UPDATE research_members SET admitted = true, admission_rank = ${prior.length + i + 1}, state = 'pending' WHERE run_id = ${runId} AND article_id = ${a.id}`;
    await tx`UPDATE research_runs SET admission_frozen = true, status = 'processing', updated_at = now() WHERE id = ${runId}`;
    return prior.length + chosen.length;
  });
}

export async function researchRunMetrics(runId: string): Promise<{ metrics: Record<string, number>; gaps: string[] }> {
  const [m] = await sql`SELECT count(*)::int AS stored, count(*) FILTER (WHERE in_window)::int AS "inWindow",
    count(*) FILTER (WHERE NOT in_window)::int AS "outsideWindow", count(*) FILTER (WHERE signal_only)::int AS signals,
    count(*) FILTER (WHERE admitted)::int AS admitted,
    count(*) FILTER (WHERE in_window AND NOT signal_only AND NOT admitted)::int AS "notAdmitted",
    count(*) FILTER (WHERE admitted AND state IN ('pass', 'block', 'unknown'))::int AS processed,
    count(*) FILTER (WHERE admitted AND state='pass')::int AS passed,
    count(*) FILTER (WHERE admitted AND state='block')::int AS blocked,
    count(*) FILTER (WHERE admitted AND state='unknown')::int AS "decisionUnknown",
    count(*) FILTER (WHERE admitted AND state = 'failed')::int AS failed,
    count(*) FILTER (WHERE admitted AND state = 'unknown-receipt')::int AS "unknownOutcome",
    count(*) FILTER (WHERE admitted AND error LIKE 'held-request: status=unknown;%')::int AS "quarantinedUnknown",
    count(*) FILTER (WHERE admitted AND error LIKE 'held-request: status=failed;%')::int AS "quarantinedFailed",
    count(*) FILTER (WHERE admitted AND state NOT IN ('pass','block','unknown','failed','unknown-receipt'))::int AS pending
    FROM research_members WHERE run_id = ${runId}`;
  const [f] = await sql`SELECT count(DISTINCT source_id)::int AS "sourcesObserved", coalesce(sum(returned_count),0)::int AS returned,
    coalesce(sum(parsed_count),0)::int AS parsed, coalesce(sum(excluded_count),0)::int AS "excludedSourceRecords",
    count(*) FILTER (WHERE status='failed' AND outcome IS DISTINCT FROM 'not_yet_available')::int AS "failedRequests",
    count(*) FILTER (WHERE outcome='not_yet_available')::int AS "deferredRequests",
    coalesce(sum(parsed_count) FILTER (WHERE status IN ('failed','pending')),0)::int AS "persistenceUnreconciled"
    FROM research_fetches WHERE run_id = ${runId}`;
  const [s] = await sql`WITH latest AS (
    SELECT DISTINCT ON(source_id,url) source_id,url,status,outcome,truncated FROM research_fetches WHERE run_id=${runId} ORDER BY source_id,url,attempt_number DESC,id DESC
  ), per_source AS (SELECT source_id,bool_and(status IN ('ok','not_modified') AND NOT truncated) AS ok,
    bool_or((status NOT IN ('ok','not_modified') AND outcome IS DISTINCT FROM 'not_yet_available') OR truncated) AS failed,
    bool_or(outcome='not_yet_available') AS deferred FROM latest GROUP BY source_id)
  SELECT count(*) FILTER(WHERE ok)::int AS "sourcesSucceeded",count(*) FILTER(WHERE failed)::int AS "sourcesFailed",
    count(*) FILTER(WHERE deferred AND NOT failed)::int AS "sourcesDeferred",
    (SELECT count(*)::int FROM latest WHERE truncated) AS "truncatedRequests",
    count(*) FILTER(WHERE ok AND NOT EXISTS(SELECT 1 FROM research_members m WHERE m.run_id=${runId} AND m.source_id=per_source.source_id AND m.in_window))::int AS "healthyEmptySources"
    FROM per_source`;
  const deferred = await sql<{ url: string }[]>`SELECT url FROM (
    SELECT DISTINCT ON(source_id,url) url,outcome FROM research_fetches WHERE run_id=${runId} ORDER BY source_id,url,attempt_number DESC,id DESC
  ) latest WHERE outcome='not_yet_available'`;
  const [signals] = await sql`SELECT count(*)::int AS "unlinkedSignals" FROM research_members m JOIN articles a ON a.id=m.article_id
    WHERE m.run_id=${runId} AND m.signal_only AND NOT EXISTS(SELECT 1 FROM research_members body JOIN articles b ON b.id=body.article_id
      WHERE body.run_id=m.run_id AND NOT body.signal_only AND b.research->>'canonicalKey'=a.research->>'canonicalKey')`;
  const [p] = await sql`SELECT count(*) FILTER(WHERE p.selected)::int AS selected,
    count(*) FILTER(WHERE p.selected AND p.research_brief IS NULL)::int AS "selectedWithoutBrief",
    count(*) FILTER(WHERE p.research_brief IS NOT NULL)::int AS "briefReady",
    count(*) FILTER(WHERE p.research_brief IS NULL)::int AS "briefPending"
    FROM publications p JOIN research_members m ON m.article_id = p.article_id
    WHERE m.run_id = ${runId} AND m.admitted AND p.visibility = 'public' AND p.eligible`;
  const metrics = Object.fromEntries(Object.entries({ ...m, ...f, ...s, ...signals, ...p }).map(([k, v]) => [k, Number(v)]));
  metrics.sourcesPlanned = 6;
  const familyDate = researchFamilyDate(runId);
  const [requests] = await sql`SELECT count(*)::int AS n FROM receipt_attempts
    WHERE model_run_id=coalesce((SELECT model_budget_id FROM research_runs WHERE id=${runId}),${familyDate ? `daily-${familyDate}` : runId}) AND status='unknown'`;
  metrics.modelRequestsUnknown = Number(requests!.n);
  if (familyDate) {
    const [inherited] = await sql`SELECT count(*)::int AS n FROM research_members m JOIN research_runs current ON current.id=m.run_id
      WHERE m.run_id=${runId} AND m.admitted AND EXISTS(SELECT 1 FROM research_members prior JOIN research_runs r ON r.id=prior.run_id
        WHERE prior.article_id=m.article_id AND prior.admitted AND r.id<>${runId} AND r.admission_frozen
          AND (CASE WHEN current.admission_policy='all-in-window' THEN r.collection_cutoff<current.collection_cutoff
            ELSE r.window_end<current.window_end END OR r.id||'-r1'=current.id)
          AND (r.id=${`daily-${familyDate}`} OR r.id ~ ${refreshFamilyPattern(familyDate)}))`;
    metrics.previouslyAdmitted = Number(inherited!.n);
    metrics.newlyAdmitted = metrics.admitted! - metrics.previouslyAdmitted;
  }
  // Only completed pages guarantee every parsed identity was persisted. A failed/pending page
  // may have stopped before any member was stored; its excess records are not confirmed duplicates.
  metrics.duplicateRecords = Math.max(0, metrics.parsed! - metrics.stored! - metrics.persistenceUnreconciled! - metrics.excludedSourceRecords!);
  metrics.duplicateRecordsLowerBound = metrics.duplicateRecords;
  // Inherited admissions may be absent from a later response, so stored is then an aggregate corpus.
  metrics.duplicateRecordsExact = metrics.persistenceUnreconciled || metrics.previouslyAdmitted ? 0 : 1;
  metrics.parseRejected = Math.max(0, metrics.returned! - metrics.parsed!);
  const gaps: string[] = [];
  if ((metrics.sourcesObserved ?? 0) < 6) gaps.push(`仅观测到 ${metrics.sourcesObserved ?? 0}/6 个来源`);
  if (metrics.sourcesFailed) gaps.push(`${metrics.sourcesFailed} 个来源采集尚不完整（历史失败请求共 ${metrics.failedRequests} 次）`);
  if (deferred.length) {
    const dates = [...new Set(deferred.map(row => new URL(row.url).searchParams.get("date")))].sort();
    gaps.push(`Hugging Face Daily Papers 尚未开放 ${dates.join("、")} 的社区信号，已跳过并等待下一正常刷新补采；这不表示当天没有新研究`);
  }
  if (metrics.parseRejected) gaps.push(`${metrics.parseRejected} 条来源记录未能解析`);
  if (metrics.truncatedRequests) gaps.push(`${metrics.truncatedRequests} 个来源响应仍受截断限制`);
  if (metrics.persistenceUnreconciled) gaps.push(`${metrics.persistenceUnreconciled} 条失败或未完成请求的已解析记录尚待落库对账；重复记录 ${metrics.duplicateRecords} 仅为确认下界`);
  if (metrics.failed) gaps.push(`${metrics.failed} 条资料处理失败`);
  if (metrics.unknownOutcome) gaps.push(`${metrics.unknownOutcome} 条模型请求结果未知`);
  if (metrics.modelRequestsUnknown) gaps.push(`${metrics.modelRequestsUnknown} 次共享模型预算的请求结果未知，未自动重发`);
  if (metrics.quarantinedUnknown) gaps.push(`${metrics.quarantinedUnknown} 条资料因历史未知请求已隔离，未重发；其他未提交资料独立处理`);
  if (metrics.quarantinedFailed) gaps.push(`${metrics.quarantinedFailed} 条资料因历史失败已隔离，未自动重试`);
  if (metrics.decisionUnknown) gaps.push(`${metrics.decisionUnknown} 条资料未形成可发布判断`);
  if (metrics.pending) gaps.push(`${metrics.pending} 条准入资料尚未处理完成`);
  if (metrics.briefPending) gaps.push(`${metrics.briefPending} 条公开资料的研究解读尚未完成`);
  return { metrics, gaps };
}
