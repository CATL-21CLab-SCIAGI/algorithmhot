-- Reserve each source attempt before the HTTP request. Interrupted responses keep their own path
-- and denominator and can never be silently overwritten by a resumed batch.
ALTER TABLE research_fetches DROP CONSTRAINT research_fetches_status_check;
ALTER TABLE research_fetches ADD CONSTRAINT research_fetches_status_check
  CHECK (status IN ('pending', 'ok', 'failed', 'not_modified'));
