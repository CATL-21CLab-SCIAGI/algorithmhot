import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectSnapshot, createExport, publicationClient, writeExport } from "../scripts/static-site.ts";
import { publicUrl, sanitizeItem, sanitizeReport, validateSnapshot } from "../scripts/static-site/model.ts";
import type { Snapshot } from "../scripts/static-site/model.ts";
import { normalizeBase, renderRoadmap, renderSite, validateStaticLinks } from "../scripts/static-site/render.ts";

const raw = { id: "paper_1", selected: true, title: '<script>alert("x")</script>', summary: 'summary <img src=x onerror="alert(1)">', source: { name: "arXiv", iconUrl: "http://127.0.0.1/private" }, links: { original: "https://arxiv.org/abs/1234.56789", aihot: "http://127.0.0.1:3102/items/paper_1" }, category: "algorithm", body: { original: "PRIVATE RAW FULLTEXT" }, receipt: "PRIVATE RECEIPT", apiKey: "PRIVATE KEY", tags: ["算法"], research: { evidenceBasis: "abstract", links: [{ kind: "code", url: "javascript:alert(1)", sourceUrl: "http://localhost" }, { kind: "paper", url: "https://arxiv.org/abs/1234.56789", sourceUrl: "https://arxiv.org/abs/1234.56789" }] } };
const snap = (): Snapshot => ({ schemaVersion: 1, generatedAt: "2026-10-04T04:00:00Z", publicBaseUrl: "https://pkucy2016.github.io/algorithmhot/", mode: "static-snapshot", scope: "Public test scope", items: [sanitizeItem(raw)], topics: [{ slug: "algorithm", name: "算法", group: "field", definition: "test", total: 1, recent: 1, latestAt: null, itemIds: ["paper_1"] }], reports: [] });

test("public snapshot whitelist excludes full text, receipts, local links and unknown fields", () => {
  const result = JSON.stringify(sanitizeItem(raw));
  for (const secret of ["PRIVATE", "apiKey", "receipt", "body", "127.0.0.1", "localhost", "javascript:"]) assert.equal(result.includes(secret), false, secret);
  assert.match(result, /https:\/\/arxiv.org/);
});

test("source URLs reject executable schemes, all IP literals, intranet and embedded credentials", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,Hi", "https://u:p@example.com/a", "http://localhost/a", "http://localhost./a", "http://192.168.1.2/a", "http://2130706433/a", "http://[::1]/a", "https://my.internal/a", "https://my.local/a", "https://intranet/a"]) assert.equal(publicUrl(url), null, url);
  assert.equal(publicUrl("https://arxiv.org/abs/2610.01234"), "https://arxiv.org/abs/2610.01234");
});

test("rendered HTML escapes source content and every internal link respects project base", () => {
  const { files, manifest } = createExport(snap());
  assert.doesNotThrow(() => validateStaticLinks(files, snap().publicBaseUrl));
  const item = files.get("items/paper_1/index.html")!;
  assert.match(item, /&lt;script&gt;/);
  assert.doesNotMatch(item, /<script|<img src=x/);
  assert.match(item, /href="\/algorithmhot\/topics\/"/);
  assert.equal(manifest.files.length, files.size);
  assert.equal(files.has(".nojekyll"), true);
  assert.equal([...files.keys()].some((key) => key.startsWith(".github")), false);
  assert.match(files.get("about/index.html")!, /GitHub 可能处理访问 IP/);
  const agent = files.get("agent/index.html")!;
  assert.doesNotMatch(agent, /调研模型|600 次调用|本机设置/);
  assert.doesNotMatch(agent, /<form|<select|localhost|127\.0\.0\.1|\/api\/admin/);
});

test("static validation catches missing targets and root-relative links escaping Pages prefix", () => {
  const { files } = createExport(snap());
  files.set("bad.html", '<a href="/topics/">bad</a>');
  assert.throws(() => validateStaticLinks(files, snap().publicBaseUrl), /escapes project base/);
  files.set("bad.html", '<a href="/algorithmhot/missing/">bad</a>');
  assert.throws(() => validateStaticLinks(files, snap().publicBaseUrl), /Missing static link/);
  files.set("bad.html", '<a href="/algorithmhot/#missing">bad</a>');
  assert.throws(() => validateStaticLinks(files, snap().publicBaseUrl), /Missing anchor/);
});

test("export refuses local data in prose and missing topic identities", () => {
  const s = snap();
  s.items[0].summary = "read http://127.0.0.1:3101/private";
  assert.throws(() => validateSnapshot(s), /local-only/);
  s.items[0].summary = "okay";
  s.topics[0].itemIds.push("missing");
  assert.throws(() => validateSnapshot(s), /Missing topic item/);
});

test("roadmap preserves original evidence, labels interpretation and does not retrofit old report revisions", () => {
  const s = snap();
  s.items[0].researchRoadmap = { title: "路线图", nodes: ["input", "method", "output"].map((stage) => ({ stage, label: stage, detail: "source-based note", evidenceSnippet: "Exact source evidence" })), limitations: "Only abstract available", evidenceBasis: "abstract", sourceRevision: 1, sourceUrl: "https://arxiv.org/abs/1234.56789", generatedAt: "2026-10-04T00:00:00Z" };
  const html = renderRoadmap(s.items[0].researchRoadmap);
  assert.match(html, /非论文原图/);
  assert.match(html, /基于摘要/);
  assert.match(html, /Exact source evidence/);
  assert.match(html, /独立复现未核验/);
  s.reports = [sanitizeReport({ kind: "pilot", key: "2026-10-03", title: "old report", sections: [{ label: "算法", items: [{ itemId: "paper_1", title: "test", available: true }] }], run: { status: "partial", gaps: ["missing brief"] }, metrics: { admitted: 60, selected: 29, totalEvents: 15 } })];
  const { files } = createExport(s);
  assert.equal(files.has("pilot/2026-10-03/index.html"), false);
  assert.match(files.get("items/paper_1/index.html")!, /PAPER ROADMAP/);
});

test("collection reads only publication HTTP routes, follows all topic pages and fails on repeated cursor", async () => {
  const calls: string[] = [];
  const responses: Record<string, unknown> = {
    "/api/site/pool?page=1": { page: 1, total: 1, pageCount: 1, items: [raw] },
    "/api/site/topics": { topics: [{ slug: "algorithm", name: "算法", group: "field", total: 1 }] },
    "/api/site/timeline?limit=40": { cards: [{ item: { id: "paper_1" } }], nextCursor: "next" },
    "/api/site/timeline?limit=40&cursor=next": { cards: [], nextCursor: null },
    "/api/site/topics/algorithm?page=1": { items: [raw], pageCount: 1 },
    "/api/site/reports/weekly": { items: [] }, "/api/site/reports/monthly": { items: [] }, "/api/site/reports/daily": { items: [] }, "/api/site/items/paper_1": raw,
  };
  const get = async (route: string) => { calls.push(route); assert.ok(route in responses, route); return responses[route]; };
  const result = await collectSnapshot(get, snap().publicBaseUrl);
  assert.equal(result.items.length, 1);
  assert.ok(calls.every((route) => route.startsWith("/api/site/")));
  responses["/api/site/timeline?limit=40&cursor=next"] = { cards: [], nextCursor: "next" };
  await assert.rejects(collectSnapshot(get, snap().publicBaseUrl), /cursor did not advance/);
});

test("export cannot silently truncate a report archive at the API limit", async () => {
  await assert.rejects(collectSnapshot(async (route) => route.includes("reports/") ? { items: Array(400).fill({ key: "2026-10-04" }) } : route.endsWith("topics") ? { topics: [] } : route.includes("/pool?") ? { page: 1, pageCount: 1, total: 0, items: [] } : { cards: [], nextCursor: null }, snap().publicBaseUrl), /400-report limit/);
});

test("input endpoint and public base are constrained separately", () => {
  assert.throws(() => publicationClient("https://evil.example"), /local public HTTP/);
  assert.throws(() => normalizeBase("https://site.example/a?token=secret"), /Public base/);
  assert.throws(() => normalizeBase("https://user:password@site.example/a/"), /Public base/);
  assert.equal(normalizeBase("https://site.example/algorithmhot").pathname, "/algorithmhot/");
});

test("atomic output replaces only recognized exports and refuses symlinks or arbitrary directories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "algorithmhot-static-test-"));
  try {
    const output = path.join(root, "public");
    const { files, manifest } = createExport(snap());
    await writeExport(output, files, manifest);
    assert.equal(JSON.parse(await readFile(path.join(output, "export-manifest.json"), "utf8")).files.length, files.size);
    await writeExport(output, files, manifest);
    await symlink(path.join(output, "index.html"), path.join(output, "unexpected.html"));
    await assert.rejects(writeExport(output, files, manifest), /symlink/);
    const arbitrary = path.join(root, "arbitrary");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(arbitrary);
    await writeFile(path.join(arbitrary, "personal.txt"), "keep me");
    await assert.rejects(writeExport(arbitrary, files, manifest), /without an export manifest/);
    assert.equal(await readFile(path.join(arbitrary, "personal.txt"), "utf8"), "keep me");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("public research briefs retain only known positive source revisions for original-figure binding", () => {
  assert.equal(sanitizeItem({ id: "paper_1", researchBrief: { sourceRevision: 4 } }).researchBrief?.sourceRevision, 4);
  for (const sourceRevision of [undefined, null, 0, -1, 1.5, "1"]) assert.equal(sanitizeItem({ id: "paper_1", researchBrief: { sourceRevision } }).researchBrief?.sourceRevision, null);
});

test("binary figure assets keep exact bytes through inventory and atomic export", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "algorithmhot-binary-export-"));
  try {
    const input = renderSite(snap());
    const bytes = new Uint8Array([137, 80, 78, 71, 0, 255]);
    const files = new Map<string, string | Uint8Array>(input);
    files.set("assets/paper-figures/exact.png", bytes);
    const exported = createExport(snap(), files);
    const entry = exported.manifest.files.find(file => file.path === "assets/paper-figures/exact.png")!;
    assert.equal(entry.bytes, bytes.length);
    await writeExport(path.join(root, "site"), exported.files, exported.manifest);
    assert.deepEqual(await readFile(path.join(root, "site/assets/paper-figures/exact.png")), Buffer.from(bytes));
  } finally { await rm(root, { recursive: true }); }
});
