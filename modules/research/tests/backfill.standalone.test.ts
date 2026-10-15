// The past-week listing and the arXiv API answer, on fixed fixtures.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseApi, parsePastWeek } from "../backfill.ts";

test("the past-week listing gives each announcement day's new submissions, without cross-lists", () => {
  const html = `<div id="dlpage"><h3>Mon, 12 Oct 2026 (showing 2 of 2 entries )</h3><dl>
    <dt><a href ="/abs/2610.00002">arXiv:2610.00002</a></dt><dd></dd>
    <dt><a href ="/abs/2610.00009">arXiv:2610.00009</a> (cross-list from stat.ML)</dt><dd></dd></dl>
    <h3>Fri, 9 Oct 2026 (showing 1 of 1 entries )</h3><dl><dt><a href ="/abs/2610.00001">arXiv:2610.00001</a></dt><dd></dd></dl></div>`;
  assert.deepEqual([...parsePastWeek(html)], [["2026-10-12", ["2610.00002"]], ["2026-10-09", ["2610.00001"]]]);
});

test("the API answer gives title, authors, abstract and categories", () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2610.00001v1</id><title>A  Paper</title>
    <summary> An abstract &amp; more. </summary><author><name>Ada</name></author><author><name>Bob</name></author>
    <category term="cs.LG"/><category term="cs.AI"/></entry></feed>`;
  const [p] = parseApi(xml);
  assert.deepEqual([p!.id, p!.title, p!.authors, p!.abstractText, p!.categories], ["2610.00001", "A Paper", "Ada, Bob", "An abstract & more.", ["cs.LG", "cs.AI"]]);
});
