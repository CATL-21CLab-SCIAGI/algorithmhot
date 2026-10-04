-- A frozen application-call allowance survives worker restarts. Token usage remains on receipts;
-- this is a call-count cap, not a claim about subscription billing or provider-side token limits.
CREATE TABLE model_runs (
  id text PRIMARY KEY,
  max_calls integer NOT NULL CHECK (max_calls BETWEEN 1 AND 600),
  report_reserve integer NOT NULL CHECK (report_reserve >= 0 AND report_reserve < max_calls),
  calls_used integer NOT NULL DEFAULT 0 CHECK (calls_used >= 0 AND calls_used <= max_calls),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE receipt_attempts ADD COLUMN model_run_id text REFERENCES model_runs(id);
ALTER TABLE receipt_attempts ADD COLUMN response jsonb;
CREATE INDEX receipt_attempts_model_run_idx ON receipt_attempts(model_run_id) WHERE model_run_id IS NOT NULL;

INSERT INTO budgets (service, per_minute, per_hour, per_day, note)
VALUES ('codex_cli', 60, 600, 600, 'Codex CLI 应用调用；批次总量另受 model_runs 约束')
ON CONFLICT (service) DO NOTHING;
