/**
 * Authenticated activity ingestion from the Hub SPA:
 *  - session heartbeats (time-in-Hub tracking)
 *  - user-submitted bug reports
 *  - auto-captured client errors
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db/pool');
const userSessionsDb = require('../db/userSessionsDb');
const bugReportsDb = require('../db/bugReportsDb');
const { authMiddleware } = require('../middleware/auth');
const { getClientIp } = require('../middleware/audit');

const router = express.Router();

// Light throttle on client-error ingestion to avoid log floods from a crashing client.
const clientErrorLimit = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_CLIENT_ERROR_MAX || '30', 10),
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /api/activity/heartbeat — extend/open the user's current Hub session
router.post('/heartbeat', authMiddleware, async (req, res) => {
  try {
    await userSessionsDb.heartbeat(pool, {
      userId: req.user.id,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Heartbeat error:', err);
    res.status(500).json({ error: 'Failed to record activity' });
  }
});

// POST /api/activity/bug-report — user-submitted bug report
router.post('/bug-report', authMiddleware, async (req, res) => {
  try {
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'A description of the bug is required' });
    const report = await bugReportsDb.insert(pool, {
      userId: req.user.id,
      kind: 'user_report',
      message,
      pageUrl: req.body?.page_url,
      userAgent: req.headers['user-agent'],
      ipAddress: getClientIp(req),
    });
    res.status(201).json({ id: report.id, message: 'Thanks — your report has been submitted.' });
  } catch (err) {
    console.error('Bug report error:', err);
    res.status(500).json({ error: 'Failed to submit bug report' });
  }
});

// POST /api/activity/client-error — auto-captured frontend error
router.post('/client-error', authMiddleware, clientErrorLimit, async (req, res) => {
  try {
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(204).end();
    await bugReportsDb.insert(pool, {
      userId: req.user.id,
      kind: 'client_error',
      message,
      pageUrl: req.body?.page_url,
      stack: req.body?.stack,
      userAgent: req.headers['user-agent'],
      ipAddress: getClientIp(req),
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('Client error capture failed:', err);
    res.status(500).json({ error: 'Failed to record error' });
  }
});

module.exports = router;
