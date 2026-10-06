/**
 * Admin "Analytic" dashboard endpoints (read-only aggregates) + bug-report triage.
 */
const express = require('express');
const { pool } = require('../db/pool');
const analyticsDb = require('../db/analyticsDb');
const bugReportsDb = require('../db/bugReportsDb');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

const router = express.Router();

function parseDays(req) {
  return Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
}

// GET /api/analytics/summary?days=30 — everything the dashboard needs in one call
router.get('/summary', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const days = parseDays(req);
    const [overview, topApps, topUsers, launchesByDay, bugCounts] = await Promise.all([
      analyticsDb.overview(pool, days),
      analyticsDb.topApps(pool, days, 10),
      analyticsDb.topUsers(pool, days, 10),
      analyticsDb.launchesByDay(pool, days),
      bugReportsDb.counts(pool),
    ]);
    res.json({ days, overview, topApps, topUsers, launchesByDay, bugCounts });
  } catch (err) {
    console.error('Analytics summary error:', err);
    res.status(500).json({ error: 'Failed to load analytics' });
  }
});

// GET /api/analytics/users/:id/apps?days=30 — per-user app breakdown
router.get('/users/:id/apps', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const days = parseDays(req);
    const apps = await analyticsDb.appsForUser(pool, req.params.id, days, 10);
    res.json({ apps });
  } catch (err) {
    console.error('Per-user analytics error:', err);
    res.status(500).json({ error: 'Failed to load user analytics' });
  }
});

// GET /api/analytics/bug-reports?status=open&kind=user_report
router.get('/bug-reports', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const reports = await bugReportsDb.list(pool, {
      status: req.query.status,
      kind: req.query.kind,
      limit: parseInt(req.query.limit, 10) || 100,
    });
    res.json({ reports });
  } catch (err) {
    console.error('List bug reports error:', err);
    res.status(500).json({ error: 'Failed to load bug reports' });
  }
});

// POST /api/analytics/bug-reports/:id/resolve  { resolved: true|false }
router.post('/bug-reports/:id/resolve', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const resolved = req.body?.resolved !== false; // default true
    const row = await bugReportsDb.setStatus(pool, req.params.id, resolved ? 'resolved' : 'open', req.user.id);
    if (!row) return res.status(404).json({ error: 'Report not found' });
    res.json(row);
  } catch (err) {
    console.error('Resolve bug report error:', err);
    res.status(500).json({ error: 'Failed to update report' });
  }
});

module.exports = router;
