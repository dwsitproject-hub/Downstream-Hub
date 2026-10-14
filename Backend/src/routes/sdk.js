/**
 * Public endpoints for the embeddable Hub SDK (called from other applications' pages).
 *
 *   GET  /api/sdk/v1/hub-sdk.js   the SDK script itself
 *   POST /api/sdk/v1/collect      batched telemetry: page views, heartbeats, custom events, errors
 *   POST /api/sdk/v1/bug-report   a user-submitted bug report
 *
 * Mounted before the global CORS/helmet middleware: these routes are cross-origin by design.
 * Every POST must carry a valid publishable key AND come from one of that application's
 * allowed origins. Bodies are sent as text/plain JSON so browsers make "simple" requests.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db/pool');
const sdkDb = require('../db/sdkDb');
const sentinel = require('../lib/sentinel');
const p = require('../lib/sdkPolicy');
const { getClientIp } = require('../middleware/audit');

const router = express.Router();
const SDK_FILE = path.join(__dirname, '..', 'sdk', 'hub-sdk.js');
const MAX_EVENTS = 50;
const MAX_ERRORS_PER_BATCH = 5;

let sdkCache = null;
function loadSdk() {
  if (!sdkCache) {
    const body = fs.readFileSync(SDK_FILE);
    sdkCache = { body, etag: `"${crypto.createHash('sha256').update(body).digest('hex').slice(0, 16)}"` };
  }
  return sdkCache;
}

const parseText = express.text({ type: '*/*', limit: '64kb' });

function limiter(max) {
  return rateLimit({
    windowMs: 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${rateLimit.ipKeyGenerator(req.ip || '')}|${req.sdkPayload?.key || ''}`,
    handler: (req, res) => res.status(429).json({ error: 'rate_limited' }),
  });
}

function setCors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
}

/** Parse the JSON body and attach it as req.sdkPayload (400 on garbage). */
function parsePayload(req, res, next) {
  try {
    const raw = typeof req.body === 'string' ? req.body : '';
    const payload = raw ? JSON.parse(raw) : null;
    if (!payload || typeof payload !== 'object') return res.status(400).json({ error: 'invalid_body' });
    req.sdkPayload = payload;
    return next();
  } catch {
    return res.status(400).json({ error: 'invalid_json' });
  }
}

/** Resolve the application from the key and check the request origin. */
async function authorize(req, res, next) {
  try {
    const { key } = req.sdkPayload;
    if (!p.isValidSdkKey(key)) return res.status(403).json({ error: 'invalid_key' });
    const app = await sdkDb.getAppBySdkKey(pool, key);
    if (!app) return res.status(403).json({ error: 'invalid_key' });
    const origin = req.headers.origin;
    if (!p.isOriginAllowed(origin, app)) return res.status(403).json({ error: 'origin_not_allowed' });
    setCors(res, origin); // only allowed origins get CORS headers
    if (!app.sdk_enabled) return res.status(403).json({ error: 'sdk_disabled' });
    req.sdkApp = app;
    req.sdkOrigin = p.normalizeOrigin(origin);
    return next();
  } catch (err) {
    return next(err);
  }
}

function sessionInfo(payload) {
  const session = payload.session && typeof payload.session === 'object' ? payload.session : {};
  return {
    sessionKey: p.isValidSessionKey(session.id) ? session.id : null,
    anonymousId: p.isValidSessionKey(session.anonymousId) ? session.anonymousId : null,
  };
}

function cleanEvents(raw, origin) {
  const out = [];
  let errors = 0;
  (Array.isArray(raw) ? raw.slice(0, MAX_EVENTS) : []).forEach((e) => {
    if (!e || typeof e !== 'object') return;
    if (e.type === 'page_view') {
      const pagePath = p.sanitizePath(e.path);
      if (pagePath) out.push({ type: 'page_view', path: pagePath, title: p.sanitizeText(e.title, 300) });
    } else if (e.type === 'custom') {
      const name = p.sanitizeEventName(e.name);
      if (name) out.push({ type: 'custom', name, path: p.sanitizePath(e.path), properties: p.sanitizeProperties(e.properties) });
    } else if (e.type === 'heartbeat') {
      out.push({ type: 'heartbeat' });
    } else if (e.type === 'error' && errors < MAX_ERRORS_PER_BATCH) {
      const message = p.sanitizeText(e.message, 1000);
      if (message) {
        errors += 1;
        const pagePath = p.sanitizePath(e.path);
        out.push({
          type: 'error',
          message,
          stack: p.sanitizeText(e.stack, 8000),
          path: pagePath ? origin + pagePath : null,
          breadcrumbs: p.sanitizeBreadcrumbs(e.breadcrumbs),
        });
      }
    }
  });
  return out;
}

// GET /api/sdk/v1/hub-sdk.js — the SDK, loadable from any origin
router.get('/v1/hub-sdk.js', (req, res) => {
  try {
    const { body, etag } = loadSdk();
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('ETag', etag);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    return res.send(body);
  } catch (err) {
    console.error('SDK file error:', err.message);
    return res.status(500).type('text/plain').send('// Downstream Hub SDK unavailable');
  }
});

// Preflight (only needed if a host wraps fetch and adds headers; the SDK itself avoids it)
router.options('/v1/*', (req, res) => {
  if (req.headers.origin) setCors(res, req.headers.origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.status(204).end();
});

// POST /api/sdk/v1/collect — batched telemetry
router.post('/v1/collect', parseText, parsePayload, limiter(240), authorize, async (req, res) => {
  try {
    const { sessionKey, anonymousId } = sessionInfo(req.sdkPayload);
    if (!sessionKey) return res.status(400).json({ error: 'invalid_session' });
    const events = cleanEvents(req.sdkPayload.events, req.sdkOrigin);
    if (events.length === 0) return res.status(204).end();
    const user = await sdkDb.resolveUser(pool, p.sanitizeIdentity(req.sdkPayload.user));
    const reports = await sdkDb.recordBatch(pool, {
      app: req.sdkApp,
      sessionKey,
      anonymousId,
      user,
      userAgent: p.sanitizeText(req.headers['user-agent'], 500),
      ip: getClientIp(req),
      release: p.sanitizeRelease(req.sdkPayload.release),
      events,
    });
    res.status(204).end();
    let queued = false;
    for (const report of reports) queued = Boolean(await sentinel.onBugReport(pool, report)) || queued;
    if (queued) sentinel.nudge(pool);
    return undefined;
  } catch (err) {
    console.error('SDK collect error:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/sdk/v1/bug-report — user-submitted report from the SDK widget
router.post('/v1/bug-report', parseText, parsePayload, limiter(10), authorize, async (req, res) => {
  try {
    const message = p.sanitizeText(req.sdkPayload.message, 5000);
    if (!message) return res.status(400).json({ error: 'A description of the bug is required' });
    const { sessionKey } = sessionInfo(req.sdkPayload);
    const user = await sdkDb.resolveUser(pool, p.sanitizeIdentity(req.sdkPayload.user));
    const pagePath = p.sanitizePath(req.sdkPayload.path);
    const report = await sdkDb.insertBugReport(pool, {
      app: req.sdkApp,
      sessionKey,
      user,
      userAgent: p.sanitizeText(req.headers['user-agent'], 500),
      ip: getClientIp(req),
      kind: 'user_report',
      message,
      stack: null,
      pageUrl: pagePath ? req.sdkOrigin + pagePath : null,
      release: p.sanitizeRelease(req.sdkPayload.release),
      breadcrumbs: p.sanitizeBreadcrumbs(req.sdkPayload.breadcrumbs),
    });
    res.status(201).json({ id: report.id, message: 'Thanks — your report has been sent.' });
    if (await sentinel.onBugReport(pool, report)) sentinel.nudge(pool);
    return undefined;
  } catch (err) {
    console.error('SDK bug report error:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
