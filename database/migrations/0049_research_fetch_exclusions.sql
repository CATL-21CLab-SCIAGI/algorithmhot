-- Batch metadata pages may include replacements outside the frozen announcement identity set.
ALTER TABLE research_fetches ADD COLUMN excluded_count integer NOT NULL DEFAULT 0 CHECK (excluded_count >= 0);
