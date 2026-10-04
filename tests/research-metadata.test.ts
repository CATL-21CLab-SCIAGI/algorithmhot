import assert from "node:assert/strict";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { config } from "@aihot/backend/config";
import { identityKeyFor } from "@aihot/backend/content/materials";
import { parseJsonList } from "@aihot/backend/sources/json-list";
import { fetchRss, parseRss } from "@aihot/backend/sources/rss";
import { makeResearchMetadata, mergeResearchMetadata, parseArxivIdentity, researchLinks, researchMetadataChanged } from "@aihot/backend/sources/research";
import { unsupportedConfig } from "@aihot/backend/sources/config-keys";
import type { SourceRow } from "@aihot/backend/sources/types";

const observed = new Date("2026-10-03T02:00:00Z");
const source = (settings: Partial<SourceRow> = {}): SourceRow => ({
  id: "arxiv-test", name: "arXiv", kind: "rss", config: { feedUrl: "https://rss.arxiv.org/rss/cs.LG", summaryIsBody: true, researchSourceKind: "arxiv" },
  tier: "T1_5", participation_mode: "editorial", first_party: false, interval_minutes: 360, enabled: false, cursor: null, fail_count: 0, ...settings,
});
const atom = (entry: string) => `<feed xmlns="http://www.w3.org/2005/Atom">${entry}</feed>`;
const entry = (extra = "") => `<entry><id>http://arxiv.org/abs/2609.01234v2</id><title>Research method</title><link href="https://arxiv.org/abs/2609.01234v2"/><summary>A short abstract, with reported experiments.</summary>${extra}</entry>`;

test("arXiv aliases and legacy ids share one research identity while retaining versions", () => {
  for (const url of ["https://arxiv.org/abs/2609.01234v2", "https://export.arxiv.org/pdf/2609.01234v2.pdf", "arXiv:2609.01234v2", "2609.01234v2"]) {
    assert.deepEqual(parseArxivIdentity(url), { id: "2609.01234", version: "v2", canonicalKey: "arxiv:2609.01234", canonicalUrl: "https://arxiv.org/abs/2609.01234" });
  }
  assert.equal(parseArxivIdentity("https://arxiv.org/pdf/hep-th/9901001v3.pdf")?.canonicalKey, "arxiv:hep-th/9901001");
  assert.equal(identityKeyFor({ sourceId: "x", url: "https://arxiv.org/pdf/2609.01234.pdf", title: "T", via: "fetch" }), "arxiv:2609.01234");
  for (const url of ["https://example.com/?paper=https://arxiv.org/abs/2609.01234", "https://arxiv.org.evil.example/abs/2609.01234", "garbage", "2609.01234v0"]) assert.equal(parseArxivIdentity(url), null);
});

test("Atom uses summaryIsBody for short abstracts and preserves all four distinct dates", () => {
  const [item] = parseRss(atom(entry('<published>2026-09-10T01:00:00Z</published><updated>2026-10-01T02:00:00Z</updated><arxiv:doi>10.1234/test</arxiv:doi>')), source(), undefined, observed);
  assert.equal(item!.bodyStatus, "ok");
  assert.equal(item!.bodyText, "A short abstract, with reported experiments.");
  assert.equal(item!.identityKey, "arxiv:2609.01234");
  assert.equal(item!.research?.originalPublishedAt, "2026-09-10T01:00:00.000Z");
  assert.equal(item!.research?.revisedAt, "2026-10-01T02:00:00.000Z");
  assert.equal(item!.research?.communitySelectedAt, null);
  assert.equal(item!.research?.observedAt, observed.toISOString());
  assert.equal(item!.research?.evidenceBasis, "abstract");
  assert.equal(item!.research?.doi, "10.1234/test");
  assert.equal((item!.raw as Record<string, unknown>)["arxiv:doi"], "10.1234/test");
});

test("RSS announcement and Atom revision never fabricate an original submission date", () => {
  const [rss] = parseRss('<rss><channel><item><title>Paper</title><link>https://arxiv.org/abs/2609.01234</link><pubDate>Thu, 01 Oct 2026 00:00:00 GMT</pubDate><description>Abstract</description><arxiv:announce_type>new</arxiv:announce_type></item></channel></rss>', source(), undefined, observed);
  assert.equal(rss!.publishedAt?.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(rss!.research?.originalPublishedAt, null);
  assert.equal(rss!.bodyStatus, "ok");
  assert.equal((rss!.raw as Record<string, unknown>)["arxiv:announce_type"], "new");
  const [missing] = parseRss(atom(entry("<updated>2026-10-01T00:00:00Z</updated>")), source(), undefined, observed);
  assert.equal(missing!.research?.originalPublishedAt, null);
  assert.equal(missing!.research?.revisedAt, "2026-10-01T00:00:00.000Z");
});

const hfSource = source({ kind: "json_list", participation_mode: "hot_signal", config: {
  url: "https://huggingface.co/api/daily_papers", researchSourceKind: "huggingface", titlePaths: ["paper.title"], summaryPaths: ["paper.summary"],
  summaryIsBody: true, urlTemplate: "https://huggingface.co/papers/{paper.id}", publishedAtPath: "publishedAt", externalIdPath: "paper.id", rawDropKeys: ["ignored"],
} });

test("HF is a separate signal and keeps older paper publication distinct from today's selection", () => {
  const [signal] = parseJsonList(JSON.stringify([{ publishedAt: "2026-09-09T20:00:00Z", ignored: "discard", paper: {
    id: "2609.01234", title: "Research", summary: "An abstract.", publishedAt: "2026-09-10T01:00:00Z", submittedOnDailyAt: "2026-10-02T12:00:00Z", upvotes: 120,
    githubRepo: "https://github.com/example/research", modelUrl: "https://huggingface.co/example/model",
  } }]), hfSource, observed);
  assert.equal(signal!.identityKey, "hf:2609.01234");
  assert.equal(signal!.research?.canonicalKey, "arxiv:2609.01234");
  assert.equal(signal!.research?.signalOnly, true);
  assert.equal(signal!.research?.originalPublishedAt, "2026-09-10T01:00:00.000Z");
  assert.equal(signal!.research?.communitySelectedAt, "2026-10-02T12:00:00.000Z");
  assert.equal(signal!.publishedAt?.toISOString(), "2026-10-02T12:00:00.000Z");
  assert.deepEqual(signal!.research?.links.map(link => link.kind), ["paper", "code", "weights"]);
  assert.ok(signal!.research?.links.every(link => link.sourceUrl === "https://huggingface.co/papers/2609.01234"));
  assert.equal((signal!.raw as any).paper.upvotes, 120);
  assert.equal((signal!.raw as any).ignored, undefined);
});

test("HF missing Daily Papers selection stays unknown rather than using paper or observation dates", () => {
  const [signal] = parseJsonList(JSON.stringify([{ publishedAt: "2026-10-02T12:00:00Z", paper: {
    id: "2609.01234", title: "Research", summary: "An abstract.", publishedAt: "2026-09-10T01:00:00Z",
  } }]), hfSource, observed);
  assert.equal(signal!.publishedAt, null);
  assert.equal(signal!.research?.communitySelectedAt, null);
  assert.equal(signal!.research?.originalPublishedAt, "2026-09-10T01:00:00.000Z");
});

test("plain source URLs retain explicit project and code links without inventing weights", () => {
  const sourceUrl = "https://arxiv.org/abs/2609.01234";
  const links = researchLinks(sourceUrl, [], "Project page: https://ramazan793.github.io/gala/. Code: https://github.com/org/repo. Model weights: https://huggingface.co/org/model. Related resource https://example.org/unknown. Dataset weights https://huggingface.co/datasets/org/data. A model trained on this task; https://huggingface.co/org/unknown.");
  assert.deepEqual(links.map(({ kind, url }) => [kind, url]), [
    ["project", "https://ramazan793.github.io/gala/"],
    ["code", "https://github.com/org/repo"],
    ["weights", "https://huggingface.co/org/model"],
  ]);
  assert.ok(links.every(link => link.sourceUrl === sourceUrl));
  const [paper] = parseRss(atom(entry().replace("A short abstract, with reported experiments.", "Project page: https://ramazan793.github.io/gala/")), source(), undefined, observed);
  assert.ok(paper!.research!.links.some(link => link.kind === "project" && link.url === "https://ramazan793.github.io/gala/"));
});

test("metadata merges retain versions, source links and first observation without erasing known dates", () => {
  const previous = makeResearchMetadata({ identity: parseArxivIdentity("2609.01234v2"), originalPublishedAt: "2026-09-10", revisedAt: "2026-10-01", observedAt: observed, evidenceBasis: "abstract" });
  const old = makeResearchMetadata({ identity: parseArxivIdentity("2609.01234v1"), observedAt: new Date("2026-10-04"), evidenceBasis: "unknown" });
  const merged = mergeResearchMetadata(previous, old);
  assert.equal(merged.arxivVersion, "v2");
  assert.deepEqual(merged.arxivVersions, ["v1", "v2"]);
  assert.equal(merged.originalPublishedAt, previous.originalPublishedAt);
  assert.equal(merged.revisedAt, previous.revisedAt);
  assert.equal(merged.observedAt, observed.toISOString());
  assert.equal(merged.evidenceBasis, "abstract");
  assert.equal(researchMetadataChanged(merged, mergeResearchMetadata(merged, old)), false, "repeated observations are no metadata change");
});

test("LaTeX and HTML explicit links keep clean URLs, source labels and deduplicated provenance", () => {
  const sourceUrl = "https://arxiv.org/abs/2610.00602v1";
  const raw = String.raw`\href{https://github.com/a12dongithub/PathOGen}{GitHub} and \href{https://huggingface.co/a12donhf/CPathOGen}{Hugging~Face}.`;
  const repeated = `${raw} <a href="https://github.com/a12dongithub/PathOGen">GitHub</a> <a href='https://huggingface.co/a12donhf/CPathOGen'>Hugging Face</a>`;
  const expected = [
    { kind: "code", url: "https://github.com/a12dongithub/PathOGen", sourceUrl },
    { kind: "project", url: "https://huggingface.co/a12donhf/CPathOGen", sourceUrl },
  ];
  assert.deepEqual(researchLinks(sourceUrl, [], repeated), expected);
  const [paper] = parseRss(atom(entry().replace("A short abstract, with reported experiments.", raw)), source(), undefined, observed);
  assert.ok(paper!.research!.links.some(link => link.kind === "project" && link.url === expected[1]!.url));
  assert.ok(paper!.research!.links.every(link => !/%7[BD]|[{}]/i.test(link.url)));

  const braces = researchLinks(sourceUrl, [], String.raw`Code: \url{https://github.com/lab/my\_repo}. Project page: \href{https://example.org/project}{Project page}. Model weights: \url{https://huggingface.co/lab/checkpoint}.`);
  assert.deepEqual(braces, [
    { kind: "code", url: "https://github.com/lab/my_repo", sourceUrl },
    { kind: "project", url: "https://example.org/project", sourceUrl },
    { kind: "weights", url: "https://huggingface.co/lab/checkpoint", sourceUrl },
  ]);
  assert.equal(researchLinks(sourceUrl, [], String.raw`\href{https://huggingface.co/lab/unknown}{Resource}`).length, 0, "an unspecified HF resource is not claimed to contain weights");
});

test("unparseable dates are null, malformed documents fail, valid empty feeds are healthy", () => {
  assert.equal(makeResearchMetadata({ originalPublishedAt: "invalid", observedAt: "invalid", evidenceBasis: "unknown" }).originalPublishedAt, null);
  assert.deepEqual(parseRss("<rss><channel><title>Quiet day</title></channel></rss>", source()), []);
  assert.deepEqual(parseJsonList("[]", hfSource), []);
  assert.throws(() => parseRss("<error>denied</error>", source()), /not an RSS\/Atom/);
  assert.throws(() => parseJsonList("{bad", hfSource), /not JSON/);
  assert.throws(() => parseJsonList("{}", hfSource), /array/);
});

test("research sources explicitly allow fixed frequency and reject misspelled research modes", () => {
  assert.deepEqual(unsupportedConfig("rss", { feedUrl: "https://rss.arxiv.org/rss/cs.AI", fixedInterval: true, researchSourceKind: "arxiv", summaryIsBody: true }), []);
  assert.deepEqual(unsupportedConfig("rss", { researchSourceKind: "arxivv" }), ["researchSourceKind=arxivv"]);
});

test("gzip feed response is decoded once before the common parser", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/atom+xml", "content-encoding": "gzip" });
    res.end(gzipSync(atom(entry())));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const previous = config.allowPrivateNetworkFetch;
  config.allowPrivateNetworkFetch = true;
  try {
    const address = server.address() as { port: number };
    const result = await fetchRss(source({ config: { ...source().config, feedUrl: `http://127.0.0.1:${address.port}/feed` } }));
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]!.research?.arxivVersion, "v2");
  } finally {
    config.allowPrivateNetworkFetch = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
