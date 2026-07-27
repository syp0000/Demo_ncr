-- Full schema. Idempotent: safe to re-run against an existing database.
-- Run this once before the first deploy, and again after pulling schema changes.

CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  date DATE,
  date_display TEXT,
  shift TEXT,
  time_start TEXT,
  time_end TEXT,
  manage_no TEXT NOT NULL,
  process TEXT NOT NULL,
  report_type TEXT NOT NULL DEFAULT 'work',
  author_id TEXT,
  author_name TEXT,
  editor_id TEXT,
  editor_name TEXT,
  shared_edit BOOLEAN NOT NULL DEFAULT FALSE,
  issue TEXT DEFAULT '',
  action TEXT DEFAULT '',
  defect_disposition TEXT DEFAULT '',
  text TEXT DEFAULT '',
  photo_data TEXT DEFAULT '',
  photo_name TEXT DEFAULT ''
);

-- Columns added after the first release; no-ops on a database built from the
-- CREATE TABLE above, and the upgrade path for one that predates them.
ALTER TABLE records ADD COLUMN IF NOT EXISTS editor_id TEXT;
ALTER TABLE records ADD COLUMN IF NOT EXISTS editor_name TEXT;
ALTER TABLE records ADD COLUMN IF NOT EXISTS shared_edit BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE records ADD COLUMN IF NOT EXISTS report_type TEXT NOT NULL DEFAULT 'work';
ALTER TABLE records ADD COLUMN IF NOT EXISTS defect_disposition TEXT DEFAULT '';
ALTER TABLE records ADD COLUMN IF NOT EXISTS photo_data TEXT DEFAULT '';
ALTER TABLE records ADD COLUMN IF NOT EXISTS photo_name TEXT DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_records_recorded_at ON records (recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_records_manage_no ON records (manage_no);
CREATE INDEX IF NOT EXISTS idx_records_deleted_at ON records (deleted_at);
CREATE INDEX IF NOT EXISTS idx_records_author_id ON records (author_id);
CREATE INDEX IF NOT EXISTS idx_records_editor_id ON records (editor_id);
CREATE INDEX IF NOT EXISTS idx_records_date ON records (date) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS record_history (
  id BIGSERIAL PRIMARY KEY,
  record_id TEXT NOT NULL,
  action TEXT NOT NULL,
  field_name TEXT,
  old_value TEXT,
  new_value TEXT,
  changed_by_id TEXT NOT NULL,
  changed_by_name TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_record_history_record_id ON record_history (record_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_signup_requests (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_signup_requests_status ON user_signup_requests (status, requested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_signup_requests_unique_pending
  ON user_signup_requests (LOWER(username))
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS export_audit (
  id BIGSERIAL PRIMARY KEY,
  export_type TEXT NOT NULL,
  export_mode TEXT NOT NULL DEFAULT 'all',
  record_count INTEGER NOT NULL DEFAULT 0,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  actor_is_env_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_export_audit_created_at ON export_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_export_audit_actor_id ON export_audit (actor_id, created_at DESC);
