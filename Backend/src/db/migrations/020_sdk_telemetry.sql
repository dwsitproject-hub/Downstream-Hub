-- Downstream Hub — embeddable analytics & bug-report SDK (idempotent)
--
-- Each registered application can embed the Hub SDK (<script src=".../api/sdk/v1/hub-sdk.js">).
-- The SDK reports page views, time in app (heartbeats), JS errors and user bug reports.

-- 1) Per-application SDK settings. sdk_key is a *publishable* key (it ships in web pages);
--    ingestion is additionally restricted to the application's allowed origins.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS sdk_key VARCHAR(64) DEFAULT NULL;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS sdk_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS sdk_allowed_origins TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_sdk_key
  ON applications(sdk_key) WHERE sdk_key IS NOT NULL;

-- 2) One row per browser session per application (extended by heartbeats).
CREATE TABLE IF NOT EXISTS app_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  session_key VARCHAR(64) NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  user_email VARCHAR(255) DEFAULT NULL,      -- as reported by the app when it is not a known Hub user
  anonymous_id VARCHAR(64) DEFAULT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  page_views INT NOT NULL DEFAULT 0,
  user_agent TEXT DEFAULT NULL,
  ip_address VARCHAR(45) DEFAULT NULL,
  UNIQUE (application_id, session_key)
);
CREATE INDEX IF NOT EXISTS idx_app_sessions_app_started ON app_sessions(application_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_sessions_app_last_seen ON app_sessions(application_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_sessions_user ON app_sessions(user_id, started_at DESC);

-- 3) Page views and custom events.
CREATE TABLE IF NOT EXISTS app_events (
  id BIGSERIAL PRIMARY KEY,
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  session_key VARCHAR(64) DEFAULT NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  user_email VARCHAR(255) DEFAULT NULL,
  event_type VARCHAR(20) NOT NULL,           -- 'page_view' | 'custom'
  name VARCHAR(120) DEFAULT NULL,            -- custom event name
  path VARCHAR(1000) DEFAULT NULL,           -- page path, query string and fragment-query stripped
  title VARCHAR(300) DEFAULT NULL,
  properties JSONB DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_app_events_app_type_created ON app_events(application_id, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_events_user ON app_events(user_id, created_at DESC);
-- used when a session becomes identified, to attribute its earlier anonymous events
CREATE INDEX IF NOT EXISTS idx_app_events_app_session ON app_events(application_id, session_key);

-- 4) Bug reports / client errors are scoped to an application (NULL = Downstream Hub itself).
ALTER TABLE bug_reports ADD COLUMN IF NOT EXISTS application_id UUID REFERENCES applications(id) ON DELETE CASCADE;
ALTER TABLE bug_reports ADD COLUMN IF NOT EXISTS session_key VARCHAR(64) DEFAULT NULL;
ALTER TABLE bug_reports ADD COLUMN IF NOT EXISTS user_email VARCHAR(255) DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_bug_reports_app_status_created
  ON bug_reports(application_id, status, created_at DESC);
