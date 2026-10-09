// A selection applies only when a research batch is created. A resumed batch reads its own
// immutable snapshot; historical NULL snapshots keep the deployment's original environment route.
import type { ResearchModelProfile, ResearchModelProfileId } from "@aihot/contracts/research-model";
import { z } from "zod";
import { sql, type Db } from "../db.ts";

export const RESEARCH_MODEL_SETTING = "research.model_profile";
export const RESEARCH_MODEL_PROFILES: Readonly<Record<ResearchModelProfileId, ResearchModelProfile>> = {
  "codex-gpt-6-astra": { version: 1, profileId: "codex-gpt-6-astra", transport: "codex_cli", model: "gpt-6-astra", reasoningEffort: "medium", region: null },
  "codex-gpt-6.1-sol": { version: 1, profileId: "codex-gpt-6.1-sol", transport: "codex_cli", model: "gpt-6.1-sol", reasoningEffort: "medium", region: null },
  "bedrock-gpt-6-astra": { version: 1, profileId: "bedrock-gpt-6-astra", transport: "bedrock_converse", model: "global.openai.gpt-6-astra", reasoningEffort: null, region: "us-east-1" },
};
export const researchModelProfileId = z.enum(["codex-gpt-6-astra", "codex-gpt-6.1-sol", "bedrock-gpt-6-astra"]);
export const researchModelReasoningEffort = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]);
const effort = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const profileSchema = z.object({
  version: z.literal(1), profileId: researchModelProfileId,
  transport: z.enum(["codex_cli", "bedrock_converse"]), model: z.string(),
  reasoningEffort: effort.nullable(), region: z.string().nullable(),
}).strict().superRefine((value, context) => {
  const registered = RESEARCH_MODEL_PROFILES[value.profileId];
  if (value.transport !== registered.transport || value.model !== registered.model || value.region !== registered.region
    || (value.transport === "bedrock_converse" ? value.reasoningEffort !== null : value.reasoningEffort === null)) {
    context.addIssue({ code: "custom", message: "Research model snapshot does not match its registered profile" });
  }
});
const settingSchema = z.object({ profileId: researchModelProfileId, reasoningEffort: effort.optional(), revision: z.number().int().positive() }).strict();
const validationSchema = z.object({
  model: z.string().min(1).max(100), region: z.string().nullable(), status: z.literal("unavailable"),
  checkedAt: z.string().datetime(), reason: z.string().trim().min(1).max(300),
}).strict();
const validationsSchema = z.object({ profiles: z.object({
  "codex-gpt-6-astra": validationSchema.optional(),
  "codex-gpt-6.1-sol": validationSchema.optional(),
  "bedrock-gpt-6-astra": validationSchema.optional(),
}).strict() }).strict();
export type ResearchModelValidation = z.infer<typeof validationSchema>;

/** Only trusted local diagnostics that match this exact registered model and region apply. */
export async function researchModelValidations(db: Db = sql): Promise<Partial<Record<ResearchModelProfileId, ResearchModelValidation>>> {
  const [row] = await db<{ value: unknown }[]>`SELECT value FROM settings WHERE key='research.model_validation'`;
  if (!row) return {};
  const profiles = validationsSchema.parse(row.value).profiles;
  return Object.fromEntries(Object.entries(profiles).filter(([id, diagnostic]) => {
    const profile = RESEARCH_MODEL_PROFILES[id as ResearchModelProfileId];
    return diagnostic.model === profile.model && diagnostic.region === profile.region;
  }));
}

/** Also applies to an already frozen batch: a later known rejection stops sending, without rewriting it. */
export async function assertResearchModelUsable(profile: Pick<ResearchModelProfile, "transport" | "model" | "region">, db: Db = sql): Promise<void> {
  const id = Object.values(RESEARCH_MODEL_PROFILES).find(p => p.transport === profile.transport && p.model === profile.model && p.region === profile.region)?.profileId;
  if (!id) return;
  const rejected = (await researchModelValidations(db))[id];
  if (rejected) throw Object.assign(new Error(rejected.reason), { statusCode: 400, code: "research_model_unavailable" });
}

export function parseResearchModelProfile(value: unknown): ResearchModelProfile {
  return profileSchema.parse(value);
}

export interface ResearchModelSelection {
  profile: ResearchModelProfile | null;
  source: "setting" | "environment";
  revision: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Keep compatibility installations and offline fixtures on their own pre-existing route. */
function environmentProfile(): ResearchModelProfile | null {
  if (process.env.LLM_TRANSPORT !== "codex_cli") return null;
  const model = process.env.CODEX_MODEL || "gpt-6-astra";
  const profile = Object.values(RESEARCH_MODEL_PROFILES).find(p => p.transport === "codex_cli" && p.model === model);
  if (!profile) return null;
  return parseResearchModelProfile({ ...profile, reasoningEffort: process.env.CODEX_REASONING_EFFORT || "medium" });
}

export async function researchModelSelection(db: Db = sql): Promise<ResearchModelSelection> {
  const [row] = await db<{ value: unknown; updated_at: Date; updated_by: string | null }[]>`
    SELECT value,updated_at,updated_by FROM settings WHERE key=${RESEARCH_MODEL_SETTING}`;
  if (!row) return { profile: environmentProfile(), source: "environment", revision: 0, updatedAt: null, updatedBy: null };
  const setting = settingSchema.parse(row.value);
  const registered = RESEARCH_MODEL_PROFILES[setting.profileId];
  const profile = parseResearchModelProfile({ ...registered, reasoningEffort: setting.reasoningEffort ?? registered.reasoningEffort });
  return { profile, source: "setting", revision: setting.revision,
    updatedAt: row.updated_at.toISOString(), updatedBy: row.updated_by };
}

/** Used only for the INSERT of a new batch, never for resuming an existing batch. */
export async function selectedResearchModel(db: Db = sql): Promise<ResearchModelProfile | null> {
  const profile = (await researchModelSelection(db)).profile;
  if (profile) await assertResearchModelUsable(profile, db);
  return profile;
}

/** A NULL historical snapshot deliberately does not consult the current administrator selection. */
export async function researchModelForRun(runId: string, db: Db = sql): Promise<ResearchModelProfile | null> {
  const [row] = await db<{ model_profile: unknown }[]>`SELECT model_profile FROM research_runs WHERE id=${runId}`;
  if (!row) throw new Error(`Research run ${runId} does not exist`);
  return row.model_profile === null ? null : parseResearchModelProfile(row.model_profile);
}
