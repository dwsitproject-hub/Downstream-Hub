/**
 * Read-only service API for machine clients (the MCP Gateway). Mounted at /api/service/v1.
 *
 * Fixed GET routes over Sentinel's results and the bug/error data it works on. A service key
 * (lib/serviceRead.js) is the only way in — user sessions are not accepted here, and service
 * keys are not accepted anywhere else. Nothing here writes, starts a Sentinel run, or spends
 * the Hub's Anthropic budget. Every response is redacted (emails pseudonymised, secrets
 * removed). Unconfigured (no HUB_SERVICE_READ_KEYS) = every path answers 404.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db/pool');
const serviceDb = require('../db/serviceReadDb');
const { sentinelConfig } = require('../lib/sentinel/config');
const { configuredKeys, matchKey, redactDeep } = require('../lib/serviceRead');

const router = express.Router();

// 1) Off unless configured: the API should not even be discoverable.
router.use((req, res, next) => {
  if (configuredKeys().length === 0) return res.status(404).json({ error: 'Not found' });
  return next();
});

// 2) Read only, by construction: only GET (and HEAD, which Express maps onto GET) reach a route.
router.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  res.set('Allow', 'GET');
  return res.status(405).json({ error: 'This API is read-only.' });
});

// 3) A service key, and nothing else.
router.use((req, res, next) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  const name = matchKey(token, configuredKeys());
  if (!name) return res.status(401).json({ error: 'A valid service key is required.' });
  req.serviceClient = name;
  return next();
});

router.use(rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.HUB_SERVICE_RATE_PER_MINUTE || '120', 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `service:${req.serviceClient}`,
  handler: (req, res) => res.status(429).json({ error: 'Too many requests. Try again in a minute.' }),
}));

// One line per request in the container log: who, what, how long. No data, no key.
router.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => console.log(`Service API: ${req.serviceClient} ${req.method} ${req.baseUrl}${req.path} -> ${res.statusCode} ${Date.now() - t0}ms`));
  next();
});

const send = (res, body, opts) => res.json(redactDeep(body, opts));

function fail(res, err, what) {
  if (err && err.status === 400) return res.status(400).json({ error: err.message });
  console.error(`Service API ${what} error:`, err);
  return res.status(500).json({ error: `Failed to load ${what}` });
}

// GET /status — is Sentinel on, and how busy is it.
router.get('/status', async (req, res) => {
  try {
    const cfg = sentinelConfig();
    const { rows } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
              COUNT(*) FILTER (WHERE status = 'running')::int AS running,
              COUNT(*) FILTER (WHERE status = 'done' AND created_at >= date_trunc('day', now()))::int AS done_today,
              COUNT(*) FILTER (WHERE status = 'failed' AND created_at >= date_trunc('day', now()))::int AS failed_today,
              MAX(finished_at) AS last_finished_at
       FROM sentinel_runs`
    );
    return send(res, { as_of: new Date().toISOString(), sentinel_enabled: cfg.enabled, model: cfg.model, runs: rows[0] });
  } catch (err) { return fail(res, err, 'status'); }
});

// GET /applications — every application and the Hub itself, with health at a glance.
router.get('/applications', async (req, res) => {
  try {
    return send(res, { as_of: new Date().toISOString(), applications: await serviceDb.overview(pool) });
  } catch (err) { return fail(res, err, 'applications'); }
});

// GET /sentinel/runs?scope=&kind=&status=&days=&limit=
router.get('/sentinel/runs', async (req, res) => {
  try {
    const { scope, kind, status, days, limit } = req.query;
    const runs = await serviceDb.runs(pool, { scope, kind, status, days, limit });
    return send(res, { as_of: new Date().toISOString(), days: serviceDb.clampDays(days), runs });
  } catch (err) { return fail(res, err, 'Sentinel runs'); }
});

// GET /sentinel/runs/:id — the full analysis, health report or answer.
router.get('/sentinel/runs/:id', async (req, res) => {
  try {
    const run = await serviceDb.run(pool, req.params.id);
    if (!run) return res.status(404).json({ error: 'Not found' });
    return send(res, { as_of: new Date().toISOString(), run });
  } catch (err) { return fail(res, err, 'the Sentinel run'); }
});

// GET /bug-reports?scope=&status=&kind=&days=&limit= — captured from apps: redacted as runtime data.
router.get('/bug-reports', async (req, res) => {
  try {
    const { scope, status, kind, days, limit } = req.query;
    const reports = await serviceDb.bugReports(pool, { scope, status, kind, days, limit });
    return send(res, { as_of: new Date().toISOString(), days: serviceDb.clampDays(days, 30), reports }, { runtime: true });
  } catch (err) { return fail(res, err, 'bug reports'); }
});

// GET /errors?scope=&days= — JS errors grouped by fingerprint, and per day.
router.get('/errors', async (req, res) => {
  try {
    const out = await serviceDb.errors(pool, { scope: req.query.scope, days: req.query.days });
    return send(res, { as_of: new Date().toISOString(), scope: req.query.scope, ...out }, { runtime: true });
  } catch (err) { return fail(res, err, 'errors'); }
});

router.use((req, res) => res.status(404).json({ error: 'Not found' }));

module.exports = router;
