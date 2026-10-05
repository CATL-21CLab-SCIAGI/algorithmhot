import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ResearchDayCoverage } from "@aihot/contracts/research-coverage";
import { isValidDate } from "@aihot/contracts/time";
import { config } from "../config.ts";

const SOURCE_IDS = ["research-arxiv-ml-ai", "research-arxiv-physical-science", "research-arxiv-molecular", "research-hf-daily-papers", "rss-google-deepmind", "rss-bair"] as const;
const HOSTS = new Set(["arxiv.org", "info.arxiv.org", "export.arxiv.org", "huggingface.co", "deepmind.google", "bair.berkeley.edu"]);
const count = z.number().int().nonnegative();
const publicUrl = z.string().max(1000).refine(value => {
  try { const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && HOSTS.has(u.hostname); }
  catch { return false; }
}, "Coverage source must be a public official URL");
const source = z.object({
  id: z.enum(SOURCE_IDS), name: z.string().min(1).max(100),
  observedAt: z.string().datetime(),
  status: z.enum(["checked-empty", "has-records", "unavailable"]),
  articleCount: count.nullable(), signalCount: count.nullable(),
  urls: z.array(publicUrl).min(1).max(8), note: z.string().max(600),
}).strict();
const day = z.object({
  date: z.string().refine(isValidDate), timezone: z.literal("Asia/Shanghai"),
  checkedAt: z.string().datetime(), status: z.enum(["checked-empty", "has-records", "partial"]),
  articleCount: count, signalCount: count, note: z.string().max(1000),
  sources: z.array(source).length(6),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.sources.map(s => s.id)).size !== 6) ctx.addIssue({ code: "custom", message: "Each configured source must be represented once" });
  if (value.status === "checked-empty" && (value.articleCount || value.signalCount || value.sources.some(s => s.status !== "checked-empty" || s.articleCount !== 0 || s.signalCount !== 0))) {
    ctx.addIssue({ code: "custom", message: "Empty coverage requires six successful zero-result checks" });
  }
  if (value.sources.some(s => s.status === "unavailable") && value.status !== "partial") ctx.addIssue({ code: "custom", message: "Unavailable sources must remain partial" });
});

/** Only this small reviewed DTO can leave the source-evidence directory. */
export function parseResearchCoverage(value: unknown): ResearchDayCoverage[] {
  const days = z.array(day).max(31).parse(value);
  if (new Set(days.map(d => d.date)).size !== days.length) throw new Error("Duplicate coverage day");
  return days.sort((a, b) => b.date.localeCompare(a.date));
}

export async function loadResearchCoverage(): Promise<ResearchDayCoverage[]> {
  try { return parseResearchCoverage(JSON.parse(await readFile(path.join(config.dataDir, "research", "day-coverage.json"), "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    // A malformed audit cannot silently become a claim that a day was checked.
    throw new Error("Research day coverage failed public validation");
  }
}
