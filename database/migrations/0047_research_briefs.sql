-- Model-produced research interpretation is separate from source-backed metadata.
CREATE TABLE research_briefs (
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  input_revision integer NOT NULL,
  version text NOT NULL,
  brief jsonb NOT NULL,
  receipt_id bigint NOT NULL REFERENCES receipts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, input_revision, version)
);
ALTER TABLE publications ADD COLUMN research_brief jsonb;
