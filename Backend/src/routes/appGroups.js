/**
 * Application groups and the dashboard layout. Admin only.
 *
 *   GET /api/app-groups          groups in order, with how many applications each holds
 *   PUT /api/app-groups/layout   { groups: [{ id?, name, apps: [appId…] }], ungrouped: [appId…] }
 *                                saves the whole arrangement at once (audited)
 */
const express = require('express');
const { pool } = require('../db/pool');
const appGroupsDb = require('../db/appGroupsDb');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { auditLog, getClientIp } = require('../middleware/audit');

const router = express.Router();
router.use(authMiddleware, requireAdmin);

router.get('/', async (req, res) => {
  try {
    res.json({ groups: await appGroupsDb.listGroups(pool) });
  } catch (err) {
    console.error('List application groups error:', err);
    res.status(500).json({ error: 'Failed to load application groups' });
  }
});

router.put('/layout', async (req, res) => {
  const validated = appGroupsDb.validateLayout(req.body);
  if (validated.error) return res.status(400).json({ error: validated.error });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = await appGroupsDb.layoutSummary(client);
    const groups = await appGroupsDb.saveLayout(client, validated.value);
    const after = await appGroupsDb.layoutSummary(client);
    await auditLog(client, {
      actorId: req.user.id,
      actionType: 'APP_LAYOUT_UPDATE',
      targetEntity: 'dashboard',
      payloadBefore: before,
      payloadAfter: after,
      ipAddress: getClientIp(req),
    });
    await client.query('COMMIT');
    return res.json({ groups });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error('Save application layout error:', err);
    return res.status(500).json({ error: 'Failed to save the dashboard layout' });
  } finally {
    client.release();
  }
});

module.exports = router;
