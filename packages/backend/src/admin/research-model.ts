// The Agent page saves a profile, not credentials and not a job launch. Session and CSRF checks
// live in the shared admin handler; the setting and its audit entry commit in one transaction.
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ResearchModelChoice, ResearchModelOverview, ResearchModelProfileId } from "@aihot/contracts/research-model";
import { audit, Conflict } from "../audit.ts";
import { credential } from "../config.ts";
import { sql, type Db } from "../db.ts";
import { parseResearchModelProfile, RESEARCH_MODEL_PROFILES, RESEARCH_MODEL_SETTING, researchModelProfileId, researchModelReasoningEffort, researchModelSelection, researchModelValidations } from "../providers/research-model.ts";

const LABELS: Record<ResearchModelProfileId, string> = {
  "codex-gpt-6-astra": "GPT-6 Astra · Codex 订阅",
  "codex-gpt-6.1-sol": "GPT-6.1 Sol · Codex 订阅",
  "bedrock-gpt-6-astra": "GPT-6 Astra · Amazon Bedrock",
};
const updateSchema = z.object({
  profileId: researchModelProfileId,
  reasoningEffort: researchModelReasoningEffort.optional(),
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1, "请说明切换原因").max(300),
}).strict();
async function codexConfigured(): Promise<boolean> {
  const bin = process.env.CODEX_BIN || "codex";
  const candidates = bin.includes(path.sep) ? [bin] : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, bin));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return true; } catch { /* Try the next configured PATH entry. */ }
  }
  return false;
}

async function choices(db: Db): Promise<ResearchModelChoice[]> {
  const diagnostics = await researchModelValidations(db);
  const codexReady = await codexConfigured();
  const bedrockReady = !!credential("models", "AWS_BEARER_TOKEN_BEDROCK");
  return Object.values(RESEARCH_MODEL_PROFILES).map(profile => {
    const rejected = diagnostics[profile.profileId];
    const configured = profile.transport === "codex_cli" ? codexReady : bedrockReady;
    const unavailableReason = rejected?.reason ?? (configured ? null : profile.transport === "codex_cli" ? "本机未找到可执行的 Codex CLI" : "后端尚未配置 Bedrock 凭据");
    return { id: profile.profileId, label: LABELS[profile.profileId], transport: profile.transport, model: profile.model,
      reasoningEffort: profile.reasoningEffort, region: profile.region, available: unavailableReason === null,
      unavailableReason, availability: unavailableReason === null ? "untested" : "unavailable",
      evidenceNote: rejected?.reason ?? (configured ? "本机配置已就绪；当前账户的模型权限和实际调用未在此处验证" : unavailableReason!),
      checkedAt: rejected?.checkedAt ?? null };
  });
}

export async function researchModelOverview(db: Db = sql): Promise<ResearchModelOverview> {
  const selection = await researchModelSelection(db);
  const options = await choices(db);
  const runs = await db<{ id: string; status: string; model_profile: unknown }[]>`
    SELECT id,status,model_profile FROM research_runs ORDER BY created_at DESC,id DESC LIMIT 5`;
  return { selectedProfileId: selection.profile?.profileId ?? null, selectedProfile: selection.profile,
    source: selection.source, revision: selection.revision, choices: options, appliesTo: "new_research_runs",
    currentRuns: runs.map(row => ({ runId: row.id, status: row.status, profile: row.model_profile === null ? null : parseResearchModelProfile(row.model_profile) })),
    updatedAt: selection.updatedAt, updatedBy: selection.updatedBy };
}

export async function switchResearchModel(input: unknown, actor: string): Promise<ResearchModelOverview> {
  const change = updateSchema.parse(input);
  return sql.begin(async tx => {
    // The first write also needs serialization: SELECT FOR UPDATE cannot lock an absent row.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${RESEARCH_MODEL_SETTING}))`;
    const before = await researchModelSelection(tx);
    if (before.revision !== change.expectedRevision) throw new Conflict("调研模型设置已更新，请刷新页面后重试");
    const option = (await choices(tx)).find(profile => profile.id === change.profileId)!;
    if (change.reasoningEffort !== undefined && option.transport !== "codex_cli") {
      throw Object.assign(new Error("仅 Codex 订阅模型可设置推理强度"), { statusCode: 400 });
    }
    if (!option.available) throw Object.assign(new Error(option.unavailableReason ?? "该调研模型当前不可选择"), { statusCode: 400 });
    const reasoningEffort = change.reasoningEffort ?? (before.profile?.profileId === change.profileId ? before.profile.reasoningEffort : option.reasoningEffort);
    const value = { profileId: change.profileId, revision: before.revision + 1, ...(reasoningEffort ? { reasoningEffort } : {}) };
    await tx`INSERT INTO settings(key,value,updated_by) VALUES(${RESEARCH_MODEL_SETTING},${tx.json(value)},${actor})
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()`;
    const after = await researchModelSelection(tx);
    await audit(actor, "research-model.switch", `settings:${RESEARCH_MODEL_SETTING}`, change.reason, before, after, { db: tx });
    return researchModelOverview(tx);
  }) as Promise<ResearchModelOverview>;
}
