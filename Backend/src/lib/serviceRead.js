/**
 * Read-only access for machine clients — today, the MCP Gateway, which hands Sentinel's
 * findings to Milo's production-support agent. Separate from user sign-in on purpose:
 *
 * - Keys are configured as SHA-256 hashes only: HUB_SERVICE_READ_KEYS="name:hex,name2:hex".
 *   The key itself lives with the client. Unset = the service API does not exist (404).
 * - A key can only reach the fixed GET routes in routes/service.js. It is not a user, has no
 *   role, and is accepted nowhere else in the Hub.
 * - Everything returned is redacted: email addresses become stable pseudonyms, and secrets
 *   that sometimes land in error text (tokens, keys, passwords in URLs) are removed, the same
 *   rules Sentinel applies before anything reaches Claude.
 *
 * Create a key:  node scripts/service-key.js mcp-gateway
 *
 * Control keys (`hubctl_…`, HUB_SERVICE_CONTROL_KEYS) are a separate credential for the one
 * write the Hub accepts from machines — Sentinel's model (routes/serviceControl.js). A read
 * key never works there and a control key never works on the read API.
 */
const crypto = require('crypto');
const { scrubSecrets } = require('./sentinel/privacy');

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const HEX64 = /^[0-9a-f]{64}$/i;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const warned = new Set();

/** [{ name, hash }] from HUB_SERVICE_READ_KEYS (or `variable`); malformed entries are ignored (and logged once). */
function configuredKeys(env = process.env, variable = 'HUB_SERVICE_READ_KEYS') {
  const raw = String(env[variable] || '').trim();
  if (!raw) return [];
  const keys = [];
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = part.lastIndexOf(':');
    const name = idx > 0 ? part.slice(0, idx).trim() : '';
    const hash = idx > 0 ? part.slice(idx + 1).trim().toLowerCase() : '';
    if (name && HEX64.test(hash)) keys.push({ name, hash });
    else if (!warned.has(variable)) {
      warned.add(variable);
      console.warn(`Service API: ignoring a malformed ${variable} entry (expected name:sha256hex).`);
    }
  }
  return keys;
}

/** The key's name when the token matches a configured hash, else null. Constant-time per key. */
function matchKey(token, keys, prefix = 'hubsvc_') {
  if (typeof token !== 'string' || !token.startsWith(prefix) || token.length > 200) return null;
  const got = Buffer.from(sha256(token), 'hex');
  let found = null;
  for (const k of keys) {
    if (crypto.timingSafeEqual(got, Buffer.from(k.hash, 'hex'))) found = k.name;
  }
  return found;
}

function newKey(prefix = 'hubsvc_') {
  const key = `${prefix}${crypto.randomBytes(32).toString('base64url')}`;
  return { key, hash: sha256(key) };
}

/* ---------- redaction ---------- */

function aliasSecret(env = process.env) {
  return env.HUB_SERVICE_PSEUDONYM_KEY || env.JWT_SECRET || 'dev-secret-change-in-production';
}

/** The same person always gets the same pseudonym, so counts and correlations still work. */
function alias(email, env = process.env) {
  const lower = String(email).toLowerCase();
  if (/@redacted\.invalid$/.test(lower)) return lower;
  const h = crypto.createHmac('sha256', aliasSecret(env)).update(lower).digest('hex').slice(0, 10);
  return `user-${h}@redacted.invalid`;
}

/**
 * Redact one string. `runtime: true` for data captured from apps (messages, stacks, URLs):
 * also masks IPs and key=value secrets. Off for analysis text, which quotes code.
 */
function redactText(text, { runtime = false } = {}) {
  if (text === null || text === undefined) return text;
  return scrubSecrets(String(text), { code: !runtime }).replace(EMAIL_RE, (m) => alias(m));
}

function redactDeep(value, opts) {
  if (typeof value === 'string') return redactText(value, opts);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, opts));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, opts);
    return out;
  }
  return value;
}

module.exports = { configuredKeys, matchKey, newKey, sha256, alias, redactText, redactDeep };
