/**
 * Claude Messages API over plain fetch (no SDK dependency), with retries for
 * rate limits, overload and transient network failures.
 */
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS = 4;
const TIMEOUT_MS = 5 * 60 * 1000;

class LlmError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function friendly(status, body) {
  const detail = body?.error?.message || '';
  if (status === 401) return 'The Anthropic API key was rejected (401). Check ANTHROPIC_API_KEY on the backend.';
  if (status === 403) return `The Anthropic API refused the request (403). ${detail}`.trim();
  if (status === 404) return `Model not available on this API key (404): ${detail}`.trim();
  if (status === 400) return `The Anthropic API rejected the request (400): ${detail}`.trim();
  if (status === 429) return 'Anthropic rate limit reached; try again in a few minutes.';
  if (status === 529) return 'The Anthropic API is overloaded right now; try again shortly.';
  return `Anthropic API error ${status}${detail ? `: ${detail}` : ''}`;
}

async function createMessage(cfg, body) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let res;
    try {
      res = await fetch(`${cfg.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err?.cause?.code || err?.name || err?.message || 'network error';
      lastError = new LlmError(`Cannot reach the Anthropic API (${reason}). Check the backend server's outbound HTTPS access.`, 0);
      if (attempt < MAX_ATTEMPTS) { await sleep(2000 * attempt); continue; }
      throw lastError;
    }
    if (res.ok) return res.json();
    const payload = await res.json().catch(() => null);
    lastError = new LlmError(friendly(res.status, payload), res.status);
    if (!RETRY_STATUS.has(res.status) || attempt === MAX_ATTEMPTS) throw lastError;
    const retryAfter = parseFloat(res.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) ? Math.min(60, retryAfter) * 1000 : 2000 * 2 ** (attempt - 1));
  }
  throw lastError;
}

module.exports = { createMessage, LlmError };
