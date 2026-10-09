import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { prepareRefreshRun, refreshWindow } from "@aihot/backend/research/refresh";
import { freezeAdmissions } from "@aihot/backend/research/admission";
import { composePilot } from "@aihot/backend/reports/compose";

const T = tag();
const date = "2012-02-16";
const ids = [`refresh-${date}-09`, `refresh-${date}-09-r1`, `refresh-${date}-21`];
after(async () => {
  await sql`DELETE FROM reports WHERE kind='daily' AND key=${date}`;
  await sql`DELETE FROM research_runs WHERE id=ANY(${ids})`;
  await closeDb();
});

test(`fixed morning and evening source windows retain independent observation timestamps ${T}`, () => {
  for (const hour of ["09", "21"]) {
    const cutoff = new Date(`${date}T${hour}:32:00+08:00`);
    const run = refreshWindow(`refresh-${date}-${hour}`, cutoff, new Date(), "all-in-window");
    assert.equal(run.start.toISOString(), "2012-02-15T01:00:00.000Z");
    assert.equal(run.end.toISOString(), "2012-02-16T01:00:00.000Z");
    assert.equal(run.observedAt, cutoff);
  }
});

test("explicit correction preserves the old 08:00 snapshot and replaces it with a fixed 09:00 edition", async () => {
  const original = await prepareRefreshRun(ids[0]!, new Date(`${date}T09:22:00+08:00`), { admissionPolicy: "all-in-window", modelCallCeiling: 290 });
  // Reproduce the exact legacy window shape, with no paid requests or source access.
  await sql`UPDATE research_runs SET window_start=${new Date("2012-02-15T00:00:00Z")},window_end=collection_cutoff,admission_frozen=true WHERE id=${original.id}`;
  await composePilot(original.id, true, { ruleOnly: true });
  const corrected = await prepareRefreshRun(ids[1]!, new Date(`${date}T17:00:00+08:00`), { admissionPolicy: "all-in-window", modelCallCeiling: 580 });
  assert.equal(corrected.model_call_ceiling, 580);
  assert.equal(corrected.window_end.toISOString(), "2012-02-16T01:00:00.000Z");
  assert.equal(corrected.collection_cutoff.toISOString(), "2012-02-16T09:00:00.000Z");
  assert.equal((await sql`SELECT window_start FROM research_runs WHERE id=${ids[0]!}`)[0].window_start.toISOString(), "2012-02-15T00:00:00.000Z");
  await freezeAdmissions(corrected.id);
  await composePilot(corrected.id, true, { ruleOnly: true });
  const [prior] = await sql`SELECT revision,content->>'windowEnd' AS window_end FROM report_revisions
    WHERE report_id=(SELECT id FROM reports WHERE kind='daily' AND key=${date}) ORDER BY revision DESC LIMIT 1`;
  assert.equal(prior.window_end, "2012-02-16T01:22:00.000Z");
  const evening = await prepareRefreshRun(ids[2]!, new Date(`${date}T21:15:00+08:00`), { admissionPolicy: "all-in-window", modelCallCeiling: 580 });
  await freezeAdmissions(evening.id);
  await composePilot(evening.id, true, { ruleOnly: true });
  await assert.rejects(freezeAdmissions(corrected.id), /later/);
  await assert.rejects(composePilot(corrected.id, true, { ruleOnly: true }), /旧/);
  const [report] = await sql`SELECT window_end,content->'run'->>'id' AS run_id FROM reports WHERE kind='daily' AND key=${date}`;
  assert.equal(report.run_id, evening.id);
  assert.equal(report.window_end.toISOString(), "2012-02-16T01:00:00.000Z");
});
