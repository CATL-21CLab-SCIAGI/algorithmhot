// Daily IndexNow submission of newly indexable URLs. INDEXNOW_SUBMIT_ENABLED is the safety valve: off
// (the default) the list is computed and recorded but nothing is sent. Needs INDEXNOW_KEY.
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { siteUrl } from "../publication/links.ts";
import { publicReportCondition } from "../publication/report-scope.ts";

const MAX_URLS = 10_000;

export async function submitIndexNow(now = new Date()) {
  const [state] = await sql<{ value: { since: string } }[]>`SELECT value FROM settings WHERE key = 'indexnow.watermark'`;
  const since = state ? new Date(state.value.since) : new Date(now.getTime() - 86400_000);
  const items = await sql<{ id: string }[]>`
    SELECT article_id AS id FROM publications WHERE visibility = 'public' AND indexable AND updated_at > ${since} AND updated_at <= ${now}
    ORDER BY updated_at LIMIT ${MAX_URLS}`;
  const reports = await sql<{ kind: string; key: string }[]>`SELECT kind, key FROM reports WHERE generated_at > ${since} AND generated_at <= ${now} AND ${publicReportCondition()}`;
  const stories = await sql<{ public_id: string }[]>`SELECT public_id::text FROM stories WHERE merged_into IS NULL AND created_at > ${since} AND created_at <= ${now} LIMIT 500`;
  const urls = [
    ...items.map((i) => siteUrl(`/items/${i.id}`)),
    ...reports.map((r) => siteUrl(`/${r.kind}/${r.key}`)),
    ...stories.map((s) => siteUrl(`/story/${s.public_id}`)),
  ].slice(0, MAX_URLS);
  let status: "sent" | "disabled" | "empty" | "failed" = urls.length ? "disabled" : "empty";
  let httpStatus: number | null = null;
  const key = config.indexNowKey;
  if (urls.length && config.indexNowSubmitEnabled && key) {
    const res = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host: new URL(config.siteUrl).host, key, keyLocation: siteUrl(`/${key}.txt`), urlList: urls }),
      signal: AbortSignal.timeout(30_000),
    });
    httpStatus = res.status;
    status = res.ok ? "sent" : "failed";
  }
  if (status !== "failed") {
    await sql`INSERT INTO settings (key, value, updated_by) VALUES ('indexnow.watermark', ${sql.json({ since: now.toISOString() })}, 'worker')
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  }
  return { status, httpStatus, urls: urls.length, sample: urls.slice(0, 3) };
}
