import type { ResearchMetadata } from "@aihot/contracts/research";
import { isValidDate } from "@aihot/contracts/time";
import { stableJson } from "../lib/ids.ts";

export interface ArxivIdentity {
  id: string;
  version: string | null;
  canonicalKey: string;
  canonicalUrl: string;
}

/** Only a whole arXiv id or an arxiv.org URL qualifies; embedded links do not change identity. */
export function parseArxivIdentity(value: unknown): ArxivIdentity | null {
  if (typeof value !== "string") return null;
  let id = value.trim().replace(/^arxiv:/i, "");
  if (/^https?:\/\//i.test(id)) {
    try {
      const url = new URL(id);
      if (!/^(?:export\.|www\.)?arxiv\.org$/i.test(url.hostname)) return null;
      id = decodeURIComponent(url.pathname).replace(/^\/(?:abs|pdf|html)\//i, "").replace(/\.pdf$/i, "");
    } catch { return null; }
  }
  const match = /^(\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z-]+)?\/\d{7})(v[1-9]\d*)?$/i.exec(id);
  if (!match) return null;
  const base = match[1]!.toLowerCase();
  return { id: base, version: match[2]?.toLowerCase() ?? null, canonicalKey: `arxiv:${base}`, canonicalUrl: `https://arxiv.org/abs/${base}` };
}

export function researchDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** A day heading is a calendar date, never an inferred publication timestamp. */
export function researchAnnouncementDate(value: unknown): string | null {
  return typeof value === "string" && isValidDate(value) ? value : null;
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

/** Keep only links stated by the source, with provenance; repository existence is not replication. */
export function researchLinks(sourceUrl: string, values: Array<{ kind: ResearchMetadata["links"][number]["kind"]; url: unknown }>, text = ""): ResearchMetadata["links"] {
  const links = [...values];
  // Braces delimit LaTeX \href{URL}{label} and \url{URL}; they are not part of the URL.
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'{}]+/g)) {
    const url = match[0].replace(/[.,;:!?]+$/, "").replace(/&amp;/g, "&").replace(/\\([_&%#])/g, "$1").replace(/[)\]]+$/, "");
    let parsed: URL;
    try { parsed = new URL(url); } catch { continue; }
    const hostname = parsed.hostname.replace(/^www\./i, "");
    const segments = parsed.pathname.split("/").filter(Boolean);
    const before = text.slice(Math.max(0, match.index! - 130), match.index).replace(/<[^>]*>/g, " ");
    const tail = text.slice(match.index! + match[0].length);
    const htmlLabel = /^['"][^>]*>([^<]{0,100})<\/a>/i.exec(tail)?.[1];
    const latexLabel = /\\href\s*\{\s*$/.test(before) ? /^\}\s*\{([^{}]{0,100})\}/.exec(tail)?.[1] : undefined;
    const anchorLabel = (htmlLabel ?? latexLabel ?? "").replace(/~/g, " ");
    // Classify only explicit nearby labels or known repository/paper URL structures. An arbitrary
    // homepage or a Hugging Face dataset/Space must not silently become a downloadable weight.
    const context = `${before} ${anchorLabel}`;
    const weights = /(?:model\s+weights?|weights?|checkpoints?|模型权重|权重|检查点)[^.!?;\n]{0,85}$/i.test(context.trim()) || /^(?:model|模型)(?:\s+(?:page|repository|repo))?$/i.test(anchorLabel.trim());
    const project = /(?:project\s*(?:page|website|site)?|项目(?:主页|页面|网站)?)[^.!?;\n]{0,85}$/i.test(context.trim());
    const code = /(?:source\s+code|code(?:\s+repository)?|源码|代码)[^.!?;\n]{0,85}$/i.test(context.trim());
    if (["github.com", "gitlab.com"].includes(hostname) && segments.length >= 2 && !["topics", "features", "orgs", "users", "search"].includes(segments[0]!)) links.push({ kind: "code", url });
    else if (parseArxivIdentity(url)) links.push({ kind: "paper", url });
    else if (weights && (hostname !== "huggingface.co" || (segments.length >= 2 && !["datasets", "spaces", "papers", "docs", "collections", "organizations"].includes(segments[0]!)))) links.push({ kind: "weights", url });
    else if (hostname === "huggingface.co" && /^hugging\s*face$/i.test(anchorLabel.trim())) links.push({ kind: "project", url });
    else if (project) links.push({ kind: "project", url });
    else if (code) links.push({ kind: "code", url });
  }
  const unique = new Map<string, ResearchMetadata["links"][number]>();
  for (const link of links) {
    const url = safeUrl(link.url);
    if (url) unique.set(`${link.kind}:${url}`, { kind: link.kind, url, sourceUrl });
  }
  return [...unique.values()];
}

export function makeResearchMetadata(input: {
  identity?: ArxivIdentity | null;
  doi?: unknown;
  originalPublishedAt?: unknown;
  announcedOn?: unknown;
  revisedAt?: unknown;
  communitySelectedAt?: unknown;
  observedAt?: unknown;
  evidenceBasis: ResearchMetadata["evidenceBasis"];
  signalOnly?: boolean;
  links?: ResearchMetadata["links"];
}): ResearchMetadata {
  return {
    canonicalKey: input.identity?.canonicalKey ?? null,
    arxivId: input.identity?.id ?? null,
    arxivVersion: input.identity?.version ?? null,
    arxivVersions: input.identity?.version ? [input.identity.version] : [],
    doi: typeof input.doi === "string" && input.doi.trim() ? input.doi.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "") : null,
    originalPublishedAt: researchDate(input.originalPublishedAt),
    announcedOn: researchAnnouncementDate(input.announcedOn),
    revisedAt: researchDate(input.revisedAt),
    communitySelectedAt: researchDate(input.communitySelectedAt),
    observedAt: researchDate(input.observedAt),
    evidenceBasis: input.evidenceBasis,
    signalOnly: input.signalOnly ?? false,
    links: input.links ?? [],
  };
}

/** Never erase established evidence with an absent value or downgrade a version on another feed. */
export function mergeResearchMetadata(previous: ResearchMetadata | null, incoming: ResearchMetadata): ResearchMetadata {
  if (!previous) return incoming;
  const versions = [...new Set([...previous.arxivVersions, ...incoming.arxivVersions])].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const first = (a: string | null, b: string | null) => !a ? b : !b ? a : a < b ? a : b;
  const last = (a: string | null, b: string | null) => !a ? b : !b ? a : a > b ? a : b;
  const links = [...new Map([...previous.links, ...incoming.links].map(link => [`${link.kind}:${link.url}:${link.sourceUrl}`, link])).values()];
  // Community feeds may provide only a calendar date or a different paper version. They
  // contribute selection/link evidence, never replace the original paper's source evidence.
  if (previous.signalOnly !== incoming.signalOnly) {
    const paper = previous.signalOnly ? incoming : previous;
    return { ...paper, communitySelectedAt: first(previous.communitySelectedAt, incoming.communitySelectedAt), links };
  }
  const rank = { unknown: 0, source_summary: 1, abstract: 2, fulltext: 3 };
  return {
    canonicalKey: previous.canonicalKey ?? incoming.canonicalKey,
    arxivId: previous.arxivId ?? incoming.arxivId,
    arxivVersion: versions.at(-1) ?? incoming.arxivVersion ?? previous.arxivVersion,
    arxivVersions: versions,
    doi: previous.doi ?? incoming.doi,
    originalPublishedAt: first(previous.originalPublishedAt, incoming.originalPublishedAt),
    announcedOn: last(researchAnnouncementDate(previous.announcedOn), researchAnnouncementDate(incoming.announcedOn)),
    revisedAt: last(previous.revisedAt, incoming.revisedAt),
    communitySelectedAt: first(previous.communitySelectedAt, incoming.communitySelectedAt),
    observedAt: first(previous.observedAt, incoming.observedAt),
    evidenceBasis: rank[incoming.evidenceBasis] > rank[previous.evidenceBasis] ? incoming.evidenceBasis : previous.evidenceBasis,
    signalOnly: previous.signalOnly,
    links,
  };
}

export const researchMetadataChanged = (previous: ResearchMetadata | null, next: ResearchMetadata): boolean => stableJson(previous) !== stableJson(next);
