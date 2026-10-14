/**
 * Data access for Sentinel: its run queue, per-scope settings, and the read-only
 * queries behind its tools (bug context, session timelines, error groups, usage).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isScope(scope) {
  return scope === 'hub' || UUID_RE.test(String(scope || ''));
}

function interval(days) {
  return `${Math.max(1, Math.min(365, parseInt(days, 10) || 30))} days`;
}

/* ---------- settings ---------- */

const DEFAULT_CONFIG = { repo: null, branch: 'main', source_root: '', notes: null, auto_analyze: true, updated_at: null };

async function getConfig(db, scope) {
  const { rows } = await db.query('SELECT * FROM sentinel_config WHERE scope = $1', [scope]);
  return { scope, ...DEFAULT_CONFIG, ...(rows[0] || {}) };
}

async function saveConfig(db, scope, { repo, branch, sourceRoot, notes, autoAnalyze }, userId) {
  const { rows } = await db.query(
    `INSERT INTO sentinel_config (scope, repo, branch, source_root, notes, auto_analyze, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (scope) DO UPDATE SET
       repo = EXCLUDED.repo, branch = EXCLUDED.branch, source_root = EXCLUDED.source_root,
       notes = EXCLUDED.notes, auto_analyze = EXCLUDED.auto_analyze,
       updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING *`,
    [scope, repo || null, branch || 'main', sourceRoot || '', notes || null, autoAnalyze !== false, userId || null]
  );
  return rows[0];
}

/** Name/URL of the scope, for prompts and headers. */
async function scopeInfo(db, scope) {
  if (scope === 'hub') return { scope, name: 'Downstream Hub', target_url: process.env.PUBLIC_APP_URL || null, hub: true };
  const { rows } = await db.query(
    'SELECT id, name, description, target_url FROM applications WHERE id = $1 AND deleted_at IS NULL',
    [scope]
  );
  return rows[0] ? { scope, ...rows[0], hub: false } : null;
}

/* ---------- runs ---------- */

const RUN_COLUMNS = `r.id, r.kind, r.scope, r.application_id, r.bug_report_id, r.fingerprint, r.parent_id,
  r.trigger, r.status, r.input, r.result, r.model, r.input_tokens, r.output_tokens, r.tool_calls,
  r.error, r.requested_by, r.created_at, r.started_at, r.finished_at`;

async function createRun(db, { kind, scope, bugReportId, fingerprint, parentId, trigger = 'manual', input, requestedBy, status = 'queued', error }) {
  const { rows } = await db.query(
    `INSERT INTO sentinel_runs (kind, scope, application_id, bug_report_id, fingerprint, parent_id, trigger, status, input, requested_by, error, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $12::boolean THEN now() END)
     RETURNING *`,
    [kind, scope, scope === 'hub' ? null : scope, bugReportId || null, fingerprint || null, parentId || null,
      trigger, status, input ? JSON.stringify(input) : null, requestedBy || null, error || null,
      status === 'skipped' || status === 'failed']
  );
  return rows[0];
}

/** Take the next queued run (manual before automatic, oldest first). */
async function claimNext(db) {
  const { rows } = await db.query(
    `UPDATE sentinel_runs SET status = 'running', started_at = now()
     WHERE id = (
       SELECT id FROM sentinel_runs WHERE status = 'queued'
       ORDER BY (trigger = 'manual') DESC, created_at
       LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`
  );
  return rows[0] || null;
}

/** After a restart, put runs that were mid-flight back in the queue. */
async function requeueInterrupted(db) {
  const { rowCount } = await db.query(
    `UPDATE sentinel_runs SET status = 'queued', started_at = NULL WHERE status = 'running'`
  );
  return rowCount;
}

async function finishRun(db, id, { status, result, model, inputTokens = 0, outputTokens = 0, toolCalls = 0, error }) {
  await db.query(
    `UPDATE sentinel_runs
     SET status = $2, result = $3, model = $4, input_tokens = $5, output_tokens = $6,
         tool_calls = $7, error = $8, finished_at = now()
     WHERE id = $1`,
    [id, status, result ? JSON.stringify(result) : null, model || null, inputTokens, outputTokens, toolCalls, error || null]
  );
}

async function getRun(db, id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  const { rows } = await db.query(
    `SELECT ${RUN_COLUMNS}, a.name AS application_name, u.email AS requested_by_email
     FROM sentinel_runs r
     LEFT JOIN applications a ON a.id = r.application_id
     LEFT JOIN users u ON u.id = r.requested_by
     WHERE r.id = $1`,
    [id]
  );
  return rows[0] || null;
}

async function listRuns(db, { scope, kind, limit = 20 } = {}) {
  const where = [];
  const params = [];
  if (scope && isScope(scope)) { params.push(scope); where.push(`r.scope = $${params.length}`); }
  if (kind && ['bug', 'health', 'ask'].includes(kind)) { params.push(kind); where.push(`r.kind = $${params.length}`); }
  params.push(Math.min(100, Math.max(1, parseInt(limit, 10) || 20)));
  const { rows } = await db.query(
    `SELECT ${RUN_COLUMNS}, a.name AS application_name, u.email AS requested_by_email
     FROM sentinel_runs r
     LEFT JOIN applications a ON a.id = r.application_id
     LEFT JOIN users u ON u.id = r.requested_by
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY r.created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

/** The analysis to show for a bug: its own latest run, else the latest run for the same error. */
async function latestForBug(db, bug) {
  const { rows } = await db.query(
    `SELECT ${RUN_COLUMNS}, u.email AS requested_by_email,
            (r.bug_report_id = $1) AS own
     FROM sentinel_runs r
     LEFT JOIN users u ON u.id = r.requested_by
     WHERE r.kind = 'bug' AND (r.bug_report_id = $1 OR ($2::text IS NOT NULL AND r.fingerprint = $2))
     ORDER BY (r.status IN ('queued', 'running')) DESC, r.created_at DESC
     LIMIT 1`,
    [bug.id, bug.fingerprint || null]
  );
  return rows[0] || null;
}

/** A queued/running analysis already covering this bug (or the same error). */
async function activeForBug(db, bug) {
  const { rows } = await db.query(
    `SELECT id FROM sentinel_runs
     WHERE kind = 'bug' AND status IN ('queued', 'running')
       AND (bug_report_id = $1 OR ($2::text IS NOT NULL AND fingerprint = $2))
     LIMIT 1`,
    [bug.id, bug.fingerprint || null]
  );
  return rows[0] || null;
}

/** Was this error already analysed (or being analysed) recently? */
async function recentForFingerprint(db, fingerprint, days = 14) {
  const { rows } = await db.query(
    `SELECT id FROM sentinel_runs
     WHERE kind = 'bug' AND fingerprint = $1 AND status IN ('queued', 'running', 'done')
       AND created_at >= now() - $2::interval
     LIMIT 1`,
    [fingerprint, interval(days)]
  );
  return rows[0] || null;
}

async function autoRunsToday(db) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM sentinel_runs
     WHERE trigger = 'auto' AND status IN ('running', 'done', 'failed') AND created_at >= date_trunc('day', now())`
  );
  return rows[0].n;
}

async function stats(db) {
  const { rows } = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
       COUNT(*) FILTER (WHERE status = 'running')::int AS running,
       COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now()) AND status IN ('done', 'failed'))::int AS runs_today,
       COUNT(*) FILTER (WHERE trigger = 'auto' AND status IN ('running', 'done', 'failed') AND created_at >= date_trunc('day', now()))::int AS auto_today,
       COALESCE(SUM(input_tokens) FILTER (WHERE created_at >= date_trunc('day', now())), 0)::bigint AS input_tokens_today,
       COALESCE(SUM(output_tokens) FILTER (WHERE created_at >= date_trunc('day', now())), 0)::bigint AS output_tokens_today,
       COALESCE(SUM(input_tokens) FILTER (WHERE created_at >= date_trunc('month', now())), 0)::bigint AS input_tokens_month,
       COALESCE(SUM(output_tokens) FILTER (WHERE created_at >= date_trunc('month', now())), 0)::bigint AS output_tokens_month
     FROM sentinel_runs`
  );
  return rows[0];
}

/** Earlier questions and answers in a conversation (oldest first). */
async function askChain(db, parentId, depth = 6) {
  const chain = [];
  let id = parentId;
  while (id && chain.length < depth) {
    const run = await getRun(db, id);
    if (!run || run.kind !== 'ask') break;
    chain.unshift(run);
    id = run.parent_id;
  }
  return chain;
}

/* ---------- read-only context for the agent's tools ---------- */

async function getBug(db, id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  const { rows } = await db.query(
    `SELECT b.id, b.kind, b.message, b.page_url, b.stack, b.user_agent, b.status, b.created_at,
            b.application_id, b.session_key, b.fingerprint, b.release, b.context, b.user_id,
            COALESCE(u.email, b.user_email) AS reporter_email, a.name AS application_name
     FROM bug_reports b
     LEFT JOIN users u ON u.id = b.user_id
     LEFT JOIN applications a ON a.id = b.application_id
     WHERE b.id = $1`,
    [id]
  );
  return rows[0] || null;
}

/** What the user did in the app session before (and just after) the bug. */
async function sessionTimeline(db, bug, limit = 60) {
  if (!bug.application_id || !bug.session_key) return null;
  const [session, events, related] = await Promise.all([
    db.query(
      `SELECT s.started_at, s.last_seen_at, s.page_views, s.user_agent, COALESCE(u.email, s.user_email) AS user_email
       FROM app_sessions s LEFT JOIN users u ON u.id = s.user_id
       WHERE s.application_id = $1 AND s.session_key = $2`,
      [bug.application_id, bug.session_key]
    ),
    db.query(
      `SELECT * FROM (
         SELECT created_at, event_type, name, path, title, properties
         FROM app_events
         WHERE application_id = $1 AND session_key = $2 AND created_at <= $3::timestamptz + interval '2 minutes'
         ORDER BY created_at DESC LIMIT $4) x
       ORDER BY created_at`,
      [bug.application_id, bug.session_key, bug.created_at, limit]
    ),
    db.query(
      `SELECT created_at, kind, LEFT(message, 400) AS message, page_url
       FROM bug_reports
       WHERE application_id = $1 AND session_key = $2 AND id <> $3
       ORDER BY created_at DESC LIMIT 20`,
      [bug.application_id, bug.session_key, bug.id]
    ),
  ]);
  return { session: session.rows[0] || null, events: events.rows, other_reports_in_session: related.rows };
}

/** How widespread is this error? Plus nearby errors for free-text user reports. */
async function similarReports(db, bug) {
  const out = {};
  if (bug.fingerprint) {
    const [agg, samples] = await Promise.all([
      db.query(
        `SELECT COUNT(*)::int AS occurrences,
                COUNT(DISTINCT COALESCE(user_id::text, user_email, session_key))::int AS affected_users,
                MIN(created_at) AS first_seen, MAX(created_at) AS last_seen,
                COUNT(*) FILTER (WHERE created_at >= now() - interval '24 hours')::int AS last_24h,
                ARRAY_REMOVE(ARRAY_AGG(DISTINCT release), NULL) AS releases,
                COUNT(*) FILTER (WHERE status = 'open')::int AS open
         FROM bug_reports WHERE fingerprint = $1`,
        [bug.fingerprint]
      ),
      db.query(
        `SELECT b.created_at, b.page_url, b.release, COALESCE(u.email, b.user_email) AS user_email, LEFT(b.user_agent, 160) AS user_agent
         FROM bug_reports b LEFT JOIN users u ON u.id = b.user_id
         WHERE b.fingerprint = $1 ORDER BY b.created_at DESC LIMIT 8`,
        [bug.fingerprint]
      ),
    ]);
    out.same_error = { ...agg.rows[0], recent: samples.rows };
  }
  // Errors captured around the same time for the same user or session — often the
  // technical cause of a user's "it doesn't work" report.
  const params = [bug.created_at, bug.id];
  let who = 'FALSE';
  if (bug.session_key) { params.push(bug.session_key); who = `b.session_key = $${params.length}`; }
  if (bug.user_id) { params.push(bug.user_id); who += ` OR b.user_id = $${params.length}`; }
  const scopeSql = bug.application_id ? (params.push(bug.application_id), `b.application_id = $${params.length}`) : 'b.application_id IS NULL';
  const nearby = await db.query(
    `SELECT b.created_at, b.kind, LEFT(b.message, 400) AS message, LEFT(b.stack, 1200) AS stack, b.page_url
     FROM bug_reports b
     WHERE ${scopeSql} AND b.id <> $2 AND (${who})
       AND b.created_at BETWEEN $1::timestamptz - interval '30 minutes' AND $1::timestamptz + interval '10 minutes'
     ORDER BY b.created_at DESC LIMIT 10`,
    params
  );
  out.nearby_reports_same_user = nearby.rows;
  return out;
}

function scopeWhere(scope, params, alias = 'b') {
  if (scope === 'hub') return `${alias}.application_id IS NULL`;
  params.push(scope);
  return `${alias}.application_id = $${params.length}`;
}

/** Errors grouped by fingerprint, with Sentinel's verdict where there is one. */
async function errorGroups(db, scope, days, limit = 15) {
  const params = [interval(days)];
  const where = scopeWhere(scope, params);
  params.push(Math.min(50, limit));
  const { rows } = await db.query(
    `SELECT g.*, r.result->>'summary' AS sentinel_summary, r.result->>'severity' AS sentinel_severity
     FROM (
       SELECT b.fingerprint, MAX(LEFT(b.message, 300)) AS message, COUNT(*)::int AS occurrences,
              COUNT(DISTINCT COALESCE(b.user_id::text, b.user_email, b.session_key))::int AS affected_users,
              MIN(b.created_at) AS first_seen, MAX(b.created_at) AS last_seen,
              COUNT(*) FILTER (WHERE b.status = 'open')::int AS open,
              (ARRAY_AGG(b.page_url ORDER BY b.created_at DESC))[1] AS last_page
       FROM bug_reports b
       WHERE ${where} AND b.kind = 'client_error' AND b.created_at >= now() - $1::interval
       GROUP BY b.fingerprint
     ) g
     LEFT JOIN LATERAL (
       SELECT result FROM sentinel_runs
       WHERE kind = 'bug' AND status = 'done' AND g.fingerprint IS NOT NULL AND fingerprint = g.fingerprint
       ORDER BY created_at DESC LIMIT 1) r ON TRUE
     ORDER BY g.occurrences DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

async function bugReports(db, scope, { status, kind, days = 30, limit = 25 } = {}) {
  const params = [interval(days)];
  const where = [`b.created_at >= now() - $1::interval`, scopeWhere(scope, params)];
  if (status && ['open', 'resolved'].includes(status)) { params.push(status); where.push(`b.status = $${params.length}`); }
  if (kind && ['user_report', 'client_error'].includes(kind)) { params.push(kind); where.push(`b.kind = $${params.length}`); }
  params.push(Math.min(50, limit));
  const { rows } = await db.query(
    `SELECT b.id, b.kind, b.status, b.created_at, LEFT(b.message, 500) AS message, b.page_url,
            COALESCE(u.email, b.user_email) AS reporter_email
     FROM bug_reports b LEFT JOIN users u ON u.id = b.user_id
     WHERE ${where.join(' AND ')}
     ORDER BY b.created_at DESC LIMIT $${params.length}`,
    params
  );
  return rows;
}

/** This period vs the one before it, for one application. */
async function appPeriodComparison(db, appId, days) {
  const cur = interval(days);
  const both = interval(Math.min(730, 2 * (parseInt(days, 10) || 30)));
  const VIS = 'COALESCE(user_id::text, user_email, anonymous_id)';
  const [sessions, events, bugs, users] = await Promise.all([
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE started_at >= now() - $2::interval)::int AS sessions,
         COUNT(*) FILTER (WHERE started_at < now() - $2::interval)::int AS prev_sessions,
         COUNT(DISTINCT ${VIS}) FILTER (WHERE started_at >= now() - $2::interval)::int AS users,
         COUNT(DISTINCT ${VIS}) FILTER (WHERE started_at < now() - $2::interval)::int AS prev_users,
         COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (last_seen_at - started_at)) / 60.0) FILTER (WHERE started_at >= now() - $2::interval)::numeric, 0), 0) AS minutes,
         COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (last_seen_at - started_at)) / 60.0) FILTER (WHERE started_at < now() - $2::interval)::numeric, 0), 0) AS prev_minutes
       FROM app_sessions WHERE application_id = $1 AND started_at >= now() - $3::interval`,
      [appId, cur, both]
    ),
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE event_type = 'page_view' AND created_at >= now() - $2::interval)::int AS page_views,
         COUNT(*) FILTER (WHERE event_type = 'page_view' AND created_at < now() - $2::interval)::int AS prev_page_views,
         COUNT(*) FILTER (WHERE event_type = 'custom' AND created_at >= now() - $2::interval)::int AS actions,
         COUNT(*) FILTER (WHERE event_type = 'custom' AND created_at < now() - $2::interval)::int AS prev_actions
       FROM app_events WHERE application_id = $1 AND created_at >= now() - $3::interval`,
      [appId, cur, both]
    ),
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE kind = 'client_error' AND created_at >= now() - $2::interval)::int AS errors,
         COUNT(*) FILTER (WHERE kind = 'client_error' AND created_at < now() - $2::interval)::int AS prev_errors,
         COUNT(*) FILTER (WHERE kind = 'user_report' AND created_at >= now() - $2::interval)::int AS reports,
         COUNT(*) FILTER (WHERE kind = 'user_report' AND created_at < now() - $2::interval)::int AS prev_reports
       FROM bug_reports WHERE application_id = $1 AND created_at >= now() - $3::interval`,
      [appId, cur, both]
    ),
    // Identified users: new this period, and regulars from the previous period who did not come back.
    db.query(
      `WITH v AS (
         SELECT COALESCE(user_id::text, user_email) AS who,
                MIN(started_at) AS first_seen,
                BOOL_OR(started_at >= now() - $2::interval) AS in_current,
                COUNT(*) FILTER (WHERE started_at < now() - $2::interval AND started_at >= now() - $3::interval) AS prev_sessions
         FROM app_sessions
         WHERE application_id = $1 AND (user_id IS NOT NULL OR user_email IS NOT NULL)
         GROUP BY 1)
       SELECT COUNT(*) FILTER (WHERE first_seen >= now() - $2::interval)::int AS new_users,
              COUNT(*) FILTER (WHERE NOT in_current AND prev_sessions >= 2)::int AS lapsed_regulars
       FROM v`,
      [appId, cur, both]
    ),
  ]);
  return { ...sessions.rows[0], ...events.rows[0], ...bugs.rows[0], ...users.rows[0] };
}

async function errorsByDay(db, scope, days) {
  const params = [interval(days)];
  const where = scopeWhere(scope, params);
  const { rows } = await db.query(
    `SELECT to_char(date_trunc('day', b.created_at), 'YYYY-MM-DD') AS day,
            COUNT(*) FILTER (WHERE b.kind = 'client_error')::int AS errors,
            COUNT(*) FILTER (WHERE b.kind = 'user_report')::int AS reports
     FROM bug_reports b WHERE ${where} AND b.created_at >= now() - $1::interval
     GROUP BY 1 ORDER BY 1`,
    params
  );
  return rows;
}

/** Pages with their views this period vs the previous one (spot drop-offs). */
async function pageTrends(db, appId, days, limit = 15) {
  const cur = interval(days);
  const both = interval(Math.min(730, 2 * (parseInt(days, 10) || 30)));
  const { rows } = await db.query(
    `SELECT path,
            COUNT(*) FILTER (WHERE created_at >= now() - $2::interval)::int AS views,
            COUNT(*) FILTER (WHERE created_at < now() - $2::interval)::int AS prev_views,
            COUNT(DISTINCT COALESCE(user_id::text, user_email, session_key)) FILTER (WHERE created_at >= now() - $2::interval)::int AS visitors
     FROM app_events
     WHERE application_id = $1 AND event_type = 'page_view' AND created_at >= now() - $3::interval
     GROUP BY path ORDER BY views DESC, prev_views DESC LIMIT $4`,
    [appId, cur, both, Math.min(50, limit)]
  );
  return rows;
}

module.exports = {
  isScope,
  getConfig,
  saveConfig,
  scopeInfo,
  createRun,
  claimNext,
  requeueInterrupted,
  finishRun,
  getRun,
  listRuns,
  latestForBug,
  activeForBug,
  recentForFingerprint,
  autoRunsToday,
  stats,
  askChain,
  getBug,
  sessionTimeline,
  similarReports,
  errorGroups,
  bugReports,
  appPeriodComparison,
  errorsByDay,
  pageTrends,
};
