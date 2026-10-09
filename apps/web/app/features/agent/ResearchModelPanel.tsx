import { useEffect, useState, type FormEvent } from "react";
import type { ResearchModelOverview, ResearchModelProfile, ResearchModelProfileId } from "@aihot/contracts/research-model";
import { fullDateTime } from "../../lib/format";
import { ResearchModelSaveError, saveResearchModel, type ResearchModelPanelData } from "../../lib/research-model";

const LOGIN = "/admin/login?return=%2Fagent";
const preferred: ResearchModelProfileId[] = ["codex-gpt-6-astra", "codex-gpt-6.1-sol", "bedrock-gpt-6-astra"];
const billing = (transport: ResearchModelProfile["transport"]) => transport === "codex_cli" ? "Codex 订阅" : "AWS Bedrock · 按量付费";
const modelName = (overview: ResearchModelOverview, profile: ResearchModelProfile | null) => profile
  ? overview.choices.find(c => c.id === profile.profileId)?.label ?? profile.model : "未对应预设的环境配置";

export function ResearchModelPanel({ data }: { data: ResearchModelPanelData }) {
  return <section id="research-models" data-live-research-model-panel="true" aria-labelledby="research-model-heading" className="mt-5 scroll-mt-6 rounded-2xl border border-line bg-surface px-5 py-5 sm:px-6">
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 id="research-model-heading" className="text-[16px] font-semibold text-ink">调研模型</h2>
      <span className="text-[11px] text-ink-4">管理员设置 · 下一新批次生效</span>
    </div>
    {data.kind === "admin" ? <AdminModelPanel initial={data.overview} csrf={data.csrf} /> : <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
      <p className="max-w-[520px] text-[13px] leading-relaxed text-ink-3">{data.kind === "anonymous"
        ? "登录后可查看和切换本站后续调研使用的模型。优先提供 GPT-6 Astra；页面阅读不会发起模型调用。"
        : "模型设置暂时无法读取。已有公开资料仍可阅读，请稍后刷新或登录管理员账号。"}</p>
      <a className="shrink-0 rounded-full border border-line-strong px-4 py-2 text-[12px] font-medium text-accent hover:bg-bg-sunk" href={LOGIN}>管理员登录</a>
    </div>}
  </section>;
}

function AdminModelPanel({ initial, csrf }: { initial: ResearchModelOverview; csrf: string }) {
  const [overview, setOverview] = useState(initial);
  const [choice, setChoice] = useState<ResearchModelProfileId>(initial.selectedProfileId ?? "codex-gpt-6-astra");
  const [reason, setReason] = useState("从 Agent 接入页切换调研模型");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<ResearchModelSaveError | null>(null);
  useEffect(() => { setOverview(initial); setChoice(initial.selectedProfileId ?? "codex-gpt-6-astra"); setMessage(null); setError(null); }, [initial]);
  const choices = [...overview.choices].sort((a, b) => preferred.indexOf(a.id) - preferred.indexOf(b.id));
  const selected = choices.find(c => c.id === choice);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !selected?.available || choice === overview.selectedProfileId || !reason.trim()) return;
    setBusy(true); setMessage(null); setError(null);
    try {
      const saved = await saveResearchModel({ profileId: choice, expectedRevision: overview.revision, reason: reason.trim() }, csrf);
      setOverview(saved); setChoice(saved.selectedProfileId ?? choice);
      setMessage("已保存，将用于下一次新建的调研批次。此次保存未发起模型调用。");
    } catch (e) { setError(e instanceof ResearchModelSaveError ? e : new ResearchModelSaveError(0)); }
    finally { setBusy(false); }
  };
  return <div data-private-model-control="true">
    <div className="mt-3 rounded-xl bg-bg-sunk/60 px-3.5 py-3">
      <p className="text-[11px] text-ink-4">已选模型 · {overview.source === "setting" ? "管理员设置" : "当前部署配置"}</p>
      <p className="mt-1 text-[14px] font-semibold text-ink">{modelName(overview, overview.selectedProfile)}</p>
      {overview.selectedProfile && <p className="mt-1 text-[12px] text-ink-3">{billing(overview.selectedProfile.transport)}{overview.selectedProfile.reasoningEffort ? ` · 推理强度 ${overview.selectedProfile.reasoningEffort}` : " · 服务商默认推理配置"}</p>}
      {overview.updatedAt && <p className="mt-1 text-[11px] text-ink-4">设置更新于 {fullDateTime(overview.updatedAt)}</p>}
    </div>
    <form onSubmit={submit} className="mt-4 space-y-3">
      <div>
        <label htmlFor="research-model-choice" className="mb-1.5 block text-[12px] font-medium text-ink-2">后续调研模型</label>
        <select id="research-model-choice" name="profileId" value={choice} disabled={busy} onChange={event => { setChoice(event.target.value as ResearchModelProfileId); setMessage(null); setError(null); }} className="h-10 w-full rounded-lg border border-line-strong bg-surface px-3 text-[13px] text-ink focus:border-accent focus:outline-none disabled:opacity-60">
          {choices.map(c => <option key={c.id} value={c.id} disabled={!c.available}>{c.label}{c.available ? "" : " · 暂不可选"}</option>)}
        </select>
      </div>
      {selected && <div className={`rounded-lg px-3 py-2.5 text-[12px] leading-relaxed ${selected.transport === "bedrock_converse" ? "bg-amber-soft text-amber-ink" : "bg-bg-sunk text-ink-3"}`}>
        <p className="font-medium">{billing(selected.transport)} · {selected.availability === "unavailable" ? "当前不可用" : "模型可用性未测试"}</p>
        <p className="mt-1">{selected.unavailableReason ?? selected.evidenceNote}</p>
        {selected.checkedAt && <p className="mt-1">检查于 {fullDateTime(selected.checkedAt)}</p>}
        {selected.transport === "bedrock_converse" && <p className="mt-1">保存后，未来新批次将使用 AWS 按量付费调用；600 次调用上限不是美元费用上限。</p>}
      </div>}
      {choices.filter(c => !c.available && c.id !== choice).map(c => <p key={c.id} className="text-[12px] leading-relaxed text-ink-4">{c.label}：{c.unavailableReason ?? c.evidenceNote}{c.checkedAt ? `（${fullDateTime(c.checkedAt)} 检查）` : ""}。{c.transport === "bedrock_converse" ? "此路线按 AWS 用量收费。" : ""}</p>)}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor="research-model-reason" className="mb-1.5 block text-[12px] font-medium text-ink-2">切换备注</label>
          <input id="research-model-reason" name="reason" value={reason} disabled={busy} required minLength={3} maxLength={300} onChange={event => setReason(event.target.value)} className="h-10 w-full rounded-lg border border-line-strong bg-surface px-3 text-[13px] text-ink focus:border-accent focus:outline-none disabled:opacity-60" />
        </div>
        <button type="submit" disabled={busy || !selected?.available || choice === overview.selectedProfileId || reason.trim().length < 3} className="h-10 shrink-0 rounded-full bg-accent px-4 text-[12px] font-semibold text-accent-contrast hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45">{busy ? "保存中…" : "保存，下一新批次生效"}</button>
      </div>
      <p className="text-[11px] leading-relaxed text-ink-4">只保存模型选择。已有批次使用各自固定的配置；查看页面或保存选择不会进行模型测试。</p>
      {message && <p role="status" className="text-[12px] text-ok">{message}</p>}
      {error && <p role="alert" className="text-[12px] leading-relaxed text-hot">{error.message} <a href={error.status === 401 ? LOGIN : "/agent#research-models"} className="underline">{error.status === 401 ? "重新登录" : "刷新设置"}</a></p>}
    </form>
    <details className="mt-4 border-t border-line pt-3">
      <summary className="cursor-pointer text-[12px] font-medium text-ink-3">已有批次的固定配置{overview.currentRuns.length ? `（最近 ${overview.currentRuns.length} 条）` : ""}</summary>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-4">以下为已保存的批次记录，实际进程是否仍在运行未核验。</p>
      {overview.currentRuns.length ? <ul className="mt-2 space-y-2">{overview.currentRuns.map(run => <li key={run.runId} className="rounded-lg bg-bg-sunk/50 px-3 py-2 text-[12px] leading-relaxed">
        <div className="flex flex-wrap justify-between gap-x-3"><code className="break-all text-ink-2">{run.runId}</code><span className="text-ink-4">状态：{run.status}</span></div>
        <p className="mt-1 text-ink-3">{run.profile ? `${modelName(overview, run.profile)} · ${billing(run.profile.transport)}` : "沿用该部署原有配置（旧批次未保存模型快照）"}</p>
      </li>)}</ul> : <p className="mt-2 text-[12px] text-ink-4">暂无已保存的批次记录。</p>}
    </details>
  </div>;
}
