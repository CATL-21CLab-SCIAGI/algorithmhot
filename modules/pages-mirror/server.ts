// The mirror's schedule: crawl the web service, publish the files to the mirror's branch, and keep the
// run's summary for the admin's runs page. Nothing else on the site reads the mirror; a failed push
// fails the run (job_runs and the alerts show it) and the next run starts over from the remote.
import path from "node:path";
import { defineServerModule } from "@aihot/backend/modules";
import { config } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";
import { SITE } from "@aihot/site";
import { crawl } from "./crawl.ts";
import { normalizeBase } from "./mirror.ts";
import { publish } from "./publish.ts";

const env = process.env;

export interface MirrorSummary {
  startedAt: string;
  finishedAt: string;
  pages: number;
  assets: number;
  skipped: number;
  skippedPaths: string[];
  changed: boolean;
  commit: string | null;
  pushedAt: string | null;
  error: string | null;
}

function settings() {
  const repo = env.PAGES_MIRROR_REPO;
  if (!repo) throw new Error("PAGES_MIRROR_REPO is not set");
  const maxPages = Number.parseInt(env.PAGES_MIRROR_MAX_PAGES || "400", 10);
  return {
    origin: env.PAGES_MIRROR_ORIGIN || "http://web:3000",
    base: normalizeBase(env.PAGES_MIRROR_BASE_PATH ?? "/algorithmhot"),
    primary: env.PAGES_MIRROR_PRIMARY_URL ? env.PAGES_MIRROR_PRIMARY_URL.replace(/\/+$/, "") : null,
    maxPages: Number.isFinite(maxPages) && maxPages > 0 ? maxPages : 400,
    repo,
    branch: env.PAGES_MIRROR_BRANCH || "gh-pages",
    token: env.PAGES_MIRROR_TOKEN || null,
    author: env.PAGES_MIRROR_GIT_AUTHOR || "AlgorithmHot Mirror <mirror@algorithmhot.invalid>",
  };
}

async function record(s: MirrorSummary): Promise<void> {
  await sql`
    INSERT INTO pages_mirror_state (singleton, started_at, finished_at, pages, assets, skipped, skipped_paths, changed, commit_sha, pushed_at, error)
    VALUES (true, ${s.startedAt}, ${s.finishedAt}, ${s.pages}, ${s.assets}, ${s.skipped}, ${sql.json(s.skippedPaths)}, ${s.changed}, ${s.commit}, ${s.pushedAt}, ${s.error})
    ON CONFLICT (singleton) DO UPDATE SET
      started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at, pages = EXCLUDED.pages, assets = EXCLUDED.assets,
      skipped = EXCLUDED.skipped, skipped_paths = EXCLUDED.skipped_paths, changed = EXCLUDED.changed, error = EXCLUDED.error,
      commit_sha = COALESCE(EXCLUDED.commit_sha, pages_mirror_state.commit_sha),
      pushed_at = COALESCE(EXCLUDED.pushed_at, pages_mirror_state.pushed_at)`;
}

/** One mirror run; throws (after recording the error) when the files could not be published. */
export async function mirrorOnce(): Promise<MirrorSummary> {
  const startedAt = new Date();
  const summary: MirrorSummary = {
    startedAt: startedAt.toISOString(), finishedAt: startedAt.toISOString(), pages: 0, assets: 0, skipped: 0, skippedPaths: [],
    changed: false, commit: null, pushedAt: null, error: null,
  };
  try {
    const s = settings();
    const site = await crawl({ origin: s.origin, maxPages: s.maxPages, base: s.base, primary: s.primary, siteName: SITE.name });
    Object.assign(summary, { pages: site.pages, assets: site.assets, skipped: site.skipped.length, skippedPaths: site.skipped.slice(0, 50) });
    const pushed = await publish({
      dir: path.join(config.dataDir, "pages-mirror", "repo"), repo: s.repo, branch: s.branch, token: s.token, author: s.author,
      files: site.files, now: startedAt,
    });
    Object.assign(summary, { changed: pushed.changed, commit: pushed.commit, pushedAt: pushed.pushedAt?.toISOString() ?? null });
  } catch (error) {
    summary.error = String((error as Error).message ?? error).slice(0, 4000);
  }
  summary.finishedAt = new Date().toISOString();
  await record(summary);
  if (summary.error) throw new Error(`pages mirror: ${summary.error}`);
  return summary;
}

/** The last run as the admin's runs page shows it; null before the first. */
export async function lastMirror(): Promise<MirrorSummary | null> {
  const [row] = await sql<{
    started_at: Date; finished_at: Date; pages: number; assets: number; skipped: number; skipped_paths: string[];
    changed: boolean; commit_sha: string | null; pushed_at: Date | null; error: string | null;
  }[]>`SELECT started_at, finished_at, pages, assets, skipped, skipped_paths, changed, commit_sha, pushed_at, error FROM pages_mirror_state WHERE singleton`;
  if (!row) return null;
  return {
    startedAt: row.started_at.toISOString(), finishedAt: row.finished_at.toISOString(), pages: row.pages, assets: row.assets,
    skipped: row.skipped, skippedPaths: row.skipped_paths, changed: row.changed, commit: row.commit_sha,
    pushedAt: row.pushed_at?.toISOString() ?? null, error: row.error,
  };
}

export default defineServerModule({
  name: "pages-mirror",
  schedules: [{
    name: "pages-mirror.publish",
    cron: env.PAGES_MIRROR_CRON || "40 * * * *",
    missed: "once",
    run: () => mirrorOnce(),
    when: () => env.PAGES_MIRROR_ENABLED === "true",
  }],
  admin: { runs: () => lastMirror() },
});
