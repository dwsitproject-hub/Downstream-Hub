/**
 * Application access overview. Admin only, read-only.
 *
 *   GET /api/access-overview   departments, applications and users, with who can open what
 */
const express = require('express');
const { pool } = require('../db/pool');
const accessOverviewDb = require('../db/accessOverviewDb');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware, requireAdmin);

router.get('/', async (req, res) => {
  try {
    const raw = await accessOverviewDb.loadAccessData(pool);
    res.json(accessOverviewDb.buildAccessOverview(raw));
  } catch (err) {
    console.error('Access overview error:', err);
    res.status(500).json({ error: 'Failed to load the access overview' });
  }
});

module.exports = router;
