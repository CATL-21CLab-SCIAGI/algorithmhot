// Event jobs: serial grouping, debounced digests.
import type { PgBoss } from "pg-boss";
import { groupArticle } from "../events/group.ts";
import { composeStoryDigest } from "../events/digest.ts";
import { currentArticlePriority, settleNonEditorial, type ArticlePriorityInput } from "./content.ts";
import { enqueue, ensureQueue, QUEUES, work } from "./queue.ts";
import { sql } from "../db.ts";
import { dailyWorkArticleIds, dailyWorkWindow } from "../reports/daily-work.ts";

export async function registerEventJobs(boss: PgBoss) {
  // Serial on purpose: two reports of the same new fact must not both create it.
  await work(boss, QUEUES.group, { localConcurrency: 1, pollingIntervalSeconds: 0.5 }, async ({ articleId, signalOnly }) => {
    // A discussion post comes here straight from collection: record it first (settleNonEditorial).
    if (signalOnly && !(await settleNonEditorial(articleId)).group) return { verdict: "skipped" };
    const result = await groupArticle(articleId, { signalOnly });
    if (result.storyId && !result.verdict.startsWith("signal")) {
      await enqueue(QUEUES.digest, { storyId: result.storyId }, { singletonKey: `story:${result.storyId}`, startAfter: 60 });
    }
    return result;
  });
  await work(boss, QUEUES.digest, { localConcurrency: 3, pollingIntervalSeconds: 5 }, ({ storyId }) => composeStoryDigest(storyId));
}

/** Missing jobs are repaired; terminal failures need a receipt release or an explicit rerun. */
export async function sweepUngrouped(now = new Date()): Promise<{ enqueued: number }> {
  await ensureQueue(QUEUES.group);
  return sql.begin(async (tx) => {
    const window = await dailyWorkWindow(tx, now);
    const dailyIds = await dailyWorkArticleIds(tx, window);
    const rows = await tx<(ArticlePriorityInput & { id: string })[]>`
      SELECT a.id, a.backfill, a.published_at, a.discovered_at, a.timeline_at, s.participation_mode
      FROM articles a JOIN sources s ON s.id = a.source_id
      WHERE a.grouping_status = 'pending' AND a.created_at < now() - interval '3 minutes'
        AND s.participation_mode = 'editorial' AND a.processing_state = 'analyzed' AND EXISTS (
          SELECT 1 FROM analyses an WHERE an.article_id = a.id AND an.input_revision = a.revision AND an.relevance = 'pass')
        AND NOT EXISTS (SELECT 1 FROM pgboss.job j WHERE j.name = ${QUEUES.group}
          AND j.data->>'articleId' = a.id AND j.state IN ('created', 'active', 'retry'))
      ORDER BY (a.id = ANY(${dailyIds}::text[])) DESC, a.created_at LIMIT 100 FOR UPDATE OF a SKIP LOCKED`;
    let enqueued = 0;
    for (const row of rows) {
      if (await enqueue(QUEUES.group, { articleId: row.id }, {
        singletonKey: row.id, priority: currentArticlePriority(row, window),
      }, tx)) enqueued += 1;
    }
    return { enqueued };
  });
}
