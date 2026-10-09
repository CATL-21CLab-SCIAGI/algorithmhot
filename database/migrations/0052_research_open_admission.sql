-- New twice-daily editions admit the full observed corpus. Existing snapshots keep their
-- original 60-item cap and model allowance; NULL is an explicit absence of a candidate cap.
ALTER TABLE research_runs ADD COLUMN admission_policy text NOT NULL DEFAULT 'legacy-capped';
ALTER TABLE research_runs ADD COLUMN model_call_ceiling integer;
ALTER TABLE research_runs ADD COLUMN model_budget_id text CHECK (model_budget_id IS NULL OR model_budget_id ~ '^daily-[0-9]{4}-[0-9]{2}-[0-9]{2}$');
ALTER TABLE research_runs ALTER COLUMN max_candidates DROP NOT NULL;
ALTER TABLE research_runs DROP CONSTRAINT research_runs_max_candidates_check;
ALTER TABLE research_runs ADD CONSTRAINT research_runs_admission_policy_check CHECK (
  (admission_policy = 'legacy-capped' AND max_candidates IS NOT NULL AND max_candidates BETWEEN 1 AND 60 AND model_call_ceiling IS NULL)
  OR (admission_policy = 'all-in-window' AND (kind = 'daily' OR (kind = 'pilot' AND model_budget_id IS NOT NULL))
      AND max_candidates IS NULL AND model_call_ceiling IS NOT NULL AND model_call_ceiling IN (290, 580))
);
