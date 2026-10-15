/**
 * Service CONTROL API for machine clients. Mounted at /api/service/control/v1.
 *
 * The one setting the Hub lets a machine change: which Claude model Sentinel uses. Milo sets
 * it (through the MCP Gateway) when the Boss changes Sentinel's model on Milo's Agent team
 * page, so the Hub's Sentinel follows Milo.
 *
 *   GET /sentinel/model   current model, where it came from, the allowed models
 *   PUT /sentinel/model   { model, requested_by? }  — allowed models only; audited
 *
 * Kept apart from the read-only service API (routes/service.js) on purpose:
 * - its own credential: control keys (`hubctl_…`, HUB_SERVICE_CONTROL_KEYS, hashes only).
 *   Read keys are refused here and control keys are refused on the read API;
 * - unconfigured (no HUB_SERVICE_CONTROL_KEYS) = every path answers 404;
 * - one route, two methods; everything else is 404/405;
 * - every change is written to audit_logs (SENTINEL_MODEL_SET).
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db/pool');
const models = require('../lib/sentinel/models');
const settings = require('../lib/sentinel/settings');
const { configuredKeys, matchKey } = require('../lib/serviceRead');
const { auditLog, getClientIp } = require('../middleware/audit');

const CONTROL_KEYS = 'HUB_SERVICE_CONTROL_KEYS';
const router = express.Router();

// Off unless configured.
router.use((req, res, next) => {
  if (configuredKeys(process.env, CONTROL_KEYS).length === 0) return res.status(404).json({ error: 'Not found' });
  return next();
});

// A control key, and nothing else.
router.use((req, res, next) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  const name = matchKey(token, configuredKeys(process.env, CONTROL_KEYS), 'hubctl_');
  if (!name) return res.status(401).json({ error: 'A valid control key is required.' });
  req.serviceClient = name;
  return next();
});

router.use(rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `control:${req.serviceClient}`,
  handler: (req, res) => res.status(429).json({ error: 'Too many requests. Try again in a minute.' }),
}));

router.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => console.log(`Service control API: ${req.serviceClient} ${req.method} ${req.baseUrl}${req.path} -> ${res.statusCode} ${Date.now() - t0}ms`));
  next();
});

const allowed = () => models.MODELS.map((m) => ({ id: m.id, label: m.label }));

function view(current) {
  return {
    model: current.model,
    set_from: current.from === 'milo' ? 'milo' : 'server default (SENTINEL_MODEL)',
    source: current.source,
    updated_at: current.updated_at,
    allowed: allowed(),
  };
}

router.get('/sentinel/model', async (req, res) => {
  try {
    return res.json(view(await settings.currentModel(pool)));
  } catch (err) {
    console.error('Service control: read model error:', err);
    return res.status(500).json({ error: 'Failed to read the Sentinel model' });
  }
});

router.put('/sentinel/model', async (req, res) => {
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  if (!models.isSelectable(model)) {
    return res.status(400).json({ error: 'Unsupported model.', allowed: allowed() });
  }
  const requestedBy = typeof req.body?.requested_by === 'string'
    ? req.body.requested_by.replace(/[^\w.@+\- ]/g, '').trim().slice(0, 120)
    : '';
  const source = requestedBy ? `${req.serviceClient} (${requestedBy})` : req.serviceClient;
  try {
    const result = await settings.setModel(pool, model, source);
    if (result.changed) {
      await auditLog(pool, {
        actorId: null,
        actionType: 'SENTINEL_MODEL_SET',
        targetEntity: 'sentinel:model',
        payloadBefore: { model: result.previous },
        payloadAfter: { model: result.model, source },
        ipAddress: getClientIp(req),
      });
      console.log(`Sentinel: model changed ${result.previous} -> ${result.model} by ${source}`);
    }
    return res.json({ ...result, allowed: allowed() });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message, allowed: allowed() });
    console.error('Service control: set model error:', err);
    return res.status(500).json({ error: 'Failed to set the Sentinel model' });
  }
});

router.all('/sentinel/model', (req, res) => {
  res.set('Allow', 'GET, PUT');
  return res.status(405).json({ error: 'Use GET or PUT.' });
});

router.use((req, res) => res.status(404).json({ error: 'Not found' }));

module.exports = router;
