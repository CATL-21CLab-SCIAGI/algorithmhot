import assert from "node:assert/strict";
import { test } from "node:test";
import { computeBoardsInWorker } from "@aihot/backend/leaderboard/method/compute";
import { computeBoard, type BoardInput } from "@aihot/backend/leaderboard/method/v15";

test("threaded v15 preserves complete board output and lets the parent event loop run", async () => {
  const models = ["a", "b", "c", "d", "e"];
  const input: BoardInput = {
    board: "coding", models, names: Object.fromEntries(models.map((m) => [m, m])), anchors: ["a", "c", "e"],
    policy: { sources: 2, families: 1, operators: 2, categories: 0, directAnchors: 1 },
    registry: {
      first: { family: "first", weight: 0.5, operator: "first", protocol: "test", direction: "HIGHER", interval_sd: null },
      second: { family: "second", weight: 0.5, operator: "second", protocol: "test", direction: "HIGHER", interval_sd: null },
    },
    signals: ["first", "second"].map((key) => ({ key, rows: models.map((modelSlug, i) => ({ modelSlug, score: 10 - i, lowerBound: null, upperBound: null, configuration: "" })) })),
    qualificationScenarios: {},
  };
  const expected = await computeBoard(input);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  try {
    const actual = await computeBoardsInWorker([input]);
    assert.deepEqual(actual.outputs, [expected]);
    assert.ok(ticks > 0, "other worker duties can progress during computation");
  } finally { clearInterval(timer); }
});

test("worker computation errors reject the round", async () => {
  await assert.rejects(computeBoardsInWorker([{} as BoardInput]));
});
