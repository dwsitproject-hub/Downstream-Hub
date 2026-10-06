-- Downstream Hub — Admin-invite activation + usage analytics (idempotent)
-- Safe to run repeatedly (startup runner re-applies all migrations).

-- 1) Users: allow invited accounts with no password yet; ensure activation columns exist.
DO $$
BEGIN
  -- invited users are created without a password until they activate
  BEGIN
    ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
  EXCEPTION WHEN others THEN
    -- already nullable or column absent; ignore
    NULL;
  END;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ DEFAULT NULL;
END $$;

-- 2) Hub usage sessions (heartbeat-based). One row per continuous visit.
CREATE TABLE IF NOT EXISTS user_activity_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ DEFAULT NULL,
  ip_address VARCHAR(45) DEFAULT NULL,
  user_agent TEXT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_activity_sessions_user
  ON user_activity_sessions(user_id, started_at DESC);
-- fast lookup of the current open session for a user
CREATE INDEX IF NOT EXISTS idx_user_activity_sessions_open
  ON user_activity_sessions(user_id, last_seen_at DESC) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_user_activity_sessions_started
  ON user_activity_sessions(started_at);

-- 3) Bug reports: user-submitted reports AND auto-captured client errors.
CREATE TABLE IF NOT EXISTS bug_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  kind VARCHAR(20) NOT NULL DEFAULT 'user_report',   -- 'user_report' | 'client_error'
  message TEXT NOT NULL,
  page_url TEXT DEFAULT NULL,
  stack TEXT DEFAULT NULL,
  user_agent TEXT DEFAULT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'open',          -- 'open' | 'resolved'
  ip_address VARCHAR(45) DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ DEFAULT NULL,
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_bug_reports_status_created
  ON bug_reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bug_reports_kind
  ON bug_reports(kind, created_at DESC);
