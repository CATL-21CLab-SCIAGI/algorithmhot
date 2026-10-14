// Figure lookups on fixed pages (no network, no database): only reusable licences get a figure.
import assert from "node:assert/strict";
import { test } from "node:test";
import { arxivLicense, figureNote, firstArxivFigure, lookFor, pageImage, reusable } from "../figures.ts";

const abs = (license: string) => `<html><body><div class="abs-license"><a href="${license}" title="Rights to this article" class="has_license">licence</a></div></body></html>`;
const htmlPaper = `<html><body>
  <figure id="alg1" class="ltx_float ltx_float_algorithm"><div>Algorithm 1</div></figure>
  <figure id="S0.F0" class="ltx_figure"><img src="2610.13737v1/icon.png" width="40" height="40" alt=""></figure>
  <figure id="S0.F1" class="ltx_figure"><img src="2610.13737v1/overview.png" width="469" height="196" alt="Refer to caption">
    <figcaption class="ltx_caption"><span class="ltx_tag ltx_tag_figure">Figure 1: </span>Overview of the method.</figcaption></figure>
</body></html>`;

test("licences: CC BY, CC BY-SA and CC0 allow reuse; non-commercial, no-derivatives and arXiv's own do not", () => {
  for (const ok of ["http://creativecommons.org/licenses/by/4.0/", "https://creativecommons.org/licenses/by-sa/4.0/", "http://creativecommons.org/publicdomain/zero/1.0/"]) assert.ok(reusable(ok), ok);
  for (const no of ["http://creativecommons.org/licenses/by-nc/4.0/", "http://creativecommons.org/licenses/by-nd/4.0/", "http://arxiv.org/licenses/nonexclusive-distrib/1.0/", null]) assert.equal(reusable(no), false, String(no));
});

test("the arXiv abstract page gives the licence; the HTML version its first real figure, resolved against the page", () => {
  assert.equal(arxivLicense(abs("http://creativecommons.org/licenses/by/4.0/")), "http://creativecommons.org/licenses/by/4.0/");
  assert.deepEqual(firstArxivFigure(htmlPaper, "https://arxiv.org/html/2610.13737"), { url: "https://arxiv.org/html/2610.13737v1/overview.png", caption: "Overview of the method." });
  assert.equal(firstArxivFigure("<html><body><p>no figures</p></body></html>", "https://arxiv.org/html/x"), null);
});

test("a publisher page's announced image is used unless it is a logo or cover", () => {
  assert.equal(pageImage('<meta property="og:image" content="/fig/1.png">', "https://www.nature.com/articles/x"), "https://www.nature.com/fig/1.png");
  assert.equal(pageImage('<meta property="og:image" content="https://pubs.acs.org/cover/jacs.jpg">', "https://pubs.acs.org/doi/x"), null);
});

test("lookups: an arXiv paper under arXiv's own licence keeps 待补 and says why; a CC BY one gets its figure and credit", async () => {
  const fetchers = (license: string) => ({
    arxiv: async (url: string) => ({ text: url.includes("/abs/") ? abs(license) : htmlPaper, url: url.includes("/abs/") ? url : `${url}v1` }),
    page: async () => null,
  });
  const closed = await lookFor({ id: "a", raw: { kind: "arxiv", arxivId: "2610.13737" } }, fetchers("http://arxiv.org/licenses/nonexclusive-distrib/1.0/"));
  assert.equal(closed.status, "license");
  assert.deepEqual(figureNote({ ...closed, checkedAt: "", attempts: 1 } as never), { label: "配图", value: "待补（许可不允许转载）" });
  const open = await lookFor({ id: "b", raw: { kind: "arxiv", arxivId: "2610.13737" } }, fetchers("http://creativecommons.org/licenses/by/4.0/"));
  assert.equal(open.status, "ok");
  if (open.status !== "ok") return;
  assert.equal(open.url, "https://arxiv.org/html/2610.13737v1/overview.png");
  assert.equal(open.credit, "arXiv:2610.13737 图 1 · CC BY 4.0");
  // A journal article without an open licence is not even fetched.
  let fetched = false;
  const journal = await lookFor({ id: "c", raw: { kind: "crossref", doi: "10.1/x", license: null } }, { arxiv: async () => null, page: async () => { fetched = true; return null; } });
  assert.deepEqual([journal.status, fetched], ["license", false]);
});
