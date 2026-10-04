// Reparse preserved responses after parser corrections, without replacing source evidence.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sql, closeDb, type Db } from '@aihot/backend/db';
import { parseRss } from '@aihot/backend/sources/rss';
import { parseJsonList } from '@aihot/backend/sources/json-list';
import { decideTimeline, identityKeyFor, upsertMaterial } from '@aihot/backend/content/materials';
import { mergeResearchMetadata } from '@aihot/backend/sources/research';
import { researchReparseMode } from '@aihot/backend/research/collect-utils';
import type { Candidate, SourceRow } from '@aihot/backend/sources/types';

async function correctHfDates(tx: Db, articleId: string, sourceId: string, candidate: Candidate) {
  const [article] = await tx`SELECT discovered_at,backfill_reason,research FROM articles WHERE id=${articleId} AND source_id=${sourceId} FOR UPDATE`;
  if (!article || !candidate.research) return;
  // Preserve the actual first observation and explicit import classification. A previous inferred
  // stale classification is recomputed from the corrected source date.
  const explicitBackfill = article.backfill_reason === 'stale-on-discovery' ? null : article.backfill_reason;
  const timeline = decideTimeline(candidate.publishedAt, article.discovered_at, explicitBackfill);
  const research = { ...(article.research ?? candidate.research), communitySelectedAt: candidate.research.communitySelectedAt };
  await tx`UPDATE articles SET published_at=${timeline.publishedAt},published_at_claim=${candidate.publishedAt ?? null},
    timeline_at=${timeline.timelineAt},backfill=${timeline.backfill},backfill_reason=${timeline.backfillReason},research=${tx.json(research)},updated_at=now()
    WHERE id=${articleId}`;
}

const id = process.argv[2];
const options = process.argv.slice(3);
const requestedSource = options.find(option => !option.startsWith('--'));
const linksOnly = options.includes('--links-only');
try {
  if (options.filter(option => !option.startsWith('--')).length > 1 || options.some(option => option.startsWith('--') && option !== '--links-only')) throw new Error('Usage: reparse-research.ts RUN_ID [SOURCE_ID] [--links-only]');
  if (!id || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('A valid existing research batch id is required');
  const [run] = await sql`SELECT * FROM research_runs WHERE id=${id}`;
  if (!run) throw new Error('Research batch does not exist');
  const sources = await sql<SourceRow[]>`SELECT * FROM sources WHERE config ? 'researchSourceKind' ORDER BY id`;
  const chosen = requestedSource ? sources.filter(source => source.id === requestedSource) : sources;
  if (!chosen.length) throw new Error('Research source does not exist');
  const mode = researchReparseMode(!!run.admission_frozen, requestedSource ? chosen[0]?.config.researchSourceKind : undefined, !!requestedSource, linksOnly);
  for (const source of chosen) {
    const files = await sql`SELECT DISTINCT ON(url) * FROM research_fetches WHERE run_id=${id} AND source_id=${source.id} AND status='ok' ORDER BY url,id DESC`;
    let corrected = 0, unmatchedExistingRecords = 0;
    for (const f of files) {
      const bytes = await readFile(f.response_path);
      if (f.response_sha256 && createHash('sha256').update(bytes).digest('hex') !== f.response_sha256) throw new Error(`Saved response hash mismatch: fetch ${f.id}`);
      const text = bytes.toString('utf8');
      const candidates = source.kind === 'json_list' ? parseJsonList(text, source, f.observed_at) : parseRss(text, source, f.url, f.observed_at);
      for (const candidate of candidates) {
        await sql.begin(async tx => {
          // Hold the batch row during each material write: an admission freeze between files must
          // not allow this recovery path to add or change research candidates.
          const [current] = await tx`SELECT admission_frozen FROM research_runs WHERE id=${id} FOR UPDATE`;
          if (mode === 'all' && current!.admission_frozen) throw new Error('Research admissions were frozen while reparsing');
          if (mode === 'links_only') {
            if (!candidate.research) return;
            const identity = identityKeyFor({ ...candidate, sourceId: source.id, via: 'import' });
            const [existing] = await tx`SELECT a.id,a.research FROM articles a JOIN research_members m ON m.article_id=a.id
              WHERE m.run_id=${id} AND a.identity_key=${identity} FOR UPDATE OF a`;
            if (!existing?.research) { unmatchedExistingRecords++; return; }
            const links = mergeResearchMetadata(existing.research, candidate.research).links;
            await tx`UPDATE articles SET research=jsonb_set(research,'{links}',${tx.json(links)}::jsonb),updated_at=now() WHERE id=${existing.id}`;
            corrected++;
            return;
          }
          if (mode === 'hf_metadata') {
            if (!candidate.identityKey?.startsWith('hf:') || !candidate.research?.signalOnly) throw new Error('Frozen repair accepts only HF signal metadata');
            const [existing] = await tx`SELECT a.id FROM articles a JOIN research_members m ON m.article_id=a.id
              WHERE m.run_id=${id} AND m.signal_only AND a.source_id=${source.id} AND a.identity_key=${candidate.identityKey}`;
            if (!existing) { unmatchedExistingRecords++; return; }
            await correctHfDates(tx, existing.id, source.id, candidate);
            corrected++;
            return;
          }
          const material = await upsertMaterial({ ...candidate, sourceId: source.id, via: 'import', discoveredAt: f.observed_at, backfill: run.kind === 'pilot' ? 'research-bootstrap' : null }, tx);
          if (source.config.researchSourceKind === 'huggingface') await correctHfDates(tx, material.articleId, source.id, candidate);
          const at = candidate.publishedAt?.getTime();
          await tx`INSERT INTO research_members(run_id,article_id,source_id,in_window,signal_only)
            VALUES(${id},${material.articleId},${source.id},${at !== undefined && at >= run.window_start.getTime() && at < run.window_end.getTime()},${source.participation_mode !== 'editorial'})
            ON CONFLICT(run_id,article_id) DO UPDATE SET in_window=EXCLUDED.in_window,updated_at=now()`;
          corrected++;
        });
      }
      if (mode === 'all') await sql`UPDATE research_fetches SET parsed_count=${candidates.length} WHERE id=${f.id}`;
    }
    console.log(JSON.stringify({ source: source.id, mode, responsesReparsed: files.length, corrected, unmatchedExistingRecords }));
  }
} finally { await closeDb(); }
