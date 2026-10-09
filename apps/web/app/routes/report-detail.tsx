import { SITE, withSubject } from "@aihot/industry/site";
import { data, redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/report-detail";
import type { ReportDetail, ReportNavigationEntry, ReportKind } from "@aihot/contracts/site";
import { apiGet, loadOr404 } from "../lib/api.server";
import { pageMeta, titled } from "../lib/seo";
import { beijingDate } from "../lib/format";
import { ReportLayout } from "../features/report/ReportLayout";
import { ReportPaper } from "../features/report/ReportPaper";
import { reportReaderCopy } from "../features/report/reader-copy";
import { KIND_LABEL, kindFromPath } from "../features/report/format";

const PATTERN: Record<ReportKind, RegExp> = {
  pilot: /^\d{4}-\d{2}-\d{2}$/,
  daily: /^\d{4}-\d{2}-\d{2}$/,
  weekly: /^\d{4}-W\d{2}$/,
  monthly: /^\d{4}-\d{2}$/,
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const kind = kindFromPath(new URL(request.url).pathname);
  if (kind === "pilot") throw redirect("/daily", 301);
  const key = params.key ?? "";
  if (!PATTERN[kind].test(key)) throw data({ message: "not_found" }, { status: 404 });
  const [report, { items: index }] = await Promise.all([
    loadOr404<ReportDetail>(`/api/site/reports/${kind}/${key}`, { signal: request.signal }),
    apiGet<{ items: ReportNavigationEntry[] }>(`/api/site/reports/${kind}/navigation/${key}`, { signal: request.signal }),
  ]);
  return { report, index, today: beijingDate(Date.now()) };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: titled("报告不存在") }, { name: "robots", content: "noindex" }];
  const r = loaderData.report;
  const copy = reportReaderCopy(r);
  return pageMeta({
    title: r.kind === "daily" ? `${withSubject("日报")} ${r.key}` : r.title.replace(`${SITE.name} `, `${SITE.subject} `),
    description: copy.paragraph?.slice(0, 150) ?? `${SITE.name} ${r.key} 的${withSubject(KIND_LABEL[r.kind])}。`,
    path: `/${r.kind}/${r.key}`,
    image: `/og/reports/${r.kind}/${r.key}.png`,
    type: "article",
  });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=600" };
}

export default function ReportDetailPage() {
  const { report, index, today } = useLoaderData<typeof loader>();
  return (
    <ReportLayout kind={report.kind} index={index} current={report.key} today={today}>
      <ReportPaper report={report} index={index} />
    </ReportLayout>
  );
}
