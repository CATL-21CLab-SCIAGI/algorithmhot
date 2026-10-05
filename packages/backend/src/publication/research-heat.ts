import { computeResearchHeat, type ResearchHeatRanking } from "@aihot/contracts/research-heat";
import type { ResearchMetadata } from "@aihot/contracts/research";
import { sql } from "../db.ts";
import { listedCondition } from "./scope.ts";

/** Public projection only; an UNKNOWN processing result can never supply an unpublished item. */
export async function loadResearchHeat(at = new Date()): Promise<ResearchHeatRanking> {
  const rows = await sql<{ id: string; title: string; source_name: string; url: string; published_at: Date | null; research: ResearchMetadata | null }[]>`
    SELECT p.article_id AS id, p.title, s.name AS source_name, p.url, p.published_at, p.research
    FROM publications p JOIN sources s ON s.id = p.source_id
    WHERE ${listedCondition(at)} ORDER BY p.article_id`;
  return computeResearchHeat(rows.map(row => ({ id: row.id, title: row.title, sourceName: row.source_name, sourceUrl: row.url, publishedAt: row.published_at?.toISOString() ?? null, research: row.research })), at.toISOString());
}
