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
  issue TEXT DEFAULT '',
  action TEXT DEFAULT '',
  defect_disposition TEXT DEFAULT '',
  text TEXT DEFAULT '',
  photo_data TEXT DEFAULT '',
  photo_name TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_records_recorded_at ON records (recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_records_manage_no ON records (manage_no);
CREATE INDEX IF NOT EXISTS idx_records_deleted_at ON records (deleted_at);
CREATE INDEX IF NOT EXISTS idx_records_author_id ON records (author_id);

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
