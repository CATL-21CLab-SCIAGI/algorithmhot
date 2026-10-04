// Reset monitor assembly: a post confirming a stated number of resets nobody announced records each
// of them; plural wording without a number stays one; applying the same post again changes nothing.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { applyRecognition } from "@aihot/backend/monitor/assemble";
import type { Proposition, Recognition } from "@aihot/backend/monitor/recognize";

after(async () => {
  await closeDb();
});

let n = 0;
async function post(text: string): Promise<string> {
  n += 1;
  const id = `9${Date.now()}${n}`;
  await sql`INSERT INTO monitor_posts (id, author, published_at, text, url) VALUES (${id}, 'thsottiaux', now(), ${text}, ${`https://x.com/thsottiaux/status/${id}`})`;
  return id;
}

function confirmation(excerpt: string, count: number): Recognition {
  const p: Proposition = {
    kind: "direct_reset", kindExplicit: true, action: "confirm", real: true, count, relatesTo: null, excerpt, excerptZh: "我们重置了额度",
    statedTime: null, timeInferred: false, expectedLanding: null, scope: { audienceSource: null, plans: null, audienceZh: null, productsZh: null },
  };
  return { relevant: true, translationZh: "译文", contextZh: [], outage: null, needsReview: false, propositions: [p], model: "test", promptVersion: "test", receiptId: 0 };
}

const events = async (postId: string) =>
  (await sql<{ id: string; status: string }[]>`SELECT id, status FROM monitor_events WHERE id LIKE ${`%-${postId}-%`} ORDER BY id`).map((r) => ({ ...r }));

test("a confirmation of two resets nobody announced records two confirmed resets, once", async () => {
  const id = await post("We reset Codex rate limits twice today. Both are live for every paid plan.");
  const rec = confirmation("We reset Codex rate limits twice today", 2);
  const applied = await applyRecognition(id, rec);
  assert.deepEqual(await events(id), [{ id: `reset-${id}-1-1`, status: "confirmed" }, { id: `reset-${id}-1-2`, status: "confirmed" }]);
  assert.equal(applied.notify.length, 1, "one push for the post");
  const again = await applyRecognition(id, rec);
  assert.deepEqual([again.eventIds, again.notify], [[], []]);
  assert.equal((await events(id)).length, 2, "applying the post again adds nothing");
});

test("plural wording without a stated number stays one reset", async () => {
  const id = await post("We reset Codex rate limits for everyone. More resets are coming.");
  await applyRecognition(id, confirmation("We reset Codex rate limits for everyone", 2));
  assert.deepEqual(await events(id), [{ id: `reset-${id}-1-1`, status: "confirmed" }]);
});
