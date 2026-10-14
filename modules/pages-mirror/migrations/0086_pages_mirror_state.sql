-- The last mirror run (modules/pages-mirror/server.ts), shown on the admin's runs page. One row; the
-- last pushed commit is kept when a later run fails.
CREATE TABLE IF NOT EXISTS pages_mirror_state (
  singleton     boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz NOT NULL,
  pages         integer NOT NULL DEFAULT 0,
  assets        integer NOT NULL DEFAULT 0,
  skipped       integer NOT NULL DEFAULT 0,
  skipped_paths jsonb NOT NULL DEFAULT '[]',
  changed       boolean NOT NULL DEFAULT false,
  commit_sha    text,
  pushed_at     timestamptz,
  error         text
);
