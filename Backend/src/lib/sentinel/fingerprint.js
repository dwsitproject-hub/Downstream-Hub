/**
 * Grouping key for auto-captured errors: the same error, thrown from the same place,
 * gets the same fingerprint even when ids, numbers or bundle hashes differ. Sentinel
 * analyses each fingerprint once instead of once per occurrence.
 */
const crypto = require('crypto');

/** Replace the volatile parts of an error message. */
function normalizeMessage(message) {
  return String(message || '')
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\b[0-9a-f]{12,}\b/g, '<hex>')
    .replace(/"[^"]{0,200}"|'[^']{0,200}'|`[^`]{0,200}`/g, '<str>')
    .replace(/\d+/g, '0')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/**
 * First stack frame that points into the app, with line/column numbers, query strings
 * and content hashes in bundle names ("index-3fa9c1.js") removed.
 */
function topFrame(stack) {
  const lines = String(stack || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const frame = lines.find((l) => /^at\s/.test(l) || /@/.test(l) || /\.(m?js|jsx|tsx?)\b/.test(l));
  if (!frame) return '';
  return frame
    .replace(/https?:\/\/[^/\s)]+/g, '')         // origin: same code on another host is the same frame
    .replace(/\?[^:)\s]*/g, '')                  // ?v=123 cache busters
    .replace(/[-.][0-9a-zA-Z_]{6,}(?=\.m?js\b)/g, '') // bundle content hashes
    .replace(/:\d+(:\d+)?/g, '')                 // line:column
    .slice(0, 300);
}

/** Fingerprint for a client error; null for user reports (each one is read on its own). */
function fingerprint({ scope, kind, message, stack }) {
  if (kind !== 'client_error') return null;
  const basis = [scope || 'hub', normalizeMessage(message), topFrame(stack)].join('|');
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 40);
}

module.exports = { fingerprint, normalizeMessage, topFrame };
