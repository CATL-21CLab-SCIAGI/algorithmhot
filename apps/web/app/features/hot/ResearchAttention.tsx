import { Link } from "react-router";
import type { ResearchHeatRanking } from "@aihot/contracts/research-heat";

const date = (value: string) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short" }).format(new Date(value));
const kind = { publication: "原始发表", announcement: "公告日期", community: "社区入选" };

export function ResearchAttention({ ranking }: { ranking: ResearchHeatRanking }) {
  return <section aria-label="近7天科研关注榜" className="pb-8" data-research-heat={ranking.ruleVersion}>
    <header className="pb-5 pt-5 lg:pt-1"><p className="text-[12px] font-semibold tracking-[0.08em] text-hot">科研关注 · 来源信号</p><h1 className="mt-2 text-[26px] font-bold text-ink">近 7 天科研关注榜</h1><p className="mt-2 text-[13px] leading-relaxed text-ink-3">至少 2 个来源渠道提及同一研究，按来源时间衰减排序。来自已公开资料中的论文发布与社区入选信号。</p><p className="mt-2 text-[12px] text-ink-4">更新于 {date(ranking.computedAt)} 北京时间</p></header>
    <ol className="card divide-y divide-line-soft overflow-hidden">{ranking.entries.map(entry => <li key={entry.itemId} data-item-id={entry.itemId} className="p-5">
      <div className="flex items-start gap-4"><span className="num text-[24px] font-bold text-hot">{String(entry.rank).padStart(2, "0")}</span><div className="min-w-0 flex-1"><Link to={`/items/${entry.itemId}`} className="text-[17px] font-semibold leading-relaxed text-ink hover:text-accent">{entry.title}</Link><p className="mt-2 text-[12px] text-ink-3">{entry.sourceCount} 个来源渠道 · 关注指数 <strong className="num text-hot">{entry.heat.toFixed(1)}</strong></p><ul className="mt-3 space-y-1.5 text-[12px] text-ink-4">{entry.signals.map(signal => <li key={signal.source}><a href={signal.url} target="_blank" rel="noopener noreferrer" className="text-accent">{signal.source} ↗</a> · {kind[signal.kind]}：{signal.precision === "day" ? `${signal.at.slice(0, 10)}（来源仅给日期）` : `${date(signal.at)} 北京时间`}</li>)}</ul></div></div>
    </li>)}</ol>
    {!ranking.entries.length && <p className="card p-5 text-[13px] text-ink-3">当前已公开资料中，尚无至少 2 个来源渠道在 7 天内提及的研究。</p>}
    <p className="mt-5 text-[12px] leading-relaxed text-ink-3">按近 7 天的论文公告与社区入选信号排序，同一来源只计一次，较新的信号权重更高。关注指数反映来源关注，不代表学术质量或独立复现。</p>
  </section>;
}
