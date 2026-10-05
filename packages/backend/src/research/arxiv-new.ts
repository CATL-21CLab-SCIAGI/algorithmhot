import { load } from "cheerio";
import { isValidDate } from "@aihot/contracts/time";
import { sanitizeBody } from "../content/sanitize.ts";
import { collapseWhitespace } from "../lib/text.ts";
import { makeResearchMetadata, parseArxivIdentity, researchLinks } from "../sources/research.ts";
import type { Candidate, SourceRow } from "../sources/types.ts";

export interface ArxivNewPage {
  day: string;
  total: number;
  nextOffset: number | null;
  candidates: Candidate[];
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Parse only the official batch page's explicit per-paper abstracts; never infer source dates. */
export function parseArxivNewPage(html: string, url: string, source: SourceRow, observedAt: Date): ArxivNewPage {
  if (!Number.isFinite(observedAt.getTime())) throw new Error("Invalid announcement observation time");
  const base = new URL(url);
  if (base.protocol !== "https:" || !/^(?:www\.)?arxiv\.org$/.test(base.hostname) || !/^\/list\/[^/]+\/new\/?$/.test(base.pathname)) throw new Error("Expected an official arXiv new-listing URL");
  const offsetText = base.searchParams.get("skip") ?? "0";
  if (!/^\d+$/.test(offsetText) || !Number.isSafeInteger(Number(offsetText))) throw new Error("Invalid arXiv listing offset");
  const offset = Number(offsetText);
  const $ = load(html), content = $("#dlpage");
  if (content.length !== 1) throw new Error("Missing unique arXiv new-listing container");
  const headings = content.find("h3").map((_, node) => collapseWhitespace($(node).text())).get()
    .filter(text => text.startsWith("Showing new listings for "));
  if (headings.length !== 1) throw new Error("Missing unique arXiv announcement day");
  const match = /^Showing new listings for (Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{1,2}) ([A-Z][a-z]+) (\d{4})$/.exec(headings[0]!);
  const month = match ? MONTHS.indexOf(match[3]!) : -1;
  const day = match ? `${match[4]}-${String(month + 1).padStart(2, "0")}-${match[2]!.padStart(2, "0")}` : "";
  if (!match || month < 0 || !isValidDate(day) || WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()] !== match[1]) throw new Error("Invalid arXiv announcement day heading");
  const totalMatch = /Total of\s+([\d,]+)\s+entries/i.exec(content.text());
  const total = totalMatch ? Number(totalMatch[1]!.replaceAll(",", "")) : NaN;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("Missing arXiv listing denominator");
  const entries = content.find("dt").toArray();
  if (total > offset && !entries.length) throw new Error("Nonempty arXiv new-listing page parsed as empty");
  if (entries.length && offset + entries.length > total) throw new Error("ArXiv listing entries exceed their denominator");

  const candidates = entries.map((node, index): Candidate => {
    const dt = $(node), dd = dt.next();
    if (!dd.is("dd")) throw new Error("ArXiv identity is missing its adjacent description");
    const href = dt.find('a[href^="/abs/"]').first().attr("href");
    const identity = href ? parseArxivIdentity(new URL(href, base).href) : null;
    if (!identity) throw new Error("Invalid arXiv listing identity");
    const titleNode = dd.find(".list-title");
    if (titleNode.length !== 1) throw new Error("Missing unique arXiv paper title");
    const titleCopy = titleNode.clone(); titleCopy.find(".descriptor").remove();
    const title = collapseWhitespace(titleCopy.text());
    if (!title) throw new Error("Empty arXiv paper title");
    const authorCopy = dd.find(".list-authors").first().clone(); authorCopy.find(".descriptor").remove();
    const author = collapseWhitespace(authorCopy.text()) || null;
    const abstracts = dd.find("p.mathjax");
    if (!abstracts.length) throw new Error(`Missing explicit arXiv abstract for ${identity.id}`);
    const abstractHtml = abstracts.map((_, paragraph) => $.html(paragraph)).get().join("\n");
    const bodyHtml = sanitizeBody(abstractHtml, base.href);
    const bodyText = collapseWhitespace(load(bodyHtml, null, false).text());
    if (!bodyText || bodyText === title) throw new Error(`Empty or title-only arXiv abstract for ${identity.id}`);
    const paperUrl = `${identity.canonicalUrl}${identity.version ?? ""}`;
    const categories = [...dd.find(".list-subjects").text().matchAll(/\(([A-Za-z][\w.-]*)\)/g)].map(m => m[1]!);
    return {
      identityKey: identity.canonicalKey, url: paperUrl, title, author,
      // The announcement heading does not establish submission or revision time.
      publishedAt: null, sourceUpdatedAt: null,
      bodyHtml, bodyText, excerpt: bodyText, bodyStatus: "ok", media: [], categories,
      research: makeResearchMetadata({ identity, announcedOn: day, originalPublishedAt: null, revisedAt: null, observedAt,
        evidenceBasis: "abstract", signalOnly: source.participation_mode !== "editorial",
        links: researchLinks(base.href, [{ kind: "paper", url: paperUrl }], abstractHtml) }),
      raw: { kind: "arxiv-new-listing", sourceId: source.id, sourceUrl: base.href, entryOffset: offset + index,
        arxivId: identity.id, announcedOn: day, entryHtml: $.html(node) + $.html(dd) },
    };
  });
  return { day, total, nextOffset: offset + entries.length < total ? offset + entries.length : null, candidates };
}
