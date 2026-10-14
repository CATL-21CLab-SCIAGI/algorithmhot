import assert from "node:assert/strict";
import { test } from "node:test";
import { selectionMetrics, selectionThresholdMetrics, type SelectionMetricCase } from "../scripts/eval-selection-core.ts";

test("selection metrics keep valid-output quality separate from decisive coverage", () => {
  const cases: SelectionMetricCase[] = [
    { gold: "select", decision: "select" },
    { gold: "select", decision: "select" },
    { gold: "select", decision: "select" },
    { gold: "reject", decision: "reject" },
    { gold: "reject", decision: "reject" },
    { gold: "reject", decision: "select" },
    { gold: "select", decision: null },
    { gold: "reject", decision: null },
    { gold: "either", decision: "select" },
    { gold: "either", decision: null },
  ];

  assert.deepEqual(selectionMetrics(cases), {
    n: 10,
    decisiveGold: 8,
    decisive: 6,
    either: 2,
    errors: 3,
    decisiveErrors: 2,
    eitherErrors: 1,
    tp: 3,
    fp: 1,
    fn: 0,
    tn: 2,
    coverage: 0.75,
    accuracy: 0.833,
    completeAccuracy: 0.625,
    precision: 0.75,
    recall: 1,
    f1: 0.857,
    selectedRate: 0.667,
    goldSelectRate: 0.5,
  });
});

test("either cases do not lower decisive coverage or complete accuracy", () => {
  const metrics = selectionMetrics([
    { gold: "select", decision: "select" },
    { gold: "reject", decision: "reject" },
    { gold: "either", decision: null },
    { gold: "either", decision: null },
  ]);
  assert.equal(metrics.coverage, 1);
  assert.equal(metrics.accuracy, 1);
  assert.equal(metrics.completeAccuracy, 1);
  assert.equal(metrics.errors, 2);
  assert.equal(metrics.decisiveErrors, 0);
  assert.equal(metrics.eitherErrors, 2);
});

test("threshold sweep uses the same decisive failure denominator", () => {
  const metrics = selectionThresholdMetrics([
    { gold: "select", available: true, relevance: "pass", score: 80 },
    { gold: "select", available: false, relevance: null, score: null },
    { gold: "reject", available: true, relevance: "pass", score: 70 },
    { gold: "reject", available: true, relevance: "pass", score: 30 },
    { gold: "either", available: false, relevance: null, score: null },
  ], 60);

  assert.deepEqual(metrics, {
    t: 60,
    acc: 0.667,
    completeAcc: 0.5,
    coverage: 0.75,
    P: 0.5,
    R: 1,
    F1: 0.667,
    sel: 0.667,
    decisive: 3,
    decisiveGold: 4,
    decisiveErrors: 1,
  });
});
