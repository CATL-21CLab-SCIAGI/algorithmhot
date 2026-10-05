import { Link } from "react-router";
import type { ResearchHeatRanking } from "@aihot/contracts/research-heat";

const date = (value: string) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short" }).format(new Date(value));
const kind = { publication: "原始发表", announcement: "公告日期", community: "社区入选" };

export function ResearchAttention({ ranking }: { ranking: ResearchHeatRanking }) {
  return <section aria-label="近7天科研关注榜" className="pb-8" data-research-heat={ranking.ruleVersion}>
    <header className="pb-5 pt-5 lg:pt-1"><p className="text-[12px] font-semibold tracking-[0.08em] text-hot">科研关注 · 来源信号</p><h1 className="mt-2 text-[26px] font-bold text-ink">近 7 天科研关注榜</h1><p className="mt-2 text-[13px] leading-relaxed text-ink-3">至少 2 个来源渠道提及同一研究，按来源时间衰减排序。来自已公开资料中的论文发布与社区入选信号。</p><p className="mt-2 text-[12px] text-ink-4">截至 {date(ranking.computedAt)} 北京时间 · {ranking.publicItems} 条公开资料中，{ranking.qualifyingResearch} 项符合 7 天条件 · 48 小时多源研究 {ranking.recent48hResearch} 项</p></header>
    <ol className="card divide-y divide-line-soft overflow-hidden">{ranking.entries.map(entry => <li key={entry.itemId} data-item-id={entry.itemId} className="p-5">
      <div className="flex items-start gap-4"><span className="num text-[24px] font-bold text-hot">{String(entry.rank).padStart(2, "0")}</span><div className="min-w-0 flex-1"><Link to={`/items/${entry.itemId}`} className="text-[17px] font-semibold leading-relaxed text-ink hover:text-accent">{entry.title}</Link><p className="mt-2 text-[12px] text-ink-3">{entry.sourceCount} 个来源渠道 · 关注指数 <strong className="num text-hot">{entry.heat.toFixed(1)}</strong></p><ul className="mt-3 space-y-1.5 text-[12px] text-ink-4">{entry.signals.map(signal => <li key={signal.source}><a href={signal.url} target="_blank" rel="noopener noreferrer" className="text-accent">{signal.source} ↗</a> · {kind[signal.kind]}：{signal.precision === "day" ? `${signal.at.slice(0, 10)}（来源仅给日期）` : `${date(signal.at)} 北京时间`}</li>)}</ul></div></div>
    </li>)}</ol>
    {!ranking.entries.length && <p className="card p-5 text-[13px] text-ink-3">当前已公开资料中，尚无至少 2 个来源渠道在 7 天内提及的研究。</p>}
    <div className="mt-5 space-y-2 text-[12px] leading-relaxed text-ink-3"><p>关注指数 = 10 × Σ 0.5^(距来源日期小时数 ÷ 24)。沿用 AIHOT 的来源去重与 24 小时半衰期，将科研观察窗口明确扩展至 7 天；同一论文的 arXiv 分类重复采集只计一次。</p><p>arXiv 公告和 Hugging Face 入选各计一个来源渠道；不计点赞或浏览量，不使用学术评分，不表示全网热议或独立复现。仅有日期的公告以 UTC 当日零点计算；缺少持续可比历史，暂不展示涨跌和趋势。</p><p>同分条目按稳定资料 ID 排序，不代表学术优劣。未准入、未公开资料和采集缺口未纳入本榜。</p></div>
  </section>;
}
