export type SelectionGoldDecision = "select" | "reject" | "either";
export type SelectionDecision = "select" | "reject";

export interface SelectionMetricCase {
  gold: SelectionGoldDecision;
  decision: SelectionDecision | null;
}

export interface SelectionThresholdCase {
  gold: SelectionGoldDecision;
  available: boolean;
  relevance: string | null;
  score: number | null;
}

function round(value: number): number {
  return +value.toFixed(3);
}

/**
 * Selection quality has two denominators:
 * - valid-output metrics describe decisions the pipeline actually returned;
 * - coverage / completeAccuracy charge failures against every decisive gold case.
 * Gold "either" cases are excluded from both denominators, but their failures remain observable.
 */
export function selectionMetrics(cases: SelectionMetricCase[]) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  let decisiveGold = 0, either = 0, errors = 0, decisiveErrors = 0, eitherErrors = 0;
  let goldSelect = 0;

  for (const row of cases) {
    if (row.gold === "either") {
      either++;
      if (row.decision === null) {
        errors++;
        eitherErrors++;
      }
      continue;
    }

    decisiveGold++;
    if (row.gold === "select") goldSelect++;
    if (row.decision === null) {
      errors++;
      decisiveErrors++;
      continue;
    }

    if (row.decision === "select" && row.gold === "select") tp++;
    else if (row.decision === "select") fp++;
    else if (row.gold === "select") fn++;
    else tn++;
  }

  const decisive = tp + fp + fn + tn;
  const correct = tp + tn;
  const precision = tp / Math.max(1, tp + fp);
  const recall = tp / Math.max(1, tp + fn);
  const f1 = (2 * precision * recall) / Math.max(1e-9, precision + recall);

  return {
    n: cases.length,
    decisiveGold,
    decisive,
    either,
    errors,
    decisiveErrors,
    eitherErrors,
    tp,
    fp,
    fn,
    tn,
    coverage: round(decisive / Math.max(1, decisiveGold)),
    accuracy: round(correct / Math.max(1, decisive)),
    completeAccuracy: round(correct / Math.max(1, decisiveGold)),
    precision: round(precision),
    recall: round(recall),
    f1: round(f1),
    selectedRate: round((tp + fp) / Math.max(1, decisive)),
    // A property of the labelled decisive set, not of whichever cases a model happened to answer.
    goldSelectRate: round(goldSelect / Math.max(1, decisiveGold)),
  };
}

export function selectionThresholdMetrics(cases: SelectionThresholdCase[], threshold: number) {
  const metrics = selectionMetrics(cases.map((row) => ({
    gold: row.gold,
    decision: row.available
      ? (row.relevance === "pass" && row.score !== null && row.score >= threshold ? "select" : "reject")
      : null,
  })));
  return {
    t: threshold,
    acc: metrics.accuracy,
    completeAcc: metrics.completeAccuracy,
    coverage: metrics.coverage,
    P: metrics.precision,
    R: metrics.recall,
    F1: metrics.f1,
    sel: metrics.selectedRate,
    decisive: metrics.decisive,
    decisiveGold: metrics.decisiveGold,
    decisiveErrors: metrics.decisiveErrors,
  };
}
