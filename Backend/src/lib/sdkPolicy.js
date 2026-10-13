/**
 * Pure rules for the embeddable Hub SDK: origin allow-listing, key format,
 * and sanitising what browsers send us. No I/O — unit tested.
 */
const crypto = require('crypto');

const SDK_KEY_PREFIX = 'dwsk_';
const SDK_KEY_RE = /^dwsk_[A-Za-z0-9_-]{20,60}$/;
const SESSION_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function generateSdkKey() {
  return SDK_KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
}

function isValidSdkKey(key) {
  return typeof key === 'string' && SDK_KEY_RE.test(key);
}

function isValidSessionKey(key) {
  return typeof key === 'string' && SESSION_KEY_RE.test(key);
}

/** "https://App.Example.com:443/path" -> "https://app.example.com"; null for anything not http(s). */
function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const u = new URL(value.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

/** Origins implied by an application's registration: its target URL and OIDC redirect URIs. */
function defaultAllowedOrigins(app) {
  const out = new Set();
  const add = (v) => {
    const o = normalizeOrigin(v);
    if (o) out.add(o);
  };
  add(app?.target_url);
  const uris = Array.isArray(app?.oidc_redirect_uris) ? app.oidc_redirect_uris : [];
  uris.forEach(add);
  return [...out];
}

/** Explicit allow-list when configured, otherwise the registration defaults. */
function effectiveAllowedOrigins(app) {
  const explicit = (Array.isArray(app?.sdk_allowed_origins) ? app.sdk_allowed_origins : [])
    .map(normalizeOrigin)
    .filter(Boolean);
  return explicit.length > 0 ? [...new Set(explicit)] : defaultAllowedOrigins(app);
}

function isOriginAllowed(origin, app) {
  const o = normalizeOrigin(origin);
  if (!o) return false; // missing, "null" (sandboxed/file://) or not http(s)
  return effectiveAllowedOrigins(app).includes(o);
}

/**
 * Keep the page path, drop query strings everywhere (including inside hash routes),
 * so tokens such as ?code= / ?token= are never stored.
 * "/orders?id=9#/x/y?z=1" -> "/orders#/x/y"
 */
function sanitizePath(value) {
  if (typeof value !== 'string') return null;
  let s = value.trim();
  if (!s) return null;
  // tolerate full URLs: keep only path + hash
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      s = u.pathname + u.hash;
    } catch {
      return null;
    }
  }
  const [pathPart, ...hashParts] = s.split('#');
  const pathClean = pathPart.split('?')[0] || '/';
  const hash = hashParts.join('#');
  const hashClean = hash ? hash.split('?')[0] : '';
  let out = hashClean ? `${pathClean}#${hashClean}` : pathClean;
  if (!out.startsWith('/')) out = `/${out}`;
  return out.slice(0, 500);
}

function sanitizeEventName(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().replace(/[^\w .:/-]/g, '').slice(0, 80);
  return s || null;
}

/** Plain JSON object of at most ~2 KB, otherwise dropped. */
function sanitizeProperties(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const json = JSON.stringify(value);
    if (json.length > 2048) return null;
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function sanitizeText(value, max) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s ? s.slice(0, max) : null;
}

/** Normalise the user an app reports via DwsHub.identify(). */
function sanitizeIdentity(value) {
  if (!value || typeof value !== 'object') return { id: null, email: null };
  const id = typeof value.id === 'string' && UUID_RE.test(value.id.trim()) ? value.id.trim().toLowerCase() : null;
  const email = typeof value.email === 'string' && EMAIL_RE.test(value.email.trim())
    ? value.email.trim().toLowerCase().slice(0, 255)
    : null;
  return { id, email };
}

module.exports = {
  SDK_KEY_PREFIX,
  generateSdkKey,
  isValidSdkKey,
  isValidSessionKey,
  normalizeOrigin,
  defaultAllowedOrigins,
  effectiveAllowedOrigins,
  isOriginAllowed,
  sanitizePath,
  sanitizeEventName,
  sanitizeProperties,
  sanitizeText,
  sanitizeIdentity,
};
