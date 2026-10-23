/**
 * Pure rules for the embeddable Hub SDK: origin allow-listing, key format,
 * and sanitising what browsers send us. No I/O — unit tested.
 */
const crypto = require('crypto');
const { scrubSecrets } = require('./sentinel/privacy');

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

const RELEASE_RE = /^[A-Za-z0-9][A-Za-z0-9._+\-]{0,63}$/;
const MAX_BREADCRUMBS = 30;
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/** App build/version the SDK reports (git sha, tag or semver), e.g. "1.4.2" or "3fa9c1d". */
function sanitizeRelease(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return RELEASE_RE.test(s) ? s : null;
}

/** URL of an API call: origin + path for absolute URLs, path for relative ones; never the query. */
function sanitizeRequestUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const s = value.trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return (u.origin + u.pathname).slice(0, 300);
    } catch {
      return null;
    }
  }
  const p = sanitizePath(s.split('#')[0]);
  return p ? p.slice(0, 300) : null;
}

/**
 * What happened just before an error or report: navigations, failed API calls,
 * console errors and tracked actions. Unknown shapes are dropped.
 */
function sanitizeBreadcrumbs(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const c of value.slice(-MAX_BREADCRUMBS)) {
    if (!c || typeof c !== 'object') continue;
    const t = Number.isFinite(c.t) && c.t > 0 ? Math.round(c.t) : null;
    if (c.type === 'nav') {
      const path = sanitizePath(c.path);
      if (path) out.push({ t, type: 'nav', path });
    } else if (c.type === 'http') {
      const url = sanitizeRequestUrl(c.url);
      const method = typeof c.method === 'string' && HTTP_METHODS.has(c.method.toUpperCase()) ? c.method.toUpperCase() : 'GET';
      const status = Number.isInteger(c.status) && c.status >= 0 && c.status < 1000 ? c.status : 0;
      const ms = Number.isFinite(c.ms) && c.ms >= 0 ? Math.min(600000, Math.round(c.ms)) : null;
      if (url) out.push({ t, type: 'http', method, url, status, ms });
    } else if (c.type === 'console') {
      // console output sometimes includes tokens: never store them
      const message = sanitizeText(c.message, 300);
      if (message) out.push({ t, type: 'console', message: scrubSecrets(message) });
    } else if (c.type === 'action') {
      const name = sanitizeEventName(c.name);
      if (name) out.push({ t, type: 'action', name });
    }
  }
  return out.length ? out : null;
}

const STACK_URL_RE = /\b([a-z][a-z0-9+.-]*):\/\/[^\s)]+/gi;
const EXTENSION_SCHEMES = new Set([
  'chrome-extension', 'moz-extension', 'safari-extension', 'safari-web-extension', 'ms-browser-extension',
]);

/**
 * True when every script URL in a stack belongs to a browser extension (MetaMask, password
 * managers, ad blockers...). Their injected scripts run on every page and throw into the
 * page's global handlers, but they are not the app's errors. A stack with no URL at all is
 * NOT treated as noise: there is nothing to say it isn't the app's own.
 */
function isExtensionOnlyStack(stack) {
  if (typeof stack !== 'string' || !stack) return false;
  const schemes = [...stack.matchAll(STACK_URL_RE)].map((m) => m[1].toLowerCase());
  return schemes.length > 0 && schemes.every((s) => EXTENSION_SCHEMES.has(s));
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
  sanitizeRelease,
  sanitizeRequestUrl,
  sanitizeBreadcrumbs,
  isExtensionOnlyStack,
};
