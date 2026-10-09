-- Opt-in withdrawal of empty editions. Existing reports retain their publication behavior.
ALTER TABLE reports ADD COLUMN hide_when_empty boolean NOT NULL DEFAULT false;
