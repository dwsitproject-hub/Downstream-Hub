/**
 * Read-only aggregate queries for the Admin "Analytic" dashboard.
 * Sources: sso_access_logs (app launches), user_activity_sessions (time in Hub), users.
 * All queries are windowed to the last `days` days.
 */

function windowClause(days) {
  const d = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
  return { interval: `${d} days`, days: d };
}

/** Headline counters for the dashboard cards. */
async function overview(db, days) {
  const { interval } = windowClause(days);
  const { rows } = await db.query(
    `WITH launches AS (
       SELECT * FROM sso_access_logs
       WHERE deleted_at IS NULL AND outcome = 'success'
         AND created_at >= now() - $1::interval
     ),
     sess AS (
       SELECT * FROM user_activity_sessions
       WHERE started_at >= now() - $1::interval
     )
     SELECT
       (SELECT COUNT(DISTINCT user_id) FROM sess)::int AS active_users,
       (SELECT COUNT(*) FROM launches)::int AS total_launches,
       (SELECT COUNT(*) FROM sess)::int AS total_sessions,
       COALESCE((SELECT ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(ended_at, last_seen_at) - started_at)) / 60.0)::numeric, 1)
                 FROM sess), 0) AS avg_session_minutes,
       COALESCE((SELECT ROUND(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, last_seen_at) - started_at)) / 60.0)::numeric, 0)
                 FROM sess), 0) AS total_minutes`,
    [interval]
  );
  return rows[0];
}

/** Most-used applications (by successful launches). */
async function topApps(db, days, limit = 10) {
  const { interval } = windowClause(days);
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
    [interval, Math.min(50, limit)]
  );
  return rows;
}

/** Most active users: app launches + total time in Hub. */
async function topUsers(db, days, limit = 10) {
  const { interval } = windowClause(days);
  const { rows } = await db.query(
    `WITH launches AS (
       SELECT user_id, COUNT(*)::int AS launches
       FROM sso_access_logs
       WHERE deleted_at IS NULL AND outcome = 'success'
         AND created_at >= now() - $1::interval
       GROUP BY user_id
     ),
     sess AS (
       SELECT user_id,
              COUNT(*)::int AS sessions,
              ROUND(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, last_seen_at) - started_at)) / 60.0)::numeric, 0) AS minutes
       FROM user_activity_sessions
       WHERE started_at >= now() - $1::interval
       GROUP BY user_id
     )
     SELECT u.id, u.email,
            COALESCE(l.launches, 0) AS launches,
            COALESCE(se.sessions, 0) AS sessions,
            COALESCE(se.minutes, 0) AS minutes
     FROM users u
     LEFT JOIN launches l ON l.user_id = u.id
     LEFT JOIN sess se ON se.user_id = u.id
     WHERE u.deleted_at IS NULL
       AND (l.launches IS NOT NULL OR se.sessions IS NOT NULL)
     ORDER BY launches DESC, minutes DESC
     LIMIT $2`,
    [interval, Math.min(50, limit)]
  );
  return rows;
}

/** Daily launch volume for a simple trend chart. */
async function launchesByDay(db, days) {
  const { interval } = windowClause(days);
  const { rows } = await db.query(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
            COUNT(*)::int AS launches
     FROM sso_access_logs
     WHERE deleted_at IS NULL AND outcome = 'success'
       AND created_at >= now() - $1::interval
     GROUP BY 1
     ORDER BY 1`,
    [interval]
  );
  return rows;
}

/** Per-user app breakdown (which apps a given user opens most). */
async function appsForUser(db, userId, days, limit = 10) {
  const { interval } = windowClause(days);
  const { rows } = await db.query(
    `SELECT a.id, a.name, COUNT(s.id)::int AS launches
     FROM sso_access_logs s
     JOIN applications a ON a.id = s.application_id
     WHERE s.deleted_at IS NULL AND s.outcome = 'success'
       AND s.user_id = $1
       AND s.created_at >= now() - $2::interval
     GROUP BY a.id, a.name
     ORDER BY launches DESC
     LIMIT $3`,
    [userId, interval, Math.min(50, limit)]
  );
  return rows;
}

module.exports = { overview, topApps, topUsers, launchesByDay, appsForUser };
