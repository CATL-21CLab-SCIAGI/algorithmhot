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
function pilot(key = "2026-10-03", empty = false): ReportDetail {
  const citation = { itemId: "research-fixture", title: "研究提出新的比较方法", summary: "作者报告在给定设置下的结果。", sourceName: "arXiv", sourceUrl: "https://arxiv.org/abs/2609.12345", sourceId: "arxiv-test", sourceIconUrl: null, firstParty: false, role: null, storyPublicId: null, publishedAt: research.originalPublishedAt, available: true, research };
  return {
    kind: "pilot", key, issueNumber: 1, title: "科研试刊", windowStart: "2026-09-26T05:17:00Z", windowEnd: "2026-10-03T05:17:00Z", generatedAt: "2026-10-03T05:30:00Z", revision: 1,
    lead: empty ? null : { title: "研究提出新的比较方法", leadParagraph: "作者报告在给定设置下的结果。" }, overview: null,
    highlights: empty ? [] : [citation], sections: empty ? [] : [{ label: "算法", summary: null, items: [citation] }], stories: empty ? [] : [{ ...citation, label: "算法" }], flashes: [], cover: null,
    metrics: { selectedCount: empty ? 0 : 1 }, readingMinutes: 1, prev: null, next: null,
    run: { id: "pilot-local-fixture", kind: "pilot", status: "partial", metrics: { sourcesObserved: 5, admitted: 2, notAdmitted: 20, processed: 1, failed: 0, unknownOutcome: 1, pending: 0, selected: empty ? 0 : 1, displayed: empty ? 0 : 1 }, gaps: ["仅观测到 5/6 个来源", "1 条模型请求结果未知"] },
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
  if (path.startsWith("/api/site/reports/pilot/")) {
    const key = path.slice("/api/site/reports/pilot/".length);
    const nav = [{ key: "2026-10-03", issueNumber: 1, title: "科研试刊" }];
    if (key === "latest-page") return res.end(JSON.stringify({ index: nav, report: pilot() }));
    if (key.startsWith("navigation/")) return res.end(JSON.stringify({ items: nav }));
    if (key === "2026-10-03" || key === "2026-10-02") return res.end(JSON.stringify(pilot(key, key === "2026-10-02")));
  }
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


test("production SSR pilot shows its real seven-day window, bounded processing and research provenance", async () => {
  for (const path of ["/pilot", "/pilot/2026-10-03"]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, logs);
    const html = await response.text();
    const visible = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, "");
    assert.match(masthead(html), /科研试刊/);
    assert.doesNotMatch(masthead(html), /08:00|每天|本月/);
    assert.match(visible, /2026-09-26 13:17/);
    assert.match(visible, /2026-10-03 13:17/);
    assert.match(visible, /部分完成/);
    assert.match(visible, /未准入资料20/);
    assert.match(visible, /处理失败0/);
    assert.match(visible, /请求结果未知1/);
    assert.match(visible, /仅观测到 5\/6 个来源/);
    assert.match(visible, /本期看点/);
    assert.match(visible, /基于摘要/);
    for (const date of ["2026-09-20 10:00", "2026-09-28 11:00", "2026-10-01 12:00", "2026-10-03 13:00"]) assert(visible.includes(date));
    assert.match(html, /href="https:\/\/example.org\/research-code"/);
    assert.doesNotMatch(html, /href="javascript:/);
    assert.doesNotMatch(visible, /今日看点|独立复现通过/);
  }
});

test("production SSR empty pilot preserves missing evidence instead of claiming no new research", async () => {
  const response = await fetch(`${origin}/pilot/2026-10-02`);
  assert.equal(response.status, 200, logs);
  const html = await response.text();
  assert.match(html, /本期暂未刊载条目，来源或处理仍有缺口/);
  assert.doesNotMatch(html, /今日无新研究|本期没有入选内容/);
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
