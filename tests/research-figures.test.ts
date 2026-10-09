import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { PAPER_FIGURES } from "@aihot/industry/paper-figures";
import { approveResearchPaperFigure, ensureResearchPaperFigure, figureCaptionConfidence, getVerifiedResearchPaperFigure, inspectFigureBytes, registerResearchHtmlFigureCandidate, registerResearchPdfFigureCandidate } from "@aihot/backend/research/figures";
import { publicPaperFigure } from "@aihot/contracts/paper-figure";
import type { ResearchFigureInput } from "@aihot/backend/research/figures";
import type { guardedFetch } from "@aihot/backend/lib/http-fetch";

const input: ResearchFigureInput = { itemId: "figure-test", sourceRevision: 2, arxivId: "2610.12345", arxivVersion: "v1", title: "A source-bound method" };
const abs = (license = "https://creativecommons.org/licenses/by/4.0/") => `<meta name="citation_arxiv_id" content="2610.12345"><meta name="citation_title" content="A source-bound method"><meta name="citation_author" content="Example, Ada"><div class="abs-license"><a href="${license}">License</a></div>`;
const html = (caption = "Figure 2: Overview of our proposed framework.", extra = "") => `<h1 class="ltx_title_document">A source-bound method</h1><figure class="ltx_figure" id="S2.F2"><img src="2610.12345v1/overview.png">${extra}<figcaption><span class="ltx_tag_figure">Figure 2:</span>${caption.replace(/^Figure 2:\s*/, "")}</figcaption></figure>`;
const png = await sharp({ create: { width: 640, height: 320, channels: 3, background: "white" } }).png().toBuffer();
const now = new Date("2026-10-08T01:00:00.000Z");
const trainingCaption = "Figure 2: RoboJEPA training. A frozen visual encoder provides tokens; the predictor minimizes teacher-forcing and autoregressive rollout losses.";
const htmlSource = () => ({ abstractHtml: Buffer.from(abs()), html: Buffer.from(html(trainingCaption)), image: png,
  figureId: "S2.F2", imageUrl: "https://arxiv.org/html/2610.12345v1/overview.png" });

function fetcher(pages: { abs?: string; html?: string; image?: Buffer; status?: number } = {}) {
  const calls: string[] = [];
  const fetch: typeof guardedFetch = async (url, options) => {
    calls.push(url);
    assert.equal(options?.maxRedirects, 0);
    const body = url.includes("/abs/") ? Buffer.from(pages.abs ?? abs()) : url.endsWith("overview.png") ? pages.image ?? png : Buffer.from(pages.html ?? html());
    return { status: pages.status ?? 200, url, headers: new Headers({ "content-type": "text/html" }), body, text: () => body.toString() };
  };
  return { fetch, calls };
}
async function temporary<T>(run: (cacheDir: string) => Promise<T>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "algorithmhot-figures-test-"));
  try { return await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("original caption plus exact title/version/license and decoded complete image can be source-verified", () => temporary(async cacheDir => {
  const { fetch, calls } = fetcher();
  const result = await ensureResearchPaperFigure(input, { cacheDir, fetch, now });
  assert.equal(result.status, "verified");
  assert.equal(result.verificationBasis, "source-caption");
  assert.equal(result.figure?.caption, "Figure 2:Overview of our proposed framework.");
  assert.equal(result.figure?.sourceUrl, "https://arxiv.org/html/2610.12345v1#S2.F2");
  assert.equal(result.figure?.width, 640);
  assert.equal(result.figure?.licenseName, "CC BY 4.0");
  assert.equal(calls.length, 3);
  assert.deepEqual(await getVerifiedResearchPaperFigure(input, { cacheDir }), result.figure);
  assert.deepEqual(await getVerifiedResearchPaperFigure({ itemId: input.itemId, sourceRevision: input.sourceRevision }, { cacheDir }), result.figure);
  assert.deepEqual(await ensureResearchPaperFigure(input, { cacheDir, fetch, now }), result);
  assert.equal(calls.length, 3, "same inputs reuse evidence, without HTTP retries");
  await assert.rejects(ensureResearchPaperFigure({ ...input, arxivVersion: "v2" }, { cacheDir, fetch }), /input changed/);
  assert.equal(calls.length, 3);
}));

test("unreachable is cached and never treated as an original figure or auto-retried", () => temporary(async cacheDir => {
  const { fetch, calls } = fetcher({ status: 503 });
  assert.equal((await ensureResearchPaperFigure(input, { cacheDir, fetch })).status, "unavailable");
  assert.equal((await ensureResearchPaperFigure(input, { cacheDir, fetch })).status, "unavailable");
  assert.equal(await getVerifiedResearchPaperFigure(input, { cacheDir }), null);
  assert.equal(calls.length, 1);
}));

test("the official complete RDF title binds artwork when the visible heading omits its subtitle", () => temporary(async cacheDir => {
  const rdf = '<div class="ltx_rdf" about="" property="dcterms:title" content="A source-bound method"></div>';
  const shortHeading = html().replace('>A source-bound method</h1>', '>A source-bound</h1>');
  const { fetch } = fetcher({ html: shortHeading + rdf });
  const result = await ensureResearchPaperFigure(input, { cacheDir, fetch });
  assert.equal(result.status, "verified");
  assert.equal(result.candidate?.titleMatches, true);
}));

test("conflicting official title metadata cannot approve an otherwise matching heading", () => temporary(async cacheDir => {
  for (const [label, rdf] of [
    ["different", '<div class="ltx_rdf" about="" property="dcterms:title" content="A different paper"></div>'],
    ["ambiguous", '<div class="ltx_rdf" about="" property="dcterms:title" content="A source-bound method"></div><div class="ltx_rdf" about="" property="dcterms:title" content="A different paper"></div>'],
  ]) {
    const { fetch } = fetcher({ html: html() + rdf });
    const result = await ensureResearchPaperFigure({ ...input, itemId: `title-${label}` }, { cacheDir, fetch });
    assert.equal(result.status, "review_required");
    assert.equal(result.candidate?.titleMatches, false);
  }
}));

test("a weak caption needs a specific editorial review of matching cached bytes", () => temporary(async cacheDir => {
  const { fetch } = fetcher({ html: html("Figure 2: A comparison of the pipeline with baselines.") });
  const pending = await ensureResearchPaperFigure(input, { cacheDir, fetch });
  assert.equal(pending.status, "review_required");
  assert.equal(await getVerifiedResearchPaperFigure(input, { cacheDir }), null);
  const review = { sha256: pending.candidate!.figure.sha256, reviewer: "test-editor", note: "Reviewed the complete original image and caption against the exact source version." };
  await assert.rejects(approveResearchPaperFigure(input, { ...review, sha256: "a".repeat(64) }, { cacheDir }), /does not match/);
  const approved = await approveResearchPaperFigure(input, review, { cacheDir, now });
  assert.equal(approved.verificationBasis, "editorial-review");
  assert.equal(approved.figure?.verifiedAt, now.toISOString());
}));

test("general arXiv distribution permission is not silently expanded to public image reuse", () => temporary(async cacheDir => {
  const { fetch } = fetcher({ abs: abs("https://arxiv.org/licenses/nonexclusive-distrib/1.0/") });
  const pending = await ensureResearchPaperFigure(input, { cacheDir, fetch });
  assert.equal(pending.status, "review_required");
  assert.equal(pending.candidate?.licenseAllowsReuse, false);
  await assert.rejects(approveResearchPaperFigure(input, { sha256: pending.candidate!.figure.sha256, reviewer: "editor", note: "looks fine" }, { cacheDir }), /does not match/);
}));

test("restricted CC terms retain their exact name without becoming unrestricted permission", () => temporary(async cacheDir => {
  const { fetch } = fetcher({ abs: abs("https://creativecommons.org/licenses/by-nc-sa/4.0/") });
  const pending = await ensureResearchPaperFigure(input, { cacheDir, fetch });
  assert.equal(pending.status, "review_required");
  assert.equal(pending.candidate?.figure.licenseName, "CC BY-NC-SA 4.0");
  assert.equal(pending.candidate?.licenseAllowsReuse, false);
}));

test("mismatched paper titles and multi-part images cannot become automatic covers", () => temporary(async cacheDir => {
  const wrong = fetcher({ html: html().replace("<h1 class=\"ltx_title_document\">A source-bound method", "<h1 class=\"ltx_title_document\">Another paper") });
  assert.equal((await ensureResearchPaperFigure(input, { cacheDir, fetch: wrong.fetch })).status, "review_required");
  const split = fetcher({ html: html(undefined, '<img src="2610.12345v1/panel-b.png">') });
  const result = await ensureResearchPaperFigure({ ...input, itemId: "multipart" }, { cacheDir, fetch: split.fetch });
  assert.equal(result.status, "missing");
  assert.equal(split.calls.length, 2, "never crop just one panel from a multipart figure");
}));

test("unknown versions and unsafe external artwork do not trigger guesses or downloads", () => temporary(async cacheDir => {
  const { fetch, calls } = fetcher({ html: html().replace("2610.12345v1/overview.png", "https://example.org/image.png") });
  assert.equal((await ensureResearchPaperFigure({ ...input, itemId: "no-version", arxivVersion: null }, { cacheDir, fetch })).status, "missing");
  assert.equal(calls.length, 0);
  assert.equal((await ensureResearchPaperFigure(input, { cacheDir, fetch })).status, "missing");
  assert.equal(calls.length, 2);
}));

test("existing audited pilot artwork is reused only for its exact source revision", async () => {
  const existing = PAPER_FIGURES[0]!;
  const { fetch, calls } = fetcher();
  const reused = await ensureResearchPaperFigure({ itemId: existing.itemId, sourceRevision: existing.sourceRevision }, { fetch });
  assert.equal(reused.verificationBasis, "legacy-audit");
  assert.deepEqual(reused.figure, existing);
  assert.equal(calls.length, 0);
});

test("legacy solver scalability results retain source evidence but cannot become a method cover", async () => {
  const existing = PAPER_FIGURES.find(f => f.itemId === "rmujtpniv4b0wgn8q2tustjac")!;
  const { fetch, calls } = fetcher();
  const identity = { itemId: existing.itemId, sourceRevision: existing.sourceRevision };
  const result = await ensureResearchPaperFigure(identity, { fetch });
  assert.equal(result.status, "review_required");
  assert.equal(result.verificationBasis, null);
  assert.equal(await getVerifiedResearchPaperFigure(identity), null);
  assert.deepEqual(result.excludedFigure, existing);
  assert.equal(calls.length, 0);
});

test("manual HTML selection preserves a heuristic miss and stays private until exact-byte editorial approval", () => temporary(async cacheDir => {
  const source = htmlSource(), publicImageDir = path.join(cacheDir, "public");
  assert.equal(figureCaptionConfidence(trainingCaption), null, "the original training caption does not need heuristic keywords");
  const { fetch, calls } = fetcher({ html: source.html.toString() });
  const missing = await ensureResearchPaperFigure(input, { cacheDir, fetch, now });
  assert.equal(missing.status, "missing");
  const pending = await registerResearchHtmlFigureCandidate(input, source, { cacheDir, publicImageDir, fetch, now });
  assert.equal(calls.length, 2, "manual registration makes no network requests");
  assert.equal(pending.status, "review_required");
  assert.equal(pending.verificationBasis, null);
  assert.equal(pending.figure, null);
  assert.equal(await getVerifiedResearchPaperFigure(input, { cacheDir }), null);
  const candidate = pending.candidate!;
  assert.equal(candidate.confidence, "medium");
  assert.equal(candidate.figure.imageOrigin, "remote");
  assert.equal(candidate.figure.imageUrl, source.imageUrl);
  assert.equal(candidate.figure.sourceUrl, "https://arxiv.org/html/2610.12345v1#S2.F2");
  assert.equal(candidate.figure.caption, trainingCaption.replace(": ", ":"));
  assert.equal(candidate.licenseAllowsReuse, true);
  assert.equal(candidate.titleMatches, true);
  assert.deepEqual(await readFile(path.join(cacheDir, "images", candidate.figure.sha256)), png);
  assert.deepEqual(await readFile(path.join(cacheDir, "sources", `${candidate.htmlSha256}.html`)), source.html);
  assert.deepEqual(await readFile(path.join(cacheDir, "sources", `${candidate.abstractSha256}.abs.html`)), source.abstractHtml);
  const files = await readdir(path.join(cacheDir, "sources"));
  const prior = JSON.parse(await readFile(path.join(cacheDir, "sources", files.find(f => f.endsWith(".prior.json"))!), "utf8"));
  assert.deepEqual(prior, missing);
  await assert.rejects(readdir(publicImageDir), { code: "ENOENT" });
  const review = { sha256: candidate.figure.sha256, reviewer: "test-editor", note: "Inspected the complete teacher-forcing and rollout panels against the exact original HTML image." };
  await assert.rejects(approveResearchPaperFigure(input, { ...review, sha256: "a".repeat(64) }, { cacheDir }), /does not match/);
  const approved = await approveResearchPaperFigure(input, review, { cacheDir, publicImageDir, now });
  assert.equal(approved.verificationBasis, "editorial-review");
  assert.equal(approved.figure?.imageUrl, source.imageUrl);
  assert.deepEqual(publicPaperFigure(approved.figure, input.itemId, input.sourceRevision), approved.figure);
  await assert.rejects(readdir(publicImageDir), { code: "ENOENT" }, "remote approval does not publish a copied image");
  await assert.rejects(registerResearchHtmlFigureCandidate(input, source, { cacheDir }), /already verified/);
}));

test("manual HTML images must match the exact selected official version URL", () => temporary(async cacheDir => {
  const source = htmlSource();
  for (const imageUrl of [
    "https://arxiv.org/html/2610.12345v1/another-figure.png",
    "https://arxiv.org/html/2610.12345v2/overview.png",
    "https://example.org/overview.png",
    "https://arxiv.org/html/2610.12345v1/overview.png?version=2",
  ]) await assert.rejects(registerResearchHtmlFigureCandidate(input, { ...source, imageUrl }, { cacheDir }), /image URL|official arXiv version/);
  await assert.rejects(registerResearchHtmlFigureCandidate(input, { ...source,
    html: Buffer.from(source.html.toString().replace("2610.12345v1/overview.png", "2610.12345v2/overview.png")),
    imageUrl: "https://arxiv.org/html/2610.12345v2/overview.png" }, { cacheDir }), /official arXiv version/);
  await assert.rejects(registerResearchHtmlFigureCandidate(input, { ...source,
    html: Buffer.from('<base href="https://example.org/">' + source.html.toString()) }, { cacheDir }), /official arXiv version/);
  assert.deepEqual(await readdir(cacheDir), []);
}));

test("manual HTML selection rejects partial, nested, responsive, and ambiguous figures", () => temporary(async cacheDir => {
  const source = htmlSource();
  for (const markup of [
    html(trainingCaption, '<img src="2610.12345v1/panel-b.png">'),
    html(trainingCaption, '<svg width="640" height="320"></svg>'),
    html(trainingCaption, '<figure><figcaption>Nested panel</figcaption></figure>'),
    html(trainingCaption).replace('<img src=', '<img srcset="2610.12345v1/another.png 2x" src='),
    html(trainingCaption) + html(trainingCaption),
    html(trainingCaption).replace("<figcaption>", "<div>").replace("</figcaption>", "</div>"),
  ]) await assert.rejects(registerResearchHtmlFigureCandidate(input, { ...source, html: Buffer.from(markup) }, { cacheDir }), /one complete image/);
  assert.deepEqual(await readdir(cacheDir), []);
}));

test("manual HTML selection cannot change source identity, title, or an existing cache binding", () => temporary(async cacheDir => {
  const source = htmlSource();
  await assert.rejects(registerResearchHtmlFigureCandidate({ ...input, title: "A different paper" }, source, { cacheDir }), /identity or title/);
  await assert.rejects(registerResearchHtmlFigureCandidate(input, { ...source,
    html: Buffer.from(source.html.toString().replace("A source-bound method", "A different paper")) }, { cacheDir }), /identity or title/);
  for (const abstractHtml of [abs().replace('content="2610.12345"', 'content="2610.99999"'),
    abs().replace('content="2610.12345"', 'content="2610.12345v2"'),
    abs().replace("A source-bound method", "A different paper"),
    abs() + '<meta name="citation_arxiv_id" content="2610.99999">',
  ]) await assert.rejects(registerResearchHtmlFigureCandidate(input, { ...source, abstractHtml: Buffer.from(abstractHtml) }, { cacheDir }), /identity or title/);
  const { fetch } = fetcher({ status: 503 });
  await ensureResearchPaperFigure(input, { cacheDir, fetch });
  const file = path.join(cacheDir, `${input.itemId}-r${input.sourceRevision}.json`), before = await readFile(file);
  await assert.rejects(registerResearchHtmlFigureCandidate({ ...input, arxivVersion: "v2" }, source, { cacheDir }), /input changed/);
  assert.deepEqual(await readFile(file), before, "a differently bound failed record is not overwritten");
  await assert.rejects(readdir(path.join(cacheDir, "sources")), { code: "ENOENT" });
}));

test("manual HTML registration cannot expand restricted, missing, or ambiguous reuse permission", () => temporary(async cacheDir => {
  const source = htmlSource();
  for (const abstractHtml of [
    abs("https://arxiv.org/licenses/nonexclusive-distrib/1.0/"),
    abs("https://creativecommons.org/licenses/by-nc-sa/4.0/"),
    abs("https://creativecommons.org/licenses/by-nd/4.0/"),
    abs().replace(/<div class="abs-license">.*<\/div>/, ""),
    abs() + '<div class="abs-license"><a href="https://arxiv.org/licenses/nonexclusive-distrib/1.0/">License</a></div>',
  ]) await assert.rejects(registerResearchHtmlFigureCandidate(input, { ...source, abstractHtml: Buffer.from(abstractHtml) }, { cacheDir }), /reusable image permission/);
  assert.equal(await getVerifiedResearchPaperFigure(input, { cacheDir }), null);
  assert.deepEqual(await readdir(cacheDir), []);
}));

test("manual HTML SVG objects resolve a version-bound base and still require decoded safe bytes", () => temporary(async cacheDir => {
  const source = htmlSource(), imageUrl = "https://arxiv.org/html/2610.12345v1/figure.svg";
  const markup = '<base href="https://arxiv.org/html/2610.12345v1/">' + html(trainingCaption).replace('<img src="2610.12345v1/overview.png">', '<object type="image/svg+xml" data="figure.svg"></object>');
  const image = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><rect width="640" height="320" fill="white"/></svg>');
  const objectSource = { ...source, html: Buffer.from(markup), imageUrl, image };
  await assert.rejects(registerResearchHtmlFigureCandidate(input, { ...source, image: png.subarray(0, 40) }, { cacheDir }));
  await assert.rejects(registerResearchHtmlFigureCandidate(input, { ...objectSource, image: png }, { cacheDir }), /declared image type/);
  await assert.rejects(registerResearchHtmlFigureCandidate(input, { ...objectSource,
    image: Buffer.from(image.toString().replace("</svg>", "<script>alert(1)</script></svg>")) }, { cacheDir }), /active/);
  const pending = await registerResearchHtmlFigureCandidate(input, objectSource, { cacheDir });
  assert.equal(pending.status, "review_required");
  assert.equal(pending.candidate?.figure.contentType, "image/svg+xml");
  assert.equal(pending.candidate?.figure.imageUrl, imageUrl);
}));

test("a complete PDF extraction preserves its source and prior gap, then publishes only after exact-byte approval", () => temporary(async cacheDir => {
  const publicImageDir = path.join(cacheDir, "public");
  const split = fetcher({ html: html(undefined, '<img src="2610.12345v1/panel-b.png">') });
  assert.equal((await ensureResearchPaperFigure(input, { cacheDir, fetch: split.fetch })).status, "missing");
  const source = { abstractHtml: Buffer.from(abs()), html: Buffer.from(html()), pdf: Buffer.from("%PDF-1.7\nsource fixture"), png,
    figureId: "S2.F2", pageNumber: 3, bounds: [20, 30, 420, 230] as [number, number, number, number], dpi: 150 };
  const pending = await registerResearchPdfFigureCandidate(input, source, { cacheDir, publicImageDir, now });
  assert.equal(pending.status, "review_required");
  assert.equal(await getVerifiedResearchPaperFigure(input, { cacheDir }), null);
  await assert.rejects(readdir(publicImageDir), { code: "ENOENT" });
  const candidate = pending.candidate!;
  assert.equal(candidate.figure.imageOrigin, "pdf-extract");
  assert.equal(candidate.figure.sourceUrl, "https://arxiv.org/pdf/2610.12345v1#page=3");
  assert.deepEqual(candidate.pdfExtraction?.bounds, source.bounds);
  const files = await readdir(path.join(cacheDir, "sources"));
  const prior = JSON.parse(await readFile(path.join(cacheDir, "sources", files.find(f => f.endsWith(".prior.json"))!), "utf8"));
  assert.equal(prior.status, "missing");
  assert.deepEqual(await readFile(path.join(cacheDir, "sources", `${candidate.pdfExtraction!.pdfSha256}.pdf`)), source.pdf);
  const approved = await approveResearchPaperFigure(input, { sha256: candidate.figure.sha256, reviewer: "test-editor", note: "Inspected both intact panels on the PDF page and the complete crop." }, { cacheDir, publicImageDir, now });
  assert.deepEqual(await readFile(path.join(publicImageDir, path.basename(approved.figure!.imageUrl))), png);
  assert.deepEqual(publicPaperFigure(approved.figure, input.itemId, input.sourceRevision), approved.figure);
  await assert.rejects(registerResearchPdfFigureCandidate(input, source, { cacheDir }), /already verified/);
}));

test("PDF extraction cannot grant missing reuse permission or cross a title or crop boundary", () => temporary(async cacheDir => {
  const source = { abstractHtml: Buffer.from(abs("https://arxiv.org/licenses/nonexclusive-distrib/1.0/")), html: Buffer.from(html()),
    pdf: Buffer.from("%PDF-1.7\nsource fixture"), png, figureId: "S2.F2", pageNumber: 3, bounds: [20, 30, 420, 230] as [number, number, number, number], dpi: 150 };
  await assert.rejects(registerResearchPdfFigureCandidate({ ...input, title: "Different paper" }, source, { cacheDir }), /identity, title/);
  await assert.rejects(registerResearchPdfFigureCandidate(input, { ...source, bounds: [20, 30, 10, 230] }, { cacheDir }), /bounds/);
  const pending = await registerResearchPdfFigureCandidate(input, source, { cacheDir });
  await assert.rejects(approveResearchPaperFigure(input, { sha256: pending.candidate!.figure.sha256, reviewer: "editor", note: "looks fine" }, { cacheDir }), /does not match/);
}));

test("caption ranking rejects experimental-result overviews and unsafe or truncated images", async () => {
  assert.equal(figureCaptionConfidence("Figure 1: Overview of experimental results.")?.confidence, "medium");
  assert.equal(figureCaptionConfidence("Figure 1: Our proposed architecture." )?.confidence, "high");
  assert.equal(figureCaptionConfidence("Figure 1: Pipeline ablations." )?.confidence, "medium");
  await assert.rejects(inspectFigureBytes(Buffer.from('<svg width="640" height="320"><script>alert(1)</script></svg>')), /active/);
  await assert.rejects(inspectFigureBytes(png.subarray(0, 40)));
});
