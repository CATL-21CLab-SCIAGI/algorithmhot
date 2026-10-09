-- User-authorized one-time extra 1800 calls, split into three separately frozen 600-call
-- model runs. Existing daily budgets and earlier historical runs are not rewritten.
ALTER TABLE research_runs DROP CONSTRAINT research_runs_model_budget_id_check;
ALTER TABLE research_runs ADD CONSTRAINT research_runs_model_budget_id_check CHECK (
  (id NOT LIKE 'recollect-20261009-oct05-07-v1%'
    AND (model_budget_id IS NULL OR model_budget_id ~ '^daily-[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
  OR (
    kind = 'pilot' AND admission_policy = 'all-in-window' AND model_call_ceiling = 580
    AND model_budget_id IS NOT NULL AND model_budget_id = id
    AND (
      (id = 'recollect-20261009-oct05-07-v1-2026-10-05'
        AND window_start = '2026-10-04T01:00:00Z'::timestamptz AND window_end = '2026-10-05T01:00:00Z'::timestamptz)
      OR (id = 'recollect-20261009-oct05-07-v1-2026-10-06'
        AND window_start = '2026-10-05T01:00:00Z'::timestamptz AND window_end = '2026-10-06T01:00:00Z'::timestamptz)
      OR (id = 'recollect-20261009-oct05-07-v1-2026-10-07'
        AND window_start = '2026-10-06T01:00:00Z'::timestamptz AND window_end = '2026-10-07T01:00:00Z'::timestamptz)
    )
  )
);
