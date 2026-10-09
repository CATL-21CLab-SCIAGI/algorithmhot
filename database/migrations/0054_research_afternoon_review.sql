-- Add the afternoon cumulative ceiling without rewriting existing frozen runs or budgets.
ALTER TABLE research_runs DROP CONSTRAINT research_runs_admission_policy_check;
ALTER TABLE research_runs ADD CONSTRAINT research_runs_admission_policy_check CHECK (
  (admission_policy = 'legacy-capped' AND max_candidates IS NOT NULL AND max_candidates BETWEEN 1 AND 60 AND model_call_ceiling IS NULL)
  OR (admission_policy = 'all-in-window' AND (kind = 'daily' OR (kind = 'pilot' AND model_budget_id IS NOT NULL))
      AND max_candidates IS NULL AND model_call_ceiling IS NOT NULL AND model_call_ceiling IN (290, 435, 580))
);
