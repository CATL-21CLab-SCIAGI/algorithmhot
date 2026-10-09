import { SITE, withSubject } from "@aihot/industry/site";
import { data as withHeaders, Link, redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/home";
import type { ReportDetail, TimelineResponse } from "@aihot/contracts/site";
import { isCategoryKey, isChannelKey } from "@aihot/contracts/taxonomy";
import { apiGet, loadOr404, queryString, releaseBoundCache } from "../lib/api.server";
import { listPath, organizationLd, pageMeta } from "../lib/seo";
import { Wordmark } from "../components/Logo";
import { Timeline } from "../features/feed/Timeline";
import { HotTopics } from "../features/feed/HotTopics";
import { CategoryTabs, SearchField, SearchIconLink } from "../features/feed/Filters";
import { beijingDate, beijingWeekday } from "../lib/format";
import { reportReaderCopy } from "../features/report/reader-copy";
import { IconArrowRight, IconDoc } from "../components/icons";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q");
  // Search lives on /all; keep the parameters so old links still land on results.
  if (q && q.trim()) throw redirect(`/all${url.search}`);
  const channelParam = url.searchParams.get("channel") ?? "all";
  const categoryParam = url.searchParams.get("category");
  const channel = isChannelKey(channelParam) ? channelParam : "all";
  const category = categoryParam && isCategoryKey(categoryParam) ? categoryParam : null;
  const tag = url.searchParams.get("tag")?.trim() || null;
  const upstream = new Headers();
  const [data, issue] = await Promise.all([
    loadOr404<TimelineResponse>(`/api/site/timeline${queryString({ channel: channel === "all" ? null : channel, category, tag })}`, { responseHeaders: upstream, signal: request.signal }),
    !category && !tag ? apiGet<{ report: ReportDetail | null }>("/api/site/reports/daily/latest-page", { signal: request.signal }).catch(() => null) : Promise.resolve(null),
  ]);
  return withHeaders({ data, report: issue?.report ?? null, filters: { channel, category, tag, topic: null } }, { headers: releaseBoundCache(data.refreshAt, 60, Date.now(), upstream) });
}

export function meta({ loaderData }: Route.MetaArgs) {
  const f = loaderData?.filters;
  const path = listPath("/", { channel: f && f.channel !== "all" ? f.channel : null, category: f?.category, tag: f?.tag });
  return pageMeta({ path, jsonLd: path === "/" ? organizationLd() : undefined });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

function TodayLabel() {
  const today = beijingDate(Date.now());
  const [, m, d] = today.split("-").map(Number) as [number, number, number];
  return (
    <span className="text-[12.5px] text-ink-4" suppressHydrationWarning>
      {m}月{d}日 · {beijingWeekday(today).replace("星期", "周")}
    </span>
  );
}

export default function Home() {
  const { data, report, filters } = useLoaderData<typeof loader>();
  const reportCopy = report ? reportReaderCopy(report) : null;
  const title = filters.tag ? `#${filters.tag}` : "精选";
  return (
    <div className="pb-6">
      {/* Phones: brand bar, today's hot topics, then the feed under "最新精选". */}
      <div className="flex h-14 items-center justify-between lg:hidden">
        <Wordmark size={20} className="text-ink" />
        <TodayLabel />
      </div>
      <div className="hidden lg:block">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">{title}</h1>
        <div className="mb-5 mt-4 flex items-center justify-between gap-4">
          <CategoryTabs base="/" category={filters.category} channel={filters.channel} layoutId="home-cat-desk" className="min-w-0" />
          <SearchField variant="track" keep={{ category: filters.category }} />
        </div>
      </div>

      {report && <section aria-label="最新科研日报" className="mb-6 mt-3 rounded-panel border border-line bg-surface p-5 lg:mt-0 lg:p-6">
        <div className="flex items-start gap-4">
          <span className="hidden size-12 shrink-0 items-center justify-center rounded-card bg-accent-soft text-accent sm:flex"><IconDoc size={25} /></span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]"><span className="font-semibold tracking-[.12em] text-accent">最新科研日报</span><span className="num text-ink-4">{report.key}</span></div>
            <h2 className="mt-2 text-[19px] font-semibold leading-snug text-ink"><Link to={`/daily/${report.key}`} className="hover:text-accent">{reportCopy?.title}</Link></h2>
            <p className="mt-2 line-clamp-2 max-w-[900px] text-[13px] leading-relaxed text-ink-3">{reportCopy?.paragraph || "算法、AI4AI 与 AI4S 的研究进展，附论文原图、方法解读与原文入口。"}</p>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-4"><span><b className="num font-semibold text-ink">{report.metrics.totalEvents ?? 0}</b> 条研究 · {report.sections.length} 个栏目</span></div>
              <Link to={`/daily/${report.key}`} className="inline-flex min-h-9 items-center gap-2 rounded-control bg-accent px-3 text-[12px] font-medium text-accent-contrast hover:bg-accent-ink">阅读日报 <IconArrowRight size={14} /></Link>
            </div>
          </div>
        </div>
      </section>}
      {data.hot && <HotTopics entries={data.hot} />}

      <h2 className="mt-6 text-[20px] font-bold text-ink lg:hidden">{filters.tag ? title : "最新精选"}</h2>
      <div className="-mx-4 mt-3 flex items-center gap-2 pl-4 pr-2 lg:hidden">
        <CategoryTabs base="/" category={filters.category} channel={filters.channel} layoutId="home-cat-mobile" size="sm" className="min-w-0 flex-1" />
        <SearchIconLink />
      </div>

      <Timeline initial={data} filters={data.filters} />
    </div>
  );
}
