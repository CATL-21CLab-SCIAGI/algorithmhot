import { test } from "node:test";
import assert from "node:assert/strict";
import { publicPaperFigure } from "@aihot/contracts/paper-figure";
import { PAPER_FIGURES } from "@aihot/industry/paper-figures";
import { sanitizeCitation, sanitizeReport } from "../scripts/static-site/model.ts";
import { assertPaperFigureBindings, assertPaperFigureMarkup, paperFiguresForRoute } from "../scripts/pages-publisher.ts";
import { load } from "cheerio";

const figure = PAPER_FIGURES[0]!;
test("original cover whitelist requires the cited paper and exact brief revision", () => {
  assert.deepEqual(publicPaperFigure({ ...figure, privateReview: "/private/receipt" }, figure.itemId, figure.sourceRevision), figure);
  assert.equal(publicPaperFigure(figure, "other-paper", figure.sourceRevision), null);
  assert.equal(publicPaperFigure(figure, figure.itemId, figure.sourceRevision + 1), null);
  assert.equal(publicPaperFigure({ ...figure, imageOrigin: "remote", imageUrl: "http://localhost/a.png" }, figure.itemId, figure.sourceRevision), null);
  const citation = { itemId: figure.itemId, available: true, researchBrief: { sourceRevision: figure.sourceRevision }, paperFigure: figure };
  assert.deepEqual(sanitizeCitation(citation).paperFigure, figure);
  assert.equal(sanitizeCitation({ ...citation, available: false }).paperFigure, null);
});

test("weekly and monthly exports retain frozen original covers and route ownership", () => {
  for (const kind of ["daily", "weekly", "monthly"] as const) {
    const key = kind === "weekly" ? "2026-W40" : kind === "monthly" ? "2026-09" : "2026-10-04";
    const report = sanitizeReport({ kind, key, sections: [{ label: "研究", items: [{ itemId: figure.itemId, available: true, researchBrief: { sourceRevision: figure.sourceRevision }, paperFigure: figure }] }] });
    assert.deepEqual(report.sections[0]!.items[0]!.paperFigure, figure);
    assert.deepEqual(paperFiguresForRoute([figure], { reports: [report] }, `/${kind}/${key}`), [figure]);
    assert.deepEqual(paperFiguresForRoute([figure], { reports: [report] }, `/${kind}/1900-01`), []);
  }
});

test("illustrated exports fail if an included paper loses its cover or the registry changes", () => {
  const raw = { kind: "weekly", key: "2026-W40", illustrated: true, sections: [{ label: "研究", items: [{ itemId: figure.itemId, available: true, researchBrief: { sourceRevision: figure.sourceRevision }, paperFigure: figure }] }] };
  const report = sanitizeReport(raw), snapshot = { items: [{ id: figure.itemId }], reports: [report] };
  assert.doesNotThrow(() => assertPaperFigureBindings([figure], snapshot));
  assert.throws(() => assertPaperFigureBindings([], snapshot), /differs from/);
  assert.throws(() => assertPaperFigureBindings([{ ...figure, caption: "different" }], snapshot), /differs from/);
  assert.throws(() => sanitizeReport({ ...raw, sections: [{ items: [{ itemId: figure.itemId, available: true }] }] }), /without a verified original figure/);
  assert.throws(() => assertPaperFigureMarkup(load("<article>No cover</article>"), [figure], "https://pkucy2016.github.io/algorithmhot/", true), /missing a required/);
});
