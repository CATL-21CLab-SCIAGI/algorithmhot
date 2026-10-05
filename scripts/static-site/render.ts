import type { PublicBrief, PublicCitation, PublicItem, PublicReport, PublicResearch, PublicRoadmap, PublicTopic, Snapshot } from "./model.ts";
import { CSS } from "./styles.ts";
import { publicUrl, selectedItems, poolItems } from "./model.ts";
import { computeResearchHeat, type ResearchHeatRanking } from "@aihot/contracts/research-heat";

export const escapeHtml = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const e = escapeHtml;
const date = (value: string | null, time = false): string => {
  if (!value || Number.isNaN(Date.parse(value))) return "未知";
  const d = new Date(value);
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", ...(time ? { hour: "2-digit", minute: "2-digit" } : {}) }).format(d);
};
const count = (value: number | undefined): string => value === undefined ? "—" : value.toLocaleString("zh-CN");
const categories: Record<string, string> = { algorithm: "算法", ai4ai: "AI4AI", ai4s: "AI4S" };
const evidence: Record<string, string> = { abstract: "基于摘要", fulltext: "基于来源正文", source_summary: "基于来源摘要", unknown: "依据范围未知" };
const status: Record<string, string> = { complete: "处理完成", partial: "部分完成", failed: "处理失败", collecting: "采集中", processing: "处理中", unknown: "状态未知" };
const metricNames: Record<string, string> = { returned: "返回记录", parsed: "解析成功", stored: "保存记录", duplicateRecords: "重复记录", parseRejected: "解析拒绝", inWindow: "窗口内记录", outsideWindow: "窗口外记录", signals: "社区信号", unlinkedSignals: "未关联信号", previouslyAdmitted: "此前已准入", newlyAdmitted: "本次新增准入", admitted: "准入研究", notAdmitted: "未准入研究", passed: "主流程成功", processed: "处理完成", blocked: "预筛拒绝", failed: "处理失败", unknownOutcome: "请求结果未知", modelRequestsUnknown: "共享预算请求结果未知", quarantinedUnknown: "因历史未知请求隔离", quarantinedFailed: "因历史失败隔离", decisionUnknown: "判定未知", pending: "待处理", selected: "精选研究", briefReady: "研究解读就绪", briefPending: "研究解读未完成", selectedWithoutBrief: "精选但缺解读", published: "刊载研究", totalEvents: "刊载条目", displayOmitted: "展示上限排除", excludedByDisplayLimit: "展示上限排除", sourcesCount: "刊载来源", sourcesPlanned: "计划来源", sourcesObserved: "已观测来源", sourcesSucceeded: "成功来源", sourcesFailed: "失败来源", healthyEmptySources: "健康空源", failedRequests: "失败来源请求", truncatedRequests: "截断来源请求", duplicateRecordsExact: "重复数精确统计（1=是）", persistenceUnreconciled: "保存待核对", healthySources: "健康来源", plannedSources: "计划来源" };

// Same local vector vocabulary as TopicIcon.tsx; no institution logo or remote image asset.
const drawings: Record<string, string> = {
  algorithm: '<path d="M5 18 12 5l7 13M8 13h8"/><circle cx="12" cy="5" r="2"/>',
  ai4ai: '<path d="M6 8a7 7 0 0 1 12 0M18 16a7 7 0 0 1-12 0M6 4v4h4M18 20v-4h-4m-2-7 1 2 2 1-2 1-1 2-1-2-2-1 2-1z"/>',
  ai4s: '<path d="M9 3h6M10 3v7L5 18a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-8V3M8 15h8"/>',
  "data-training": '<path d="M4 19h16M6 15v-4M12 15V8M18 15V4M4 8l6-4 4 2 6-4"/>',
  reasoning: '<path d="M4 17h4l4-10h8M5 7h3M16 17h3m-4-13 3 3-3 3"/><circle cx="4" cy="17" r="2"/><circle cx="20" cy="7" r="2"/>',
  agent: '<rect x="5" y="7" width="14" height="12" rx="4"/><path d="M12 3v4M2 11v4M22 11v4M9 15h6M9 11h.1M15 11h.1"/>',
  "synthetic-data": '<ellipse cx="10" cy="6" rx="6" ry="2.5"/><path d="M4 6v11c0 3 12 3 12 0v-5M4 11c0 3 7 3 10 1m5-10 1 3 3 1-3 1-1 3-1-3-3-1 3-1z"/>',
  materials: '<path d="m12 3 8 5v9l-8 5-8-5V8zM4 8l8 5 8-5M12 13v9M8 5.5l8 5v9"/>',
  "computational-physics": '<ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(35 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(-35 12 12)"/><circle cx="12" cy="12" r="2"/>',
  "molecular-modeling": '<path d="m6 7 6 5 6-6M12 12l-4 7M12 12l7 6"/><circle cx="6" cy="7" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="12" r="2"/><circle cx="8" cy="19" r="2"/><circle cx="19" cy="18" r="2.5"/>',
  reproducibility: '<path d="M4 10a8 8 0 1 1 1 7M4 4v6h6M9 13l2 2 5-5"/>',
  papers: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5"/>',
  benchmarks: '<path d="M5 20V10h4v10M10 20V4h4v16M15 20v-7h4v7M3 20h18"/>',
  "open-source": '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/>',
  tutorials: '<path d="M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1v14M6 8l3 1M15 9l3-1"/>',
  google: '<path d="M12 8c-6-8-14 8-6 8 5 0 7-11 12-11 7 0 6 12 0 12-3 0-4-2-5-4"/><circle cx="19" cy="18" r="2"/>',
  bair: '<path d="M7 20V4h6a4 4 0 0 1 0 8H7m6 0a4 4 0 0 1 0 8H7M4 4h3M4 20h3"/>',
  "hugging-face": '<circle cx="12" cy="10" r="7"/><path d="M9 10h.1M15 10h.1M9 13q3 3 6 0M3 14l4 2-2-4M21 14l-4 2 2-4M3 14c-2 5 4 8 7 5M21 14c2 5-4 8-7 5"/>',
};
const icon = (slug: string): string => `<span class="topic-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${drawings[slug] ?? drawings.papers}</svg></span>`;
const outside = (url: string | null, label: string): string => url ? `<a href="${e(url)}" target="_blank" rel="noopener noreferrer">${e(label)} ↗</a>` : `<span class="muted">${e(label)}：未提供可公开访问的链接</span>`;
const paragraph = (text: string | null): string => text ? `<p>${e(text)}</p>` : "";

export function normalizeBase(input: string): URL {
  const url = new URL(input);
  if (!publicUrl(input) || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !/^[a-z0-9.-]+$/i.test(url.hostname) || !/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`)) throw new Error("Public base must be an HTTPS URL with a simple project path");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

export function renderRoadmap(r: PublicRoadmap | null): string {
  if (!r) return "";
  const stages: Record<string, string> = { input: "研究输入", method: "关键方法", output: "研究输出", validation: "作者验证" };
  const groups = Object.entries(stages).flatMap(([stage, label]) => {
    const nodes = r.nodes.filter(n => n.stage === stage);
    return nodes.length ? [`<section class="roadmap-group"><div class="stage">${e(label)}</div>${nodes.map(n => `<div class="roadmap-node"><h4>${e(n.label)}</h4><p>${e(n.detail)}</p><details><summary>查看原文依据</summary><blockquote>${e(n.evidenceSnippet)}</blockquote></details></div>`).join("")}</section>`] : [];
  });
  return `<figure class="roadmap"><div class="kicker">PAPER ROADMAP · 关键路线</div><h3>${e(r.title)}</h3><p class="roadmap-caption">根据原文整理的方法地图，非论文原图 · ${e(evidence[r.evidenceBasis] ?? evidence.unknown)}。分组不代表执行先后；分支方法与验证环节分别阅读。${r.evidenceBasis === "fulltext" ? "依据当前获取的正文文本，原文图表未核阅。" : ""}</p><div class="roadmap-nodes">${groups.join("")}</div><figcaption class="roadmap-caption">作者报告，独立复现未核验。${e(r.limitations)}<br>${outside(r.sourceUrl, "路线图依据原文")} · 来源版本 ${r.sourceRevision}</figcaption></figure>`;
}

function renderBrief(b: PublicBrief | null): string {
  if (!b) return '<div class="research-block warning"><h3>研究解读尚未完成</h3><p>当前保留来源摘要与原文链接，不补写未知结论。</p></div>';
  return ([['methodChange', '研究变化'], ['applicableTasks', '适用任务'], ['comparisonConditions', '作者报告的比较条件'], ['limitations', '证据限制']] as const).map(([key, label]) => `<section class="research-block${key === "limitations" ? " warning" : ""}"><h3>${label}</h3><p>${e(b[key])}</p></section>`).join("");
}
function renderResearch(r: PublicResearch | null, publishedAt: string | null): string {
  const dates: Array<[string, string | null]> = [["原始发表", r?.originalPublishedAt ?? publishedAt], ["修订时间", r?.revisedAt ?? null], ["社区入选", r?.communitySelectedAt ?? null], ["本站观测", r?.observedAt ?? null]];
  const labels: Record<string, string> = { paper: "论文", project: "项目", code: "代码", weights: "权重" };
  return `<dl class="metadata">${dates.map(([label, d]) => `<div><dt>${label}</dt><dd>${e(date(d, true))}</dd></div>`).join("")}${r?.arxivId ? `<div><dt>arXiv</dt><dd>${e(r.arxivId)}${e(r.arxivVersion)}</dd></div>` : ""}${r?.doi ? `<div><dt>DOI</dt><dd>${e(r.doi)}</dd></div>` : ""}</dl>${r?.links.length ? `<div class="links">${r.links.map((l) => outside(l.url, labels[l.kind] ?? l.kind)).join("")}</div><p class="muted small">入口存在不等于代码、权重或实验已被独立复现。</p>` : ""}`;
}

export function renderResearchAttention(ranking: ResearchHeatRanking, href: (route: string) => string): string {
  const kind = { publication: "原始发表", announcement: "公告日期", community: "社区入选" };
  return `<section aria-label="近7天科研关注榜" class="pb-8" data-research-heat="${e(ranking.ruleVersion)}"><header class="page-header pb-5 pt-5"><p class="kicker text-[12px] font-semibold text-hot">科研关注 · 来源信号</p><h1 class="mt-2 text-[26px] font-bold text-ink">近 7 天科研关注榜</h1><p class="mt-2 text-[13px] leading-relaxed text-ink-3">至少 2 个来源渠道提及同一研究，按来源时间衰减排序。来自已公开资料中的论文发布与社区入选信号。</p><p class="mt-2 text-[12px] text-ink-4">截至 ${e(date(ranking.computedAt, true))} 北京时间 · ${ranking.publicItems} 条公开资料中，${ranking.qualifyingResearch} 项符合 7 天条件 · 48 小时多源研究 ${ranking.recent48hResearch} 项</p></header><ol class="card divide-y divide-line-soft overflow-hidden">${ranking.entries.map(entry => `<li class="p-5" data-item-id="${e(entry.itemId)}"><div class="flex items-start gap-4"><span class="num text-[24px] font-bold text-hot">${String(entry.rank).padStart(2, "0")}</span><div class="min-w-0 flex-1"><a class="text-[17px] font-semibold leading-relaxed text-ink hover:text-accent" href="${e(href(`items/${entry.itemId}/`))}">${e(entry.title)}</a><p class="mt-2 text-[12px] text-ink-3">${entry.sourceCount} 个来源渠道 · 关注指数 <strong class="num text-hot">${entry.heat.toFixed(1)}</strong></p><ul class="mt-3 space-y-1.5 text-[12px] text-ink-4">${entry.signals.map(signal => `<li>${outside(signal.url, signal.source)} · ${kind[signal.kind]}：${signal.precision === "day" ? `${e(signal.at.slice(0, 10))}（来源仅给日期）` : `${e(date(signal.at, true))} 北京时间`}</li>`).join("")}</ul></div></div></li>`).join("")}</ol>${ranking.entries.length ? "" : '<p class="card p-5 text-[13px] text-ink-3">当前已公开资料中，尚无至少 2 个来源渠道在 7 天内提及的研究。</p>'}<div class="mt-5 space-y-2 text-[12px] leading-relaxed text-ink-3"><p>关注指数 = 10 × Σ 0.5^(距来源日期小时数 ÷ 24)。沿用 AIHOT 的来源去重与 24 小时半衰期，将科研观察窗口明确扩展至 7 天；同一论文的 arXiv 分类重复采集只计一次。</p><p>arXiv 公告和 Hugging Face 入选各计一个来源渠道；不计点赞或浏览量，不使用学术评分，不表示全网热议或独立复现。仅有日期的公告以 UTC 当日零点计算；缺少持续可比历史，暂不展示涨跌和趋势。</p><p>同分条目按稳定资料 ID 排序，不代表学术优劣。未准入、未公开资料和采集缺口未纳入本榜。</p></div></section>`;
}

export function renderSite(snapshot: Snapshot): Map<string, string> {
  const base = normalizeBase(snapshot.publicBaseUrl), files = new Map<string, string>();
  const selected = selectedItems(snapshot), pool = poolItems(snapshot);
  const href = (route = ""): string => `${base.pathname}${route}`;
  const reportLink = (r: PublicReport): string => href(`${r.kind}/${r.key}/`);
  const page = (route: string, title: string, body: string, active: string): void => {
    const nav = [["", "精选研究", "home"], ["hot/", "科研关注榜", "hot"], ["topics/", "研究主题", "topics"], ["pilot/", "七天试刊", "pilot"], ["daily/", "科研日报", "daily"], ["archive/", "报告归档", "archive"], ["agent/", "Agent 阅读", "agent"]];
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="AlgorithmHot 科研热点：算法、AI4AI、AI4S 的方法变化、适用任务、比较条件与证据限制。"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'"><title>${e(title)} · AlgorithmHot 科研热点</title><link rel="canonical" href="${e(new URL(route, base).href)}"><link rel="icon" href="${href("assets/icon.svg")}" type="image/svg+xml"><link rel="stylesheet" href="${href("assets/site.css")}"></head><body><a class="skip" href="#content">跳到正文</a><aside class="sidebar"><a href="${href()}" class="brand">Algorithm<i>Hot</i><div class="subbrand">科研热点</div></a><nav class="nav" aria-label="主导航">${nav.map(([url, name, key]) => `<a href="${href(url)}"${active === key ? ' aria-current="page"' : ""}>${name}</a>`).join("")}</nav><div class="sidebar-note">公开阅读版<br>算法 · AI4AI · AI4S<br>每一条都保留研究依据</div></aside><main id="content">${body}</main><footer class="footer"><p>AlgorithmHot · 科研热点<br>评分尚未经过人工标注集校准；作者报告不等于独立复现。</p><p>公开快照：${e(date(snapshot.generatedAt, true))} 北京时间<br><a href="${href("data/snapshot.json")}">公开数据</a> · <a href="${href("about/")}">来源与隐私说明</a></p></footer></body></html>`;
    files.set(route ? `${route}index.html` : "index.html", html);
  };
  const card = (i: PublicItem): string => `<article class="item-card"><div class="kicker">${e(categories[i.category ?? ""] ?? "研究资料")}</div><h2><a href="${href(`items/${i.id}/`)}">${e(i.title)}</a></h2><p class="summary">${e(i.summary ?? "摘要尚未提供，请查看原文。")}</p><div class="item-meta"><span>${e(i.sourceName)}</span><span>发表 ${e(date(i.publishedAt))}</span><span>${e(evidence[i.researchBrief?.evidenceBasis ?? i.research?.evidenceBasis ?? "unknown"] ?? evidence.unknown)}</span>${i.researchRoadmap ? '<span>含关键路线图</span>' : ""}</div><div class="tags">${i.tags.slice(0, 6).map((t) => `<span>${e(t)}</span>`).join("")}</div></article>`;
  const cards = (items: PublicItem[]): string => items.length ? `<div class="item-list">${items.map(card).join("")}</div>` : '<div class="empty">这个主题暂时没有符合条件的精选研究。保留主题，等待后续资料。</div>';
  const reportCard = (r: PublicReport): string => `<a class="archive-card" href="${reportLink(r)}"><div class="kicker">${r.kind === "pilot" ? "七天试刊 · 试运行" : "科研日报"} / ${e(r.key)}</div><h2>${e(r.lead?.title ?? r.title)}</h2><p class="small muted">${e(date(r.windowStart, true))} → ${e(date(r.windowEnd, true))} 北京时间</p><div class="badges"><span class="badge">${count(r.metrics.totalEvents)} 条刊载</span><span class="badge">${e(status[r.status] ?? r.status)}</span>${r.gaps.length ? `<span class="badge">${r.gaps.length} 项缺口</span>` : ""}<span class="badge">修订 ${r.revision}</span></div></a>`;
  const topicCard = (t: PublicTopic): string => `<a class="topic-card" href="${href(`topics/${t.slug}/`)}"><div class="topic-heading">${icon(t.slug)}<h3>${e(t.name)}</h3></div><p class="topic-description">${e(t.definition)}</p><div class="topic-foot"><span>${t.recent ? `近 30 天 ${count(t.recent)} 条精选` : "近 30 天暂无精选"}</span><span>${t.latestAt ? e(date(t.latestAt)) : "等待新研究"} →</span></div></a>`;
  const latestPilot = snapshot.reports.find((r) => r.kind === "pilot");
  const latestDaily = snapshot.reports.find((r) => r.kind === "daily");
  page("", "精选研究", `<header class="page-header"><div class="kicker">RESEARCH WITH EVIDENCE</div><h1>从研究变化，看到下一步。</h1><p class="lead">追踪算法、AI4AI 与 AI4S。读方法增量、比较条件和证据限制，回到原始资料判断价值。</p></header>${latestPilot ? `<section class="hero top-story"><div class="kicker">最近七天试刊 · ${e(latestPilot.key)}</div><h2>${e(latestPilot.lead?.title ?? latestPilot.title)}</h2><p class="lead">${e(latestPilot.lead?.leadParagraph)}</p><div class="badges"><span class="badge">${count(latestPilot.metrics.totalEvents)} 条研究</span><span class="badge">${latestPilot.sections.length} 个栏目</span><span class="badge">${e(status[latestPilot.status] ?? latestPilot.status)}</span></div><p class="small muted">${e(date(latestPilot.windowStart, true))} 至 ${e(date(latestPilot.windowEnd, true))} 北京时间${latestPilot.gaps.length ? ` · ${latestPilot.gaps.length} 项处理缺口，详见报告` : ""}</p><a class="button" href="${reportLink(latestPilot)}">阅读真实报告 →</a></section>` : ""}${latestDaily ? `<div class="section-header"><h2>最新日报</h2><p>每 3 小时累计更新</p></div>${reportCard(latestDaily)}` : ""}<section class="section"><div class="section-header"><h2>精选研究</h2><p>${selected.length} 条公开精选；资料日期不改写为快照日期</p></div><div class="toolbar">${["algorithm", "ai4ai", "ai4s"].filter((s) => snapshot.topics.some((t) => t.slug === s)).map((s) => `<a href="${href(`topics/${s}/`)}">${e(categories[s])}</a>`).join("")}<a href="${href("topics/")}">全部主题 →</a></div>${cards(selected)}</section>`, "home");
  page("all/", "全部科研动态", `<header class="page-header"><h1>全部科研动态</h1><p class="lead">网页更新：${e(date(snapshot.generatedAt, true))} 北京时间。${pool.length} 条公开动态，包含精选与其他已通过相关性筛选的资料；更新网页不改写研究日期。</p></header>${cards(pool)}`, "all");
  page("hot/", "近7天科研关注榜", renderResearchAttention(snapshot.researchAttention ?? computeResearchHeat(pool, snapshot.generatedAt), href), "hot");
  const groups = [["field", "研究方向", "算法、AI4AI、AI4S 与交叉方法"], ["genre", "资料类型", "论文、评测、实现与实践"], ["company", "机构与社区", "机构发布与社区辅助信号"]];
  page("topics/", "研究主题", `<header class="page-header"><div class="kicker">RESEARCH ATLAS</div><h1>按主题看科研</h1><p class="lead">从 ${snapshot.topics.length} 个主题进入算法、AI4AI 与 AI4S。每项保留研究依据与原始来源。</p></header>${groups.map(([key, title, description]) => `<section class="section"><div class="section-header"><h2>${title}</h2><p>${description}</p></div><div class="topic-grid">${snapshot.topics.filter((t) => t.group === key).map(topicCard).join("")}</div></section>`).join("")}<p class="section small muted">主题可交叉，主题计数不能相加作为独立研究总数。机构图标为本站主题标记。</p>`, "topics");
  const byId = new Map(snapshot.items.map((i) => [i.id, i]));
  for (const t of snapshot.topics) page(`topics/${t.slug}/`, t.name, `<header class="page-header"><div class="kicker">RESEARCH TOPIC</div><div class="topic-heading">${icon(t.slug)}<h1>${e(t.name)}</h1></div><p class="lead">${e(t.definition)}</p><div class="badges"><span class="badge">${count(t.total)} 条精选</span><span class="badge">近 30 天 ${count(t.recent)} 条</span></div></header>${cards(t.itemIds.map((id) => byId.get(id)!))}`, "topics");
  for (const i of snapshot.items) page(`items/${i.id}/`, i.title, `<article class="reading"><header class="page-header"><div class="kicker">${e(categories[i.category ?? ""] ?? "RESEARCH NOTE")}</div><h1 class="reading-title">${e(i.title)}</h1>${i.originalTitle ? `<p class="original-title">${e(i.originalTitle)}</p>` : ""}<div class="item-meta"><span>${e(i.sourceName)}</span><span>发表 ${e(date(i.publishedAt, true))} 北京时间</span>${outside(i.sourceUrl, "查看原文")}</div><div class="badges"><span class="badge good">${e(evidence[i.researchBrief?.evidenceBasis ?? i.research?.evidenceBasis ?? "unknown"] ?? evidence.unknown)}</span><span class="badge">作者报告 · 独立复现未核验</span></div></header><div class="abstract">${paragraph(i.summary ?? "摘要暂缺，请以原文为准。")}</div>${renderRoadmap(i.researchRoadmap)}${renderBrief(i.researchBrief)}<section class="section"><h2>来源与研究身份</h2>${renderResearch(i.research, i.publishedAt)}</section></article>`, "home");
  for (const r of snapshot.reports) {
    const m = r.metrics;
    const story = (i: PublicCitation, n: number): string => `<article class="report-story"><div class="kicker">研究 ${String(n + 1).padStart(2, "0")}</div><h3>${e(i.title)}</h3><div class="item-meta"><span>${e(i.sourceName)}</span><span>${e(date(i.publishedAt))}</span><span>${e(evidence[i.researchBrief?.evidenceBasis ?? i.research?.evidenceBasis ?? "unknown"] ?? evidence.unknown)}</span>${outside(i.sourceUrl, "原文")}</div>${i.available ? `<p class="summary">${e(i.summary)}</p>${renderRoadmap(i.researchRoadmap)}${i.researchBrief ? `<details><summary>展开研究变化、比较条件与证据限制</summary>${renderBrief(i.researchBrief)}</details>` : ""}${i.itemId ? `<a class="details-link" href="${href(`items/${i.itemId}/`)}">研究解读与来源详情 →</a>` : ""}` : '<div class="warning-note">该资料已撤回，不再提供内容详情。</div>'}</article>`;
    const metrics = Object.entries(m).filter(([key]) => key !== "duplicateRecordsLowerBound");
    page(`${r.kind}/${r.key}/`, `${r.kind === "pilot" ? "七天试刊" : "科研日报"} ${r.key}`, `<article class="reading"><header class="report-masthead"><div class="kicker">ALGORITHMHOT · RESEARCH JOURNAL</div><div class="name">科研热点 · ${r.kind === "pilot" ? "试刊" : "日报"}</div><div class="edition"><span>${r.kind === "pilot" ? "最近七天 · 试运行" : "每 3 小时更新"}</span><span>第 ${r.issueNumber} 期 · ${e(r.key)}</span><span>修订 ${r.revision} · ${e(status[r.status] ?? r.status)}</span></div></header><div class="run-panel"><p class="small muted">实际窗口（北京时间）</p><p>${e(date(r.windowStart, true))} → ${e(date(r.windowEnd, true))}</p><div class="stats">${[["来源成功 / 计划", `${count(m.sourcesSucceeded ?? m.healthySources)} / ${count(m.sourcesPlanned ?? m.plannedSources)}`], ["准入研究", count(m.admitted)], ["精选研究", count(m.selected)], ["报告刊载", count(m.totalEvents)]].map(([label, value]) => `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`).join("")}</div><p class="small muted">成刊 ${e(date(r.generatedAt, true))} · 评分尚未经过人工标注集校准</p>${r.gaps.length ? `<div class="warning-note"><strong>阅读前请留意</strong><ul>${r.gaps.map((g) => `<li>${e(g)}</li>`).join("")}</ul></div>` : ""}<details><summary>查看完整采集与处理统计</summary><table class="metrics-table"><tbody>${metrics.map(([key, value]) => `<tr><td>${e(metricNames[key] ?? key)}</td><td>${count(value)}</td></tr>`).join("")}</tbody></table><p class="small muted">记录包含研究与社区信号；未准入不等于模型拒绝；主题可交叉。窗口内无候选不代表相关领域没有新研究。</p></details></div><header class="page-header"><h1 class="reading-title">${e(r.lead?.title ?? r.title)}</h1><p class="lead">${e(r.lead?.leadParagraph ?? r.overview)}</p></header>${r.sections.length ? `<nav class="report-toc" aria-label="报告栏目">${r.sections.map((s, index) => `<a href="#section-${index}">${e(s.label)} · ${s.items.length}</a>`).join("")}</nav>${r.sections.map((s, index) => `<section class="report-section" id="section-${index}"><h2>${e(s.label)} <span class="small">${s.items.length} 条</span></h2>${paragraph(s.summary)}${s.items.map(story).join("")}</section>`).join("")}` : `<div class="empty">${r.gaps.length ? "本刊存在上述处理缺口，请结合来源状态阅读。" : "本刊期处理已完成，未产生精选。保留完整采集统计，等待后续研究。"}</div>`}</article>`, r.kind);
  }
  for (const kind of ["pilot", "daily"] as const) page(`${kind}/`, kind === "pilot" ? "七天试刊" : "科研日报", `<header class="page-header"><div class="kicker">RESEARCH JOURNAL</div><h1>${kind === "pilot" ? "最近七天试刊" : "科研日报"}</h1><p class="lead">${kind === "pilot" ? "首期试运行保留实际七天窗口、处理范围和证据缺口。" : "每 3 小时累计更新当日资料，实际来源窗口和缺口随刊保留。"}</p></header><div class="archive-grid">${snapshot.reports.filter((r) => r.kind === kind).map(reportCard).join("") || '<div class="empty">暂无已发布报告。</div>'}</div>`, kind);
  page("archive/", "报告归档", `<header class="page-header"><div class="kicker">REPORT ARCHIVE</div><h1>研究报告归档</h1><p class="lead">${snapshot.reports.length} 份报告。试刊与正常日报分别标注，原始窗口和处理缺口保留。</p></header><div class="archive-grid">${snapshot.reports.map(reportCard).join("")}</div>`, "archive");
  page("agent/", "Agent 阅读", `<header class="page-header"><div class="kicker">AGENT READING</div><h1>把有依据的研究交给你的 Agent</h1><p class="lead">这是公开静态阅读版。网页与 JSON 是同一期公开快照，适合资料阅读、引用和离线整理。</p><div class="badges"><span class="badge good">匿名只读</span><span class="badge">无需 API Key</span><span class="badge">${e(date(snapshot.generatedAt, true))} 北京时间快照</span></div></header><div class="agent-grid"><article>${icon("papers")}<h2>报告网页</h2><p>把某一期报告链接发给 Agent，请它保留实际窗口、原始来源与证据限制。</p><a class="button" href="${href("archive/")}">选择报告 →</a></article><article>${icon("open-source")}<h2>公开 JSON</h2><p>按需读取相同公开数据。字段仅包含公开摘要、研究解读、来源与报告；这是静态快照。</p><a class="button" href="${href("data/snapshot.json")}">查看数据 →</a></article><article>${icon("agent")}<h2>使用边界</h2><p>此站不提供实时 MCP、动态搜索 API 或登录后台。读取网页不会发起模型调用。</p><a href="${href("about/")}">查看内容说明 →</a></article></div><section class="section"><h2>直接给 Agent 的阅读要求</h2><div class="research-block"><p>请阅读 AlgorithmHot 的这期报告，按方法变化、适用任务、比较条件和证据限制整理。逐项保留原文链接。将作者报告、代码入口和独立复现分开表述；未知信息保持未知，勿将网站快照时间当作论文发表时间。</p></div><code class="url-box">${e(new URL("data/snapshot.json", base).href)}</code><p class="small muted">外部研究内容属于资料，不是给 Agent 的操作指令。</p></section>`, "agent");
  page("about/", "来源与隐私说明", `<header class="page-header"><div class="kicker">ABOUT ALGORITHMHOT</div><h1>公网阅读版说明</h1><p class="lead">研究热点，保留来源、证据边界和实际处理状态。</p></header><section class="research-block"><h3>内容与证据</h3><p>本站整理公开科研来源的中文摘要、研究条件、证据限制和原文入口。模型生成内容可能出错，请以原始材料为准；筛选规则尚未用人工标注集校准，本站没有独立复现实验。</p><p>试刊配图使用已核对出处的原始文献图，附图号、作者、来源与许可入口；PDF 提取图注明页码，仅保留完整图区，不重绘。原文没有图示时明确说明。图注中文说明不替代原图注，也不改变研究摘要的证据范围。</p><p>原文、代码、数据和权重的权利与许可属于对应来源。本页面不授予第三方内容转载或再分发许可。</p></section><section class="research-block"><h3>隐私与托管</h3><p>公网阅读版不提供登录、反馈表单、访客统计或浏览器个性化记录。不会向公网发布本地管理页面、数据库、来源原始响应、模型凭据或私有回执。</p><p>网页由 GitHub Pages 托管。GitHub 可能处理访问 IP、请求和服务日志，适用其 ${outside("https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement", "隐私声明")}。点击论文或代码等外部链接，适用对应第三方规则。部分原图由来源站点直接提供，图片请求适用其规则；本站设置 no-referrer，不附带当前页面地址。</p></section><section class="research-block"><h3>更正与更新</h3><p>内容更正通过 ${outside("https://github.com/PKUCY2016/algorithmhot/issues", "仓库 Issues")} 提交。这是公开渠道，请勿提交密钥、联系方式或其他私人资料。</p><p>报告由站点所有者的 Mac 每 3 小时更新；关机、断网、登录失效或额度不足时可能延迟。已发布报告仍可阅读，报告页面保留实际资料窗口、生成时间和已知处理缺口。</p><p>这是当前静态阅读版的内容与数据处理说明。若以后启用账户、访客分析、公开 API 或其他托管服务，需要据实际功能更新。</p></section><section class="research-block"><h3>快照范围与框架致谢</h3><p>${e(snapshot.scope)}。快照生成时间不是研究发表时间。主题可交叉，计数不能相加。</p><p>本项目基于 ${outside("https://github.com/KKKKhazix/AIHOT/tree/3343fe2b20db4be7269113752d82d3992fc52b6b", "AIHOT 固定版本")} 的 MIT 许可框架，采用独立的 AlgorithmHot 名称与视觉标识。</p></section>`, "");
  page("404/", "页面未找到", `<header class="page-header"><div class="kicker">404</div><h1>这页暂时不在阅读站中</h1><p class="lead">可以返回主题目录或报告归档寻找研究资料。</p><a class="button" href="${href()}">返回首页 →</a></header>`, "");
  files.set("404.html", files.get("404/index.html")!);
  files.set("assets/site.css", CSS);
  files.set("assets/icon.svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#176d78"/><path d="m16 47 16-31 16 31M23 35h18" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="32" cy="16" r="4" fill="#a6eadc"/></svg>');
  files.set("data/snapshot.json", `${JSON.stringify(snapshot, null, 2)}\n`);
  files.set("robots.txt", `User-agent: *\nAllow: /\nSitemap: ${new URL("sitemap.xml", base).href}\n`);
  const urls = [...files.keys()].filter((p) => p.endsWith("index.html")).map((p) => new URL(p.replace(/index\.html$/, ""), base).href);
  files.set("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((url) => `<url><loc>${e(url)}</loc></url>`).join("")}</urlset>`);
  return files;
}

/** Check all static page links before publishing; a missing target is a hard export error. */
export function validateStaticLinks(files: Map<string, string>, publicBaseUrl: string): void {
  const base = normalizeBase(publicBaseUrl);
  for (const [file, content] of files) {
    if (!file.endsWith(".html")) continue;
    for (const match of content.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const raw = match[1].replace(/&amp;/g, "&");
      const url = new URL(raw, new URL(file, base));
      if (url.origin !== base.origin) continue;
      if (!url.pathname.startsWith(base.pathname)) throw new Error(`Static link escapes project base: ${file} -> ${raw}`);
      const path = decodeURIComponent(url.pathname.slice(base.pathname.length));
      const target = path.endsWith("/") || !path ? `${path}index.html` : path;
      if (!files.has(target)) throw new Error(`Missing static link: ${file} -> ${target}`);
      if (url.hash && !new RegExp(`id=["']${url.hash.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(files.get(target)!)) throw new Error(`Missing anchor: ${file} -> ${raw}`);
    }
  }
}
