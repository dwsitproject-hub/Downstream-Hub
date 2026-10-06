-- Downstream Hub — users who activated via the emailed invitation link have proven
-- email ownership, so they also satisfy the SSO email-verification gate.
-- Backfills accounts activated before this rule existed. Idempotent: email_verified_at
-- is only set by invitation activation, and nothing clears hub_oidc_email_verified_at,
-- so re-running on every startup is a no-op after the first run.
UPDATE users
   SET hub_oidc_email_verified_at = email_verified_at
 WHERE email_verified_at IS NOT NULL
   AND hub_oidc_email_verified_at IS NULL
   AND deleted_at IS NULL;
