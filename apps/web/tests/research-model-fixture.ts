import type { ResearchModelOverview, ResearchModelProfile } from "@aihot/contracts/research-model";

const astra: ResearchModelProfile = { version: 1, profileId: "codex-gpt-6-astra", transport: "codex_cli", model: "gpt-6-astra", reasoningEffort: "high", region: null };
const sol: ResearchModelProfile = { ...astra, profileId: "codex-gpt-6.1-sol", model: "gpt-6.1-sol" };
const bedrock: ResearchModelProfile = { version: 1, profileId: "bedrock-gpt-6-astra", transport: "bedrock_converse", model: "global.openai.gpt-6-astra", reasoningEffort: null, region: "us-west-2" };

export function modelOverviewFixture(): ResearchModelOverview {
  return {
    selectedProfileId: sol.profileId, selectedProfile: { ...sol }, source: "setting", revision: 4,
    choices: [astra, sol, bedrock].map(profile => ({
      id: profile.profileId, label: `${profile.model} · ${profile.transport === "codex_cli" ? "Codex" : "Bedrock"}`,
      transport: profile.transport, model: profile.model, reasoningEffort: profile.reasoningEffort, region: profile.region,
      available: profile.transport === "codex_cli", availability: profile.transport === "codex_cli" ? "untested" : "unavailable",
      unavailableReason: profile.transport === "bedrock_converse" ? "服务区域拒绝访问；HTTP 400，未成功生成。" : null,
      evidenceNote: profile.transport === "codex_cli" ? "本机登录配置存在；模型实际生成尚未测试。" : "已保留失败证据。",
      checkedAt: profile.transport === "bedrock_converse" ? "2026-10-06T06:30:00Z" : null,
    })),
    appliesTo: "new_research_runs", updatedAt: "2026-10-06T05:00:00Z", updatedBy: "admin",
    currentRuns: [{ runId: "synthetic-partial-batch", status: "partial", profile: { ...sol } }, { runId: "synthetic-old-batch", status: "completed", profile: null }],
  };
}

export function internalModelFixture() {
  const value = modelOverviewFixture();
  return { ...value, apiKey: "PRIVATE_API_KEY", runtimePath: "/PRIVATE_RUNTIME_PATH",
    selectedProfile: { ...value.selectedProfile!, auth: "PRIVATE_PROFILE_AUTH" },
    choices: value.choices.map(choice => ({ ...choice, credential: "PRIVATE_CHOICE_CREDENTIAL" })),
    currentRuns: value.currentRuns.map(run => ({ ...run, receipt: "PRIVATE_RECEIPT", profile: run.profile ? { ...run.profile, auth: "PRIVATE_RUN_AUTH" } : null })),
  };
}
