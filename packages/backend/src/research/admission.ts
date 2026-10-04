import { sql, type Db } from "../db.ts";

/** When enabled, every queue and direct processing entrance uses the same frozen admission list. */
export async function admittedForProcessing(articleId: string, db: Db = sql): Promise<boolean> {
  if (process.env.RESEARCH_ADMISSION_ENABLED !== "true") return true;
  const runId = process.env.MODEL_RUN_ID;
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

const GROUPS = [
  { sources: ["research-arxiv-ml-ai"], quota: 20 },
  { sources: ["research-arxiv-physical-science"], quota: 15 },
  { sources: ["research-arxiv-molecular"], quota: 15 },
  { sources: ["rss-google-deepmind", "rss-bair"], quota: 10 },
];

/** Deterministic stratified admission, then redistribute unused slots by date and canonical identity. */
export function chooseAdmissions(input: AdmissionCandidate[], limit = 60): AdmissionCandidate[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 60) throw new Error("admission limit must be 1..60");
  const sorted = [...input].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.canonicalKey.localeCompare(b.canonicalKey) || a.id.localeCompare(b.id));
  const unique = sorted.filter((a, i) => sorted.findIndex((b) => b.canonicalKey === a.canonicalKey) === i);
  const selected: AdmissionCandidate[] = [];
  const chosen = new Set<string>();
  for (const group of GROUPS) {
    for (const a of unique.filter((a) => group.sources.includes(a.sourceId)).slice(0, group.quota)) {
      if (selected.length >= limit) break;
      chosen.add(a.canonicalKey);
      selected.push(a);
    }
  }
  for (const a of unique) {
    if (selected.length >= limit) break;
    if (!chosen.has(a.canonicalKey)) { chosen.add(a.canonicalKey); selected.push(a); }
  }
  return selected;
}

export async function freezeAdmissions(runId: string): Promise<number> {
  return sql.begin(async (tx) => {
    const [run] = await tx<{ kind: string; admission_frozen: boolean; max_candidates: number }[]>`SELECT kind, admission_frozen, max_candidates FROM research_runs WHERE id = ${runId} FOR UPDATE`;
    if (!run) throw new Error("research run missing");
    if (run.admission_frozen) return Number((await tx`SELECT count(*) AS n FROM research_members WHERE run_id = ${runId} AND admitted`)[0]!.n);
    const rows = await tx<{ id: string; source_id: string; identity_key: string; published_at: Date; research: { canonicalKey?: string } | null }[]>`
      SELECT a.id, m.source_id, a.identity_key, a.published_at, a.research FROM research_members m JOIN articles a ON a.id = m.article_id
      WHERE m.run_id = ${runId} AND m.in_window AND NOT m.signal_only AND (${run.kind}='pilot' OR NOT a.backfill)`;
    const chosen = chooseAdmissions(rows.map((r) => ({ id: r.id, sourceId: r.source_id, canonicalKey: r.research?.canonicalKey ?? r.identity_key, publishedAt: r.published_at.toISOString() })), run.max_candidates);
    for (const [i, a] of chosen.entries()) await tx`UPDATE research_members SET admitted = true, admission_rank = ${i + 1}, state = 'pending' WHERE run_id = ${runId} AND article_id = ${a.id}`;
    await tx`UPDATE research_runs SET admission_frozen = true, status = 'processing', updated_at = now() WHERE id = ${runId}`;
    return chosen.length;
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
    count(*) FILTER (WHERE admitted AND state NOT IN ('pass','block','unknown','failed','unknown-receipt'))::int AS pending
    FROM research_members WHERE run_id = ${runId}`;
  const [f] = await sql`SELECT count(DISTINCT source_id)::int AS "sourcesObserved", coalesce(sum(returned_count),0)::int AS returned,
    coalesce(sum(parsed_count),0)::int AS parsed, count(*) FILTER (WHERE status = 'failed')::int AS "failedRequests",
    coalesce(sum(parsed_count) FILTER (WHERE status IN ('failed','pending')),0)::int AS "persistenceUnreconciled"
    FROM research_fetches WHERE run_id = ${runId}`;
  const [s] = await sql`WITH latest AS (
    SELECT DISTINCT ON(source_id,url) source_id,url,status,truncated FROM research_fetches WHERE run_id=${runId} ORDER BY source_id,url,attempt_number DESC,id DESC
  ), per_source AS (SELECT source_id,bool_and(status IN ('ok','not_modified') AND NOT truncated) AS ok FROM latest GROUP BY source_id)
  SELECT count(*) FILTER(WHERE ok)::int AS "sourcesSucceeded",count(*) FILTER(WHERE NOT ok)::int AS "sourcesFailed",
    (SELECT count(*)::int FROM latest WHERE truncated) AS "truncatedRequests",
    count(*) FILTER(WHERE ok AND NOT EXISTS(SELECT 1 FROM research_members m WHERE m.run_id=${runId} AND m.source_id=per_source.source_id AND m.in_window))::int AS "healthyEmptySources"
    FROM per_source`;
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
  // Only completed pages guarantee every parsed identity was persisted. A failed/pending page
  // may have stopped before any member was stored; its excess records are not confirmed duplicates.
  metrics.duplicateRecords = Math.max(0, metrics.parsed! - metrics.stored! - metrics.persistenceUnreconciled!);
  metrics.duplicateRecordsLowerBound = metrics.duplicateRecords;
  metrics.duplicateRecordsExact = metrics.persistenceUnreconciled ? 0 : 1;
  metrics.parseRejected = Math.max(0, metrics.returned! - metrics.parsed!);
  const gaps: string[] = [];
  if ((metrics.sourcesObserved ?? 0) < 6) gaps.push(`仅观测到 ${metrics.sourcesObserved ?? 0}/6 个来源`);
  if (metrics.sourcesFailed) gaps.push(`${metrics.sourcesFailed} 个来源采集尚不完整（历史失败请求共 ${metrics.failedRequests} 次）`);
  if (metrics.parseRejected) gaps.push(`${metrics.parseRejected} 条来源记录未能解析`);
  if (metrics.truncatedRequests) gaps.push(`${metrics.truncatedRequests} 个来源响应仍受截断限制`);
  if (metrics.persistenceUnreconciled) gaps.push(`${metrics.persistenceUnreconciled} 条失败或未完成请求的已解析记录尚待落库对账；重复记录 ${metrics.duplicateRecords} 仅为确认下界`);
  if (metrics.failed) gaps.push(`${metrics.failed} 条资料处理失败`);
  if (metrics.unknownOutcome) gaps.push(`${metrics.unknownOutcome} 条模型请求结果未知`);
  if (metrics.decisionUnknown) gaps.push(`${metrics.decisionUnknown} 条资料未形成可发布判断`);
  if (metrics.pending) gaps.push(`${metrics.pending} 条准入资料尚未处理完成`);
  if (metrics.briefPending) gaps.push(`${metrics.briefPending} 条公开资料的研究解读尚未完成`);
  return { metrics, gaps };
}
