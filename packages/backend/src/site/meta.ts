// Small site-wide facts for the web shell (e.g. the changelog red-dot anchor).
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.ts";

export interface ChangelogRelease {
  date: string;
  time: string;
  kind: "更新" | "优化" | "公告" | "下线";
  title: string;
  body: string[];
}

let changelogCache: { latestVersion: string; releases: ChangelogRelease[] } | null = null;

/** Changelog is published as a data file in the industry pack (industry/changelog.json), newest first. */
export function loadChangelog() {
  if (!changelogCache) {
    const file = process.env.AIHOT_CHANGELOG_FILE || path.join(REPO_ROOT, "industry/changelog.json");
    const data = JSON.parse(readFileSync(file, "utf8")) as { latestVersion: string; releases: ChangelogRelease[] };
    changelogCache = data;
  }
  return changelogCache;
}

export function siteMeta() {
  return { changelogVersion: loadChangelog().latestVersion };
}
