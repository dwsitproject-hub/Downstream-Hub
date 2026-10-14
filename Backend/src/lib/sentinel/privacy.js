/**
 * What leaves the Hub when Sentinel asks Claude for help.
 *
 * - Email addresses are replaced with stable pseudonyms ("user-3@redacted.invalid") for the
 *   whole run and swapped back only in the result the admin sees, so the model never sees
 *   who a user is.
 * - Secrets that sometimes end up in error messages (JWTs, bearer tokens, API keys,
 *   passwords in URLs) are removed outright.
 * - IP addresses are masked.
 */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PSEUDO_RE = /user-(\d+)@redacted\.invalid/g;

// Credentials with a recognisable shape: removed from everything, source code included.
const TOKEN_PATTERNS = [
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<jwt>'],
  [/\b(sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|dwsk_[A-Za-z0-9_-]{20,})/g, '<secret>'],
  [/(\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1<redacted>@'],
];
// "password=…"-style values and IPs: removed from runtime data (messages, stacks, analytics)
// but not from source code, where `password = req.body.password` is code, not a secret.
const DATA_PATTERNS = [
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 <redacted>'],
  [/((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\s*["']?\s*[:=]\s*["']?)[^\s"'&,;]{4,}/gi, '$1<redacted>'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>'],
];

function scrubSecrets(text, { code = false } = {}) {
  let out = String(text);
  for (const [re, rep] of TOKEN_PATTERNS) out = out.replace(re, rep);
  if (!code) for (const [re, rep] of DATA_PATTERNS) out = out.replace(re, rep);
  return out;
}

class Pseudonymizer {
  constructor() {
    this.toAlias = new Map(); // lower-case email -> alias
    this.toEmail = new Map(); // alias -> original email
  }

  alias(email) {
    const key = String(email).toLowerCase();
    if (/@redacted\.invalid$/.test(key)) return key;
    let a = this.toAlias.get(key);
    if (!a) {
      a = `user-${this.toAlias.size + 1}@redacted.invalid`;
      this.toAlias.set(key, a);
      this.toEmail.set(a, email);
    }
    return a;
  }

  /** Text going to the model. `code: true` for source files (keeps key=value code intact). */
  outbound(text, { code = false } = {}) {
    if (text === null || text === undefined) return text;
    return scrubSecrets(String(text), { code }).replace(EMAIL_RE, (m) => this.alias(m));
  }

  /** Any JSON-able value going to the model. */
  outboundJson(value) {
    return this.outbound(JSON.stringify(value === undefined ? null : value));
  }

  /** Text coming back from the model, for the admin's eyes. */
  inbound(text) {
    if (typeof text !== 'string') return text;
    return text.replace(PSEUDO_RE, (m) => this.toEmail.get(m) || m);
  }

  /** Restore emails everywhere inside a structured result. */
  inboundDeep(value) {
    if (typeof value === 'string') return this.inbound(value);
    if (Array.isArray(value)) return value.map((v) => this.inboundDeep(v));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.inboundDeep(v);
      return out;
    }
    return value;
  }
}

module.exports = { Pseudonymizer, scrubSecrets };
