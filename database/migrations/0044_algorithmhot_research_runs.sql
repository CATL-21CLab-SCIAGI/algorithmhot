-- A frozen research window, its source receipts and its bounded model admission set.
ALTER TABLE reports DROP CONSTRAINT reports_kind_check;
ALTER TABLE reports ADD CONSTRAINT reports_kind_check CHECK (kind IN ('daily', 'weekly', 'monthly', 'pilot'));
CREATE TABLE research_runs (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('pilot', 'daily')),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL CHECK (window_end > window_start),
  max_candidates integer NOT NULL DEFAULT 60 CHECK (max_candidates BETWEEN 1 AND 60),
  status text NOT NULL DEFAULT 'collecting',
  admission_frozen boolean NOT NULL DEFAULT false,
  report_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE research_fetches (
  id bigserial PRIMARY KEY,
  run_id text NOT NULL REFERENCES research_runs(id),
  source_id text NOT NULL REFERENCES sources(id),
  url text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('ok', 'failed', 'not_modified')),
  http_status integer,
  response_path text,
  response_sha256 text,
  returned_count integer NOT NULL DEFAULT 0,
  parsed_count integer NOT NULL DEFAULT 0,
  truncated boolean NOT NULL DEFAULT false,
  error text,
  UNIQUE(run_id, source_id, url)
);
CREATE TABLE research_members (
  run_id text NOT NULL REFERENCES research_runs(id),
  article_id text NOT NULL REFERENCES articles(id),
  source_id text NOT NULL REFERENCES sources(id),
  in_window boolean NOT NULL,
  signal_only boolean NOT NULL DEFAULT false,
  admitted boolean NOT NULL DEFAULT false,
  admission_rank integer,
  state text NOT NULL DEFAULT 'stored',
  error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id, article_id)
);
CREATE INDEX research_admission_idx ON research_members(run_id, admitted, admission_rank);
