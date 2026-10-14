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

/* ---------- per-application usage, reported by the embeddable SDK ---------- */

const SESSION_MINS = 'EXTRACT(EPOCH FROM (last_seen_at - started_at)) / 60.0';
// A visitor is a Hub user, else the email the app reported, else the browser's anonymous id.
const VISITOR = 'COALESCE(user_id::text, user_email, anonymous_id)';

/** One row per application: in-app usage + launches from the Hub + bug counts. */
async function appsOverview(db, days) {
  const { rows } = await db.query(
    `WITH s AS (
       SELECT application_id,
              COUNT(*)::int AS sessions,
              COUNT(DISTINCT ${VISITOR})::int AS active_users,
              ROUND(SUM(${SESSION_MINS})::numeric, 0) AS minutes,
              COALESCE(SUM(page_views), 0)::int AS page_views
       FROM app_sessions
       WHERE started_at >= now() - $1::interval
       GROUP BY application_id
     ),
     l AS (
       SELECT application_id, COUNT(*)::int AS launches
       FROM sso_access_logs
       WHERE deleted_at IS NULL AND outcome = 'success' AND created_at >= now() - $1::interval
       GROUP BY application_id
     ),
     b AS (
       SELECT application_id,
              COUNT(*) FILTER (WHERE status = 'open')::int AS open_bugs,
              COUNT(*) FILTER (WHERE kind = 'client_error' AND created_at >= now() - $1::interval)::int AS errors,
              COUNT(*) FILTER (WHERE kind = 'user_report' AND created_at >= now() - $1::interval)::int AS reports
       FROM bug_reports
       WHERE application_id IS NOT NULL
       GROUP BY application_id
     ),
     seen AS (
       SELECT application_id, MAX(last_seen_at) AS sdk_last_seen FROM app_sessions GROUP BY application_id
     )
     SELECT a.id, a.name, a.icon_url, a.sso_mode, a.sdk_enabled,
            COALESCE(s.active_users, 0) AS active_users, COALESCE(s.sessions, 0) AS sessions,
            COALESCE(s.minutes, 0) AS minutes, COALESCE(s.page_views, 0) AS page_views,
            COALESCE(l.launches, 0) AS launches, COALESCE(b.open_bugs, 0) AS open_bugs,
            COALESCE(b.errors, 0) AS errors, COALESCE(b.reports, 0) AS reports,
            seen.sdk_last_seen
     FROM applications a
     LEFT JOIN s ON s.application_id = a.id
     LEFT JOIN l ON l.application_id = a.id
     LEFT JOIN b ON b.application_id = a.id
     LEFT JOIN seen ON seen.application_id = a.id
     WHERE a.deleted_at IS NULL
     ORDER BY COALESCE(s.sessions, 0) DESC, COALESCE(l.launches, 0) DESC, a.name`,
    [windowInterval(days)]
  );
  return rows;
}

async function appInfo(db, appId) {
  const { rows } = await db.query(
    `SELECT a.id, a.name, a.icon_url, a.target_url, a.sso_mode, a.sdk_enabled,
            (SELECT MAX(last_seen_at) FROM app_sessions WHERE application_id = a.id) AS sdk_last_seen
     FROM applications a WHERE a.id = $1 AND a.deleted_at IS NULL`,
    [appId]
  );
  return rows[0] || null;
}

/** Everything the per-application dashboard shows. */
async function appUsage(db, appId, days) {
  const iv = windowInterval(days);
  const q = (sql) => db.query(sql, [appId, iv]).then((r) => r.rows);
  const [kpi, pageViewsByDay, sessionsByDay, topPages, topUsers, anonymous, topEvents, launches, bugs] = await Promise.all([
    q(`SELECT COUNT(*)::int AS sessions,
              COUNT(DISTINCT ${VISITOR})::int AS active_users,
              COALESCE(ROUND(SUM(mins)::numeric, 0), 0) AS total_minutes,
              COALESCE(ROUND(AVG(mins)::numeric, 1), 0) AS avg_session_minutes,
              COALESCE(SUM(page_views), 0)::int AS page_views
       FROM (SELECT *, ${SESSION_MINS} AS mins FROM app_sessions
             WHERE application_id = $1 AND started_at >= now() - $2::interval) x`),
    q(`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS value
       FROM app_events
       WHERE application_id = $1 AND event_type = 'page_view' AND created_at >= now() - $2::interval
       GROUP BY 1 ORDER BY 1`),
    q(`SELECT to_char(date_trunc('day', started_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS value
       FROM app_sessions
       WHERE application_id = $1 AND started_at >= now() - $2::interval
       GROUP BY 1 ORDER BY 1`),
    q(`SELECT path, MAX(title) AS title, COUNT(*)::int AS views,
              COUNT(DISTINCT COALESCE(user_id::text, user_email, session_key))::int AS visitors
       FROM app_events
       WHERE application_id = $1 AND event_type = 'page_view' AND created_at >= now() - $2::interval
       GROUP BY path ORDER BY views DESC LIMIT 10`),
    q(`SELECT s.user_id, COALESCE(u.email, s.user_email) AS email, bu.name AS department,
              COUNT(*)::int AS sessions,
              ROUND(SUM(EXTRACT(EPOCH FROM (s.last_seen_at - s.started_at)) / 60.0)::numeric, 0) AS minutes,
              COALESCE(SUM(s.page_views), 0)::int AS page_views, MAX(s.last_seen_at) AS last_seen
       FROM app_sessions s
       LEFT JOIN users u ON u.id = s.user_id
       LEFT JOIN business_units bu ON bu.id = u.business_unit_id AND bu.deleted_at IS NULL
       WHERE s.application_id = $1 AND s.started_at >= now() - $2::interval
         AND (s.user_id IS NOT NULL OR s.user_email IS NOT NULL)
       GROUP BY s.user_id, COALESCE(u.email, s.user_email), bu.name
       ORDER BY minutes DESC, sessions DESC LIMIT 10`),
    q(`SELECT COUNT(*)::int AS sessions
       FROM app_sessions
       WHERE application_id = $1 AND started_at >= now() - $2::interval AND user_id IS NULL AND user_email IS NULL`),
    q(`SELECT name, COUNT(*)::int AS count,
              COUNT(DISTINCT COALESCE(user_id::text, user_email, session_key))::int AS users
       FROM app_events
       WHERE application_id = $1 AND event_type = 'custom' AND created_at >= now() - $2::interval
       GROUP BY name ORDER BY count DESC LIMIT 10`),
    q(`SELECT COUNT(*)::int AS launches
       FROM sso_access_logs
       WHERE application_id = $1 AND deleted_at IS NULL AND outcome = 'success' AND created_at >= now() - $2::interval`),
    q(`SELECT COUNT(*) FILTER (WHERE status = 'open')::int AS open_bugs,
              COUNT(*) FILTER (WHERE kind = 'client_error' AND created_at >= now() - $2::interval)::int AS errors,
              COUNT(*) FILTER (WHERE kind = 'user_report' AND created_at >= now() - $2::interval)::int AS reports
       FROM bug_reports WHERE application_id = $1`),
  ]);
  return {
    kpi: { ...kpi[0], launches: launches[0].launches, anonymous_sessions: anonymous[0].sessions, ...bugs[0] },
    pageViewsByDay,
    sessionsByDay,
    topPages,
    topUsers,
    topEvents,
  };
}

/** Adds a "who" filter: a Hub user id, or the email an app reported for a non-Hub user. */
function visitorFilter(alias, { userId, email }, params) {
  if (userId) {
    params.push(userId);
    return `${alias}.user_id = $${params.length}`;
  }
  if (email) {
    params.push(String(email).toLowerCase());
    return `lower(COALESCE(u.email, ${alias}.user_email)) = $${params.length}`;
  }
  return null;
}

async function appSessions(db, appId, days, { userId, email, sort = 'recent', limit = 200 } = {}) {
  const params = [appId, windowInterval(days)];
  const where = ['s.application_id = $1', 's.started_at >= now() - $2::interval'];
  const vf = visitorFilter('s', { userId, email }, params);
  if (vf) where.push(vf);
  params.push(clampLimit(limit));
  const order = sort === 'longest' ? 'minutes DESC' : 's.started_at DESC';
  const { rows } = await db.query(
    `SELECT s.id, s.started_at, s.last_seen_at, s.page_views, s.user_id,
            COALESCE(u.email, s.user_email) AS email,
            ROUND((EXTRACT(EPOCH FROM (s.last_seen_at - s.started_at)) / 60.0)::numeric, 1) AS minutes,
            (s.last_seen_at > now() - interval '2 minutes') AS is_active,
            COUNT(*) OVER()::int AS total
     FROM app_sessions s
     LEFT JOIN users u ON u.id = s.user_id
     WHERE ${where.join(' AND ')}
     ORDER BY ${order}
     LIMIT $${params.length}`,
    params
  );
  return { total: rows[0]?.total || 0, rows };
}

async function appPageViews(db, appId, days, { path, userId, email, day, limit = 200 } = {}) {
  const params = [appId, windowInterval(days)];
  const where = ['e.application_id = $1', "e.event_type = 'page_view'", 'e.created_at >= now() - $2::interval'];
  if (path) { params.push(path); where.push(`e.path = $${params.length}`); }
  if (day) { params.push(day); where.push(`to_char(date_trunc('day', e.created_at), 'YYYY-MM-DD') = $${params.length}`); }
  const vf = visitorFilter('e', { userId, email }, params);
  if (vf) where.push(vf);
  params.push(clampLimit(limit));
  const { rows } = await db.query(
    `SELECT e.id, e.created_at, e.path, e.title, e.user_id, COALESCE(u.email, e.user_email) AS email,
            COUNT(*) OVER()::int AS total
     FROM app_events e
     LEFT JOIN users u ON u.id = e.user_id
     WHERE ${where.join(' AND ')}
     ORDER BY e.created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return { total: rows[0]?.total || 0, rows };
}

/** All identified users of an application, plus how many sessions were anonymous. */
async function appUsersUsage(db, appId, days) {
  const iv = windowInterval(days);
  const [users, anonymous] = await Promise.all([
    db.query(
      `SELECT s.user_id, COALESCE(u.email, s.user_email) AS email, bu.name AS department,
              (s.user_id IS NOT NULL) AS is_hub_user,
              COUNT(*)::int AS sessions,
              ROUND(SUM(EXTRACT(EPOCH FROM (s.last_seen_at - s.started_at)) / 60.0)::numeric, 0) AS minutes,
              COALESCE(SUM(s.page_views), 0)::int AS page_views, MAX(s.last_seen_at) AS last_seen
       FROM app_sessions s
       LEFT JOIN users u ON u.id = s.user_id
       LEFT JOIN business_units bu ON bu.id = u.business_unit_id AND bu.deleted_at IS NULL
       WHERE s.application_id = $1 AND s.started_at >= now() - $2::interval
         AND (s.user_id IS NOT NULL OR s.user_email IS NOT NULL)
       GROUP BY s.user_id, COALESCE(u.email, s.user_email), bu.name
       ORDER BY minutes DESC, sessions DESC
       LIMIT 500`,
      [appId, iv]
    ),
    db.query(
      `SELECT COUNT(*)::int AS sessions
       FROM app_sessions
       WHERE application_id = $1 AND started_at >= now() - $2::interval AND user_id IS NULL AND user_email IS NULL`,
      [appId, iv]
    ),
  ]);
  return { users: users.rows, anonymous_sessions: anonymous.rows[0].sessions };
}

/** One user's activity inside one application. */
async function appUserUsage(db, appId, days, { userId, email }) {
  const iv = windowInterval(days);
  const sessionParams = [appId, iv];
  const sessionFilter = visitorFilter('s', { userId, email }, sessionParams);
  const eventParams = [appId, iv];
  const eventFilter = visitorFilter('e', { userId, email }, eventParams);
  if (!sessionFilter || !eventFilter) return null;
  const [summary, pages, events, recent] = await Promise.all([
    db.query(
      `SELECT COUNT(*)::int AS sessions,
              COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (s.last_seen_at - s.started_at)) / 60.0)::numeric, 0), 0) AS minutes,
              COALESCE(SUM(s.page_views), 0)::int AS page_views,
              MAX(s.last_seen_at) AS last_seen, MIN(s.started_at) AS first_seen,
              MAX(COALESCE(u.email, s.user_email)) AS email, MAX(bu.name) AS department,
              BOOL_OR(s.user_id IS NOT NULL) AS is_hub_user
       FROM app_sessions s
       LEFT JOIN users u ON u.id = s.user_id
       LEFT JOIN business_units bu ON bu.id = u.business_unit_id AND bu.deleted_at IS NULL
       WHERE s.application_id = $1 AND s.started_at >= now() - $2::interval AND ${sessionFilter}`,
      sessionParams
    ),
    db.query(
      `SELECT e.path, MAX(e.title) AS title, COUNT(*)::int AS views, MAX(e.created_at) AS last_viewed
       FROM app_events e
       LEFT JOIN users u ON u.id = e.user_id
       WHERE e.application_id = $1 AND e.event_type = 'page_view' AND e.created_at >= now() - $2::interval AND ${eventFilter}
       GROUP BY e.path ORDER BY views DESC LIMIT 20`,
      eventParams
    ),
    db.query(
      `SELECT e.name, COUNT(*)::int AS count, MAX(e.created_at) AS last_at
       FROM app_events e
       LEFT JOIN users u ON u.id = e.user_id
       WHERE e.application_id = $1 AND e.event_type = 'custom' AND e.created_at >= now() - $2::interval AND ${eventFilter}
       GROUP BY e.name ORDER BY count DESC LIMIT 20`,
      eventParams
    ),
    appSessions(db, appId, days, { userId, email, limit: 20 }),
  ]);
  return { summary: summary.rows[0], pages: pages.rows, events: events.rows, sessions: recent.rows };
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
  appsOverview,
  appInfo,
  appUsage,
  appSessions,
  appPageViews,
  appUsersUsage,
  appUserUsage,
};
