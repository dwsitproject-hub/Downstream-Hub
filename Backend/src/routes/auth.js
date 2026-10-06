/**
 * Auth: register, login.
 * Uses usersDb and allowedDomainsDb (excludes soft-deleted).
 * Rate limiting applied to login and register to reduce brute-force and abuse.
 */
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const ipKeyGenerator = rateLimit.ipKeyGenerator;
const bcrypt = require('bcryptjs');
const { pool } = require('../db/pool');
const allowedDomainsDb = require('../db/allowedDomainsDb');
const businessUnitsDb = require('../db/businessUnitsDb');
const passwordPolicyDb = require('../db/passwordPolicyDb');
const passwordHistoryDb = require('../db/passwordHistoryDb');
const passwordResetDb = require('../db/passwordResetDb');
const accountActivationDb = require('../db/accountActivationDb');
const usersDb = require('../db/usersDb');
const ssoLinkDb = require('../db/ssoLinkDb');
const authSessionsDb = require('../db/authSessionsDb');
const mfaDb = require('../db/mfaDb');
const magicLinkDb = require('../db/magicLinkDb');
const ssoLinkService = require('../services/ssoLinkService');
const { validatePassword, passwordRequirementsFromPolicy } = require('../lib/passwordValidation');
const deviceTrust = require('../lib/deviceTrust');
const { authMiddleware } = require('../middleware/auth');
const { auditLog, getClientIp } = require('../middleware/audit');
const mailer = require('../lib/mailer');
const { isSafeSsoReturnTo } = require('../lib/ssoReturnTo');

const router = express.Router();
const SESSION_COOKIE = process.env.AUTH_SESSION_COOKIE || 'hub_session';
const CSRF_COOKIE = process.env.AUTH_CSRF_COOKIE || 'hub_csrf';
const SESSION_TTL_MS = Math.max(10 * 60 * 1000, parseInt(process.env.AUTH_SESSION_TTL_MS || '86400000', 10));

function isOpenRegistrationEnabled() {
  const v = process.env.OPEN_REGISTRATION;
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return process.env.NODE_ENV === 'test';
}
const MFA_CHALLENGE_TTL_SECONDS = Math.max(60, parseInt(process.env.MFA_CHALLENGE_TTL_SECONDS || '300', 10));
const MFA_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.MFA_MAX_ATTEMPTS || '5', 10));
const MFA_ENABLED = process.env.MFA_ENABLED === '1';

function isLoginMfaEnabled() {
  return process.env.LOGIN_MFA_ENABLED !== '0' && process.env.LOGIN_MFA_ENABLED !== 'false';
}
const LOGIN_MAGIC_LINK_TTL_MINUTES = Math.max(5, Math.min(60, parseInt(process.env.LOGIN_MAGIC_LINK_TTL_MINUTES || '15', 10)));
const LOGIN_MAGIC_LINK_TTL_MS = LOGIN_MAGIC_LINK_TTL_MINUTES * 60 * 1000;
const SSO_LINK_AUTO_EMAIL_VERIFY_ENABLED = process.env.SSO_LINK_AUTO_EMAIL_VERIFY_ENABLED !== '0';

function cookieSecureFlag(req) {
  if (process.env.AUTH_COOKIE_SECURE === '1') return true;
  if (process.env.AUTH_COOKIE_SECURE === '0') return false;
  if (req) {
    if (req.secure) return true;
    const proto = req.headers['x-forwarded-proto'];
    if (proto) {
      return String(proto).split(',')[0].trim().toLowerCase() === 'https';
    }
  }
  return false;
}

function setSessionCookies(req, res, sessionToken, csrfToken) {
  const secure = cookieSecureFlag(req);
  const sameSite = secure ? 'none' : 'lax';
  const base = {
    secure,
    sameSite,
    path: '/',
    maxAge: SESSION_TTL_MS,
  };
  res.cookie(SESSION_COOKIE, sessionToken, { ...base, httpOnly: true });
  res.cookie(CSRF_COOKIE, csrfToken, { ...base, httpOnly: false });
}

function clearSessionCookies(req, res) {
  const secure = cookieSecureFlag(req);
  const sameSite = secure ? 'none' : 'lax';
  res.clearCookie(SESSION_COOKIE, { path: '/', secure, sameSite });
  res.clearCookie(CSRF_COOKIE, { path: '/', secure, sameSite });
}

function generateSessionToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function deviceHashFromRequest(req) {
  const raw = deviceTrust.readDeviceToken(req);
  if (raw) return deviceTrust.deviceHashFromToken(raw);
  return null;
}

function publicAppBase() {
  return (process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

async function issueFullSession(req, res, user, auditAction = 'LOGIN') {
  const sessionToken = generateSessionToken();
  const csrfToken = generateSessionToken();
  await authSessionsDb.create(pool, {
    userId: user.id,
    sessionToken,
    csrfToken,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  setSessionCookies(req, res, sessionToken, csrfToken);
  const client = await pool.connect();
  try {
    await auditLog(client, {
      actorId: user.id,
      actionType: auditAction,
      targetEntity: user.email,
      payloadBefore: null,
      payloadAfter: null,
      ipAddress: getClientIp(req),
    });
  } finally {
    client.release();
  }
  return {
    user: { id: user.id, email: user.email, role: user.role, business_unit_id: user.business_unit_id },
  };
}

async function trustDeviceFromRequest(req, res, user) {
  let rawDevice = deviceTrust.readDeviceToken(req);
  if (!rawDevice) {
    rawDevice = deviceTrust.generateDeviceToken();
    deviceTrust.setDeviceCookie(req, res, rawDevice);
  }
  const deviceHash = deviceTrust.deviceHashFromToken(rawDevice);
  await mfaDb.upsertTrustedDevice(pool, {
    userId: user.id,
    deviceHash,
    ipAddress: getClientIp(req),
    expiresAt: deviceTrust.deviceExpiresAt(),
    lastVerifiedAt: new Date(),
  });
  await mfaDb.updateLastMfaVerifiedAt(pool, user.id);
  return deviceHash;
}

async function sendLoginMagicLink(req, user, { returnTo, clientId } = {}) {
  await magicLinkDb.invalidatePendingForUser(pool, user.id);
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(rawToken);
  const pendingId = crypto.randomUUID();
  const pendingLoginHash = hashToken(pendingId);
  const expiresAt = new Date(Date.now() + LOGIN_MAGIC_LINK_TTL_MS);
  await magicLinkDb.insert(pool, {
    userId: user.id,
    tokenHash,
    expiresAt,
    requestIp: getClientIp(req),
    pendingLoginHash,
  });
  const loginUrlObj = new URL(`${publicAppBase()}/magic-link-login`);
  loginUrlObj.searchParams.set('token', rawToken);
  if (returnTo && isSafeSsoReturnTo(returnTo)) {
    loginUrlObj.searchParams.set('returnTo', returnTo);
  }
  if (clientId) {
    loginUrlObj.searchParams.set('client_id', String(clientId).trim());
  }
  const loginUrl = loginUrlObj.toString();
  try {
    await mailer.sendLoginMagicLinkEmail({
      to: user.email,
      loginUrl,
      ttlMinutes: LOGIN_MAGIC_LINK_TTL_MINUTES,
    });
  } catch (mailErr) {
    console.error('Login magic link email error:', mailErr.message);
  }
  const client = await pool.connect();
  try {
    await auditLog(client, {
      actorId: user.id,
      actionType: 'LOGIN_MFA_MAGIC_LINK_SENT',
      targetEntity: user.email,
      payloadBefore: null,
      payloadAfter: { expires_in: LOGIN_MAGIC_LINK_TTL_MS / 1000 },
      ipAddress: getClientIp(req),
    });
  } finally {
    client.release();
  }
  return { pendingId, expiresIn: Math.floor(LOGIN_MAGIC_LINK_TTL_MS / 1000) };
}

const MAGIC_LINK_INVALID_ERROR =
  'This sign-in link is no longer valid. Use the latest email or sign in again.';

async function classifyMagicLinkFailure(rawToken) {
  const tokenHash = hashToken(rawToken);
  const row = await magicLinkDb.findByHash(pool, tokenHash);
  if (!row) return { reason: 'not_found' };
  if (row.used_at) {
    const superseded = await magicLinkDb.hasNewerTokenForUser(pool, row.user_id, row.created_at);
    return { reason: superseded ? 'superseded' : 'reused', row };
  }
  if (new Date(row.expires_at) <= new Date()) return { reason: 'expired', row };
  return { reason: 'invalid', row };
}

async function auditMagicLinkVerifyFailure(req, failure) {
  let userEmail = null;
  const userId = failure.row?.user_id || null;
  if (userId) {
    const user = await usersDb.getById(pool, userId);
    userEmail = user?.email || null;
  }
  const client = await pool.connect();
  try {
    await auditLog(client, {
      actorId: userId,
      actionType: 'LOGIN_MFA_MAGIC_LINK_FAIL',
      targetEntity: userEmail,
      payloadBefore: null,
      payloadAfter: {
        reason: failure.reason,
        token_id: failure.row?.id || null,
      },
      ipAddress: getClientIp(req),
    });
  } catch (err) {
    console.error('Magic link verify audit log error:', err.message);
  } finally {
    client.release();
  }
}

async function rejectMagicLinkVerify(req, res, failure) {
  await auditMagicLinkVerifyFailure(req, failure);
  return res.status(400).json({
    error: MAGIC_LINK_INVALID_ERROR,
    code: 'MAGIC_LINK_INVALID',
  });
}

async function tryLegacyOtpMfa(req, res, user, policy) {
  if (!(MFA_ENABLED && user.mfa_enabled && user.mfa_method === 'email_otp')) return false;
  const deviceHash = deviceHashFromRequest(req);
  const trusted = deviceHash
    ? await mfaDb.getTrustedDevice(pool, { userId: user.id, deviceHash })
    : null;
  const risk = evaluateRisk({ knownDevice: !!trusted, req });
  const needsPeriodicMfa = !user.last_mfa_verified_at || (
    Date.now() - new Date(user.last_mfa_verified_at).getTime() >
    (policy.mfa_reverify_days || 14) * 24 * 60 * 60 * 1000
  );
  const needsRiskMfa = risk.score >= (policy.mfa_risk_threshold || 50);
  if (!(needsPeriodicMfa || needsRiskMfa)) return false;

  const challengeId = crypto.randomUUID();
  const otp = generateOtpCode();
  await mfaDb.createChallenge(pool, {
    userId: user.id,
    reason: needsRiskMfa ? 'risk' : 'periodic',
    challengeId,
    otpHash: hashOtp(otp),
    expiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_SECONDS * 1000),
    maxAttempts: MFA_MAX_ATTEMPTS,
  });
  await mfaDb.insertRiskEvent(pool, {
    userId: user.id,
    email: user.email,
    ipAddress: getClientIp(req),
    userAgent: req.headers['user-agent'] || '',
    deviceHash: deviceHash || 'unknown',
    riskScore: risk.score,
    reasons: risk.reasons,
    decision: needsRiskMfa ? 'MFA_REQUIRED_RISK' : 'MFA_REQUIRED_PERIODIC',
  });
  try {
    await mailer.sendOtpEmail({ to: user.email, otp, ttlSeconds: MFA_CHALLENGE_TTL_SECONDS });
  } catch (mailErr) {
    console.error('MFA OTP email error:', mailErr.message);
  }
  res.status(202).json({
    mfa_required: true,
    challenge_id: challengeId,
    expires_in: MFA_CHALLENGE_TTL_SECONDS,
    reason: needsRiskMfa ? 'risk' : 'periodic',
  });
  return true;
}

function generateOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function hashOtp(raw) {
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

function evaluateRisk({ knownDevice, req }) {
  let score = 0;
  const reasons = [];
  if (!knownDevice) {
    score += 40;
    reasons.push('new_device');
  }
  const ip = getClientIp(req) || '';
  if (ip && !ip.startsWith('10.') && !ip.startsWith('192.168.') && !ip.startsWith('127.')) {
    score += 10;
    reasons.push('non_private_network');
  }
  const hour = new Date().getHours();
  if (hour < 5 || hour > 22) {
    score += 10;
    reasons.push('odd_login_hour');
  }
  return { score, reasons };
}

const FORGOT_PASSWORD_MESSAGE =
  'If an account is associated with this email, you will receive instructions shortly.';

const isTest = process.env.NODE_ENV === 'test';
const loginLimit = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_LOGIN_WINDOW_MS || '900000', 10),
  max: isTest ? 10000 : Math.max(1, parseInt(process.env.RATE_LIMIT_LOGIN_MAX || '20', 10)),
  message: { error: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const registerLimit = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_REGISTER_WINDOW_MS || '900000', 10),
  max: isTest ? 10000 : Math.max(1, parseInt(process.env.RATE_LIMIT_REGISTER_MAX || '5', 10)),
  message: { error: 'Too many registration attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const forgotPasswordLimit = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_FORGOT_PASSWORD_WINDOW_MS || '900000', 10),
  max: isTest ? 10000 : Math.max(1, parseInt(process.env.RATE_LIMIT_FORGOT_PASSWORD_MAX || '5', 10)),
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const rawIp = req.ip || req.socket?.remoteAddress || 'unknown';
    const ip = ipKeyGenerator(rawIp);
    const email = String(req.body?.email || '')
      .trim()
      .toLowerCase();
    return `${ip}:${email || 'no-email'}`;
  },
});

const magicLinkResendLimit = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_MAGIC_LINK_RESEND_WINDOW_MS || '900000', 10),
  max: isTest ? 10000 : Math.max(1, parseInt(process.env.RATE_LIMIT_MAGIC_LINK_RESEND_MAX || '3', 10)),
  message: { error: 'Too many resend attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const rawIp = req.ip || req.socket?.remoteAddress || 'unknown';
    const ip = ipKeyGenerator(rawIp);
    const email = String(req.body?.email || '').trim().toLowerCase();
    return `magic-resend:${ip}:${email || 'no-email'}`;
  },
});

const magicLinkVerifyLimit = rateLimit({
  windowMs: 60 * 1000,
  max: isTest ? 10000 : Math.max(1, parseInt(process.env.RATE_LIMIT_MAGIC_LINK_VERIFY_MAX || '10', 10)),
  message: { error: 'Too many verification attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// GET /api/auth/password-requirements — public password rules for forms
router.get('/password-requirements', async (req, res) => {
  try {
    const policy = await passwordPolicyDb.get(pool);
    res.json(passwordRequirementsFromPolicy(policy));
  } catch (err) {
    console.error('Password requirements error:', err);
    res.status(500).json({ error: 'Failed to load password requirements' });
  }
});

// GET /api/auth/registration-options — only when open registration is enabled
router.get('/registration-options', async (req, res) => {
  if (!isOpenRegistrationEnabled()) {
    return res.status(403).json({ error: 'Registration is disabled. Contact an administrator.' });
  }
  try {
    const business_units = await businessUnitsDb.list(pool);
    res.json({ business_units: business_units.map((bu) => ({ id: bu.id, name: bu.name })) });
  } catch (err) {
    console.error('Registration options error:', err);
    res.status(500).json({ error: 'Failed to load registration options' });
  }
});

// POST /api/auth/register
router.post('/register', registerLimit, async (req, res) => {
  if (!isOpenRegistrationEnabled()) {
    return res.status(403).json({ error: 'Registration is disabled. Contact an administrator.' });
  }
  try {
    const { email, password, password_retype, business_unit_id } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    if (password !== password_retype) {
      return res.status(400).json({ error: 'Password and confirm password do not match' });
    }
    const emailNorm = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    const policy = await passwordPolicyDb.get(pool);
    const pv = validatePassword(password, policy);
    if (!pv.valid) {
      return res.status(400).json({ error: pv.error });
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
        return res.status(400).json({ error: 'Invalid department' });
      }
      buId = bu.id;
    }
    const password_hash = await bcrypt.hash(password, 10);
    const n = await usersDb.countActive(pool);
    const role = n === 0 ? 'Admin' : 'Employee';
    const user = await usersDb.create(pool, { email: emailNorm, password_hash, role, business_unit_id: buId });
    const session = await issueFullSession(req, res, user, 'REGISTER');
    res.status(201).json(session);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

function parseSsoResumeFromBody(body) {
  const returnTo = String(body?.return_to || '').trim();
  const clientId = String(body?.client_id || '').trim();
  return {
    returnTo: returnTo && isSafeSsoReturnTo(returnTo) ? returnTo : null,
    clientId: clientId || null,
  };
}

// POST /api/auth/login
router.post('/login', loginLimit, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const ssoResume = parseSsoResumeFromBody(req.body);
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    const emailNorm = String(email).trim().toLowerCase();
    const user = await usersDb.getByEmail(pool, emailNorm);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (user.is_active === false) {
      return res.status(403).json({
        error: 'Your account is not activated yet. Please use the activation link sent to your email.',
        code: 'ACCOUNT_NOT_ACTIVATED',
      });
    }
    const policy = await passwordPolicyDb.get(pool);
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(423).json({ error: 'Account locked', code: 'ACCOUNT_LOCKED', locked_until: user.locked_until });
    }
    if (!(await bcrypt.compare(password, user.password_hash))) {
      await usersDb.incrementFailedLogin(pool, user.id, policy.max_login_attempts, policy.lockout_duration_mins);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    await usersDb.resetFailedLogin(pool, user.id);
    if (policy.password_expiry_days > 0) {
      const changedAt = user.password_changed_at ? new Date(user.password_changed_at).getTime() : 0;
      const expiryMs = policy.password_expiry_days * 24 * 60 * 60 * 1000;
      if (!changedAt || Date.now() - changedAt > expiryMs) {
        return res.status(403).json({ error: 'Password expired', code: 'PASSWORD_EXPIRED' });
      }
    }

    if (await tryLegacyOtpMfa(req, res, user, policy)) return;

    if (isLoginMfaEnabled()) {
      const deviceHash = deviceHashFromRequest(req);
      const trusted = deviceHash
        ? await mfaDb.getTrustedDevice(pool, { userId: user.id, deviceHash })
        : null;
      if (trusted && deviceTrust.canBypassMfa(trusted, policy)) {
        await mfaDb.touchTrustedDevice(pool, {
          userId: user.id,
          deviceHash,
          ipAddress: getClientIp(req),
        });
        await mfaDb.updateLastMfaVerifiedAt(pool, user.id);
        const session = await issueFullSession(req, res, user, 'LOGIN_MFA_BYPASS');
        return res.json(session);
      }

      const { pendingId, expiresIn } = await sendLoginMagicLink(req, user, ssoResume);
      return res.status(202).json({
        magic_link_required: true,
        pending_id: pendingId,
        expires_in: expiresIn,
        message: 'Check your email for a sign-in link.',
      });
    }

    const session = await issueFullSession(req, res, user, 'LOGIN');
    return res.json(session);
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/oidc/auto-link/start
// Entry point for future OIDC callback integration: trigger email-verified linking for a local account.
router.post('/oidc/auto-link/start', async (req, res) => {
  try {
    if (!SSO_LINK_AUTO_EMAIL_VERIFY_ENABLED) {
      return res.status(400).json({ error: 'linking_disabled' });
    }
    const email = ssoLinkService.normalizeEmail(req.body?.email);
    const oidcSub = ssoLinkService.normalizeSubject(req.body?.oidc_sub);
    if (!email || !oidcSub) return res.status(400).json({ error: 'email and oidc_sub are required' });
    const user = await usersDb.getByEmail(pool, email);
    if (!user) return res.status(404).json({ error: 'user_not_found' });
    if (user.oidc_sub && user.oidc_sub === oidcSub) {
      return res.json({ message: 'already_linked' });
    }
    const existing = await ssoLinkDb.getByOidcSub(pool, oidcSub);
    if (existing && existing.id !== user.id) {
      return res.status(409).json({ error: 'oidc_sub_already_linked' });
    }
    const created = await ssoLinkService.createEmailVerification(pool, {
      actorId: null,
      user,
      subject: oidcSub,
      mode: 'auto_email_verify',
    });
    const publicBase = (process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    const verifyUrl = `${publicBase}/login?sso_verify=${encodeURIComponent(created.tokenRaw)}`;
    try {
      await mailer.sendSsoLinkVerificationEmail({ to: user.email, verifyUrl });
    } catch (mailErr) {
      console.error('Auto-link verification email error:', mailErr.message);
    }
    return res.status(202).json({ message: 'verification_sent' });
  } catch (err) {
    console.error('Auto-link start error:', err);
    return res.status(500).json({ error: 'auto_link_start_failed' });
  }
});

// GET /api/auth/oidc/auto-link/verify?token=...
router.get('/oidc/auto-link/verify', async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    if (!token) return res.status(400).json({ error: 'token required' });
    const result = await ssoLinkService.consumeEmailVerificationAndLink(pool, { actorId: null, tokenRaw: token });
    if (!result.ok) return res.status(400).json({ error: result.code });
    return res.json({ message: 'linked' });
  } catch (err) {
    console.error('Auto-link verify error:', err);
    return res.status(500).json({ error: 'auto_link_verify_failed' });
  }
});

// POST /api/auth/mfa/verify — completes pending challenge and issues full session
router.post('/mfa/verify', async (req, res) => {
  try {
    const challengeId = String(req.body?.challenge_id || '').trim();
    const otp = String(req.body?.otp || '').trim();
    if (!challengeId || !otp) return res.status(400).json({ error: 'challenge_id and otp are required' });

    const challenge = await mfaDb.getActiveChallenge(pool, challengeId);
    if (!challenge) return res.status(400).json({ error: 'Invalid or expired challenge' });
    const attempt = await mfaDb.markChallengeAttempt(pool, challenge.id);
    if (attempt && attempt.attempts > attempt.max_attempts) {
      return res.status(429).json({ error: 'Too many attempts' });
    }
    if (hashOtp(otp) !== challenge.otp_hash) {
      return res.status(401).json({ error: 'Invalid verification code' });
    }

    await mfaDb.consumeChallenge(pool, challenge.id);
    await mfaDb.updateLastMfaVerifiedAt(pool, challenge.user_id);

    const user = await usersDb.getById(pool, challenge.user_id);
    if (!user) return res.status(400).json({ error: 'User not found' });
    await trustDeviceFromRequest(req, res, user);
    const session = await issueFullSession(req, res, user, 'LOGIN');
    return res.json(session);
  } catch (err) {
    console.error('MFA verify error:', err);
    return res.status(500).json({ error: 'Failed to verify code' });
  }
});

// GET /api/auth/magic-link/token-info?token= — public; does not reveal user identity
router.get('/magic-link/token-info', async (req, res) => {
  try {
    const raw = req.query.token;
    if (!raw || typeof raw !== 'string') return res.json({ valid: false });
    const row = await magicLinkDb.findActiveByHash(pool, hashToken(raw));
    if (!row) return res.json({ valid: false });
    return res.json({ valid: true, expires_in: Math.max(0, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000)) });
  } catch (err) {
    console.error('Magic link token info error:', err);
    return res.json({ valid: false });
  }
});

// POST /api/auth/magic-link/verify — consume login magic link and issue session
router.post('/magic-link/verify', magicLinkVerifyLimit, async (req, res) => {
  try {
    const rawToken = String(req.body?.token || '').trim();
    if (!rawToken) return res.status(400).json({ error: 'token required' });

    const tokenHash = hashToken(rawToken);
    const row = await magicLinkDb.findActiveByHash(pool, tokenHash);
    if (!row) {
      const failure = await classifyMagicLinkFailure(rawToken);
      return rejectMagicLinkVerify(req, res, failure);
    }

    const user = await usersDb.getById(pool, row.user_id);
    if (!user) {
      return rejectMagicLinkVerify(req, res, { reason: 'user_not_found', row });
    }
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(423).json({ error: 'Account locked', code: 'ACCOUNT_LOCKED', locked_until: user.locked_until });
    }
    const policy = await passwordPolicyDb.get(pool);
    if (policy.password_expiry_days > 0) {
      const changedAt = user.password_changed_at ? new Date(user.password_changed_at).getTime() : 0;
      const expiryMs = policy.password_expiry_days * 24 * 60 * 60 * 1000;
      if (!changedAt || Date.now() - changedAt > expiryMs) {
        return res.status(403).json({ error: 'Password expired', code: 'PASSWORD_EXPIRED' });
      }
    }

    await magicLinkDb.markUsed(pool, row.id);
    await magicLinkDb.invalidatePendingForUser(pool, user.id);
    await trustDeviceFromRequest(req, res, user);

    const session = await issueFullSession(req, res, user, 'LOGIN_MFA_MAGIC_LINK_VERIFIED');
    return res.json(session);
  } catch (err) {
    console.error('Magic link verify error:', err);
    return res.status(500).json({ error: 'Failed to complete sign-in' });
  }
});

// POST /api/auth/magic-link/resend — re-validates password and sends a fresh link
router.post('/magic-link/resend', magicLinkResendLimit, loginLimit, async (req, res) => {
  try {
    const { email, password, pending_id: pendingId } = req.body || {};
    const ssoResume = parseSsoResumeFromBody(req.body);
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    const emailNorm = String(email).trim().toLowerCase();
    const user = await usersDb.getByEmail(pool, emailNorm);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (user.is_active === false) {
      return res.status(403).json({
        error: 'Your account is not activated yet. Please use the activation link sent to your email.',
        code: 'ACCOUNT_NOT_ACTIVATED',
      });
    }
    const policy = await passwordPolicyDb.get(pool);
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(423).json({ error: 'Account locked', code: 'ACCOUNT_LOCKED', locked_until: user.locked_until });
    }
    if (!(await bcrypt.compare(password, user.password_hash))) {
      await usersDb.incrementFailedLogin(pool, user.id, policy.max_login_attempts, policy.lockout_duration_mins);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (pendingId) {
      const pendingHash = hashToken(String(pendingId).trim());
      const pending = await magicLinkDb.findActiveByPendingLoginHash(pool, pendingHash);
      if (!pending || pending.user_id !== user.id) {
        return res.status(400).json({ error: 'Invalid or expired pending login' });
      }
    }

    const { pendingId: newPendingId, expiresIn } = await sendLoginMagicLink(req, user, ssoResume);
    return res.status(202).json({
      magic_link_required: true,
      pending_id: newPendingId,
      expires_in: expiresIn,
      message: 'A new sign-in link has been sent to your email.',
    });
  } catch (err) {
    console.error('Magic link resend error:', err);
    return res.status(500).json({ error: 'Failed to resend sign-in link' });
  }
});

// POST /api/auth/logout — revoke cookie session
router.post('/logout', async (req, res) => {
  try {
    const src = req.headers.cookie || '';
    const map = src.split(';').reduce((acc, p) => {
      const [k, ...rest] = p.split('=');
      if (k && rest.length) acc[k.trim()] = decodeURIComponent(rest.join('=').trim());
      return acc;
    }, {});
    const sessionToken = map[SESSION_COOKIE];
    if (sessionToken) await authSessionsDb.revokeBySessionToken(pool, sessionToken);
  } catch (err) {
    console.error('Logout revoke warning:', err.message);
  }
  clearSessionCookies(req, res);
  res.json({ message: 'Signed out' });
});

// POST /api/auth/change-password-expired — no auth; for users blocked by password expiry
router.post('/change-password-expired', async (req, res) => {
  try {
    const { email, current_password, new_password, new_password_retype } = req.body || {};
    if (!email || !current_password || !new_password || !new_password_retype) {
      return res.status(400).json({ error: 'Email, current password, new password and confirm are required' });
    }
    if (new_password !== new_password_retype) {
      return res.status(400).json({ error: 'New password and confirm do not match' });
    }
    const policy = await passwordPolicyDb.get(pool);
    const pv = validatePassword(new_password, policy);
    if (!pv.valid) return res.status(400).json({ error: pv.error });
    const emailNorm = String(email).trim().toLowerCase();
    const user = await usersDb.getByEmail(pool, emailNorm);
    if (!user || !(await bcrypt.compare(current_password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or current password' });
    }
    if (policy.password_expiry_days <= 0) {
      return res.status(400).json({ error: 'Password expiry is not enabled' });
    }
    const changedAt = user.password_changed_at ? new Date(user.password_changed_at).getTime() : 0;
    const expiryMs = policy.password_expiry_days * 24 * 60 * 60 * 1000;
    if (changedAt && Date.now() - changedAt <= expiryMs) {
      return res.status(400).json({ error: 'Password is not expired; use normal login' });
    }
    if (policy.password_history_count > 0) {
      if (await bcrypt.compare(new_password, user.password_hash)) {
        return res.status(400).json({ error: 'Cannot reuse a recent password' });
      }
      const history = await passwordHistoryDb.getHashesForUser(pool, user.id, policy.password_history_count);
      for (const row of history) {
        if (await bcrypt.compare(new_password, row.password_hash)) {
          return res.status(400).json({ error: 'Cannot reuse a recent password' });
        }
      }
      const currentHash = user.password_hash;
      const password_hash = await bcrypt.hash(new_password, 10);
      await usersDb.updatePassword(pool, user.id, password_hash);
      await passwordHistoryDb.add(pool, user.id, currentHash);
      await passwordHistoryDb.trimToLimit(pool, user.id, policy.password_history_count);
    } else {
      const password_hash = await bcrypt.hash(new_password, 10);
      await usersDb.updatePassword(pool, user.id, password_hash);
    }
    const session = await issueFullSession(req, res, user, 'PASSWORD_CHANGE');
    res.json({ message: 'Password updated', ...session });
  } catch (err) {
    console.error('Change password expired error:', err);
    res.status(500).json({ error: 'Failed to update password' });
  }
});

// POST /api/auth/change-password — authenticated user changes own password
router.post('/change-password', authMiddleware, async (req, res) => {
  try {
    const { current_password, new_password, new_password_retype } = req.body || {};
    if (!current_password || !new_password || !new_password_retype) {
      return res.status(400).json({ error: 'Current password, new password and confirm are required' });
    }
    if (new_password !== new_password_retype) {
      return res.status(400).json({ error: 'New password and confirm do not match' });
    }
    const policy = await passwordPolicyDb.get(pool);
    const pv = validatePassword(new_password, policy);
    if (!pv.valid) return res.status(400).json({ error: pv.error });
    const user = await usersDb.getByEmail(pool, req.user.email);
    if (!user || !(await bcrypt.compare(current_password, user.password_hash))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    if (policy.password_history_count > 0) {
      const history = await passwordHistoryDb.getHashesForUser(pool, req.user.id, policy.password_history_count);
      for (const row of history) {
        if (await bcrypt.compare(new_password, row.password_hash)) {
          return res.status(400).json({ error: 'Cannot reuse a recent password' });
        }
      }
      if (await bcrypt.compare(new_password, user.password_hash)) {
        return res.status(400).json({ error: 'Cannot reuse a recent password' });
      }
      const currentHash = user.password_hash;
      const password_hash = await bcrypt.hash(new_password, 10);
      await usersDb.updatePassword(pool, req.user.id, password_hash);
      await passwordHistoryDb.add(pool, req.user.id, currentHash);
      await passwordHistoryDb.trimToLimit(pool, req.user.id, policy.password_history_count);
    } else {
      const password_hash = await bcrypt.hash(new_password, 10);
      await usersDb.updatePassword(pool, req.user.id, password_hash);
    }
    const client = await pool.connect();
    try {
      await auditLog(client, {
        actorId: req.user.id,
        actionType: 'PASSWORD_CHANGE',
        targetEntity: `user:${req.user.email}`,
        payloadBefore: null,
        payloadAfter: null,
        ipAddress: getClientIp(req),
      });
    } finally {
      client.release();
    }
    res.json({ message: 'Password updated' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Failed to update password' });
  }
});

// GET /api/auth/reset-token-info?token= — public; does not reveal user identity
router.get('/reset-token-info', async (req, res) => {
  try {
    const raw = req.query.token;
    if (!raw || typeof raw !== 'string') {
      return res.json({ valid: false });
    }
    const tokenHash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
    const row = await passwordResetDb.findActiveByHash(pool, tokenHash);
    if (!row) return res.json({ valid: false });
    if (new Date(row.expires_at) < new Date()) return res.json({ valid: false });
    return res.json({ valid: true });
  } catch (err) {
    console.error('Reset token info error:', err);
    return res.json({ valid: false });
  }
});

// POST /api/auth/forgot-password — generic response; rate limited (IP + email)
router.post('/forgot-password', forgotPasswordLimit, async (req, res) => {
  try {
    const raw = req.body?.email;
    const emailNorm = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    const ip = getClientIp(req);

    if (process.env.NODE_ENV === 'development') {
      console.info('[auth] forgot-password: request received');
    }

    if (emailNorm && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) {
      const user = await usersDb.getByEmail(pool, emailNorm);
      if (user) {
        const rawToken = crypto.randomBytes(32).toString('base64url');
        const tokenHash = crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
        const ttlMin = Math.max(5, Math.min(120, parseInt(process.env.PASSWORD_RESET_TTL_MINUTES || '30', 10)));
        const expiresAt = new Date(Date.now() + ttlMin * 60 * 1000);
        await passwordResetDb.insert(pool, {
          userId: user.id,
          tokenHash,
          expiresAt,
          requestIp: ip,
        });
        const publicBase = (process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || 'http://localhost:3000').replace(
          /\/$/,
          ''
        );
        const resetUrl = `${publicBase}/reset-password?token=${encodeURIComponent(rawToken)}`;
        try {
          await mailer.sendPasswordResetEmail({ to: emailNorm, resetUrl });
        } catch (mailErr) {
          console.error('Password reset email error:', mailErr.message);
        }
        const client = await pool.connect();
        try {
          await auditLog(client, {
            actorId: null,
            actionType: 'PASSWORD_RESET_REQUEST',
            targetEntity: `email:${emailNorm}`,
            payloadBefore: null,
            payloadAfter: null,
            ipAddress: ip,
          });
        } finally {
          client.release();
        }
      } else if (process.env.FORGOT_PASSWORD_DEBUG === '1') {
        console.info('[auth] forgot-password: no user in DB for this email (no mail sent; response is still generic)');
      }
    }
    return res.status(200).json({ message: FORGOT_PASSWORD_MESSAGE });
  } catch (err) {
    console.error('Forgot password error:', err);
    return res.status(200).json({ message: FORGOT_PASSWORD_MESSAGE });
  }
});

// POST /api/auth/reset-password — no auth; does not return session token
router.post('/reset-password', async (req, res) => {
  const { token: rawToken, new_password, new_password_retype } = req.body || {};
  if (!rawToken || typeof rawToken !== 'string') {
    return res.status(400).json({ error: 'Reset token required' });
  }
  if (!new_password || !new_password_retype) {
    return res.status(400).json({ error: 'New password and confirmation are required' });
  }
  if (new_password !== new_password_retype) {
    return res.status(400).json({ error: 'New password and confirm do not match' });
  }

  const client = await pool.connect();
  try {
    const tokenHash = crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
    await client.query('BEGIN');
    const row = await passwordResetDb.findActiveByHash(client, tokenHash);
    if (!row || new Date(row.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      const ip = getClientIp(req);
      const ac = await pool.connect();
      try {
        await auditLog(ac, {
          actorId: null,
          actionType: 'PASSWORD_RESET_FAIL',
          targetEntity: 'reset-password',
          payloadBefore: null,
          payloadAfter: null,
          ipAddress: ip,
        });
      } catch {
        /* ignore */
      } finally {
        ac.release();
      }
      return res.status(400).json({ error: 'Invalid or expired reset link' });
    }

    const user = await usersDb.getById(client, row.user_id);
    if (!user) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid or expired reset link' });
    }

    const policy = await passwordPolicyDb.get(client);
    const pv = validatePassword(new_password, policy);
    if (!pv.valid) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: pv.error });
    }

    if (policy.password_history_count > 0) {
      const fullUser = await usersDb.getByEmail(client, user.email);
      if (await bcrypt.compare(new_password, fullUser.password_hash)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Cannot reuse a recent password' });
      }
      const history = await passwordHistoryDb.getHashesForUser(client, user.id, policy.password_history_count);
      for (const h of history) {
        if (await bcrypt.compare(new_password, h.password_hash)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Cannot reuse a recent password' });
        }
      }
      const currentHash = fullUser.password_hash;
      const password_hash = await bcrypt.hash(new_password, 10);
      await usersDb.updatePassword(client, user.id, password_hash);
      await passwordHistoryDb.add(client, user.id, currentHash);
      await passwordHistoryDb.trimToLimit(client, user.id, policy.password_history_count);
    } else {
      const password_hash = await bcrypt.hash(new_password, 10);
      await usersDb.updatePassword(client, user.id, password_hash);
    }

    await passwordResetDb.markUsed(client, row.id);
    await passwordResetDb.invalidatePendingForUser(client, user.id);
    await client.query('COMMIT');

    const ip = getClientIp(req);
    const logClient = await pool.connect();
    try {
      await auditLog(logClient, {
        actorId: user.id,
        actionType: 'PASSWORD_RESET_COMPLETE',
        targetEntity: `user:${user.email}`,
        payloadBefore: null,
        payloadAfter: null,
        ipAddress: ip,
      });
    } finally {
      logClient.release();
    }

    try {
      await mailer.sendPasswordChangedEmail({ to: user.email });
    } catch (mailErr) {
      console.error('Password changed email error:', mailErr.message);
    }

    return res.json({
      message: 'Password updated. Please sign in with your new password.',
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    console.error('Reset password error:', err);
    return res.status(500).json({ error: 'Failed to reset password' });
  } finally {
    client.release();
  }
});

// GET /api/auth/activate-account/token-info — validate an invitation token (no auth)
router.get('/activate-account/token-info', async (req, res) => {
  try {
    const raw = req.query.token;
    if (!raw || typeof raw !== 'string') return res.json({ valid: false });
    const tokenHash = hashToken(raw);
    const row = await accountActivationDb.findActiveByHash(pool, tokenHash);
    if (!row || new Date(row.expires_at) < new Date()) return res.json({ valid: false });
    const user = await usersDb.getById(pool, row.user_id);
    if (!user) return res.json({ valid: false });
    return res.json({ valid: true, email: user.email });
  } catch (err) {
    console.error('Activation token info error:', err);
    return res.json({ valid: false });
  }
});

// POST /api/auth/activate-account — set first password, activate, and sign in (no prior auth)
router.post('/activate-account', async (req, res) => {
  const { token: rawToken, new_password, new_password_retype } = req.body || {};
  if (!rawToken || typeof rawToken !== 'string') {
    return res.status(400).json({ error: 'Activation token required' });
  }
  if (!new_password || !new_password_retype) {
    return res.status(400).json({ error: 'Password and confirmation are required' });
  }
  if (new_password !== new_password_retype) {
    return res.status(400).json({ error: 'Password and confirm do not match' });
  }

  const client = await pool.connect();
  let activatedUser = null;
  try {
    const tokenHash = hashToken(rawToken);
    await client.query('BEGIN');
    const row = await accountActivationDb.findActiveByHash(client, tokenHash);
    if (!row || new Date(row.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This activation link is invalid or has expired.' });
    }
    const user = await usersDb.getById(client, row.user_id);
    if (!user) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This activation link is invalid or has expired.' });
    }
    const policy = await passwordPolicyDb.get(client);
    const pv = validatePassword(new_password, policy);
    if (!pv.valid) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: pv.error });
    }
    const password_hash = await bcrypt.hash(new_password, 10);
    activatedUser = await usersDb.activateWithPassword(client, user.id, password_hash);
    await accountActivationDb.markUsed(client, row.id);
    await accountActivationDb.invalidatePendingForUser(client, user.id);
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('Activate account error:', err);
    return res.status(500).json({ error: 'Failed to activate account' });
  } finally {
    client.release();
  }

  // Log the user in immediately so they land on the Hub.
  try {
    const session = await issueFullSession(req, res, activatedUser, 'ACCOUNT_ACTIVATED');
    return res.json({ message: 'Account activated.', ...session });
  } catch (err) {
    console.error('Activation session error:', err);
    // Activation succeeded even if session issuance failed; let them sign in normally.
    return res.json({ message: 'Account activated. Please sign in.' });
  }
});

// GET /api/auth/me (current user with fresh BU from DB)
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await usersDb.getByIdWithBuName(pool, req.user.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    res.json({
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        business_unit_id: user.business_unit_id,
        business_unit_name: user.business_unit_name,
      },
    });
  } catch (err) {
    console.error('Me error:', err);
    res.status(500).json({ error: 'Failed to load user' });
  }
});

module.exports = router;
