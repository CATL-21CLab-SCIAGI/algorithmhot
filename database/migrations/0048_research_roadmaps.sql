-- Source-bound method diagrams are independent of briefs and keep private model receipts.
CREATE TABLE research_roadmaps (
  article_id text NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  input_revision integer NOT NULL,
  version text NOT NULL,
  input_hash text NOT NULL,
  source_hash text NOT NULL,
  evidence_basis text NOT NULL,
  roadmap jsonb NOT NULL,
  receipt_id bigint NOT NULL REFERENCES receipts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, input_revision, version, input_hash)
);
ALTER TABLE publications ADD COLUMN research_roadmap jsonb;
