/**
 * Admin "Analytic" dashboard endpoints (read-only aggregates + drill-downs)
 * and bug-report triage. All routes are Admin only.
 */
const express = require('express');
const { pool } = require('../db/pool');
const analyticsDb = require('../db/analyticsDb');
const bugReportsDb = require('../db/bugReportsDb');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware, requireAdmin);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDays(req) {
  return Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
}

/** Optional UUID query/route param: returns undefined when absent, null when malformed. */
function optUuid(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return UUID_RE.test(String(value)) ? String(value) : null;
}

function badRequest(res, msg) {
  return res.status(400).json({ error: msg });
}

// GET /api/analytics/summary?days=30 — everything the dashboard needs in one call
router.get('/summary', async (req, res) => {
  try {
    const days = parseDays(req);
    const [overview, topApps, topUsers, launchesByDay, bugCounts] = await Promise.all([
      analyticsDb.overview(pool, days),
      analyticsDb.topApps(pool, days, 10),
      analyticsDb.activeUsers(pool, days, { limit: 10, orderBy: 'launches' }),
      analyticsDb.launchesByDay(pool, days),
      bugReportsDb.counts(pool),
    ]);
    res.json({ days, overview, topApps, topUsers, launchesByDay, bugCounts });
  } catch (err) {
    console.error('Analytics summary error:', err);
    res.status(500).json({ error: 'Failed to load analytics' });
  }
});

// GET /api/analytics/active-users?days=30&order=minutes|launches
router.get('/active-users', async (req, res) => {
  try {
    const users = await analyticsDb.activeUsers(pool, parseDays(req), {
      orderBy: req.query.order === 'launches' ? 'launches' : 'minutes',
    });
    res.json({ users });
  } catch (err) {
    console.error('Active users error:', err);
    res.status(500).json({ error: 'Failed to load active users' });
  }
});

// GET /api/analytics/launches?days=30&app_id=&user_id=&day=YYYY-MM-DD
router.get('/launches', async (req, res) => {
  const appId = optUuid(req.query.app_id);
  const userId = optUuid(req.query.user_id);
  if (appId === null) return badRequest(res, 'Invalid app_id');
  if (userId === null) return badRequest(res, 'Invalid user_id');
  const day = req.query.day ? String(req.query.day) : undefined;
  if (day && !DAY_RE.test(day)) return badRequest(res, 'day must be YYYY-MM-DD');
  try {
    const result = await analyticsDb.launches(pool, parseDays(req), { appId, userId, day });
    res.json(result);
  } catch (err) {
    console.error('Launches error:', err);
    res.status(500).json({ error: 'Failed to load app opens' });
  }
});

// GET /api/analytics/sessions?days=30&user_id=&sort=recent|longest
router.get('/sessions', async (req, res) => {
  const userId = optUuid(req.query.user_id);
  if (userId === null) return badRequest(res, 'Invalid user_id');
  try {
    const result = await analyticsDb.sessions(pool, parseDays(req), {
      userId,
      sort: req.query.sort === 'longest' ? 'longest' : 'recent',
    });
    res.json(result);
  } catch (err) {
    console.error('Sessions error:', err);
    res.status(500).json({ error: 'Failed to load sessions' });
  }
});

// GET /api/analytics/apps/:id/users?days=30 — who uses this app
router.get('/apps/:id/users', async (req, res) => {
  const appId = optUuid(req.params.id);
  if (!appId) return badRequest(res, 'Invalid application id');
  try {
    const result = await analyticsDb.appUsers(pool, appId, parseDays(req));
    if (!result.app) return res.status(404).json({ error: 'Application not found' });
    res.json(result);
  } catch (err) {
    console.error('App users error:', err);
    res.status(500).json({ error: 'Failed to load application users' });
  }
});

// GET /api/analytics/users/:id?days=30 — user profile, totals, apps, recent sessions
router.get('/users/:id', async (req, res) => {
  const userId = optUuid(req.params.id);
  if (!userId) return badRequest(res, 'Invalid user id');
  try {
    const days = parseDays(req);
    const [summary, apps, recent] = await Promise.all([
      analyticsDb.userSummary(pool, userId, days),
      analyticsDb.appsForUser(pool, userId, days),
      analyticsDb.sessions(pool, days, { userId, limit: 20 }),
    ]);
    if (!summary) return res.status(404).json({ error: 'User not found' });
    res.json({ user: summary, apps, sessions: recent.rows });
  } catch (err) {
    console.error('User analytics error:', err);
    res.status(500).json({ error: 'Failed to load user analytics' });
  }
});

// GET /api/analytics/bug-reports?status=open|resolved&kind=user_report|client_error
router.get('/bug-reports', async (req, res) => {
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
router.post('/bug-reports/:id/resolve', async (req, res) => {
  const id = optUuid(req.params.id);
  if (!id) return badRequest(res, 'Invalid report id');
  try {
    const resolved = req.body?.resolved !== false; // default true
    const row = await bugReportsDb.setStatus(pool, id, resolved ? 'resolved' : 'open', req.user.id);
    if (!row) return res.status(404).json({ error: 'Report not found' });
    res.json(row);
  } catch (err) {
    console.error('Resolve bug report error:', err);
    res.status(500).json({ error: 'Failed to update report' });
  }
});

module.exports = router;
