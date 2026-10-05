import type { ResearchDayCoverage } from "@aihot/contracts/research-coverage";

/** A source check is shown separately from paper cards, so an empty date stays explainable. */
export function ResearchCoverage({ days }: { days: ResearchDayCoverage[] }) {
  if (!days.length) return null;
  return <section className="card mb-5 px-4 py-3 text-[13px]" aria-label="历史日期补查" data-research-coverage={JSON.stringify(days)}>
    <h2 className="mb-2 font-semibold text-ink">历史日期补查</h2>
    <p className="mb-2 leading-6 text-ink-3">按北京时间核对本站六个固定来源；零条目只表示这些来源未检出当天记录。</p>
    {days.map(day => <details key={day.date} className="border-t border-line-soft py-2">
      <summary className="cursor-pointer leading-6 text-ink-2">
        <time dateTime={day.date}>{day.date.slice(5).replace("-", "月")}日</time>
        {" · "}{day.status === "checked-empty" ? "已补查" : day.status === "partial" ? "补查有缺口" : "已检出记录"}
        {" · "}正文 {day.articleCount} 条 · 社区信号 {day.signalCount} 条
      </summary>
      <p className="mt-2 leading-6 text-ink-3">{day.note}</p>
      <ul className="mt-2 space-y-2 text-ink-3">{day.sources.map(source => <li key={source.id}>
        <span className="font-medium text-ink-2">{source.name}</span>：{source.note}
        {source.urls.map((url, index) => <a key={url} href={url} target="_blank" rel="noopener noreferrer" className="ml-2 text-accent hover:underline">来源{source.urls.length > 1 ? index + 1 : ""}</a>)}
        <span className="ml-2 text-[12px] text-ink-4">观测于 {new Date(source.observedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</span>
      </li>)}</ul>
      <p className="mt-3 text-[12px] text-ink-4">核对时间：{new Date(day.checkedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}（北京时间）</p>
    </details>)}
  </section>;
}
