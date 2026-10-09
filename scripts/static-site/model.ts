// Public snapshot DTOs are deliberately narrower than the API. Never spread API objects here.
import { computeResearchHeat, type ResearchHeatRanking } from "@aihot/contracts/research-heat";
import type { ResearchDayCoverage } from "@aihot/contracts/research-coverage";
import type { ResearchPaperFigure } from "@aihot/contracts/research";
import { publicPaperFigure } from "@aihot/contracts/paper-figure";
type ObjectValue = Record<string, unknown>;
export const obj = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
export const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const str = (value: unknown): string => typeof value === "string" ? value : "";
export const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
const nullable = (value: unknown): string | null => str(value) || null;
export function identifier(value: unknown): string {
  const result = str(value);
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(result)) throw new Error("Invalid public identifier");
  return result;
}

/** Public hyperlinks only. Local services, credentials, and executable URL schemes never leave the machine. */
export function publicUrl(value: unknown): string | null {
  try {
    const url = new URL(str(value));
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!host.includes(".") || host.endsWith(".local") || host.endsWith(".localhost") || host.endsWith(".internal")) return null;
    // Block IP literals entirely: public research links use DNS names.
    if (/^[\d.]+$/.test(host) || host.includes(":")) return null;
    return url.href;
  } catch { return null; }
}

export interface PublicResearch {
  arxivId: string | null; arxivVersion: string | null; arxivVersions: string[]; doi: string | null;
  originalPublishedAt: string | null; revisedAt: string | null; communitySelectedAt: string | null; observedAt: string | null;
  evidenceBasis: string;
  announcedOn?: string;
  links: Array<{ kind: string; url: string; sourceUrl: string | null }>;
}
export interface PublicBrief {
  methodChange: string; applicableTasks: string; comparisonConditions: string; limitations: string; evidenceBasis: string;
  sourceRevision: number | null;
}
export interface PublicRoadmap {
  title: string; nodes: Array<{ stage: string; label: string; detail: string; evidenceSnippet: string }>;
  limitations: string; evidenceBasis: string; sourceRevision: number; sourceUrl: string | null; generatedAt: string;
}
export interface PublicItem {
  id: string; title: string; originalTitle: string | null; summary: string | null; reason: string | null;
  sourceName: string; sourceUrl: string | null; publishedAt: string | null; timelineAt: string | null;
  category: string | null; tags: string[]; research: PublicResearch | null; researchBrief: PublicBrief | null; researchRoadmap: PublicRoadmap | null;
  selected?: boolean;
}
export interface PublicTopic {
  slug: string; name: string; group: string; definition: string; total: number; recent: number; latestAt: string | null; itemIds: string[];
}
export interface PublicCitation {
  paperFigure?: ResearchPaperFigure | null;
  itemId: string | null; title: string; summary: string | null; sourceName: string; sourceUrl: string | null;
  publishedAt: string | null; available: boolean; research: PublicResearch | null; researchBrief: PublicBrief | null; researchRoadmap: PublicRoadmap | null;
}
export interface PublicReport {
  illustrated?: boolean;
  kind: "pilot" | "daily" | "weekly" | "monthly"; key: string; issueNumber: number; title: string; windowStart: string; windowEnd: string;
  generatedAt: string; revision: number; lead: { title: string; leadParagraph: string } | null; overview: string | null;
  sections: Array<{ label: string; summary: string | null; items: PublicCitation[] }>;
  metrics: Record<string, number>; status: string; gaps: string[];
}
export interface Snapshot {
  schemaVersion: 1; generatedAt: string; publicBaseUrl: string; mode: "static-snapshot";
  scope: string; items: PublicItem[]; topics: PublicTopic[]; reports: PublicReport[];
  /** Listed publication pool, separate from selected items and archived report references. */
  poolItemIds?: string[];
  researchAttention?: ResearchHeatRanking;
  researchCoverage?: ResearchDayCoverage[];
}
export const selectedItems = (snapshot: Snapshot): PublicItem[] => snapshot.items.filter(item => item.selected !== false);
export const poolItems = (snapshot: Snapshot): PublicItem[] => snapshot.poolItemIds ? snapshot.poolItemIds.map(id => snapshot.items.find(item => item.id === id)!) : snapshot.items;

/** Enumerated public fields only: source response files, paths and private receipt fields are omitted. */
export function sanitizeResearchCoverage(value: unknown): ResearchDayCoverage[] {
  if (!Array.isArray(value) || value.length > 31) throw new Error("Invalid research coverage days");
  const sources = new Set(["research-arxiv-ml-ai", "research-arxiv-physical-science", "research-arxiv-molecular", "research-hf-daily-papers", "rss-google-deepmind", "rss-bair"]);
  const hosts = new Set(["arxiv.org", "info.arxiv.org", "export.arxiv.org", "huggingface.co", "deepmind.google", "bair.berkeley.edu"]);
  const stamp = (v: unknown): string => { if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(v) || !Number.isFinite(Date.parse(v))) throw new Error("Invalid coverage observation time"); return v; };
  const count = (v: unknown): number => { if (!Number.isSafeInteger(v) || Number(v) < 0) throw new Error("Invalid coverage count"); return Number(v); };
  const text = (v: unknown, max: number): string => { if (typeof v !== "string" || v.length > max) throw new Error("Invalid coverage text"); return v; };
  const days = value.map(raw => {
    const d = obj(raw), date = str(d.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || d.timezone !== "Asia/Shanghai" || !["checked-empty", "has-records", "partial"].includes(str(d.status))) throw new Error("Invalid coverage day");
    const rows = list(d.sources).map(rawSource => {
      const s = obj(rawSource), id = str(s.id), status = str(s.status);
      if (!sources.has(id) || !["checked-empty", "has-records", "unavailable"].includes(status)) throw new Error("Invalid coverage source");
      const urls = list(s.urls).map(rawUrl => { const url = publicUrl(rawUrl); if (!url || !url.startsWith("https:") || !hosts.has(new URL(url).hostname)) throw new Error("Invalid coverage public URL"); return url; });
      if (!urls.length || urls.length > 8) throw new Error("Invalid coverage source URLs");
      return { id, name: text(s.name, 100), observedAt: stamp(s.observedAt), status: status as ResearchDayCoverage["sources"][number]["status"], articleCount: s.articleCount === null ? null : count(s.articleCount), signalCount: s.signalCount === null ? null : count(s.signalCount), urls, note: text(s.note, 600) };
    });
    if (rows.length !== 6 || new Set(rows.map(s => s.id)).size !== 6) throw new Error("Coverage requires six distinct sources");
    const day: ResearchDayCoverage = { date, timezone: "Asia/Shanghai", checkedAt: stamp(d.checkedAt), status: str(d.status) as ResearchDayCoverage["status"], articleCount: count(d.articleCount), signalCount: count(d.signalCount), note: text(d.note, 1000), sources: rows };
    if (day.status === "checked-empty" && (day.articleCount || day.signalCount || rows.some(s => s.status !== "checked-empty" || s.articleCount !== 0 || s.signalCount !== 0))) throw new Error("Empty coverage requires six successful zero-result checks");
    if (rows.some(s => s.status === "unavailable") && day.status !== "partial") throw new Error("Unavailable coverage source must remain partial");
    return day;
  });
  if (new Set(days.map(d => d.date)).size !== days.length) throw new Error("Duplicate coverage day");
  return days.sort((a, b) => b.date.localeCompare(a.date));
}

export function research(value: unknown): PublicResearch | null {
  if (!value) return null;
  const r = obj(value);
  return {
    arxivId: nullable(r.arxivId), arxivVersion: nullable(r.arxivVersion), arxivVersions: list(r.arxivVersions).map(str), doi: nullable(r.doi),
    originalPublishedAt: nullable(r.originalPublishedAt), revisedAt: nullable(r.revisedAt), communitySelectedAt: nullable(r.communitySelectedAt), observedAt: nullable(r.observedAt),
    evidenceBasis: str(r.evidenceBasis) || "unknown",
    ...(typeof r.announcedOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.announcedOn) && Number.isFinite(Date.parse(r.announcedOn)) && new Date(r.announcedOn).toISOString().slice(0, 10) === r.announcedOn ? { announcedOn: r.announcedOn } : {}),
    links: list(r.links).flatMap((value) => {
      const l = obj(value), url = publicUrl(l.url), kind = str(l.kind);
      return url && ["paper", "project", "code", "weights"].includes(kind) ? [{ kind, url, sourceUrl: publicUrl(l.sourceUrl) }] : [];
    }),
  };
}
export function brief(value: unknown): PublicBrief | null {
  if (!value) return null;
  const b = obj(value);
  return { methodChange: str(b.methodChange), applicableTasks: str(b.applicableTasks), comparisonConditions: str(b.comparisonConditions), limitations: str(b.limitations), evidenceBasis: str(b.evidenceBasis) || "unknown", sourceRevision: Number.isSafeInteger(b.sourceRevision) && Number(b.sourceRevision) > 0 ? Number(b.sourceRevision) : null };
}
export function roadmap(value: unknown): PublicRoadmap | null {
  if (!value) return null;
  const r = obj(value);
  const nodes = list(r.nodes).map((value) => { const n = obj(value); return { stage: str(n.stage), label: str(n.label), detail: str(n.detail), evidenceSnippet: str(n.evidenceSnippet) }; });
  if (nodes.length < 3 || nodes.length > 6 || nodes.some((n) => !["input", "method", "output", "validation"].includes(n.stage) || !n.evidenceSnippet)) throw new Error("Invalid public research roadmap");
  return { title: str(r.title), nodes, limitations: str(r.limitations), evidenceBasis: str(r.evidenceBasis), sourceRevision: number(r.sourceRevision), sourceUrl: publicUrl(r.sourceUrl), generatedAt: str(r.generatedAt) };
}
export function sanitizeItem(value: unknown): PublicItem {
  const i = obj(value);
  return {
    id: identifier(i.id), title: str(i.title), originalTitle: nullable(i.originalTitle), summary: nullable(i.summary), reason: nullable(i.reason),
    sourceName: str(obj(i.source).name), sourceUrl: publicUrl(obj(i.links).original), publishedAt: nullable(i.publishedAt), timelineAt: nullable(i.timelineAt),
    category: nullable(i.category), tags: list(i.tags).map(str), research: research(i.research), researchBrief: brief(i.researchBrief), researchRoadmap: roadmap(i.researchRoadmap),
    ...(typeof i.selected === "boolean" ? { selected: i.selected } : {}),
  };
}
export function sanitizeTopic(value: unknown, itemIds: string[]): PublicTopic {
  const t = obj(value);
  return { slug: identifier(t.slug), name: str(t.name), group: str(t.group), definition: str(t.definition), total: number(t.total), recent: number(t.recent), latestAt: nullable(t.latestAt), itemIds };
}
export function sanitizeCitation(value: unknown): PublicCitation {
  const c = obj(value);
  return {
    itemId: c.itemId ? identifier(c.itemId) : null, title: str(c.title), summary: nullable(c.summary), sourceName: str(c.sourceName), sourceUrl: publicUrl(c.sourceUrl),
    publishedAt: nullable(c.publishedAt), available: c.available === true, research: research(c.research), researchBrief: brief(c.researchBrief), researchRoadmap: roadmap(c.researchRoadmap),
    paperFigure: c.available === true ? publicPaperFigure(c.paperFigure, nullable(c.itemId), brief(c.researchBrief)?.sourceRevision ?? null) : null,
  };
}
export function sanitizeReport(value: unknown): PublicReport {
  const r = obj(value), run = obj(r.run), lead = obj(r.lead);
  if (r.kind !== "pilot" && r.kind !== "daily" && r.kind !== "weekly" && r.kind !== "monthly") throw new Error("Unsupported report kind");
  const metrics = Object.fromEntries(Object.entries(obj(r.metrics)).filter(([, v]) => typeof v === "number" && Number.isFinite(v))) as Record<string, number>;
  const report: PublicReport = {
    ...(r.illustrated === true ? { illustrated: true } : {}),
    kind: r.kind, key: identifier(r.key), issueNumber: number(r.issueNumber), title: str(r.title), windowStart: str(r.windowStart), windowEnd: str(r.windowEnd),
    generatedAt: str(r.generatedAt), revision: number(r.revision), lead: r.lead ? { title: str(lead.title), leadParagraph: str(lead.leadParagraph) } : null,
    overview: nullable(r.overview), sections: list(r.sections).map((value) => { const s = obj(value); return { label: str(s.label), summary: nullable(s.summary), items: list(s.items).map(sanitizeCitation) }; }),
    metrics, status: str(run.status) || "unknown", gaps: list(run.gaps).map(str),
  };
  if (report.illustrated && report.sections.some(s => s.items.some(i => i.available && !i.paperFigure))) throw new Error("Illustrated report contains an available citation without a verified original figure");
  return report;
}

export function validateSnapshot(snapshot: Snapshot): void {
  const content = JSON.stringify(snapshot);
  if (/(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?=[:\/\s"\\]|$)|\/Users\/|(?:sk-proj-|sk-[A-Za-z0-9]{20})|BEGIN [A-Z ]*PRIVATE KEY/.test(content)) throw new Error("Snapshot contains local-only or credential-like content; refusing export");
  const ids = new Set(snapshot.items.map((i) => i.id));
  if (ids.size !== snapshot.items.length) throw new Error("Duplicate public item IDs");
  if (snapshot.poolItemIds && (new Set(snapshot.poolItemIds).size !== snapshot.poolItemIds.length || snapshot.poolItemIds.some(id => !ids.has(id)))) throw new Error("Invalid public pool item identities");
  if (snapshot.researchAttention && JSON.stringify(snapshot.researchAttention) !== JSON.stringify(computeResearchHeat(poolItems(snapshot), snapshot.generatedAt))) throw new Error("Research attention differs from public snapshot evidence");
  if (snapshot.researchCoverage && JSON.stringify(snapshot.researchCoverage) !== JSON.stringify(sanitizeResearchCoverage(snapshot.researchCoverage))) throw new Error("Research coverage contains fields outside its public whitelist");
  for (const t of snapshot.topics) for (const id of t.itemIds) if (!ids.has(id)) throw new Error(`Missing topic item: ${id}`);
  for (const r of snapshot.reports) for (const s of r.sections) for (const i of s.items) {
    if (i.available && i.itemId && !ids.has(i.itemId)) throw new Error(`Missing report item: ${i.itemId}`);
  }
}
