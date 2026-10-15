// arXiv's announcement, read from each category's "new submissions" listing (https://arxiv.org/list/<cat>/new).
// The listing changes at the announcement (20:00 US Eastern, 08:00 Beijing in summer); arXiv's RSS changes
// only at midnight Eastern, hours after, so the listing is what lets a morning's announcement reach that
// morning's issue. Only the "New submissions" section is read: cross-lists and replacements are older papers.
import { load } from "cheerio";
import { isValidDate } from "@aihot/contracts/time";
import type { ItemNote } from "@aihot/contracts/site";
import { sanitizeBody } from "@aihot/backend/content/sanitize";
import { collapseWhitespace } from "@aihot/backend/lib/text";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The site's rule for arXiv: a paper goes online at 08:00 Beijing on the day arXiv announces it. */
export const ARXIV_ONLINE_TIME = "08:00";

export interface ArxivPaper {
  id: string;
  title: string;
  authors: string | null;
  abstractHtml: string;
  abstractText: string;
  categories: string[];
}

export interface ArxivListing {
  /** The announcement day the listing names (YYYY-MM-DD). */
  day: string;
  /** Entries in the whole listing, every section. */
  total: number;
  papers: ArxivPaper[];
}

export const listingUrl = (category: string) => `https://arxiv.org/list/${encodeURIComponent(category)}/new?skip=0&show=2000`;

/** One category's listing page. Throws on a page that is not a listing, so a changed layout fails the run instead of reading nothing. */
export function parseListing(html: string): ArxivListing {
  const $ = load(html);
  const content = $("#dlpage");
  if (content.length !== 1) throw new Error("not an arXiv listing: no #dlpage");
  const heading = content.find("h3").map((_, n) => collapseWhitespace($(n).text())).get().find((t) => t.startsWith("Showing new listings for "));
  const m = heading && /^Showing new listings for (\w+), (\d{1,2}) ([A-Z][a-z]+) (\d{4})$/.exec(heading);
  const month = m ? MONTHS.indexOf(m[3]!) : -1;
  const day = m ? `${m[4]}-${String(month + 1).padStart(2, "0")}-${m[2]!.padStart(2, "0")}` : "";
  if (!m || month < 0 || !isValidDate(day) || WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()] !== m[1]) throw new Error(`arXiv listing has no announcement day: ${heading ?? "none"}`);
  // A day without new papers in this category says so instead of giving a count.
  if (/No updates today/i.test(content.text()) && !content.find("dt").length) return { day, total: 0, papers: [] };
  const total = Number(/Total of\s+([\d,]+)\s+entries/i.exec(content.text())?.[1]?.replaceAll(",", "") ?? NaN);
  if (!Number.isSafeInteger(total)) throw new Error("arXiv listing has no entry count");

  const papers: ArxivPaper[] = [];
  let section = "";
  for (const node of content.find("h3,dt").toArray()) {
    if (node.tagName === "h3") {
      section = collapseWhitespace($(node).text());
      continue;
    }
    if (!/^New submissions\b/.test(section)) continue;
    const dt = $(node);
    const dd = dt.next("dd");
    if (/cross-list|replaced/i.test(dt.text())) continue;
    const href = dt.find('a[href^="/abs/"]').first().attr("href") ?? "";
    const id = /^\/abs\/(\d{4}\.\d{4,5})(?:v\d+)?$/.exec(href)?.[1];
    if (!id || !dd.length) throw new Error(`arXiv listing entry without an identifier: ${href || dt.text().slice(0, 80)}`);
    const title = dd.find(".list-title").first().clone();
    title.find(".descriptor").remove();
    const authors = dd.find(".list-authors").first().clone();
    authors.find(".descriptor").remove();
    const abstractHtml = sanitizeBody(dd.find("p.mathjax").map((_, p) => $.html(p)).get().join("\n"), "https://arxiv.org/");
    const abstractText = collapseWhitespace(load(abstractHtml, null, false).text());
    const paper: ArxivPaper = {
      id,
      title: collapseWhitespace(title.text()),
      authors: collapseWhitespace(authors.text()) || null,
      abstractHtml,
      abstractText,
      categories: [...dd.find(".list-subjects").text().matchAll(/\(([a-z-]+(?:\.[A-Za-z-]+)?)\)/g)].map((x) => x[1]!),
    };
    // A listing entry without its abstract is skipped; the engine would only have the title to judge.
    if (paper.title && paper.abstractText && paper.abstractText !== paper.title) papers.push(paper);
  }
  return { day, total, papers };
}

/** What a reader sees beside an arXiv paper. */
export function arxivNotes(paper: ArxivPaper, day: string): ItemNote[] {
  return [
    { label: "arXiv", value: paper.id, href: `https://arxiv.org/abs/${paper.id}` },
    { label: "公告", value: day },
    { label: "全文", value: "PDF", href: `https://arxiv.org/pdf/${paper.id}` },
    { label: "配图", value: "待补" },
  ];
}
