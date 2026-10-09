/** Safe administrator DTOs. Credentials and private runtime paths never cross this contract. */
export type ResearchModelProfileId = "codex-gpt-6-astra" | "codex-gpt-6.1-sol" | "bedrock-gpt-6-astra";
export type ResearchModelReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface ResearchModelProfile {
  version: 1;
  profileId: ResearchModelProfileId;
  transport: "codex_cli" | "bedrock_converse";
  model: string;
  reasoningEffort: string | null;
  region: string | null;
}

export interface ResearchModelChoice {
  id: ResearchModelProfileId;
  label: string;
  transport: ResearchModelProfile["transport"];
  model: string;
  reasoningEffort: string | null;
  region: string | null;
  /** Configuration readiness only; this does not establish account entitlement or generation success. */
  available: boolean;
  unavailableReason: string | null;
  availability: "untested" | "unavailable";
  evidenceNote: string;
  checkedAt: string | null;
}

export interface ResearchModelOverview {
  selectedProfileId: ResearchModelProfileId | null;
  selectedProfile: ResearchModelProfile | null;
  source: "setting" | "environment";
  revision: number;
  choices: ResearchModelChoice[];
  appliesTo: "new_research_runs";
  /** Recent persisted batches, not evidence of a currently running process. */
  currentRuns: Array<{ runId: string; status: string; profile: ResearchModelProfile | null }>;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface ResearchModelUpdate {
  profileId: ResearchModelProfileId;
  reasoningEffort?: ResearchModelReasoningEffort;
  expectedRevision: number;
  reason: string;
}
