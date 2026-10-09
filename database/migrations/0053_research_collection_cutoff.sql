-- Collection snapshots and publication windows are independent: a delayed review
-- still covers the same closed 09:00 edition. Preserve legacy observed cutoffs.
ALTER TABLE research_runs ADD COLUMN collection_cutoff timestamptz;
UPDATE research_runs SET collection_cutoff=window_end;
ALTER TABLE research_runs ALTER COLUMN collection_cutoff SET NOT NULL;
ALTER TABLE research_runs ALTER COLUMN collection_cutoff SET DEFAULT now();
