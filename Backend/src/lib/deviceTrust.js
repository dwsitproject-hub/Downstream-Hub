/**
 * Trusted device cookie and login MFA bypass window evaluation.
 */
const crypto = require('crypto');

const DEVICE_COOKIE = process.env.HUB_DEVICE_COOKIE || 'hub_device';
const DEVICE_TTL_DAYS = Math.max(1, parseInt(process.env.HUB_DEVICE_TTL_DAYS || '90', 10));
const DEVICE_TTL_MS = DEVICE_TTL_DAYS * 24 * 60 * 60 * 1000;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function parseCookies(req) {
  const src = req.headers.cookie || '';
  return src.split(';').reduce((acc, part) => {
    const [k, ...rest] = part.split('=');
    if (k && rest.length) acc[k.trim()] = decodeURIComponent(rest.join('=').trim());
    return acc;
  }, {});
}

function readDeviceToken(req) {
  const map = parseCookies(req);
  const raw = map[DEVICE_COOKIE];
  return raw && typeof raw === 'string' ? raw.trim() : null;
}

function deviceHashFromToken(rawToken) {
  if (!rawToken) return null;
  return sha256(rawToken);
}

function generateDeviceToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function deviceCookieOptions(req) {
  let secure = false;
  if (process.env.AUTH_COOKIE_SECURE === '1') secure = true;
  else if (process.env.AUTH_COOKIE_SECURE === '0') secure = false;
  else if (req) {
    if (req.secure) secure = true;
    else {
      const proto = req.headers['x-forwarded-proto'];
      if (proto) secure = String(proto).split(',')[0].trim().toLowerCase() === 'https';
    }
  }
  return {
    secure,
    sameSite: secure ? 'none' : 'lax',
    path: '/',
    maxAge: DEVICE_TTL_MS,
    httpOnly: true,
  };
}

function setDeviceCookie(req, res, rawToken) {
  const opts = deviceCookieOptions(req);
  res.cookie(DEVICE_COOKIE, rawToken, opts);
}

function clearDeviceCookie(req, res) {
  const opts = deviceCookieOptions(req);
  res.clearCookie(DEVICE_COOKIE, { path: '/', secure: opts.secure, sameSite: opts.sameSite });
}

function deviceExpiresAt() {
  return new Date(Date.now() + DEVICE_TTL_MS);
}

/**
 * Format a Date in a specific IANA timezone as YYYY-MM-DD (calendar-day bypass).
 */
function calendarDateInTimezone(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const y = parts.find((p) => p.type === 'year')?.value;
    const m = parts.find((p) => p.type === 'month')?.value;
    const d = parts.find((p) => p.type === 'day')?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch {
    /* invalid timezone — fall through */
  }
  return date.toISOString().slice(0, 10);
}

const MAX_BYPASS_DAYS = 90;

/**
 * Modes:
 *  - rolling_24h  : N hours since last_verified_at (refreshed by every bypassed login, so it slides)
 *  - calendar_day : same calendar day (in the policy timezone) as last_verified_at
 *  - rolling_days : N days since last_mfa_at, the last *real* MFA — fixed, not refreshed by bypasses
 *
 * @param {{ last_verified_at: Date|string|null, last_mfa_at?: Date|string|null }} trustedDevice
 * @param {{ login_mfa_bypass_mode?: string, login_mfa_bypass_hours?: number, login_mfa_bypass_days?: number, login_mfa_bypass_timezone?: string }} policy
 * @param {Date} [now]
 */
function isWithinBypassWindow(trustedDevice, policy, now = new Date()) {
  const mode = policy?.login_mfa_bypass_mode || 'rolling_24h';

  if (mode === 'rolling_days') {
    // Devices trusted before last_mfa_at existed have no anchor: require MFA once.
    if (!trustedDevice?.last_mfa_at) return false;
    const mfaAt = new Date(trustedDevice.last_mfa_at);
    if (Number.isNaN(mfaAt.getTime())) return false;
    const days = Math.max(1, Math.min(MAX_BYPASS_DAYS, parseInt(String(policy?.login_mfa_bypass_days ?? 7), 10) || 7));
    return now.getTime() - mfaAt.getTime() <= days * 24 * 60 * 60 * 1000;
  }

  if (!trustedDevice?.last_verified_at) return false;
  const verifiedAt = new Date(trustedDevice.last_verified_at);
  if (Number.isNaN(verifiedAt.getTime())) return false;

  if (mode === 'calendar_day') {
    const tz = policy?.login_mfa_bypass_timezone || 'UTC';
    return calendarDateInTimezone(verifiedAt, tz) === calendarDateInTimezone(now, tz);
  }

  const hours = Math.max(1, Math.min(168, parseInt(String(policy?.login_mfa_bypass_hours ?? 24), 10) || 24));
  const windowMs = hours * 60 * 60 * 1000;
  return now.getTime() - verifiedAt.getTime() <= windowMs;
}

/**
 * @param {object|null} trustedDevice from mfaDb.getTrustedDevice
 * @param {object} policy from passwordPolicyDb.get
 */
function canBypassMfa(trustedDevice, policy) {
  if (!trustedDevice) return false;
  return isWithinBypassWindow(trustedDevice, policy);
}

module.exports = {
  DEVICE_COOKIE,
  DEVICE_TTL_MS,
  MAX_BYPASS_DAYS,
  sha256,
  readDeviceToken,
  deviceHashFromToken,
  generateDeviceToken,
  setDeviceCookie,
  clearDeviceCookie,
  deviceExpiresAt,
  isWithinBypassWindow,
  canBypassMfa,
  calendarDateInTimezone,
};
