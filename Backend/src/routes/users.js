/**
 * User list, manual create, BU assignment, deactivate, reset password. Admin only.
 * Data access via usersDb (excludes soft-deleted users).
 */
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db/pool');
const usersDb = require('../db/usersDb');
const ssoLinkDb = require('../db/ssoLinkDb');
const businessUnitsDb = require('../db/businessUnitsDb');
const allowedDomainsDb = require('../db/allowedDomainsDb');
const passwordPolicyDb = require('../db/passwordPolicyDb');
const passwordHistoryDb = require('../db/passwordHistoryDb');
const ssoLinkService = require('../services/ssoLinkService');
const accountActivationDb = require('../db/accountActivationDb');
const { validatePassword } = require('../lib/passwordValidation');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { auditLog, getClientIp } = require('../middleware/audit');
const mailer = require('../lib/mailer');

const ACTIVATION_TTL_HOURS = Math.max(1, Math.min(168, parseInt(process.env.ACTIVATION_TTL_HOURS || '48', 10)));

function publicAppBase() {
  return (process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
}

/**
 * Issue a fresh one-time activation token (revoking any older ones) and email the link.
 * Returns whether the email was actually handed to SMTP.
 */
async function sendActivationInvite(req, user) {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
  const expiresAt = new Date(Date.now() + ACTIVATION_TTL_HOURS * 60 * 60 * 1000);
  await accountActivationDb.invalidatePendingForUser(pool, user.id);
  await accountActivationDb.insert(pool, {
    userId: user.id,
    tokenHash,
    expiresAt,
    requestIp: getClientIp(req),
  });
  const activateUrl = `${publicAppBase()}/activate?token=${encodeURIComponent(rawToken)}`;
  try {
    const result = await mailer.sendAccountActivationEmail({ to: user.email, activateUrl, ttlHours: ACTIVATION_TTL_HOURS });
    return { emailSent: !result.skipped, expiresAt };
  } catch (mailErr) {
    console.error('Activation email error:', mailErr.message);
    return { emailSent: false, expiresAt };
  }
}

const router = express.Router();

/** Generate a high-entropy random password (20 chars, alphanumeric + safe symbols). */
function generateRandomPassword() {
  const length = 20;
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%&*';
  const bytes = crypto.randomBytes(length);
  let s = '';
  for (let i = 0; i < length; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}

// GET /api/users — list all users with BU (Admin only)
router.get('/', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const rows = await usersDb.listWithBu(pool);
    const users = rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      business_unit_id: r.business_unit_id,
      business_unit_name: r.business_unit_name || null,
      created_at: r.created_at,
      locked_until: r.locked_until || null,
      is_active: r.is_active !== false,
      oidc_linked: !!r.oidc_sub,
      oidc_linked_at: r.oidc_linked_at || null,
      oidc_linked_by_mode: r.oidc_linked_by_mode || null,
      oidc_subject_fingerprint: r.oidc_sub ? ssoLinkDb.subjectFingerprint(r.oidc_sub) : null,
    }));
    res.json({ users });
  } catch (err) {
    console.error('List users error:', err);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// GET /api/users/me/sso-status — self-service SSO link status
router.get('/me/sso-status', authMiddleware, async (req, res) => {
  try {
    const status = await ssoLinkService.getUserStatus(pool, req.user.id);
    if (!status) return res.status(404).json({ error: 'User not found' });
    return res.json({
      linked: status.linked,
      authSource: status.auth_source,
      linkedAt: status.linked_at,
      linkedByMode: status.linked_by_mode,
      subjectFingerprint: status.subject_fingerprint,
    });
  } catch (err) {
    console.error('Get SSO status error:', err);
    return res.status(500).json({ error: 'Failed to load SSO status' });
  }
});

// POST /api/users/me/sso-connect/start — sends verification link for self-service connect
router.post('/me/sso-connect/start', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const me = await usersDb.getById(client, req.user.id);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const subject = ssoLinkService.buildSyntheticSubjectForUser(me);
    const result = await ssoLinkService.createEmailVerification(client, {
      user: me,
      mode: 'connect_sso',
      subject,
      actorId: req.user.id,
    });
    const publicBase = (process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    const verifyUrl = `${publicBase}/change-password?sso_verify=${encodeURIComponent(result.tokenRaw)}`;
    try {
      await mailer.sendSsoLinkVerificationEmail({ to: me.email, verifyUrl });
    } catch (mailErr) {
      console.error('SSO connect email send failed:', mailErr.message);
    }
    return res.json({
      message: 'Verification email sent',
      expires_at: result.expiresAt,
    });
  } catch (err) {
    console.error('Start SSO connect error:', err);
    return res.status(500).json({ error: 'Failed to start SSO connect' });
  } finally {
    client.release();
  }
});

// POST /api/users/me/sso-unlink — self unlink
router.post('/me/sso-unlink', authMiddleware, async (req, res) => {
  try {
    const row = await ssoLinkDb.unlinkOidcSubFromUser(pool, { userId: req.user.id });
    if (!row) return res.status(404).json({ error: 'User not found' });
    await ssoLinkDb.insertLinkEvent(pool, {
      userId: req.user.id,
      actorId: req.user.id,
      mode: 'self_service',
      eventType: 'unlink',
      status: 'success',
    });
    return res.json({ message: 'SSO unlinked' });
  } catch (err) {
    console.error('Unlink SSO error:', err);
    return res.status(500).json({ error: 'Failed to unlink SSO' });
  }
});

// GET /api/users/sso/verify?token=... — consumes verification token and links account
router.get('/sso/verify', authMiddleware, async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    if (!token) return res.status(400).json({ error: 'token required' });
    const result = await ssoLinkService.consumeEmailVerificationAndLink(pool, {
      actorId: req.user.id,
      tokenRaw: token,
    });
    if (!result.ok) return res.status(400).json({ error: result.code });
    return res.json({ message: 'SSO linked successfully' });
  } catch (err) {
    console.error('Verify SSO link error:', err);
    return res.status(500).json({ error: 'Failed to verify link' });
  }
});

// GET /api/users/:id/sso-status — admin status lookup
router.get('/:id/sso-status', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const status = await ssoLinkService.getUserStatus(pool, req.params.id);
    if (!status) return res.status(404).json({ error: 'User not found' });
    return res.json({
      linked: status.linked,
      authSource: status.auth_source,
      linkedAt: status.linked_at,
      linkedByMode: status.linked_by_mode,
      subjectFingerprint: status.subject_fingerprint,
    });
  } catch (err) {
    console.error('Admin get SSO status error:', err);
    return res.status(500).json({ error: 'Failed to load SSO status' });
  }
});

// GET /api/users/:id/sso-events — admin history
router.get('/:id/sso-events', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const events = await ssoLinkDb.listLinkEventsByUser(pool, req.params.id, 50);
    return res.json({ events });
  } catch (err) {
    console.error('Admin get SSO events error:', err);
    return res.status(500).json({ error: 'Failed to load SSO events' });
  }
});

// POST /api/users/:id/sso-link/start — admin prelink URL
router.post('/:id/sso-link/start', authMiddleware, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const target = await usersDb.getById(client, req.params.id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    const subject = ssoLinkService.buildSyntheticSubjectForUser(target);
    const result = await ssoLinkService.createEmailVerification(client, {
      user: target,
      mode: 'admin_prelink',
      subject,
      actorId: req.user.id,
    });
    const publicBase = (process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    const url = `${publicBase}/change-password?sso_verify=${encodeURIComponent(result.tokenRaw)}`;
    await ssoLinkDb.insertLinkEvent(client, {
      userId: target.id,
      actorId: req.user.id,
      mode: 'admin_prelink',
      eventType: 'prelink_generated',
      status: 'success',
    });
    return res.json({ url, expires_at: result.expiresAt });
  } catch (err) {
    console.error('Admin prelink start error:', err);
    return res.status(500).json({ error: 'Failed to generate prelink URL' });
  } finally {
    client.release();
  }
});

// POST /api/users/:id/sso-unlink — admin unlink
router.post('/:id/sso-unlink', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const row = await ssoLinkDb.unlinkOidcSubFromUser(pool, { userId: req.params.id });
    if (!row) return res.status(404).json({ error: 'User not found' });
    await ssoLinkDb.insertLinkEvent(pool, {
      userId: req.params.id,
      actorId: req.user.id,
      mode: 'admin',
      eventType: 'unlink',
      status: 'success',
      reasonCode: req.body?.reason ? 'admin_reason_provided' : null,
      metadata: { reason: String(req.body?.reason || '').trim() || null },
    });
    return res.json({ message: 'SSO unlinked' });
  } catch (err) {
    console.error('Admin unlink SSO error:', err);
    return res.status(500).json({ error: 'Failed to unlink SSO' });
  }
});

// POST /api/users — invite a new user (Admin only).
// Creates an inactive account with no password and emails an activation link;
// the user sets their own password to complete registration.
router.post('/', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const { email, role, business_unit_id } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }
    const emailNorm = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    const validRoles = ['Admin', 'Employee'];
    const roleVal = role != null && role !== '' ? String(role) : 'Employee';
    if (!validRoles.includes(roleVal)) {
      return res.status(400).json({ error: 'role must be Admin or Employee' });
    }
    const domain = emailNorm.split('@')[1];
    if (!domain) {
      return res.status(400).json({ error: 'Email domain not authorized.' });
    }
    const domainRow = await allowedDomainsDb.getByDomain(pool, domain);
    if (!domainRow) {
      return res.status(400).json({ error: 'Email domain not authorized.' });
    }
    let buId = null;
    if (business_unit_id != null && business_unit_id !== '') {
      const bu = await businessUnitsDb.getById(pool, business_unit_id);
      if (!bu) {
        return res.status(400).json({ error: 'Department not found' });
      }
      buId = bu.id;
    }

    const user = await usersDb.createInvited(pool, { email: emailNorm, role: roleVal, business_unit_id: buId });
    const { emailSent } = await sendActivationInvite(req, user);

    await auditLog(pool, {
      actorId: req.user.id,
      actionType: 'CREATE',
      targetEntity: `user:${user.email}`,
      payloadBefore: null,
      payloadAfter: { id: user.id, email: user.email, role: user.role, business_unit_id: user.business_unit_id, invited: true },
      ipAddress: getClientIp(req),
    });
    res.status(201).json({
      user: { id: user.id, email: user.email, role: user.role, business_unit_id: user.business_unit_id, created_at: user.created_at, is_active: false },
      activation_email_sent: emailSent,
      message: emailSent
        ? 'Invitation sent. The user will receive an email to set their password.'
        : 'User created, but the activation email could not be sent. Check SMTP settings or server logs for the link.',
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    console.error('Create user error:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// POST /api/users/:id/resend-activation — new invitation link for a pending user (Admin only).
// Older links stop working as soon as the new one is issued.
router.post('/:id/resend-activation', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const user = await usersDb.getById(pool, req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (user.is_active !== false) {
      return res.status(400).json({ error: 'This account is already activated.' });
    }
    const { emailSent, expiresAt } = await sendActivationInvite(req, user);
    await auditLog(pool, {
      actorId: req.user.id,
      actionType: 'ACTIVATION_RESENT',
      targetEntity: `user:${user.email}`,
      payloadBefore: null,
      payloadAfter: { expires_at: expiresAt },
      ipAddress: getClientIp(req),
    });
    res.json({
      activation_email_sent: emailSent,
      expires_at: expiresAt,
      message: emailSent
        ? `Activation email re-sent to ${user.email}. Earlier links no longer work.`
        : 'A new activation link was created, but the email could not be sent. Check SMTP settings or server logs for the link.',
    });
  } catch (err) {
    console.error('Resend activation error:', err);
    res.status(500).json({ error: 'Failed to resend activation email' });
  }
});

// POST /api/users/:id/unlock — clear lock state (Admin only); must be before PATCH /:id
router.post('/:id/unlock', authMiddleware, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const user = await usersDb.getById(pool, id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    await usersDb.unlockUser(pool, id);
    await auditLog(pool, {
      actorId: req.user.id,
      actionType: 'UNLOCK',
      targetEntity: `user:${user.email}`,
      payloadBefore: null,
      payloadAfter: null,
      ipAddress: getClientIp(req),
    });
    res.json({ message: 'Account unlocked' });
  } catch (err) {
    console.error('Unlock user error:', err);
    res.status(500).json({ error: 'Failed to unlock user' });
  }
});

// POST /api/users/:id/deactivate — soft-delete user (Admin only); must be before PATCH /:id
router.post('/:id/deactivate', authMiddleware, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const before = await usersDb.getById(pool, id);
    if (!before) {
      return res.status(404).json({ error: 'User not found' });
    }
    const ok = await usersDb.softDelete(pool, id);
    if (!ok) {
      return res.status(404).json({ error: 'User not found' });
    }
    await auditLog(pool, {
      actorId: req.user.id,
      actionType: 'DEACTIVATE',
      targetEntity: `user:${before.email}`,
      payloadBefore: before,
      payloadAfter: null,
      ipAddress: getClientIp(req),
    });
    res.json({ message: 'User deactivated' });
  } catch (err) {
    console.error('Deactivate user error:', err);
    res.status(500).json({ error: 'Failed to deactivate user' });
  }
});

// POST /api/users/:id/reset-password — set random password, return it for admin to copy (Admin only)
router.post('/:id/reset-password', authMiddleware, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const before = await usersDb.getById(pool, id);
    if (!before) {
      return res.status(404).json({ error: 'User not found' });
    }
    const temporaryPassword = generateRandomPassword();
    const password_hash = await bcrypt.hash(temporaryPassword, 10);
    await usersDb.updatePassword(pool, id, password_hash);
    await passwordHistoryDb.deleteForUser(pool, id);
    await auditLog(pool, {
      actorId: req.user.id,
      actionType: 'PASSWORD_RESET',
      targetEntity: `user:${before.email}`,
      payloadBefore: null,
      payloadAfter: null,
      ipAddress: getClientIp(req),
    });
    res.json({ message: 'Password reset', temporary_password: temporaryPassword });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// PATCH /api/users/:id — update user's role and/or business_unit_id (Admin only)
router.patch('/:id', authMiddleware, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  const hasBu = Object.prototype.hasOwnProperty.call(body, 'business_unit_id');
  const hasRole = Object.prototype.hasOwnProperty.call(body, 'role');
  if (!hasBu && !hasRole) {
    return res.status(400).json({ error: 'role or business_unit_id required' });
  }

  const validRoles = ['Admin', 'Employee'];
  let roleVal;
  if (hasRole) {
    roleVal = String(body.role);
    if (!validRoles.includes(roleVal)) {
      return res.status(400).json({ error: 'role must be Admin or Employee' });
    }
  }

  let buId;
  if (hasBu) {
    buId = body.business_unit_id === null || body.business_unit_id === undefined || body.business_unit_id === ''
      ? null
      : body.business_unit_id;
    if (buId !== null && typeof buId !== 'string') {
      return res.status(400).json({ error: 'business_unit_id must be a UUID or null' });
    }
  }

  const client = await pool.connect();
  try {
    const before = await usersDb.getById(client, id);
    if (!before) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (hasRole && req.user.id === id && before.role === 'Admin' && roleVal === 'Employee') {
      return res.status(400).json({ error: 'You cannot change your own role' });
    }
    if (hasBu && buId !== null) {
      const bu = await businessUnitsDb.getById(client, buId);
      if (!bu) {
        return res.status(400).json({ error: 'Department not found' });
      }
    }

    const updates = {};
    if (hasRole) updates.role = roleVal;
    if (hasBu) updates.business_unit_id = buId;
    const row = await usersDb.updateProfile(client, id, updates);
    await auditLog(client, {
      actorId: req.user.id,
      actionType: 'UPDATE',
      targetEntity: `user:${row.email}`,
      payloadBefore: before,
      payloadAfter: row,
      ipAddress: getClientIp(req),
    });
    res.json(row);
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ error: 'Failed to update user' });
  } finally {
    client.release();
  }
});

module.exports = router;
