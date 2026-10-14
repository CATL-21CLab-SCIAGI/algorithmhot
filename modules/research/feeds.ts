// The paper feeds this site follows (industry/research-feeds.json): arXiv categories and journals by ISSN.
// Each feed is one source row of kind `external` (the engine does not collect it; server.ts does).
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "@aihot/backend/config";

const Base = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,80}$/),
  name: z.string().min(1).max(200),
  tier: z.enum(["T1", "T1_5", "T2"]),
  tags: z.array(z.string().max(60)).max(30).default([]),
  category: z.string().max(60).optional(),
});

const ArxivFeed = Base.extend({
  id: Base.shape.id.refine((id) => id.startsWith("arxiv-"), "arXiv feed ids start with arxiv-"),
  categories: z.array(z.string().regex(/^[a-z-]+(\.[A-Za-z-]+)?$/)).min(1).max(8),
});

const CrossrefFeed = Base.extend({
  id: Base.shape.id.refine((id) => id.startsWith("crossref-"), "journal feed ids start with crossref-"),
  issn: z.array(z.string().regex(/^\d{4}-\d{3}[\dX]$/)).min(1).max(4),
  /** A DOI an article must match: keeps research articles, drops news, editorials and corrections. */
  doiPattern: z.string().optional().refine((p) => { if (p === undefined) return true; try { new RegExp(p); return true; } catch { return false; } }, "doiPattern must be a regular expression"),
  /** For a broad journal: an article is kept only when its title or abstract names one of these. */
  keywords: z.array(z.string().min(2).max(60)).max(200).optional(),
});

export const Feeds = z.object({
  arxiv: z.array(ArxivFeed).default([]),
  crossref: z.array(CrossrefFeed).default([]),
}).superRefine((f, ctx) => {
  const ids = [...f.arxiv, ...f.crossref].map((x) => x.id);
  for (const id of new Set(ids.filter((id, i) => ids.indexOf(id) !== i))) ctx.addIssue({ code: "custom", message: `duplicate feed id ${id}` });
});

export type ArxivFeed = z.infer<typeof ArxivFeed>;
export type CrossrefFeed = z.infer<typeof CrossrefFeed>;
export type Feeds = z.infer<typeof Feeds>;

let cached: Feeds | null = null;

/** The site's feeds, read once per process. */
export function feeds(file = path.join(REPO_ROOT, "industry/research-feeds.json")): Feeds {
  return cached ??= Feeds.parse(JSON.parse(readFileSync(file, "utf8")));
}
