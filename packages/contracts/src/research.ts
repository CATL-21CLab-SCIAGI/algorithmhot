export const RESEARCH_EVIDENCE_BASES = ["abstract", "fulltext", "source_summary", "unknown"] as const;
export type ResearchEvidenceBasis = typeof RESEARCH_EVIDENCE_BASES[number];

/** Source-backed research metadata. Unknown dates stay null; community selection is not publication. */
export interface ResearchMetadata {
  canonicalKey: string | null;
  arxivId: string | null;
  arxivVersion: string | null;
  arxivVersions: string[];
  doi: string | null;
  originalPublishedAt: string | null;
  /** Official arXiv announcement day (YYYY-MM-DD); distinct from the submission timestamp. */
  announcedOn?: string | null;
  revisedAt: string | null;
  communitySelectedAt: string | null;
  observedAt: string | null;
  evidenceBasis: ResearchEvidenceBasis;
  signalOnly: boolean;
  links: Array<{ kind: "paper" | "project" | "code" | "weights"; url: string; sourceUrl: string }>;
}

/** Model interpretation of one source revision; claims remain attributed to their authors. */
export interface ResearchBrief {
  methodChange: string;
  applicableTasks: string;
  comparisonConditions: string;
  limitations: string;
  evidenceBasis: ResearchMetadata["evidenceBasis"];
  sourceRevision: number;
  promptVersion: string;
  generatedAt: string;
  /** An audited source check changes only the published interpretation, never the model receipt. */
  editorialReview?: { sourceRevision: number; reviewedAt: string; note: string };
}

/** A source-bound reading aid, not a paper figure or an independent reproduction. */
export interface ResearchRoadmap {
  title: string;
  nodes: Array<{
    stage: "input" | "method" | "output" | "validation";
    label: string;
    detail: string;
    /** A short verbatim excerpt from the exact source revision used. */
    evidenceSnippet: string;
  }>;
  limitations: string;
  evidenceBasis: ResearchEvidenceBasis;
  sourceRevision: number;
  sourceHash: string;
  sourceUrl: string;
  promptVersion: string;
  generatedAt: string;
}

export const RESEARCH_BRIEF_LABELS = {
  methodChange: "研究变化",
  applicableTasks: "适用任务",
  comparisonConditions: "作者报告的比较条件",
  limitations: "证据限制",
} as const;
