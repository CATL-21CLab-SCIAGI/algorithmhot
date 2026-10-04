-- Optional metadata keeps pre-research articles compatible. Signal identities remain separate.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS research jsonb;
ALTER TABLE publications ADD COLUMN IF NOT EXISTS research jsonb;
CREATE INDEX IF NOT EXISTS articles_research_canonical_idx ON articles ((research->>'canonicalKey'))
  WHERE research->>'canonicalKey' IS NOT NULL;
