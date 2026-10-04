// Official API prices (lb_prices kind='official'), kept as a dated file in database/seeds. Each refresh
// fills in the models that have no price yet; scripts/import-leaderboard-prices.ts rewrites them all
// from a newer file.
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.ts";
import { sql } from "../db.ts";

export const PRICE_FILE = path.join(REPO_ROOT, "database/seeds/lb-official-prices-2026-09-26.json");

interface PriceFile {
  verifiedOn: string;
  /** slug → [currency, input, output, cached input, source url], per million tokens */
  prices: Record<string, [string, number | null, number | null, number | null, string]>;
}

export async function importOfficialPrices(opts: { file?: string; overwrite?: boolean } = {}): Promise<{ written: number; unknown: string[] }> {
  const seed = JSON.parse(readFileSync(opts.file ?? PRICE_FILE, "utf8")) as PriceFile;
  let written = 0;
  const unknown: string[] = [];
  for (const [slug, [currency, input, output, cached, url]] of Object.entries(seed.prices)) {
    const [model] = await sql<{ id: string }[]>`SELECT id FROM lb_models WHERE slug = ${slug}`;
    if (!model) {
      unknown.push(slug);
      continue;
    }
    const res = opts.overwrite
      ? await sql`INSERT INTO lb_prices (model_id, kind, currency, input, output, cached_input, source_url, verified_on)
                  VALUES (${model.id}, 'official', ${currency}, ${input}, ${output}, ${cached}, ${url}, ${seed.verifiedOn})
                  ON CONFLICT (model_id, kind) DO UPDATE SET currency = EXCLUDED.currency, input = EXCLUDED.input, output = EXCLUDED.output,
                    cached_input = EXCLUDED.cached_input, source_url = EXCLUDED.source_url, verified_on = EXCLUDED.verified_on, updated_at = now()`
      : await sql`INSERT INTO lb_prices (model_id, kind, currency, input, output, cached_input, source_url, verified_on)
                  VALUES (${model.id}, 'official', ${currency}, ${input}, ${output}, ${cached}, ${url}, ${seed.verifiedOn})
                  ON CONFLICT (model_id, kind) DO NOTHING`;
    written += res.count;
  }
  return { written, unknown };
}
