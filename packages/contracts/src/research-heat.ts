// Research adaptation of heat-v1: deduplicated source channels and the same 24 h half-life.
// Seven days is explicit because sparse research/community announcements are not a live news feed.
export interface ResearchHeatInput {
  id: string; title: string; sourceName: string; sourceUrl: string | null; publishedAt: string | null;
  research: { arxivId: string | null; doi: string | null; originalPublishedAt: string | null; communitySelectedAt: string | null; announcedOn?: string | null } | null;
}
export interface ResearchHeatSignal { source: string; url: string; at: string; kind: "publication" | "announcement" | "community"; precision: "timestamp" | "day" }
export interface ResearchHeatEntry { rank: number; itemId: string; title: string; heat: number; sourceCount: number; signals: ResearchHeatSignal[] }
export interface ResearchHeatRanking {
  ruleVersion: "research-source-heat-v1-168h-halflife24h"; computedAt: string; windowHours: 168; halfLifeHours: 24; minSources: 2;
  publicItems: number; qualifyingResearch: number; recent48hResearch: number; entries: ResearchHeatEntry[];
}
const HOUR = 3_600_000;
function external(value: string | null): URL | null {
  try { const u = new URL(value ?? ""); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname) && !/\.(local|localhost|internal)$/i.test(u.hostname) ? u : null; } catch { return null; }
}
const arxiv = (value: string | null | undefined): string | null => value && /^\d{4}\.\d{4,5}(v\d+)?$/.test(value) ? value.replace(/v\d+$/, "") : null;
const validTime = (value: string | null | undefined): string | null => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

/** Pure calculation shared by the public API and static export; never uses scores, votes or collection time. */
export function computeResearchHeat(items: readonly ResearchHeatInput[], computedAt: string): ResearchHeatRanking {
  const now = Date.parse(computedAt);
  if (!Number.isFinite(now)) throw new Error("Invalid research heat cutoff");
  const groups = new Map<string, { item: ResearchHeatInput; signals: Map<string, ResearchHeatSignal> }>();
  for (const item of items) {
    const url = external(item.sourceUrl), id = arxiv(item.research?.arxivId);
    if (!url) continue;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const sourceKey = host === "arxiv.org" || host.endsWith(".arxiv.org") ? "arxiv.org" : host;
    const urlArxivId = sourceKey === "arxiv.org" ? arxiv(url.pathname.match(/^\/(?:abs|pdf)\/(\d{4}\.\d{4,5}(?:v\d+)?)(?:\.pdf)?\/?$/)?.[1]) : null;
    if (sourceKey === "arxiv.org" && (!id || urlArxivId !== id)) continue;
    const identity = id ? `arxiv:${id}` : item.research?.doi ? `doi:${item.research.doi.toLowerCase()}` : `url:${url.origin}${url.pathname}`;
    let group = groups.get(identity);
    if (!group) { group = { item, signals: new Map() }; groups.set(identity, group); }
    if (item.id.localeCompare(group.item.id) < 0) group.item = item;
    const add = (key: string, signal: ResearchHeatSignal) => {
      const at = Date.parse(signal.at);
      if (at > now || at <= now - 168 * HOUR) return;
      const previous = group!.signals.get(key);
      if (!previous || previous.at < signal.at || (previous.at === signal.at && signal.url.localeCompare(previous.url) < 0)) group!.signals.set(key, signal);
    };
    // Different arXiv category feeds remain one source. HF community inclusion is a second
    // independently recorded channel, not a voter count or evidence of scientific replication.
    const date = validTime(item.research?.originalPublishedAt ?? item.publishedAt);
    if (date && host !== "huggingface.co") add(sourceKey, { source: sourceKey === "arxiv.org" ? "arXiv" : item.sourceName, url: url.href, at: date, kind: "publication", precision: "timestamp" });
    const day = item.research?.announcedOn;
    if (sourceKey === "arxiv.org" && day && /^\d{4}-\d{2}-\d{2}$/.test(day) && validTime(day)?.slice(0, 10) === day) {
      // The source provides a day only: use the start of that UTC day, never an invented hour.
      add(sourceKey, { source: "arXiv", url: url.href, at: `${day}T00:00:00.000Z`, kind: "announcement", precision: "day" });
    }
    const community = validTime(item.research?.communitySelectedAt);
    if (id && community) add("huggingface.co", { source: "Hugging Face Daily Papers", url: `https://huggingface.co/papers/${id}`, at: community, kind: "community", precision: "timestamp" });
  }
  const candidates = [...groups.values()].filter(group => group.signals.size >= 2).map(({ item, signals }) => {
    const evidence = [...signals.values()].sort((a, b) => a.source.localeCompare(b.source));
    const rawHeat = evidence.reduce((sum, signal) => sum + 0.5 ** ((now - Date.parse(signal.at)) / HOUR / 24), 0);
    return { item, evidence, rawHeat };
  }).sort((a, b) => b.rawHeat - a.rawHeat || a.item.id.localeCompare(b.item.id));
  return {
    ruleVersion: "research-source-heat-v1-168h-halflife24h", computedAt: new Date(now).toISOString(), windowHours: 168, halfLifeHours: 24, minSources: 2,
    publicItems: items.length, qualifyingResearch: candidates.length,
    recent48hResearch: candidates.filter(c => c.evidence.filter(s => Date.parse(s.at) > now - 48 * HOUR).length >= 2).length,
    entries: candidates.slice(0, 10).map(({ item, evidence, rawHeat }, i) => ({ rank: i + 1, itemId: item.id, title: item.title, heat: Math.round(rawHeat * 100) / 10, sourceCount: evidence.length, signals: evidence })),
  };
}
