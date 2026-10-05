import type { ReportDetail } from "@aihot/contracts/site";
import { fullDateTime } from "../../lib/format";

const STATUS: Record<string, string> = {
  created: "尚未开始", collecting: "采集中", processing: "处理中", complete: "处理完成", completed: "处理完成",
  partial: "部分完成", failed: "运行失败", blocked: "等待恢复", published: "已生成试刊",
};
const METRICS: Record<string, string> = {
  sourcesPlanned: "计划来源", plannedSources: "计划来源", sourcesObserved: "已观测来源", sourcesSucceeded: "成功来源", sourcesFailed: "失败来源", healthyEmptySources: "健康空源",
  returned: "返回记录", parsed: "解析成功", excludedSourceRecords: "公告集合外记录", duplicateRecords: "重复记录", duplicates: "重复记录", stored: "已保存资料", inWindow: "窗口内资料", outsideWindow: "窗口外资料", signals: "社区信号",
  previouslyAdmitted: "此前已准入", newlyAdmitted: "本次新增准入", admitted: "准入模型处理", notAdmitted: "未准入资料", processed: "处理结果已记录", failed: "处理失败", unknownOutcome: "请求结果未知", pending: "待处理",
  selected: "精选", published: "本期刊载", publishedCount: "本期刊载", displayed: "本期刊载", excludedByDisplayLimit: "展示上限排除", displayExcluded: "展示上限排除",
  failedRequests: "来源请求失败", truncatedRequests: "来源请求受截断", modelCalls: "模型调用", modelCallCount: "模型调用", modelRequestsUnknown: "共享预算请求结果未知",
  prefilterUnknown: "相关性未知", prefilterBlocked: "预筛不相关", prefilterPassed: "预筛通过", calls: "模型调用",
  unlinkedSignals: "未关联正文的信号", parseRejected: "解析失败", briefReady: "研究解读已完成", briefPending: "研究解读待完成", selectedWithoutBrief: "缺解读未刊载的精选",
  passed: "相关资料处理成功", blocked: "预筛不相关", decisionUnknown: "判断依据不足",
  roadmapsPublished: "附重点方法解读的刊载研究",
  quarantinedUnknown: "因历史未知请求隔离", quarantinedFailed: "因历史失败隔离",
  persistenceUnreconciled: "保存结果待核对", duplicateRecordsLowerBound: "确认重复下界", duplicateRecordsExact: "重复数已完全核对",
};

export function RunStatus({ report }: { report: ReportDetail }) {
  if (report.kind !== "pilot" && !report.run) return null;
  const run = report.run;
  const metrics = run?.metrics ?? {};
  const summary = [
    { label: "采集来源", value: `${metrics.sourcesSucceeded ?? metrics.healthySources ?? "—"} / ${metrics.sourcesPlanned ?? metrics.plannedSources ?? "—"}` },
    { label: "准入研究", value: metrics.admitted ?? "—" },
    { label: "达到精选标准", value: metrics.selected ?? "—" },
    { label: "本期刊载", value: metrics.published ?? metrics.publishedCount ?? metrics.displayed ?? "—" },
  ];
  return <section aria-label="本期处理范围" className="mt-5 rounded-panel border border-line bg-bg-sunk px-4 py-4 @[640px]:px-5">
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
      <h2 className="text-[14px] font-semibold text-ink">{report.kind === "pilot" ? "最近七天试刊 · 实际覆盖窗口" : "本期处理范围"}</h2>
      <span className="text-[12px] text-ink-3">{run ? `${STATUS[run.status] ?? run.status}（${run.status}）` : "运行状态未知"}</span>
    </div>
    <p className="mt-2 text-[13px] leading-relaxed text-ink-2"><time dateTime={report.windowStart}>{fullDateTime(report.windowStart)}</time> 至 <time dateTime={report.windowEnd}>{fullDateTime(report.windowEnd)}</time>（北京时间）</p>
    <p className="mt-1 text-[11.5px] text-ink-4">生成于 {fullDateTime(report.generatedAt)} · 修订 {report.revision} · 评分尚未校准</p>
    {run && <>
      <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 @[520px]:grid-cols-4">
        {summary.map(({ label, value }) => <div key={label}><dt className="text-[11.5px] text-ink-4">{label}</dt><dd className="num mt-1 text-[21px] font-semibold tracking-tight text-ink">{typeof value === "number" ? value.toLocaleString("zh-CN") : value}</dd></div>)}
      </dl>
      {run.gaps.length > 0 ? <div className="mt-4 rounded-control bg-amber-soft px-3 py-2.5">
        <h3 className="text-[12px] font-semibold text-amber-ink">阅读前请留意</h3>
        <ul className="mt-1 space-y-1 text-[12px] leading-relaxed text-ink-3">{run.gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul>
      </div> : <p className="mt-3 text-[12px] text-ink-4">当前运行记录未列出缺口。未准入资料没有经过本批次模型评审。</p>}
      <details className="group mt-3 border-t border-line pt-3">
        <summary className="cursor-pointer text-[12px] font-medium text-accent focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent">查看完整采集与处理统计</summary>
        <p className="mt-3 text-[11.5px] leading-relaxed text-ink-4">记录包含研究资料与社区信号；未准入资料未经过本批次模型评审。各主题可能交叉，主题计数不能直接相加。评分尚未经过人工标注集校准。</p>
        <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-3 @[640px]:grid-cols-3">
          {Object.entries(metrics).filter(([key]) => key !== "duplicateRecordsLowerBound").map(([key, value]) => <div key={key}>
            <dt className="text-[11px] text-ink-4">{key === "duplicateRecords" && metrics.duplicateRecordsExact === 0 ? "确认重复下界" : METRICS[key] ?? key}</dt>
            <dd className="num mt-0.5 text-[14px] font-semibold text-ink">{key === "duplicateRecordsExact" ? value === 1 ? "是" : "否" : Number.isFinite(value) ? value.toLocaleString("zh-CN") : "未知"}</dd>
          </div>)}
        </dl>
        <p className="mt-4 text-[11px] text-ink-4">运行标识 <code className="break-all">{run.id}</code></p>
      </details>
    </>}
  </section>;
}
