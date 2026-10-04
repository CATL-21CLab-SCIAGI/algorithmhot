import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useLoaderData, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/agent";
import { SITE, withSubject } from "@aihot/industry/site";
import { FEATURES } from "@aihot/industry/features";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { MCP_TOOL_NAMES as T } from "@aihot/contracts/mcp";
import { listPath, pageMeta, siteUrl } from "../lib/seo";
import { CodeBlock, CopyButton } from "../components/CodeBlock";
import { IconArrowUpRight, IconChevronRight } from "../components/icons";
import { AsideCard, ReadingLayout } from "../components/ui/Page";

/** The status badge reflects this page request, rather than a shared cached health result. */
export function headers() {
  return { "Cache-Control": "no-store" };
}

const MCP_VERSION = "2.0.0";
/** The machine-readable entry points, with what each one is for. */
const RESOURCES: Array<[label: string, href: string, note: string]> = [
  ["Agent Markdown", "/api/v1/agent", "给 Agent 的使用说明与答案"],
  ["llms.txt", "/llms.txt", "给大模型读的站点说明"],
  ["MCP Server", "/api/mcp", "MCP 客户端的连接地址"],
  ["OpenAPI 3.1", "/openapi-v1.json", "REST API v1 的完整定义"],
];

const TABS = [
  { key: "markdown", label: "Agent Markdown", note: "把地址交给 Agent", audience: "适合能读取网页的 Agent" },
  { key: "mcp", label: "MCP", note: "连接六个研究工具", audience: "适合支持 MCP 的客户端" },
  { key: "rss", label: "RSS", note: "订阅研究更新", audience: "适合阅读器与自动化流程" },
  { key: "api", label: "REST API", note: "接入自己的应用", audience: "适合脚本与应用开发" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

function normalizeTab(value: string | null): TabKey {
  return TABS.find((tab) => tab.key === value)?.key ?? "mcp";
}

export async function loader({ request }: Route.LoaderArgs) {
  const tab = new URL(request.url).searchParams.get("tab");
  let healthy = true;
  try {
    const res = await fetch(`${process.env.API_BASE_URL || "http://127.0.0.1:3101"}/api/health`, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(3000)]) });
    healthy = res.ok;
  } catch {
    healthy = false;
  }
  // The public address the examples show is the configured one, the same on the server and in the browser.
  return { tab: normalizeTab(tab), healthy, base: siteUrl() };
}

export function meta({ loaderData }: Route.MetaArgs) {
  // Only the tab is part of the address (mcp is the default and not written).
  const path = listPath("/agent", { tab: loaderData && loaderData.tab !== "mcp" ? loaderData.tab : null });
  return pageMeta({ title: "Agent 接入", description: `让 Agent 直接使用 ${SITE.name}：Markdown、MCP、RSS、REST API v1，匿名只读。`, path, image: "/og/pages/agent.png" });
}

function Section({ title, children, id, step }: { title: string; children: ReactNode; id?: string; step?: string }) {
  return (
    <section id={id} className="mt-8 scroll-mt-24">
      <h3 className="mb-3 flex items-center gap-2.5 text-[15px] font-semibold text-ink">
        {step && <span className="mono inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-accent/10 text-[11px] text-accent">{step}</span>}
        {title}
      </h3>
      <div className="text-[13.5px] leading-[1.85] text-ink-2">{children}</div>
    </section>
  );
}

function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2"><span className="mt-[11px] size-1 shrink-0 rounded-full bg-ink-4" /><span>{it}</span></li>
      ))}
    </ul>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <code className="mono break-words rounded-mark bg-bg-sunk px-1.5 py-0.5 text-[0.88em] text-ink">{children}</code>;
}

function MethodIcon({ method, size = 24 }: { method: TabKey; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {method === "markdown" && <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6M8 13h8M8 17h5" /></>}
      {method === "mcp" && <><path d="m8 8 4-4 4 4M12 4v9M5 13l-3 3 3 3M2 16h20M19 13l3 3-3 3M12 16v5" /><circle cx="12" cy="13" r="2" fill="currentColor" stroke="none" /></>}
      {method === "rss" && <><path d="M5 4a15 15 0 0 1 15 15M5 10a9 9 0 0 1 9 9" /><circle cx="6" cy="18" r="2" fill="currentColor" stroke="none" /></>}
      {method === "api" && <><path d="m7 7-5 5 5 5M17 7l5 5-5 5M14 4l-4 16" /></>}
    </svg>
  );
}

function ConnectionAddress({ value, href, label = "接入地址" }: { value: string; href?: string; label?: string }) {
  return (
    <div className="rounded-xl border border-line bg-bg-sunk/50 p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium text-ink-4">{label}</span>
        <CopyButton text={value} label="复制地址" />
      </div>
      {href
        ? <a href={href} className="mono block break-all text-[13px] leading-relaxed text-accent hover:underline">{value}</a>
        : <code className="mono block break-all text-[13px] leading-relaxed text-ink">{value}</code>}
    </div>
  );
}

function Reference({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <details id={id} className="group mt-7 scroll-mt-24 border-t border-line pt-5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[13px] font-medium text-ink-2 transition-colors hover:text-accent [&::-webkit-details-marker]:hidden">
        {title}<span className="transition-transform group-open:rotate-90"><IconChevronRight size={16} /></span>
      </summary>
      <div className="mt-4 text-[13px] leading-[1.85] text-ink-3">{children}</div>
    </details>
  );
}

function MarkdownTab({ base }: { base: string }) {
  const guide = `${base}/api/v1/agent`;
  const prompt = `请先读取 ${guide} 的使用说明，再根据里面提供的地址，帮我查看最近 7 天算法、AI4AI 与 AI4S 的研究动态，说明方法变化和证据限制，并附上来源和阅读链接。`;
  return <>
    <h2 className="text-[20px] font-bold text-ink">给 Agent 一个地址，就能开始阅读</h2>
    <p className="mt-2 text-[14.5px] leading-relaxed text-ink-3">适合能读取网页的 Agent。使用说明列出最新资讯、搜索、热点、事件、日报与试刊；答案附来源、时间和阅读链接，能力更新也会出现在同一个说明地址。</p>
    <Section step="01" title="取得阅读入口">
      <ConnectionAddress value={guide} href="/api/v1/agent" label="Agent 使用说明 · Markdown" />
    </Section>
    <Section step="02" title="把这句话发给你的 Agent">
      <div className="rounded-xl border border-accent/15 bg-accent/5 p-4"><p>{prompt}</p><CopyButton text={prompt} label="复制提问" className="mt-3" /></div>
    </Section>
    <Reference title="可以读取哪些内容？">
      <Bullets items={[
        "最新资讯与搜索：过去 24 小时或最近 7 天，可按分类筛选。",
        "当前热点：按榜单顺序阅读，再顺着返回的事件地址查看来龙去脉。",
        `${withSubject("日报")}：最新一期或指定日期的固定刊物。`,
        "研究试刊：最近七天资料，附实际窗口、处理范围与缺口。",
        "资料来自外部信源，重要事实仍请回原文核对。",
      ]} />
    </Reference>
  </>;
}

function McpTab({ base }: { base: string }) {
  const url = `${base}/api/mcp`;
  const name = SITE.mcpPrefix;
  const tools = [
    [T.latest, "最新研究", "过去 24 小时或最近 7 天，精选或全部"],
    [T.search, "检索资料", "搜索最近 7 天的研究主题与关键词"],
    [T.hot, "研究热点", "当前热点榜与事件排名"],
    [T.story, "事件脉络", "热点事件的时间线与持续更新综述"],
    [T.daily, "正常日报", "最新一期或指定日期的日报"],
    [T.pilot, "研究试刊", "最新或指定 key，含实际窗口、处理范围与缺口"],
  ];
  return (
    <>
      <h2 className="text-[20px] font-bold text-ink">加一个地址，Agent 直接调用六个工具</h2>
      <p className="mt-2 text-[14.5px] text-ink-3">适合支持远程 MCP 的 Agent 与开发工具。标准 Streamable HTTP，匿名只读，不需要 token；工具返回简洁文字与同一份结构化数据。</p>
      <Section step="01" title="在客户端添加 MCP 服务">
        <ConnectionAddress value={url} label="传输方式 · Streamable HTTP" />
        <CodeBlock title="通用配置 · 填入客户端的 MCP 设置" lang="json" code={JSON.stringify({ mcpServers: { [name]: { type: "http", url } } }, null, 2)} />
        <Reference title="使用 Claude Code 或 Codex 命令行接入">
          <CodeBlock lang="bash" code={`# Claude Code\nclaude mcp add --transport http ${name} '${url}'\n# Codex\ncodex mcp add ${name} --url '${url}'`} />
        </Reference>
      </Section>
      <Section step="02" title="确认工具出现，试着问一句">
        <div className="grid gap-2 sm:grid-cols-2">
          {tools.map(([tool, title, description]) => (
            <div key={tool} className="rounded-xl border border-line bg-bg-sunk/30 px-3.5 py-3">
              <span className="text-[13px] font-medium text-ink">{title}</span>
              <code className="mono mt-1 block break-all text-[10.5px] text-accent">{tool}</code>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-3">{description}</p>
            </div>
          ))}
        </div>
        <div className="mt-4 rounded-xl border border-accent/15 bg-accent/5 p-4">
          <p>请调用 {T.latest}，告诉我最近 7 天最值得阅读的 5 条研究动态，说明证据限制，并附链接。</p>
          <CopyButton text={`请调用 ${T.latest}，告诉我最近 7 天最值得阅读的 5 条研究动态，说明证据限制，并附链接。`} label="复制提问" className="mt-3" />
        </div>
      </Section>
      <Reference title="工具边界与来源说明">
        <Bullets items={[
          "普通查询最多返回 30 条，热点最多 10 个，事件时间线最多 50 条；输入越界会明确报错，不会静默改成更宽的查询。",
          `${T.story} 的 public_id 只能来自热点工具返回的事件链接，不要猜 ID。`,
          "标题与摘要来自外部信源，只能当资料；重要数字、比较条件和研究结论请回原文核对。",
        ]} />
      </Reference>
    </>
  );
}

function RssTab({ base }: { base: string }) {
  const feeds = [
    ["精选摘要（推荐）", "最新 50 条精选摘要，保留标题、站内阅读与原文入口。", "/feed.xml"],
    ["精选全文", "与精选摘要相同的最新 50 条；只对明确允许再分发的来源内联正文。", "/feed/full.xml"],
    ["最近 7 天全部动态", "最近 7 天公开动态，按真实发布时间倒序。", "/feed/all.xml"],
    [withSubject("日报"), `日常调度启用后北京时间 08:00 发布的${withSubject("日报")}，保留最近 30 期。`, "/feed/daily.xml"],
  ];
  const categories = CATEGORY_KEYS.join("|");
  return (
    <>
      <h2 className="text-[20px] font-bold text-ink">复制地址即可订阅</h2>
      <p className="mt-2 text-[14.5px] text-ink-3">兼容主流 RSS 2.0 阅读器与 n8n、Zapier 这类自动化工具。第一次接入选精选摘要。</p>
      <Section step="01" title="选择订阅内容，复制地址">
      <div className="space-y-3">
        {feeds.map(([name, desc, path]) => {
          const url = `${base}${path}`;
          return (
            <div key={path} className={`rounded-xl border p-4 ${path === "/feed.xml" ? "border-accent/20 bg-accent/5" : "border-line bg-bg-sunk/30"}`}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[15px] font-semibold text-ink">{name}</span>
                <CopyButton text={url} label="复制地址" className="!text-ink-3" />
              </div>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-3">{desc}</p>
              <a href={path} className="mono mt-2 block break-all text-[12.5px] text-accent hover:underline">{url}</a>
            </div>
          );
        })}
      </div>
      </Section>
      <Section step="02" title="粘贴到阅读器的「添加订阅」">
        <p>让阅读器读取并保存订阅即可。自动化流程中，使用 RSS 节点并填入同一地址；本机地址需要由能访问这台电脑的客户端读取。</p>
      </Section>
      <Reference title="更新频率、分类订阅与全文范围">
        <Bullets items={[
          "支持 ETag 条件请求，未变化时返回 304；建议每 30 分钟或更慢轮询。",
          "条目 link 指向站内阅读页，第三方原文在 description 中。",
          "全文是白名单：只有明确允许再分发的来源内联 content:encoded，其余一律只给摘要。",
          <>分类订阅 <Mono>{`/feed/category/{${categories}}.xml`}</Mono></>,
          <>分类全文 <Mono>{`/feed/full/category/{${categories}}.xml`}</Mono></>,
        ]} />
      </Reference>
    </>
  );
}

function ApiTab({ base }: { base: string }) {
  const endpoints: Array<[string, string]> = [
    ["/api/v1/items", "精选或最近 7 天公开动态；支持分类、时间和关键词"],
    ...(FEATURES.codexResetMonitor
      ? ([
          ["/api/v1/codex-resets/recent", "Codex 重置监控（轮询用）：最近 7 天与尚未落地的预告"],
          ["/api/v1/codex-resets", "Codex 重置与发卡的完整历史"],
        ] as Array<[string, string]>)
      : []),
    ["/api/v1/hot-topics", "当前热点榜与事件排名"],
    ["/api/v1/stories/{publicId}", "事件详情：报道时间线、综述与关联事件"],
    ["/api/v1/dailies", `${withSubject("日报")}日期索引`],
    ["/api/v1/dailies/latest", `最新${withSubject("日报")}`],
    ["/api/v1/dailies/{date}", `指定日期的${withSubject("日报")}`],
    ["/api/v1/pilots", "研究试刊索引；/latest 或 /{YYYY-MM-DD} 读取一期，保留实际窗口与处理缺口"],
    ["/api/v1/weeklies", "周报索引；/latest 或 /{YYYY-Www} 读取一期"],
    ["/api/v1/monthlies", "月报索引；/latest 或 /{YYYY-MM} 读取一期"],
    ["/api/v1/selected/snapshot", "当前全部精选；首次完整同步（分页）"],
    ["/api/v1/selected/changes", "精选的新增、修改和撤选；之后只取变化"],
  ];
  return (
    <>
      <h2 className="text-[20px] font-bold text-ink">匿名 GET，不需要 token</h2>
      <p className="mt-2 text-[14.5px] text-ink-3">浏览器跨域、curl 和默认 HTTP SDK 都可以直接用。临时查最近内容用 items；长期维护全部精选用一次快照加增量游标。字段与错误码以 <a href="/openapi-v1.json" className="text-accent hover:underline">OpenAPI 3.1</a> 为准。</p>
      <Section step="01" title="发起第一个请求">
        <CodeBlock title="读取最近 24 小时的精选 · 最多 20 条" lang="bash" code={`curl '${base}/api/v1/items?mode=selected&window=24h&limit=20'`} />
        <p>返回摘要、推荐理由、站内阅读页和原文链接，不返回正文。若时间窗口内没有精选，空列表是有效结果。</p>
      </Section>
      <Section step="02" title="按需要选择接口">
      <div className="overflow-x-auto rounded-card border border-line bg-surface">
        <table className="w-full min-w-[560px] text-left text-[13.5px]">
          <thead className="bg-bg-sunk text-ink-3"><tr><th className="px-3 py-2 font-medium">方法</th><th className="px-3 py-2 font-medium">路径</th><th className="px-3 py-2 font-medium">说明</th></tr></thead>
          <tbody className="divide-y divide-line">
            {endpoints.map(([p, d]) => (
              <tr key={p}><td className="px-3 py-2 font-mono text-[12px] text-ok">GET</td><td className="px-3 py-2 font-mono text-[12.5px] text-ink">{p}</td><td className="px-3 py-2 text-ink-2">{d}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      </Section>
      <Reference title="查询范围、缓存与返回格式">
        <Bullets items={[
          "不传 mode 等同 selected（精选）；只有明确需要全部公开动态才用 all。",
          "完整精选不限 7 天：snapshot 首次拿全，changes 只取变化；items 只看最近 7 天。",
          "items 不带正文：返回摘要、推荐理由、站内阅读页与原文链接。",
          "没有推送通道：按响应的 s-maxage 带 If-None-Match 轮询，没变化时是 304。",
          "错误是 Problem JSON；反馈时附上 requestId 即可定位。",
        ]} />
      </Reference>
      <Reference title="长期同步：一次快照，之后只拉变化">
        <CodeBlock lang="bash" code={`# 首次：分页拿当前全部精选，保存第一页响应里的 cursor（逐页相同）\ncurl '${base}/api/v1/selected/snapshot?fields=minimal&limit=500'\n# hasMore 为 true 就带 nextPage 继续翻\ncurl '${base}/api/v1/selected/snapshot?fields=minimal&limit=500&page=<上一页的 nextPage>'\n# 翻完之后：原样回传 cursor，只拿新增、修改和撤选\ncurl '${base}/api/v1/selected/changes?cursor=<第一页响应的 cursor>&limit=100'`} />
        <p>每页成功应用后再保存新 cursor。返回 409 snapshot_required 时重新取一次快照即可，接口不会静默漏数。</p>
      </Reference>
      <Reference title="错误与恢复" id="agent-api-recovery">
        <Bullets items={[
          "400：参数不合法；按 OpenAPI 修正，不要自动改成更宽的查询。",
          "409 snapshot_required：增量游标无法安全续传，重新取一次完整快照。",
          "429：遵守 Retry-After，不要增加并发重试。",
          "5xx：指数退避，并使用上次成功的缓存。",
        ]} />
      </Reference>
    </>
  );
}

export default function AgentPage() {
  const { tab: initialTab, healthy, base } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>(initialTab);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => setTab(normalizeTab(params.get("tab"))), [params]);

  const select = (key: TabKey) => {
    setTab(key);
    navigate(key === "mcp" ? "/agent" : `/agent?tab=${key}`, { replace: true, preventScrollReset: true });
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index + TABS.length - 1) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    else return;
    event.preventDefault();
    select(TABS[next].key);
    tabRefs.current[next]?.focus();
  };

  const host = new URL(base).host;
  const localOnly = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname);
  const pill = "inline-flex items-center gap-1.5 rounded-full border border-line bg-surface/80 px-2.5 py-1 text-[11px] text-ink-3";
  const aside = (
    <>
      <AsideCard title="选择接入方式" className="hidden lg:block">
        <nav aria-label="接入方式导航" className="-mx-2 space-y-1">
          {TABS.map((method) => (
            <button
              key={method.key}
              type="button"
              aria-pressed={tab === method.key}
              aria-controls={`agent-panel-${method.key}`}
              onClick={() => select(method.key)}
              className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${tab === method.key ? "bg-accent/8 text-accent" : "text-ink-3 hover:bg-bg-sunk hover:text-ink"}`}
            >
              <MethodIcon method={method.key} size={18} />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium">{method.label}</span>
                <span className="mt-0.5 block text-[11px] text-ink-4">{method.note}</span>
              </span>
              {tab === method.key && <IconChevronRight size={14} />}
            </button>
          ))}
        </nav>
      </AsideCard>
      <AsideCard title="接入资源">
        <nav aria-label="接入资源" className="-mx-2 -mb-1">
          {RESOURCES.map(([l, h, note]) => (
            <a key={h} href={h} className="group flex items-start gap-2 rounded-control px-2 py-2 transition-colors hover:bg-bg-sunk">
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] text-ink-2 group-hover:text-ink">{l}</span>
                <span className="mt-0.5 block text-[12px] text-ink-4">{note}</span>
              </span>
              <IconArrowUpRight size={13} className="mt-1 shrink-0 text-ink-4" />
            </a>
          ))}
        </nav>
      </AsideCard>
      <AsideCard title="连接前，先确认地址可达">
        <p className="text-[13px] leading-[1.75] text-ink-3">先在客户端所在的电脑打开本站，再添加接入地址。本机服务停止后，订阅和工具调用也会暂停。</p>
        <p className="mt-3 text-[12px] leading-relaxed text-ink-4">仍有问题，可反馈客户端、版本和报错；无需提供 token 或本地文件。</p>
        <Link to="/feedback" prefetch="intent" className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
          去反馈 <IconChevronRight size={14} />
        </Link>
      </AsideCard>
    </>
  );
  return (
    <ReadingLayout aside={aside}>
      <header className="relative overflow-hidden rounded-2xl border border-line bg-surface px-5 py-7 sm:px-7 sm:py-8">
        <div className="pointer-events-none absolute -right-12 -top-16 size-56 rounded-full bg-accent/5" aria-hidden="true" />
        <div className="relative">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-[11px] font-semibold tracking-[0.14em] text-accent">AGENT 接入</span>
          <span className={`inline-flex items-center gap-1.5 text-[11px] ${healthy ? "text-ok" : "text-hot"}`} role="status">
            <span className={`size-1.5 rounded-full ${healthy ? "bg-ok" : "bg-hot"}`} aria-hidden="true" />
            {healthy ? "本次检查 · API 可用" : "本次检查 · API 未能连通"}
          </span>
        </div>
        <h1 className="mt-4 max-w-[560px] text-[28px] font-semibold leading-[1.3] tracking-tight text-ink sm:text-[34px]">把科研热点，<br className="sm:hidden" />接入你的 Agent</h1>
        <p className="mt-3 max-w-[550px] text-[14px] leading-[1.85] text-ink-3">通过 {SITE.name}，读取算法、AI4AI 与 AI4S 的研究动态、来源证据和试刊。选择适合你的方式，复制地址即可开始。</p>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <span className={pill}>匿名只读 · 无需 API Key</span>
          <span className={`${pill} mono`}>API v1</span>
          <span className={`${pill} mono`}>MCP {MCP_VERSION}</span>
        </div>
        </div>
      </header>

      <div className="mt-3 flex items-start gap-3 rounded-xl border border-line bg-bg-sunk/40 px-4 py-3.5">
        <svg className="mt-0.5 shrink-0 text-ink-3" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
        <div className="min-w-0 text-[12px] leading-[1.75]">
          <p className="font-medium text-ink-2">{localOnly ? "当前为本机地址" : "当前接入地址"}<span className="mono ml-2 break-all font-normal text-ink-3">{host}</span></p>
          <p className="mt-0.5 text-ink-3">{localOnly ? "请在运行本站的电脑上连接。云端 Agent、在线阅读器或另一台电脑无法直接访问这个本机地址。" : "客户端需要能够访问本站。这里的只读接入用于读取已有资料，不会启动采集或模型处理。"}</p>
        </div>
      </div>

      <section className="mt-8" aria-labelledby="agent-method-heading">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 id="agent-method-heading" className="text-[14px] font-semibold text-ink">选择接入方式</h2>
          <span className="text-[11px] text-ink-4">同一份资料，四种入口</span>
        </div>
        <div role="tablist" aria-label="接入方式" aria-orientation="horizontal" className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {TABS.map((method, index) => {
            const selected = tab === method.key;
            return (
              <button
                key={method.key}
                ref={(element) => { tabRefs.current[index] = element; }}
                type="button"
                role="tab"
                id={`agent-tab-${method.key}`}
                aria-selected={selected}
                aria-controls={`agent-panel-${method.key}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => select(method.key)}
                onKeyDown={(event) => onTabKeyDown(event, index)}
                className={`group relative flex min-h-[133px] flex-col items-start rounded-xl border p-3.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:min-h-[149px] sm:p-4 ${selected ? "border-accent/45 bg-accent/7 shadow-[0_0_0_1px_var(--color-accent)]" : "border-line bg-surface hover:border-accent/30 hover:bg-bg-sunk/40"}`}
                title={method.audience}
              >
                <span className={`inline-flex size-9 items-center justify-center rounded-lg ${selected ? "bg-accent text-accent-contrast" : "bg-bg-sunk text-ink-3 group-hover:text-accent"}`}><MethodIcon method={method.key} size={21} /></span>
                {selected && <svg className="absolute right-3 top-3 text-accent" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m3 8 3 3 7-7" /></svg>}
                <span className={`mt-3 text-[13px] font-semibold leading-snug ${selected ? "text-accent" : "text-ink"}`}>{method.label}</span>
                <span className="mt-1 text-[11px] leading-relaxed text-ink-4">{method.note}</span>
              </button>
            );
          })}
        </div>
      </section>

      {TABS.map((method) => (
        <div
          key={method.key}
          role="tabpanel"
          id={`agent-panel-${method.key}`}
          aria-labelledby={`agent-tab-${method.key}`}
          tabIndex={0}
          hidden={tab !== method.key}
          className="mt-5 min-w-0 rounded-2xl border border-line bg-surface p-5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:p-7"
        >
          <p className="mb-3 text-[11px] font-medium text-accent">{method.audience}</p>
          {method.key === "markdown" && <MarkdownTab base={base} />}
          {method.key === "mcp" && <McpTab base={base} />}
          {method.key === "rss" && <RssTab base={base} />}
          {method.key === "api" && <ApiTab base={base} />}
        </div>
      ))}
    </ReadingLayout>
  );
}
