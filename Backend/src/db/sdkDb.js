/**
 * Data access for the embeddable Hub SDK: app lookup by publishable key, user
 * resolution, session/event ingestion, and the per-application SDK settings.
 */
const { generateSdkKey } = require('../lib/sdkPolicy');

const APP_CACHE_MS = 60 * 1000;
const USER_CACHE_MS = 5 * 60 * 1000;
const appCache = new Map(); // sdk_key -> { app, expires }
const userCache = new Map(); // "id|email" -> { value, expires }

function cacheGet(map, key) {
  const hit = map.get(key);
  if (hit && hit.expires > Date.now()) return hit;
  if (hit) map.delete(key);
  return null;
}

function cacheSet(map, key, value, ttl) {
  if (map.size > 5000) map.clear(); // crude bound; entries are cheap to rebuild
  map.set(key, { value, expires: Date.now() + ttl });
}

/** Application for a publishable key (only fields ingestion needs). Cached briefly. */
async function getAppBySdkKey(db, sdkKey) {
  const hit = cacheGet(appCache, sdkKey);
  if (hit) return hit.value;
  const { rows } = await db.query(
    `SELECT id, name, target_url, oidc_redirect_uris, sdk_enabled, sdk_allowed_origins
     FROM applications WHERE sdk_key = $1 AND deleted_at IS NULL`,
    [sdkKey]
  );
  const app = rows[0] || null;
  cacheSet(appCache, sdkKey, app, APP_CACHE_MS);
  return app;
}

function invalidateKey(sdkKey) {
  if (sdkKey) appCache.delete(sdkKey);
}

/**
 * Map what the app reported (Hub user id and/or email) to a Hub user.
 * Unknown users are kept as email-only so their activity is still visible.
 */
async function resolveUser(db, { id, email }) {
  if (!id && !email) return { userId: null, email: null };
  const key = `${id || ''}|${email || ''}`;
  const hit = cacheGet(userCache, key);
  if (hit) return hit.value;
  let row = null;
  if (id) {
    const r = await db.query('SELECT id, email FROM users WHERE id = $1 AND deleted_at IS NULL', [id]);
    row = r.rows[0] || null;
  }
  if (!row && email) {
    const r = await db.query('SELECT id, email FROM users WHERE lower(email) = $1 AND deleted_at IS NULL', [email]);
    row = r.rows[0] || null;
  }
  const value = row ? { userId: row.id, email: row.email } : { userId: null, email: email || null };
  cacheSet(userCache, key, value, USER_CACHE_MS);
  return value;
}

/**
 * Store one SDK batch. events: already-sanitised
 *   { type: 'page_view', path, title } | { type: 'custom', name, path, properties }
 *   | { type: 'heartbeat' } | { type: 'error', message, stack, path }
 */
async function recordBatch(db, { app, sessionKey, anonymousId, user, userAgent, ip, events }) {
  const pageViews = events.filter((e) => e.type === 'page_view');
  await db.query(
    `INSERT INTO app_sessions (application_id, session_key, user_id, user_email, anonymous_id, page_views, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (application_id, session_key) DO UPDATE SET
       last_seen_at = now(),
       page_views   = app_sessions.page_views + EXCLUDED.page_views,
       user_id      = COALESCE(EXCLUDED.user_id, app_sessions.user_id),
       user_email   = COALESCE(EXCLUDED.user_email, app_sessions.user_email),
       anonymous_id = COALESCE(app_sessions.anonymous_id, EXCLUDED.anonymous_id)`,
    [app.id, sessionKey, user.userId, user.email, anonymousId, pageViews.length, userAgent, ip]
  );

  // Pages seen before the app called identify() (e.g. the login screen) belong to the
  // same browser session, so attribute them to the user once we know who it is.
  if (user.userId || user.email) {
    await db.query(
      `UPDATE app_events SET user_id = $3, user_email = $4
       WHERE application_id = $1 AND session_key = $2 AND user_id IS NULL AND user_email IS NULL`,
      [app.id, sessionKey, user.userId, user.email]
    );
  }

  const stored = events.filter((e) => e.type === 'page_view' || e.type === 'custom');
  if (stored.length > 0) {
    const values = [];
    const params = [];
    stored.forEach((e) => {
      const base = params.length;
      params.push(app.id, sessionKey, user.userId, user.email, e.type, e.name || null, e.path || null, e.title || null,
        e.properties ? JSON.stringify(e.properties) : null);
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`);
    });
    await db.query(
      `INSERT INTO app_events (application_id, session_key, user_id, user_email, event_type, name, path, title, properties)
       VALUES ${values.join(', ')}`,
      params
    );
  }

  const errors = events.filter((e) => e.type === 'error');
  for (const e of errors) {
    await insertBugReport(db, {
      app, sessionKey, user, userAgent, ip,
      kind: 'client_error', message: e.message, stack: e.stack, pageUrl: e.path,
    });
  }
}

async function insertBugReport(db, { app, sessionKey, user, userAgent, ip, kind, message, stack, pageUrl }) {
  const { rows } = await db.query(
    `INSERT INTO bug_reports (application_id, session_key, user_id, user_email, kind, message, page_url, stack, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, kind, status, created_at`,
    [app.id, sessionKey, user.userId, user.email, kind, message, pageUrl || null, stack || null, userAgent, ip]
  );
  return rows[0];
}

/* ---------- admin: per-application SDK settings ---------- */

async function getSettings(db, appId) {
  const { rows } = await db.query(
    `SELECT id, name, target_url, oidc_redirect_uris, sdk_key, sdk_enabled, sdk_allowed_origins
     FROM applications WHERE id = $1 AND deleted_at IS NULL`,
    [appId]
  );
  return rows[0] || null;
}

/** Give the app a key if it has none yet (keys are created lazily). */
async function ensureKey(db, appId) {
  const { rows } = await db.query(
    `UPDATE applications SET sdk_key = $2
     WHERE id = $1 AND sdk_key IS NULL AND deleted_at IS NULL
     RETURNING sdk_key`,
    [appId, generateSdkKey()]
  );
  return rows[0]?.sdk_key || null;
}

async function rotateKey(db, appId) {
  const before = await getSettings(db, appId);
  if (!before) return null;
  const { rows } = await db.query(
    'UPDATE applications SET sdk_key = $2, updated_at = now() WHERE id = $1 RETURNING sdk_key',
    [appId, generateSdkKey()]
  );
  invalidateKey(before.sdk_key);
  return rows[0]?.sdk_key || null;
}

async function updateSettings(db, appId, { enabled, allowedOrigins }) {
  const before = await getSettings(db, appId);
  if (!before) return null;
  await db.query(
    `UPDATE applications
     SET sdk_enabled = COALESCE($2, sdk_enabled),
         sdk_allowed_origins = COALESCE($3, sdk_allowed_origins),
         updated_at = now()
     WHERE id = $1`,
    [appId, typeof enabled === 'boolean' ? enabled : null, Array.isArray(allowedOrigins) ? allowedOrigins : null]
  );
  invalidateKey(before.sdk_key);
  return getSettings(db, appId);
}

/** Is the SDK actually sending data? */
async function ingestionStatus(db, appId) {
  const { rows } = await db.query(
    `SELECT
       (SELECT MAX(last_seen_at) FROM app_sessions WHERE application_id = $1) AS last_event_at,
       (SELECT COUNT(*) FROM app_sessions WHERE application_id = $1 AND started_at >= now() - interval '24 hours')::int AS sessions_24h,
       (SELECT COUNT(*) FROM app_events WHERE application_id = $1 AND created_at >= now() - interval '24 hours')::int AS events_24h,
       (SELECT COUNT(*) FROM bug_reports WHERE application_id = $1 AND kind = 'client_error'
          AND created_at >= now() - interval '24 hours')::int AS errors_24h`,
    [appId]
  );
  return rows[0];
}

module.exports = {
  getAppBySdkKey,
  invalidateKey,
  resolveUser,
  recordBatch,
  insertBugReport,
  getSettings,
  ensureKey,
  rotateKey,
  updateSettings,
  ingestionStatus,
};
