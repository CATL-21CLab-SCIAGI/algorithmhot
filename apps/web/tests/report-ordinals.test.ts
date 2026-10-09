// 使用真实生产 SSR 服务与回环 API 夹具验证报头；不是浏览器截图或画布交互测试。
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ReportDetail, ReportKind, ReportNavigationEntry, SiteItemDetail } from "@aihot/contracts/site";
import type { ResearchMetadata } from "@aihot/contracts/research";
import { isoWeekLabel } from "@aihot/contracts/time";
import { load } from "cheerio";
import { issueNumber, periodGrid } from "../app/features/report/format.ts";

const kinds: ReportKind[] = ["daily", "weekly", "monthly"];
const keys = Object.fromEntries(kinds.map((kind) => [kind, Array.from({ length: 405 }, (_, i) => {
  if (kind === "monthly") return new Date(Date.UTC(2020, i, 1)).toISOString().slice(0, 7);
  const day = new Date(Date.UTC(2020, 0, 6 + i * (kind === "weekly" ? 7 : 1))).toISOString().slice(0, 10);
  return kind === "weekly" ? isoWeekLabel(day) : day;
})])) as Record<ReportKind, string[]>;
const index = (kind: ReportKind): ReportNavigationEntry[] => keys[kind].map((key, i) => ({ key, issueNumber: i + 1, title: `第${i + 1}期` })).reverse().slice(0, 400);
function report(kind: ReportKind, key: string): ReportDetail {
  return {
    kind, key, issueNumber: keys[kind].indexOf(key) + 1, title: "测试刊物", windowStart: "2020-01-01T00:00:00Z", windowEnd: "2020-01-02T00:00:00Z", generatedAt: "2020-01-02T00:00:00Z", revision: 1,
    lead: null, overview: null, highlights: [], sections: [], stories: [], flashes: [], cover: null, metrics: {}, readingMinutes: 1, prev: null, next: null,
  };
}
const research: ResearchMetadata = {
  canonicalKey: "arxiv:2609.12345", arxivId: "2609.12345", arxivVersion: "v2", arxivVersions: ["v1", "v2"], doi: null,
  originalPublishedAt: "2026-09-20T02:00:00Z", revisedAt: "2026-09-28T03:00:00Z", communitySelectedAt: "2026-10-01T04:00:00Z", observedAt: "2026-10-03T05:00:00Z",
  evidenceBasis: "abstract", signalOnly: false,
  links: [{ kind: "paper", url: "https://arxiv.org/abs/2609.12345", sourceUrl: "https://arxiv.org/abs/2609.12345" }, { kind: "code", url: "https://example.org/research-code", sourceUrl: "https://arxiv.org/abs/2609.12345" }, { kind: "weights", url: "javascript:alert(1)", sourceUrl: "https://example.org" }],
};
function illustratedReport(key = "2026-10-03", empty = false): ReportDetail {
  const citation = { itemId: "research-fixture", title: "研究提出新的比较方法", summary: "作者报告在给定设置下的结果。", sourceName: "arXiv", sourceUrl: "https://arxiv.org/abs/2609.12345", sourceId: "arxiv-test", sourceIconUrl: null, firstParty: false, role: null, storyPublicId: null, publishedAt: research.originalPublishedAt, available: true, research,
    researchBrief: { methodChange: "研究比较新的预测方法。", applicableTasks: "模拟控制", comparisonConditions: "作者报告模拟对比。", limitations: "缺少真实系统实验。", evidenceBasis: "abstract" as const, sourceRevision: 1, promptVersion: "fixture", generatedAt: "2026-10-03T05:00:00Z" },
    paperFigure: { itemId: "research-fixture", sourceRevision: 1, imageOrigin: "remote" as const, imageUrl: "https://example.org/method-figure.png", sourceUrl: "https://example.org/paper#figure1", figureLabel: "原文图 1", caption: "输入经过方法模块得到预测。", attribution: "Example authors", licenseName: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", verifiedAt: "2026-10-03T05:00:00Z", width: 1200, height: 400, contentType: "image/png", sha256: "a".repeat(64) },
  };
  return {
    kind: "daily", key, issueNumber: 1, title: "科研日报", windowStart: "2026-09-26T05:17:00Z", windowEnd: "2026-10-03T05:17:00Z", generatedAt: "2026-10-03T05:30:00Z", revision: 1,
    lead: empty ? null : { title: "本期部分结果：已整理 1 项研究", leadParagraph: "本期部分结果，存在处理缺口。" }, overview: null,
    highlights: empty ? [] : [citation], sections: empty ? [] : [{ label: "算法", summary: null, items: [citation] }], stories: empty ? [] : [{ ...citation, label: "算法" }], flashes: [], cover: null,
    metrics: { selectedCount: empty ? 0 : 1 }, readingMinutes: 1, prev: null, next: null,
    run: { id: "pilot-local-fixture", kind: "pilot", status: "partial", metrics: { sourcesObserved: 5, sourcesSucceeded: 4, sourcesDeferred: 1, deferredRequests: 1, admitted: 2, notAdmitted: 20, processed: 1, failed: 0, unknownOutcome: 1, pending: 0, selected: empty ? 0 : 1, displayed: empty ? 0 : 1 }, gaps: ["仅观测到 5/6 个来源", "1 条模型请求结果未知", "Hugging Face Daily Papers 尚未开放 2026-10-03 的社区信号，已跳过并等待下一正常刷新补采；这不表示当天没有新研究"] },
  };
}
const item: SiteItemDetail = {
  id: "research-fixture", revision: 1, title: "研究提出新的比较方法", originalTitle: "Research fixture", summary: "作者报告在给定设置下的结果。", reason: null,
  source: { id: "arxiv-test", name: "arXiv", kind: "rss", firstParty: false, iconUrl: null }, links: { aihot: "/items/research-fixture", original: "https://arxiv.org/abs/2609.12345" },
  publishedAt: null, discoveredAt: "2026-10-03T05:00:00Z", timelineAt: "2026-10-03T05:00:00Z", category: "algorithm", tags: ["论文/研究", "算法"], score: 70, selected: true, channel: "news", story: null, x: null,
  readingMode: "summary-only", author: null, language: "en", body: null, outline: [], relatedStories: [], indexable: true, markdownAvailable: false, group: null, hasTranslation: false, bodyLanguage: "zh", research: { ...research, revisedAt: null },
};
let web: ChildProcess;
let origin: string;
let logs = "";
const api = createServer((req, res) => {
  const path = new URL(req.url!, "http://api.local").pathname;
  res.setHeader("Content-Type", "application/json");
  if (path === "/api/site/meta") return res.end(JSON.stringify({ changelogVersion: "2026-09-28T12:00" }));
  if (path === "/api/site/items/research-fixture") return res.end(JSON.stringify(item));
  if (path === "/api/site/reports/daily/2026-10-03" || path === "/api/site/reports/daily/2026-10-02") return res.end(JSON.stringify(illustratedReport(path.slice(-10), path.endsWith("2026-10-02"))));
  const match = /^\/api\/site\/reports\/(daily|weekly|monthly)\/(.+)$/.exec(path);
  if (match) {
    const kind = match[1] as ReportKind;
    const key = match[2]!;
    if (key === "latest-page") return res.end(JSON.stringify({ index: index(kind), report: report(kind, keys[kind].at(-1)!) }));
    if (key.startsWith("navigation/")) return res.end(JSON.stringify({ items: index(kind) }));
    if (keys[kind].includes(key)) return res.end(JSON.stringify(report(kind, key)));
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ code: "not_found" }));
});
before(async () => {
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  web = spawn(process.execPath, [fileURLToPath(new URL("../server.ts", import.meta.url))], {
    env: { ...process.env, NODE_ENV: "production", WEB_HOST: "127.0.0.1", WEB_PORT: "0", API_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`web did not start: ${logs}`)), 15_000);
    web.on("exit", () => { clearTimeout(timeout); reject(new Error(`web exited: ${logs}`)); });
    web.stderr!.on("data", (chunk) => { logs += String(chunk); });
    web.stdout!.on("data", (chunk) => {
      logs += String(chunk);
      const match = logs.match(/"msg":"web started","port":(\d+)/);
      if (match) { origin = `http://127.0.0.1:${match[1]}`; clearTimeout(timeout); resolve(); }
    });
  });
});
after(async () => {
  if (web && web.exitCode === null) { web.kill("SIGTERM"); await once(web, "exit"); }
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

function masthead(html: string): string {
  const header = /<header class="pt-5 lg:pt-0">([\s\S]*?)<\/header>/.exec(html);
  assert.ok(header, "the actual report masthead must be rendered");
  return header[1]!.replace(/<[^>]+>/g, "");
}

for (const kind of kinds) {
  test(`production SSR ${kind} masthead shows 405 instead of the navigation length`, async () => {
    const response = await fetch(`${origin}/${kind}`);
    assert.equal(response.status, 200, logs);
    const html = await response.text();
    const visible = masthead(html);
    assert.match(visible, /第\s*405\s*期/);
    assert.doesNotMatch(visible, /第\s*400\s*期/);
  });
  test(`production SSR ${kind} oldest detail retains its own first issue number`, async () => {
    const first = keys[kind][0]!;
    assert.ok(!index(kind).some((entry) => entry.key === first));
    const response = await fetch(`${origin}/${kind}/${first}`);
    assert.equal(response.status, 200, logs);
    const visible = masthead(await response.text());
    assert.match(visible, /第\s*1\s*期/);
  });
}


for (const kind of kinds) {
  test(`${kind} calendar keeps the current old issue number without inventing other old issues`, () => {
    const first = keys[kind][0]!;
    const grid = periodGrid(kind, first, index(kind), 1);
    const current = grid.cells.find((cell) => cell.key === first)!;
    assert.equal(current.state, "current");
    assert.match(current.label, /第 1 期/);
    assert.doesNotMatch(current.label, /未出刊/);
    const absent = grid.cells.find((cell) => cell.key === keys[kind][1])!;
    assert.equal(absent.state, "none");
    assert.match(absent.label, /未出刊/);
    assert.equal(issueNumber(index(kind), keys[kind].at(-1)!), 405);
    const refreshed = periodGrid(kind, first, [{ key: first, issueNumber: 9 }], 10);
    assert.match(refreshed.cells.find((cell) => cell.key === first)!.label, /第 10 期/, "current detail metadata wins over an older navigation snapshot");
  });
  test(`${kind} known entries without numbers stay published without length-based fallback`, () => {
    const current = keys[kind].at(-1)!;
    const previous = keys[kind].at(-2)!;
    const legacy = [{ key: current }, { key: previous }];
    assert.equal(issueNumber(legacy, current), null);
    const grid = periodGrid(kind, current, legacy);
    for (const key of [current, previous]) {
      const cell = grid.cells.find((entry) => entry.key === key)!;
      assert.match(cell.label, /已出刊/);
      assert.doesNotMatch(cell.label, /未出刊|第 \d+ 期/);
    }
    for (const n of [0, -1, NaN, 1.5]) assert.equal(issueNumber([{ key: current, issueNumber: n }], current), null);
  });
}


test("retired pilot URLs redirect to the daily publication without loading the old issue", async () => {
  for (const path of ["/pilot", "/pilot/2026-10-03"]) {
    const response = await fetch(`${origin}${path}`, { redirect: "manual" });
    assert.equal(response.status, 301, logs);
    assert.equal(response.headers.get("location"), "/daily");
  }
});

test("reader report leads with research and original artwork while operational diagnostics stay hidden", async () => {
  const response = await fetch(`${origin}/daily/2026-10-03`);
  assert.equal(response.status, 200, logs);
  const html = await response.text(), $ = load(html);
  $("script").remove();
  const visible = $("body").text();
  assert.equal($('[data-report-kind="daily"][data-report-key="2026-10-03"][data-report-revision="1"]').length, 1);
  assert.equal($('[aria-label="本期处理范围"]').length, 0);
  assert.equal($('[aria-label="头版"] h2').first().text(), "研究提出新的比较方法");
  const figure = $('figure[data-paper-figure="true"]');
  assert.equal(figure.length, 1, "the first story appears once, with its own original figure");
  assert.equal(figure.find("img").attr("src"), "https://example.org/method-figure.png");
  assert.match(figure.find("img").attr("class")!, /object-contain/);
  assert.ok(html.indexOf('data-paper-figure="true"') < html.indexOf('<h2 class="mt-4'));
  assert.doesNotMatch(visible, /本期部分结果|处理缺口|未准入|请求结果未知|尚未开放|部分完成|科研试刊/);
  assert.match(visible, /基于摘要|缺少真实系统实验/);
  assert.match(visible, /09:00.*15:00.*21:00/);
  assert.equal($('a[href^="/pilot"]').length, 0);
  assert.doesNotMatch($.html(), /href="javascript:/);
});

test("an empty edition does not claim that no new research exists", async () => {
  const response = await fetch(`${origin}/daily/2026-10-02`);
  assert.equal(response.status, 200, logs);
  const $ = load(await response.text());
  $("script").remove();
  assert.match($("body").text(), /这一期暂无推荐文章/);
  assert.doesNotMatch($("body").text(), /今日无新研究|没有新研究|本期处理范围/);
});

test("production SSR item keeps missing publication and revision dates distinct from observation", async () => {
  const response = await fetch(`${origin}/items/research-fixture`);
  assert.equal(response.status, 200, logs);
  const visible = (await response.text()).replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, "");
  assert.match(visible, /本站发现时间/);
  assert.match(visible, /原始提交2026-09-20 10:00/);
  assert.match(visible, /修订未知/);
  assert.match(visible, /社区入选2026-10-01 12:00/);
  assert.match(visible, /本站观测2026-10-03 13:00/);
  assert.match(visible, /基于摘要/);
});
