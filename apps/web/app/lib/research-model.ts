import type { ResearchModelOverview, ResearchModelProfile, ResearchModelUpdate } from "@aihot/contracts/research-model";

export type ResearchModelPanelData =
  | { kind: "anonymous" }
  | { kind: "unavailable" }
  | { kind: "admin"; csrf: string; overview: ResearchModelOverview };

/** Keep the browser boundary narrow even if an internal response later gains private fields. */
export function researchModelOverview(value: ResearchModelOverview): ResearchModelOverview {
  const profile = (p: ResearchModelProfile | null): ResearchModelProfile | null => p ? {
    version: p.version, profileId: p.profileId, transport: p.transport, model: p.model, reasoningEffort: p.reasoningEffort, region: p.region,
  } : null;
  return {
    selectedProfileId: value.selectedProfileId, selectedProfile: profile(value.selectedProfile), source: value.source,
    revision: value.revision, appliesTo: value.appliesTo, updatedAt: value.updatedAt, updatedBy: value.updatedBy,
    choices: value.choices.map(c => ({ id: c.id, label: c.label, transport: c.transport, model: c.model,
      reasoningEffort: c.reasoningEffort, region: c.region, available: c.available, unavailableReason: c.unavailableReason,
      availability: c.availability, evidenceNote: c.evidenceNote, checkedAt: c.checkedAt })),
    currentRuns: value.currentRuns.map(r => ({ runId: r.runId, status: r.status, profile: profile(r.profile) })),
  };
}

export class ResearchModelSaveError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(status === 401 ? "管理员登录已过期，请重新登录。"
      : status === 403 ? "登录验证已过期，请刷新页面后再保存。"
      : status === 409 ? "设置已被其他操作更新，请刷新后重新选择。"
      : status === 400 ? "当前选择无法保存，请刷新确认模型状态与切换备注。"
      : "尚未确认是否保存成功，请刷新查看当前设置。");
    this.status = status;
  }
}

/** A preference write only. The server owns validation, audit, and next-run activation. */
export async function saveResearchModel(update: ResearchModelUpdate, csrf: string, fetcher: typeof fetch = fetch): Promise<ResearchModelOverview> {
  try {
    const response = await fetcher("/api/admin/research-model", {
      method: "PUT", credentials: "same-origin", redirect: "error",
      headers: { "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ profileId: update.profileId, expectedRevision: update.expectedRevision, reason: update.reason }),
    });
    if (!response.ok) throw new ResearchModelSaveError(response.status);
    return researchModelOverview(await response.json());
  } catch (error) {
    throw error instanceof ResearchModelSaveError ? error : new ResearchModelSaveError(0);
  }
}
