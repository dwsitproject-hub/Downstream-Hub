/**
 * Sentinel settings from the environment. Read on every call so tests and the
 * status endpoint always see the current values.
 *
 *   ANTHROPIC_API_KEY             required — Sentinel is off without it
 *   SENTINEL_ENABLED=0            switch Sentinel off even when a key is set
 *   SENTINEL_MODEL                default claude-opus-5-5 (claude-sonnet-5-5 is cheaper). A model set
 *                                 from Milo (sentinel_settings, see settings.js) overrides it.
 *   SENTINEL_EFFORT               low | medium | high (default) | xhigh | max — on models that accept it
 *   SENTINEL_FALLBACKS=off        disable server-side refusal fallbacks
 *   SENTINEL_THINKING=off         disable extended thinking
 *   SENTINEL_GITHUB_TOKEN         read-only token for the application repositories
 *   SENTINEL_GITHUB_API_URL       default https://api.github.com (GitHub Enterprise: https://<host>/api/v3)
 *   SENTINEL_ANTHROPIC_BASE_URL   default https://api.anthropic.com (an internal LLM gateway, if any)
 *   SENTINEL_AUTO_DAILY_LIMIT     automatic analyses per day (default 40; manual runs are not capped)
 *   SENTINEL_MAX_STEPS            tool-use rounds per run (default 24)
 */
function int(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sentinelConfig() {
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  return {
    apiKey,
    enabled: process.env.SENTINEL_ENABLED !== '0' && Boolean(apiKey),
    switchedOff: process.env.SENTINEL_ENABLED === '0',
    baseUrl: (process.env.SENTINEL_ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
    model: process.env.SENTINEL_MODEL || 'claude-opus-5-5',
    thinking: process.env.SENTINEL_THINKING !== 'off',
    effort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(process.env.SENTINEL_EFFORT) ? process.env.SENTINEL_EFFORT : 'high',
    fallbacks: process.env.SENTINEL_FALLBACKS !== 'off',
    githubToken: process.env.SENTINEL_GITHUB_TOKEN || '',
    githubApi: (process.env.SENTINEL_GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
    autoDailyLimit: int(process.env.SENTINEL_AUTO_DAILY_LIMIT, 40, 0, 10000),
    maxSteps: int(process.env.SENTINEL_MAX_STEPS, 24, 4, 60),
    maxTokens: 16000,
    pollMs: int(process.env.SENTINEL_POLL_MS, 4000, 500, 60000),
  };
}

module.exports = { sentinelConfig };
