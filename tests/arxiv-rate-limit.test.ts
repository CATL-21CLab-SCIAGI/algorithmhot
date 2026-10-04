import assert from "node:assert/strict";
import { test } from "node:test";
import { createArxivRequestLimiter, isArxivRequest } from "@aihot/backend/lib/arxiv-rate-limit";

test("arXiv host recognition excludes unrelated and suffix-spoofed URLs", () => {
  for (const url of ["https://rss.arxiv.org/rss/cs.AI", "https://export.arxiv.org/api/query", "https://arxiv.org/abs/2609.12345"]) assert.equal(isArxivRequest(url), true);
  for (const url of ["https://example.org/arxiv.org", "https://arxiv.org.evil.test/", "invalid"]) assert.equal(isArxivRequest(url), false);
});

test("RSS and metadata requests share serialized starts; failures keep their gap and long requests do not double-wait", async () => {
  let now = 0, lastStartedAt: number | null = null;
  const waits: number[] = [], starts: number[] = [];
  const limit = createArxivRequestLimiter(async operation => operation({
    lastStartedAt, markStarted: async at => { lastStartedAt = at; starts.push(at); },
  }), { now: () => now, sleep: async ms => { waits.push(ms); now += ms; } });
  let release!: () => void;
  let entered!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const first = limit("https://rss.arxiv.org/rss/cs.AI", async () => { entered(); await held; return "rss"; });
  await began;
  let secondStarted = false;
  const second = limit("https://export.arxiv.org/api/query", async () => { secondStarted = true; now += 5000; throw new Error("source failed"); });
  const failed = assert.rejects(second, /source failed/);
  assert.equal(secondStarted, false, "a second request cannot overlap a held response body");
  assert.equal(await limit("https://huggingface.co/api/daily_papers", async () => "unrelated"), "unrelated");
  assert.deepEqual(starts, [0]);
  release();
  assert.equal(await first, "rss");
  await failed;
  assert.equal(await limit("https://rss.arxiv.org/rss/q-bio.BM", async () => "after failure"), "after failure");
  await limit("https://export.arxiv.org/api/query", async () => {});
  assert.deepEqual(starts, [0, 3100, 8100, 11200]);
  assert.deepEqual(waits, [3100, 3100]);
});

test("a new limiter honors the persisted previous start instead of resetting its wait", async () => {
  let now = 1000;
  const waits: number[] = [];
  const limit = createArxivRequestLimiter(async operation => operation({ lastStartedAt: 900, markStarted: async at => { assert.equal(at, 4000); } }), {
    now: () => now, sleep: async ms => { waits.push(ms); now += ms; },
  });
  await limit("https://rss.arxiv.org/rss/cs.LG", async () => {});
  assert.deepEqual(waits, [3000]);
});
