-- Preserve HTTP failure receipts; classify only newly observed explicit HF date upper bounds.
-- NULL keeps every historical row's original failure meaning. No historical evidence is rewritten.
ALTER TABLE research_fetches ADD COLUMN outcome text;
ALTER TABLE research_fetches ADD CONSTRAINT research_fetches_outcome_check
  CHECK (outcome IS NULL OR (outcome = 'not_yet_available' AND status = 'failed' AND http_status IS NOT DISTINCT FROM 400));
