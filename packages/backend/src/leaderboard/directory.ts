// The model directory (database/seeds/lb-models-*.json): display names, providers and release dates,
// and the name each evaluation source uses for a model. A new site imports it before the first round,
// so fetched rows resolve to the same models, names and brand marks as on AIHOT instead of one new
// model per unfamiliar name. Models and aliases already present are kept.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createId } from "@paralleldrive/cuid2";
import { REPO_ROOT } from "../config.ts";
import { sql } from "../db.ts";

export const DIRECTORY_FILE = path.join(REPO_ROOT, "database/seeds/lb-models-2026-09-29.json");

interface Directory {
  /** [slug, name, provider, provider slug, release date] */
  models: Array<[string, string, string | null, string | null, string | null]>;
  /** source key → the source's name for a model → model slug */
  aliases: Record<string, Record<string, string>>;
}

const chunks = <T>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

export async function importModelDirectory(file = DIRECTORY_FILE): Promise<{ models: number; aliases: number }> {
  const dir = JSON.parse(readFileSync(file, "utf8")) as Directory;
  let models = 0;
  for (const chunk of chunks(dir.models, 500)) {
    const rows = chunk.map(([slug, name, provider, providerSlug, releasedOn]) => ({
      id: createId(), slug, name, provider, provider_slug: providerSlug, released_at: releasedOn,
      release_date_source: releasedOn ? "directory" : null, metadata_source: "directory",
    }));
    const res = await sql`INSERT INTO lb_models ${sql(rows, "id", "slug", "name", "provider", "provider_slug", "released_at", "release_date_source", "metadata_source")}
                          ON CONFLICT (slug) DO NOTHING`;
    models += res.count;
  }
  const ids = new Map((await sql<{ id: string; slug: string }[]>`SELECT id, slug FROM lb_models`).map((m) => [m.slug, m.id]));
  const aliasRows = Object.entries(dir.aliases).flatMap(([sourceKey, names]) =>
    Object.entries(names)
      .filter(([, slug]) => ids.has(slug))
      .map(([alias, slug]) => ({ id: createId(), source_key: sourceKey, alias, normalized_alias: slug, model_id: ids.get(slug)! })));
  let aliases = 0;
  for (const chunk of chunks(aliasRows, 1000)) {
    const res = await sql`INSERT INTO lb_aliases ${sql(chunk, "id", "source_key", "alias", "normalized_alias", "model_id")}
                          ON CONFLICT (source_key, alias) DO NOTHING`;
    aliases += res.count;
  }
  return { models, aliases };
}
