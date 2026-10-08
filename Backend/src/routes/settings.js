/**
 * Settings: password policy (Admin only). Password expiry, complexity, history, lockout.
 */
const express = require('express');
const { pool } = require('../db/pool');
const passwordPolicyDb = require('../db/passwordPolicyDb');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { auditLog, getClientIp } = require('../middleware/audit');

const router = express.Router();

// GET /api/settings/password-policy — Admin only
router.get('/password-policy', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const policy = await passwordPolicyDb.get(pool);
    res.json(policy);
  } catch (err) {
    console.error('Get password policy error:', err);
    res.status(500).json({ error: 'Failed to load password policy' });
  }
});

// PUT /api/settings/password-policy — Admin only
router.put('/password-policy', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const payload = {};
    if (body.password_expiry_days !== undefined) {
      const days = parseInt(String(body.password_expiry_days), 10);
      if (Number.isNaN(days) || days < 0 || days > 365) {
        return res.status(400).json({ error: 'password_expiry_days must be between 0 and 365' });
      }
      payload.password_expiry_days = days;
    }
    if (body.min_password_length !== undefined) payload.min_password_length = body.min_password_length;
    if (body.require_uppercase !== undefined) payload.require_uppercase = body.require_uppercase;
    if (body.require_lowercase !== undefined) payload.require_lowercase = body.require_lowercase;
    if (body.require_number !== undefined) payload.require_number = body.require_number;
    if (body.require_symbol !== undefined) payload.require_symbol = body.require_symbol;
    if (body.password_history_count !== undefined) payload.password_history_count = body.password_history_count;
    if (body.max_login_attempts !== undefined) payload.max_login_attempts = body.max_login_attempts;
    if (body.lockout_duration_mins !== undefined) payload.lockout_duration_mins = body.lockout_duration_mins;
    if (body.mfa_reverify_days !== undefined) payload.mfa_reverify_days = body.mfa_reverify_days;
    if (body.mfa_risk_threshold !== undefined) payload.mfa_risk_threshold = body.mfa_risk_threshold;
    if (body.login_mfa_bypass_mode !== undefined) {
      const mode = String(body.login_mfa_bypass_mode).trim();
      if (!passwordPolicyDb.BYPASS_MODES.includes(mode)) {
        return res.status(400).json({ error: `login_mfa_bypass_mode must be one of: ${passwordPolicyDb.BYPASS_MODES.join(', ')}` });
      }
      payload.login_mfa_bypass_mode = mode;
    }
    if (body.login_mfa_bypass_hours !== undefined) payload.login_mfa_bypass_hours = body.login_mfa_bypass_hours;
    if (body.login_mfa_bypass_days !== undefined) payload.login_mfa_bypass_days = body.login_mfa_bypass_days;
    if (body.login_mfa_bypass_timezone !== undefined) payload.login_mfa_bypass_timezone = body.login_mfa_bypass_timezone;

    if (Object.keys(payload).length === 0) {
      const policy = await passwordPolicyDb.get(pool);
      return res.json(policy);
    }
    const client = await pool.connect();
    try {
      const before = await passwordPolicyDb.get(client);
      const after = await passwordPolicyDb.update(client, payload);
      await auditLog(client, {
        actorId: req.user.id,
        actionType: 'UPDATE',
        targetEntity: 'password_policy',
        payloadBefore: before,
        payloadAfter: after,
        ipAddress: getClientIp(req),
      });
      res.json(after);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Update password policy error:', err);
    res.status(500).json({ error: 'Failed to update password policy' });
  }
});

module.exports = router;
