-- Downstream Hub — Sentinel run-time settings (idempotent)
--
-- Settings that are changed at run time rather than in the backend .env. Today one key:
--   model  — the Claude model Sentinel uses. Set from Milo (through the MCP Gateway's
--            control key); overrides SENTINEL_MODEL while present.
CREATE TABLE IF NOT EXISTS sentinel_settings (
  key VARCHAR(50) PRIMARY KEY,
  value TEXT NOT NULL,
  source VARCHAR(200) DEFAULT NULL,      -- who set it, e.g. "mcp-gateway (jerry@…)"
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
