/**
 * Read-only aggregate + drill-down queries for the Admin "Analytic" dashboard.
 * Sources: sso_access_logs (app opens), user_activity_sessions (time in Hub), users.
 * All queries are windowed to the last `days` days. Each headline number has a
 * matching drill-down query built on the same definition, so the detail list
 * always explains the number that was clicked.
 */
const { IDLE_WINDOW_MINUTES } = require('./userSessionsDb');

function windowInterval(days) {
  const d = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
  return `${d} days`;
}

function clampLimit(limit, max = 500) {
  return Math.min(max, Math.max(1, parseInt(limit, 10) || 200));
}

// Shared CTE fragments (parameter $1 = window interval).
const LAUNCHES_CTE = `
  SELECT user_id, COUNT(*)::int AS launches, MAX(created_at) AS last_launch
  FROM sso_access_logs
  WHERE deleted_at IS NULL AND outcome = 'success'
    AND created_at >= now() - $1::interval
  GROUP BY user_id`;

const SESSIONS_CTE = `
  SELECT user_id,
         COUNT(*)::int AS sessions,
         ROUND(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, last_seen_at) - started_at)) / 60.0)::numeric, 0) AS minutes,
         MAX(last_seen_at) AS last_seen
  FROM user_activity_sessions
  WHERE started_at >= now() - $1::interval
  GROUP BY user_id`;

/** Headline counters for the dashboard cards. */
async function overview(db, days) {
  const { rows } = await db.query(
    `WITH l AS (${LAUNCHES_CTE}),
          s AS (${SESSIONS_CTE}),
          sess_rows AS (
            SELECT EXTRACT(EPOCH FROM (COALESCE(ended_at, last_seen_at) - started_at)) / 60.0 AS mins
            FROM user_activity_sessions
            WHERE started_at >= now() - $1::interval
          )
     SELECT
       (SELECT COUNT(*) FROM (SELECT user_id FROM l UNION SELECT user_id FROM s) au)::int AS active_users,
       COALESCE((SELECT SUM(launches) FROM l), 0)::int AS total_launches,
       (SELECT COUNT(*) FROM sess_rows)::int AS total_sessions,
       COALESCE((SELECT ROUND(AVG(mins)::numeric, 1) FROM sess_rows), 0) AS avg_session_minutes,
       COALESCE((SELECT ROUND(SUM(mins)::numeric, 0) FROM sess_rows), 0) AS total_minutes`,
    [windowInterval(days)]
  );
  return rows[0];
}

/** Most-used applications (by successful opens). */
async function topApps(db, days, limit = 10) {
  const { rows } = await db.query(
    `SELECT a.id, a.name, COUNT(s.id)::int AS launches,
            COUNT(DISTINCT s.user_id)::int AS unique_users
     FROM sso_access_logs s
     JOIN applications a ON a.id = s.application_id
     WHERE s.deleted_at IS NULL AND s.outcome = 'success'
       AND s.created_at >= now() - $1::interval
     GROUP BY a.id, a.name
     ORDER BY launches DESC
     LIMIT $2`,
    [windowInterval(days), clampLimit(limit, 50)]
  );
  return rows;
}

/**
 * Users with any activity (a Hub session or an app open) in the window.
 * Backs "Active users", "Most active users" and "Total time in Hub".
 */
async function activeUsers(db, days, { limit = 200, orderBy = 'minutes' } = {}) {
  const order = orderBy === 'launches'
    ? 'launches DESC, minutes DESC'
    : 'minutes DESC, launches DESC';
  const { rows } = await db.query(
    `WITH l AS (${LAUNCHES_CTE}),
          s AS (${SESSIONS_CTE})
     SELECT u.id, u.email, bu.name AS department,
            COALESCE(l.launches, 0)::int AS launches,
            COALESCE(s.sessions, 0)::int AS sessions,
            COALESCE(s.minutes, 0) AS minutes,
            GREATEST(l.last_launch, s.last_seen) AS last_seen
     FROM users u
     LEFT JOIN business_units bu ON bu.id = u.business_unit_id AND bu.deleted_at IS NULL
     LEFT JOIN l ON l.user_id = u.id
     LEFT JOIN s ON s.user_id = u.id
     WHERE u.deleted_at IS NULL
       AND (l.user_id IS NOT NULL OR s.user_id IS NOT NULL)
     ORDER BY ${order}
     LIMIT $2`,
    [windowInterval(days), clampLimit(limit)]
  );
  return rows;
}

/** Daily open volume (for the trend chart). */
async function launchesByDay(db, days) {
  const { rows } = await db.query(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
            COUNT(*)::int AS launches
     FROM sso_access_logs
     WHERE deleted_at IS NULL AND outcome = 'success'
       AND created_at >= now() - $1::interval
     GROUP BY 1
     ORDER BY 1`,
    [windowInterval(days)]
  );
  return rows;
}

/** Individual app opens, optionally filtered by app, user, and/or day (YYYY-MM-DD). */
async function launches(db, days, { appId, userId, day, limit = 200 } = {}) {
  const params = [windowInterval(days)];
  const where = [
    `s.deleted_at IS NULL`,
    `s.outcome = 'success'`,
    `s.created_at >= now() - $1::interval`,
  ];
  if (appId) { params.push(appId); where.push(`s.application_id = $${params.length}`); }
  if (userId) { params.push(userId); where.push(`s.user_id = $${params.length}`); }
  if (day) { params.push(day); where.push(`to_char(date_trunc('day', s.created_at), 'YYYY-MM-DD') = $${params.length}`); }
  params.push(clampLimit(limit));
  const { rows } = await db.query(
    `SELECT s.id, s.created_at, u.id AS user_id, u.email, a.id AS app_id, a.name AS app_name,
            COUNT(*) OVER()::int AS total
     FROM sso_access_logs s
     JOIN users u ON u.id = s.user_id
     JOIN applications a ON a.id = s.application_id
     WHERE ${where.join(' AND ')}
     ORDER BY s.created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return { total: rows[0]?.total || 0, rows };
}

/** Hub sessions, newest first or longest first; optionally for a single user. */
async function sessions(db, days, { userId, sort = 'recent', limit = 200 } = {}) {
  const params = [windowInterval(days), String(IDLE_WINDOW_MINUTES)];
  const where = [`s.started_at >= now() - $1::interval`];
  if (userId) { params.push(userId); where.push(`s.user_id = $${params.length}`); }
  params.push(clampLimit(limit));
  const order = sort === 'longest' ? 'minutes DESC' : 's.started_at DESC';
  const { rows } = await db.query(
    `SELECT s.id, s.started_at, s.last_seen_at, s.ended_at,
            u.id AS user_id, u.email,
            ROUND((EXTRACT(EPOCH FROM (COALESCE(s.ended_at, s.last_seen_at) - s.started_at)) / 60.0)::numeric, 1) AS minutes,
            (s.ended_at IS NULL AND s.last_seen_at > now() - ($2 || ' minutes')::interval) AS is_active,
            COUNT(*) OVER()::int AS total
     FROM user_activity_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE ${where.join(' AND ')}
     ORDER BY ${order}
     LIMIT $${params.length}`,
    params
  );
  return { total: rows[0]?.total || 0, rows };
}

/** Who uses a given application, and how often. */
async function appUsers(db, appId, days, limit = 200) {
  const appRes = await db.query('SELECT id, name, target_url FROM applications WHERE id = $1', [appId]);
  const app = appRes.rows[0] || null;
  if (!app) return { app: null, users: [] };
  const { rows } = await db.query(
    `SELECT u.id, u.email, bu.name AS department,
            COUNT(s.id)::int AS launches, MAX(s.created_at) AS last_used
     FROM sso_access_logs s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN business_units bu ON bu.id = u.business_unit_id AND bu.deleted_at IS NULL
     WHERE s.deleted_at IS NULL AND s.outcome = 'success'
       AND s.application_id = $1
       AND s.created_at >= now() - $2::interval
     GROUP BY u.id, u.email, bu.name
     ORDER BY launches DESC
     LIMIT $3`,
    [appId, windowInterval(days), clampLimit(limit)]
  );
  return { app, users: rows };
}

/** Per-user app breakdown (which apps a given user opens most). */
async function appsForUser(db, userId, days, limit = 20) {
  const { rows } = await db.query(
    `SELECT a.id, a.name, COUNT(s.id)::int AS launches, MAX(s.created_at) AS last_used
     FROM sso_access_logs s
     JOIN applications a ON a.id = s.application_id
     WHERE s.deleted_at IS NULL AND s.outcome = 'success'
       AND s.user_id = $1
       AND s.created_at >= now() - $2::interval
     GROUP BY a.id, a.name
     ORDER BY launches DESC
     LIMIT $3`,
    [userId, windowInterval(days), clampLimit(limit, 50)]
  );
  return rows;
}

/** Profile + activity totals for one user. */
async function userSummary(db, userId, days) {
  const { rows } = await db.query(
    `WITH l AS (${LAUNCHES_CTE}),
          s AS (${SESSIONS_CTE})
     SELECT u.id, u.email, u.role, u.is_active, u.created_at, bu.name AS department,
            COALESCE(l.launches, 0)::int AS launches,
            COALESCE(s.sessions, 0)::int AS sessions,
            COALESCE(s.minutes, 0) AS minutes,
            GREATEST(l.last_launch, s.last_seen) AS last_seen
     FROM users u
     LEFT JOIN business_units bu ON bu.id = u.business_unit_id AND bu.deleted_at IS NULL
     LEFT JOIN l ON l.user_id = u.id
     LEFT JOIN s ON s.user_id = u.id
     WHERE u.id = $2 AND u.deleted_at IS NULL`,
    [windowInterval(days), userId]
  );
  return rows[0] || null;
}

module.exports = {
  overview,
  topApps,
  activeUsers,
  launchesByDay,
  launches,
  sessions,
  appUsers,
  appsForUser,
  userSummary,
};
