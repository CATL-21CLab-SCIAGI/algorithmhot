-- Retain every failed request while permitting bounded, separately recorded recovery.
ALTER TABLE research_fetches ADD COLUMN attempt_number integer NOT NULL DEFAULT 1;
ALTER TABLE research_fetches DROP CONSTRAINT research_fetches_run_id_source_id_url_key;
ALTER TABLE research_fetches ADD CONSTRAINT research_fetches_attempt_unique UNIQUE(run_id,source_id,url,attempt_number);
