-- Downstream Hub — Login MFA bypass by number of days since the last real MFA (idempotent)
--
-- New bypass mode 'rolling_days': a trusted browser may skip MFA for N days counted
-- from the user's last *actual* MFA (magic link / OTP). Bypassed logins refresh
-- trusted_devices.last_verified_at, so that column cannot anchor a fixed window;
-- last_mfa_at is stamped only when the user really completes MFA.

ALTER TABLE password_policy
  ADD COLUMN IF NOT EXISTS login_mfa_bypass_days INT NOT NULL DEFAULT 7;

ALTER TABLE trusted_devices
  ADD COLUMN IF NOT EXISTS last_mfa_at TIMESTAMPTZ DEFAULT NULL;
