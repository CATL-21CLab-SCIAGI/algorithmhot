import { data as withHeaders, Link, useLoaderData } from "react-router";
import { subjectAfter, withSubject } from "@aihot/industry/site";
import catalog from "@aihot/industry/topics.json";
import type { Route } from "./+types/topics";
import { apiGet, releaseBoundCache } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { TopicIcon } from "../components/TopicIcon";
import { IconArrowRight } from "../components/icons";
import { beijingDate } from "../lib/format";

interface TopicSummary {
  slug: string;
  name: string;
  group: "company" | "field" | "genre";
  definition: string;
  total: number;
  recent: number;
  indexable: boolean;
  latestAt: string | null;
}

export async function loader({ request }: { request: Request }) {
  const upstream = new Headers();
  const data = await apiGet<{ topics: TopicSummary[]; refreshAt: string | null }>("/api/site/topics", { signal: request.signal, responseHeaders: upstream });
  return withHeaders({ ...data, groups: catalog.groups }, { headers: releaseBoundCache(data.refreshAt, 300, Date.now(), upstream) });
}

export function meta({ loaderData }: Route.MetaArgs) {
  const description = loaderData
    ? `${subjectAfter(`按${loaderData.groups.map((g) => g.name).join("、")}聚合的`, "主题页")}，共 ${loaderData.topics.length} 个主题。`
    : withSubject("主题页");
  return pageMeta({ title: "主题", description, path: "/topics", image: "/og/pages/topics.png" });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

export default function TopicsPage() {
  const { topics, groups } = useLoaderData<typeof loader>();
  return (
    <div className="pb-10">
      <header className="pb-2 pt-5 lg:pt-1">
        <p className="mono mb-2 text-[11px] font-semibold tracking-[0.2em] text-accent">RESEARCH ATLAS</p>
        <h1 className="text-[28px] font-semibold leading-[1.3] tracking-tight text-ink">{subjectAfter("按主题看")}</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
          从 <span className="num">{topics.length}</span> 个主题进入算法、AI4AI 与 AI4S。每项保留研究依据与原始来源。
        </p>
      </header>
      {groups.map((g) => (
        <section key={g.key} aria-labelledby={`topics-${g.key}`} className="pt-8">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h2 id={`topics-${g.key}`} className="text-[15px] font-bold text-ink">
              {g.name}
            </h2>
            <p className="text-[12px] text-ink-4">{g.blurb}</p>
          </div>
          <ul className="mt-3.5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {topics
              .filter((t) => t.group === g.key)
              .map((t) => (
                <li key={t.slug}>
                  <Link
                    to={`/topics/${t.slug}`}
                    prefetch="intent"
                    aria-label={`查看${t.name}相关精选文章`}
                    className="card card-hover group flex h-full min-h-[184px] flex-col px-5 py-5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    <span className="flex items-center gap-3"><TopicIcon slug={t.slug} /><span className="text-[15px] font-bold leading-snug text-ink transition-colors group-hover:text-accent">{t.name}</span></span>
                    <span className="mt-3 line-clamp-2 flex-1 text-[12.5px] leading-[1.75] text-ink-3">{t.definition}</span>
                    <span className="mt-4 flex items-center justify-between gap-2 border-t border-line-soft pt-3 text-[11.5px]">
                      <span className={t.recent ? "text-accent" : "text-ink-4"}>{t.recent ? <>近 30 天 <b className="num font-semibold">{t.recent}</b> 条精选</> : "近 30 天暂无精选"}</span>
                      <IconArrowRight size={14} className="shrink-0 text-ink-4 transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
                    </span>
                    <span className="mt-1 text-[10.5px] text-ink-4">{t.latestAt ? <>最近条目 <time dateTime={t.latestAt}>{beijingDate(t.latestAt)}</time> · 共 {t.total} 条</> : "保留主题，等待符合条件的研究"}</span>
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
