-- Downstream Hub — Sentinel, the AI production-support agent (idempotent)
--
-- Sentinel reads bug reports, JS errors and SDK analytics, reads the application's source
-- code (read-only, from GitHub), and writes a root-cause analysis with a proposed fix.
-- It also produces per-application health reports and answers admins' questions.

-- 1) Per-scope settings. scope = 'hub' (Downstream Hub itself) or an application id.
CREATE TABLE IF NOT EXISTS sentinel_config (
  scope VARCHAR(36) PRIMARY KEY,
  repo VARCHAR(200) DEFAULT NULL,                 -- GitHub "owner/name"
  branch VARCHAR(100) NOT NULL DEFAULT 'main',
  source_root VARCHAR(200) NOT NULL DEFAULT '',   -- sub-folder that holds the app, e.g. 'frontend/'
  notes TEXT DEFAULT NULL,                        -- context for Sentinel: stack, architecture, owners
  auto_analyze BOOLEAN NOT NULL DEFAULT TRUE,     -- analyse new bugs/errors automatically
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);

-- 2) Bug reports: grouping key for repeated errors, the app release, and SDK breadcrumbs.
ALTER TABLE bug_reports ADD COLUMN IF NOT EXISTS fingerprint VARCHAR(64) DEFAULT NULL;
ALTER TABLE bug_reports ADD COLUMN IF NOT EXISTS release VARCHAR(64) DEFAULT NULL;
ALTER TABLE bug_reports ADD COLUMN IF NOT EXISTS context JSONB DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_bug_reports_fingerprint
  ON bug_reports(fingerprint, created_at DESC) WHERE fingerprint IS NOT NULL;

-- 3) Every piece of work Sentinel does: a bug analysis, a health report, or an answer.
CREATE TABLE IF NOT EXISTS sentinel_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind VARCHAR(10) NOT NULL,                      -- 'bug' | 'health' | 'ask'
  scope VARCHAR(36) NOT NULL,                     -- 'hub' | application id
  application_id UUID REFERENCES applications(id) ON DELETE CASCADE,
  bug_report_id UUID REFERENCES bug_reports(id) ON DELETE CASCADE,
  fingerprint VARCHAR(64) DEFAULT NULL,
  parent_id UUID REFERENCES sentinel_runs(id) ON DELETE SET NULL,  -- follow-up question
  trigger VARCHAR(10) NOT NULL DEFAULT 'manual',  -- 'auto' | 'manual'
  status VARCHAR(10) NOT NULL DEFAULT 'queued',   -- queued | running | done | failed | skipped
  input JSONB DEFAULT NULL,                       -- { days } or { question }
  result JSONB DEFAULT NULL,                      -- structured output
  model VARCHAR(80) DEFAULT NULL,
  input_tokens INT NOT NULL DEFAULT 0,
  output_tokens INT NOT NULL DEFAULT 0,
  tool_calls INT NOT NULL DEFAULT 0,
  error TEXT DEFAULT NULL,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ DEFAULT NULL,
  finished_at TIMESTAMPTZ DEFAULT NULL
);
CREATE INDEX IF NOT EXISTS idx_sentinel_runs_queue ON sentinel_runs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_sentinel_runs_bug ON sentinel_runs(bug_report_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sentinel_runs_fingerprint ON sentinel_runs(fingerprint, created_at DESC)
  WHERE fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sentinel_runs_scope ON sentinel_runs(scope, kind, created_at DESC);
-- One automatic/manual analysis in flight per distinct error (repeats of the same error share it).
CREATE UNIQUE INDEX IF NOT EXISTS uq_sentinel_runs_active_fingerprint
  ON sentinel_runs(fingerprint) WHERE fingerprint IS NOT NULL AND status IN ('queued', 'running');
