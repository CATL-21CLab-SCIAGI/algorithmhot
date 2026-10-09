import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { researchUtcDays, hfPageDecision, hfDateNotYetAvailable, responseRecordCount, researchResponsePath, saveResearchResponse, researchReparseMode } from "@aihot/backend/research/collect-utils";

test("HF deferral requires its exact date upper-bound error and a valid observed UTC date", () => {
  const body = JSON.stringify({ error: '✖ "date" must be less than or equal to "2026-10-05T00:00:00.000Z"\n  → at date' });
  const input = { status: 400, url: "https://huggingface.co/api/daily_papers?date=2026-10-06&limit=100&p=0", body, observedAt: new Date("2026-10-06T08:00:00+08:00") };
  assert.equal(hfDateNotYetAvailable(input), true);
  for (const status of [200, 401, 403, 404, 429, 500, 503]) assert.equal(hfDateNotYetAvailable({ ...input, status }), false);
  for (const badBody of ["", "null", "[]", "{", '<html>not available</html>', JSON.stringify({ error: "Date not available" }), JSON.stringify({ message: JSON.parse(body).error }), JSON.stringify({ error: `${JSON.parse(body).error}\n  → at token` }), body.replace("2026-10-05", "2026-02-30"), body.replace("00:00:00.000Z", "12:00:00.000Z")]) {
    assert.equal(hfDateNotYetAvailable({ ...input, body: badBody }), false, badBody);
  }
  for (const url of [input.url.replace("https:", "http:"), input.url.replace("huggingface.co/", "huggingface.co.example/"), input.url.replace("/api/daily_papers", "/api/models"), input.url.replace("huggingface.co", "user:password@huggingface.co"), `${input.url}&date=2026-10-06`, input.url.replace("2026-10-06", "2026-02-30"), input.url.replace("2026-10-06", "2026-10-05"), input.url.replace("2026-10-06", "2026-10-04"), input.url.replace("2026-10-06", "2026-10-07")]) {
    assert.equal(hfDateNotYetAvailable({ ...input, url }), false, url);
  }
  assert.equal(hfDateNotYetAvailable({ ...input, observedAt: new Date("2026-10-06T07:59:59+08:00") }), false, "Beijing's new day does not open a future UTC partition");
  assert.equal(hfDateNotYetAvailable({ ...input, observedAt: new Date("invalid") }), false);
});

test("HF dates partition the exact UTC window and exclude an end at midnight", () => {
  assert.deepEqual(researchUtcDays(new Date("2026-09-30T23:59:59Z"), new Date("2026-10-02T00:00:00Z")), ["2026-09-30", "2026-10-01"]);
  assert.deepEqual(researchUtcDays(new Date("2026-09-30T23:59:59Z"), new Date("2026-10-02T00:00:00.001Z")), ["2026-09-30", "2026-10-01", "2026-10-02"]);
  const days = researchUtcDays(new Date("2026-09-26T06:00Z"), new Date("2026-10-03T06:00Z"));
  assert.equal(days.length, 8);
  assert.equal(days[0], "2026-09-26");
  assert.equal(days.at(-1), "2026-10-03");
  assert.throws(() => researchUtcDays(new Date("invalid"), new Date()), /invalid/);
});

test("HF follows a next link after a short page and only reports actual pagination truncation", () => {
  assert.deepEqual(hfPageDecision({ page: 0, returned: 84, hasNext: true, repeated: false }), { stop: false, truncated: false });
  assert.deepEqual(hfPageDecision({ page: 1, returned: 0, hasNext: false, repeated: false }), { stop: true, truncated: false });
  assert.deepEqual(hfPageDecision({ page: 1, returned: 84, hasNext: true, repeated: true }), { stop: true, truncated: true });
  assert.deepEqual(hfPageDecision({ page: 9, returned: 2, hasNext: true, repeated: false }), { stop: true, truncated: true });
  assert.deepEqual(hfPageDecision({ page: 9, returned: 2, hasNext: false, repeated: false }), { stop: true, truncated: false });
  assert.deepEqual(hfPageDecision({ page: 9, returned: 0, hasNext: true, repeated: true }), { stop: true, truncated: false });
});

test("raw record denominators include unmappable records before candidate normalization", () => {
  assert.equal(responseRecordCount('[{"paper":{"id":"2609.12345"}},{"broken":true}]', 'json_list'), 2);
  assert.equal(responseRecordCount('<feed><entry><title>No URL</title></entry></feed>', 'rss'), 1);
  assert.equal(responseRecordCount('<rss><channel><item/><item/></channel></rss>', 'rss'), 2);
  assert.equal(responseRecordCount('<rss><channel/></rss>', 'rss'), 0);
  assert.throws(() => responseRecordCount('{}', 'json_list'), /array/);
});

test("every reserved response has an immutable distinct file even after a reused attempt label", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'algorithmhot-response-test-'));
  try {
    const first = researchResponsePath(folder, 'source-0-attempt-1');
    const resumed = researchResponsePath(folder, 'source-0-attempt-1');
    assert.notEqual(first, resumed);
    const body = Buffer.from('[{"first":true}]');
    const hash = await saveResearchResponse(first, body, { status: 200, returned: 1 });
    await assert.rejects(saveResearchResponse(first, Buffer.from('replacement'), { status: 200 }), { code: 'EEXIST' });
    await saveResearchResponse(resumed, Buffer.from('[]'), { status: 200 });
    assert.deepEqual(await readFile(first), body);
    const metadata = JSON.parse(await readFile(`${first}.json`, 'utf8'));
    assert.equal(metadata.sha256, createHash('sha256').update(body).digest('hex'));
    assert.equal(hash, metadata.sha256);
    assert.equal(metadata.bytes, body.length);
    assert.equal((await readFile(resumed)).toString(), '[]');
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("a frozen batch only allows explicit HF metadata repair", () => {
  assert.equal(researchReparseMode(false, undefined, false), 'all');
  assert.equal(researchReparseMode(true, 'huggingface', true), 'hf_metadata');
  assert.equal(researchReparseMode(true, undefined, false, true), 'links_only');
  assert.equal(researchReparseMode(true, 'arxiv', true, true), 'links_only');
  assert.throws(() => researchReparseMode(true, 'huggingface', false), /Frozen/);
  assert.throws(() => researchReparseMode(true, 'arxiv', true), /Frozen/);
  assert.throws(() => researchReparseMode(true, undefined, false), /Frozen/);
});
