/**
 * Fixed, read-only queries behind the service API (routes/service.js). SELECT only; every
 * filter is validated and bound as a parameter, and every list is capped.
 */
const sentinelDb = require('./sentinelDb');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clampDays = (d, dflt = 7) => Math.max(1, Math.min(90, parseInt(d, 10) || dflt));
const clampLimit = (n, dflt = 20, max = 50) => Math.max(1, Math.min(max, parseInt(n, 10) || dflt));

/** "hub", an application id, or undefined for every scope. */
function scopeFilter(scope, params, col) {
  if (scope === undefined || scope === null || scope === '') return null;
  if (scope === 'hub') return `${col} IS NULL`;
  if (!UUID_RE.test(String(scope))) throw Object.assign(new Error('Invalid scope'), { status: 400 });
  params.push(scope);
  return `${col} = $${params.length}`;
}

/**
 * Every application plus Downstream Hub itself, each with open reports, errors in the last
 * 7 days, whether code is connected, and Sentinel's latest health verdict.
 */
async function overview(db) {
  const { rows } = await db.query(
    `WITH scopes AS (
       SELECT 'hub'::text AS scope, NULL::uuid AS application_id, 'Downstream Hub' AS name, NULL::text AS target_url
       UNION ALL
       SELECT a.id::text, a.id, a.name, a.target_url FROM applications a WHERE a.deleted_at IS NULL
     )
     SELECT s.scope, s.name, s.target_url,
            (c.repo IS NOT NULL) AS code_connected, COALESCE(c.auto_analyze, TRUE) AS auto_analyze,
            (SELECT COUNT(*) FROM bug_reports b WHERE b.application_id IS NOT DISTINCT FROM s.application_id AND b.status = 'open')::int AS open_reports,
            (SELECT COUNT(*) FROM bug_reports b WHERE b.application_id IS NOT DISTINCT FROM s.application_id
               AND b.kind = 'client_error' AND b.created_at >= now() - interval '7 days')::int AS errors_7d,
            (SELECT COUNT(*) FROM bug_reports b WHERE b.application_id IS NOT DISTINCT FROM s.application_id
               AND b.kind = 'user_report' AND b.created_at >= now() - interval '7 days')::int AS user_reports_7d,
            h.result->>'status' AS health_status, h.result->>'headline' AS health_headline, h.finished_at AS health_at
     FROM scopes s
     LEFT JOIN sentinel_config c ON c.scope = s.scope
     LEFT JOIN LATERAL (
       SELECT r.result, r.finished_at FROM sentinel_runs r
       WHERE r.kind = 'health' AND r.status = 'done' AND r.scope = s.scope
       ORDER BY r.created_at DESC LIMIT 1) h ON TRUE
     ORDER BY (s.scope = 'hub') DESC, s.name`
  );
  return rows;
}

/** Sentinel's work, newest first: bug analyses, health reports, answers. */
async function runs(db, { scope, kind, status, days, limit } = {}) {
  const params = [`${clampDays(days)} days`];
  const where = ['r.created_at >= now() - $1::interval'];
  if (scope !== undefined && scope !== '') {
    if (!sentinelDb.isScope(scope)) throw Object.assign(new Error('Invalid scope'), { status: 400 });
    params.push(scope); where.push(`r.scope = $${params.length}`);
  }
  if (kind) {
    if (!['bug', 'health', 'ask'].includes(kind)) throw Object.assign(new Error('Invalid kind'), { status: 400 });
    params.push(kind); where.push(`r.kind = $${params.length}`);
  }
  if (status) {
    if (!['queued', 'running', 'done', 'failed', 'skipped'].includes(status)) throw Object.assign(new Error('Invalid status'), { status: 400 });
    params.push(status); where.push(`r.status = $${params.length}`);
  }
  params.push(clampLimit(limit));
  const { rows } = await db.query(
    `SELECT r.id, r.kind, r.scope, COALESCE(a.name, CASE WHEN r.scope = 'hub' THEN 'Downstream Hub' END) AS application_name,
            r.bug_report_id, r.trigger, r.status, r.created_at, r.finished_at, r.model,
            r.result->>'severity' AS severity, r.result->>'category' AS category, r.result->>'confidence' AS confidence,
            r.result->>'status' AS health_status,
            CASE WHEN r.kind = 'health' THEN r.result->>'headline'
                 ELSE COALESCE(r.result->>'summary', LEFT(r.result->>'answer', 400)) END AS summary,
            r.input->>'question' AS question, LEFT(r.error, 300) AS error
     FROM sentinel_runs r LEFT JOIN applications a ON a.id = r.application_id
     WHERE ${where.join(' AND ')}
     ORDER BY r.created_at DESC LIMIT $${params.length}`,
    params
  );
  return rows;
}

/** One run in full: the structured analysis, health report or answer. */
async function run(db, id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  const { rows } = await db.query(
    `SELECT r.id, r.kind, r.scope, COALESCE(a.name, CASE WHEN r.scope = 'hub' THEN 'Downstream Hub' END) AS application_name,
            r.bug_report_id, r.fingerprint, r.trigger, r.status, r.input, r.result, r.model, r.tool_calls,
            r.created_at, r.started_at, r.finished_at, LEFT(r.error, 1000) AS error
     FROM sentinel_runs r LEFT JOIN applications a ON a.id = r.application_id
     WHERE r.id = $1`,
    [id]
  );
  return rows[0] || null;
}

/** Bug reports and captured JS errors, with Sentinel's verdict where there is one. */
async function bugReports(db, { scope, status, kind, days, limit } = {}) {
  const params = [`${clampDays(days, 30)} days`];
  const where = ['b.created_at >= now() - $1::interval'];
  const sc = scopeFilter(scope, params, 'b.application_id');
  if (sc) where.push(sc);
  if (status) {
    if (!['open', 'resolved'].includes(status)) throw Object.assign(new Error('Invalid status'), { status: 400 });
    params.push(status); where.push(`b.status = $${params.length}`);
  }
  if (kind) {
    if (!['user_report', 'client_error'].includes(kind)) throw Object.assign(new Error('Invalid kind'), { status: 400 });
    params.push(kind); where.push(`b.kind = $${params.length}`);
  }
  params.push(clampLimit(limit, 25));
  const { rows } = await db.query(
    `SELECT b.id, b.kind, b.status, b.created_at, b.resolved_at, LEFT(b.message, 500) AS message, b.page_url,
            COALESCE(a.name, 'Downstream Hub') AS application_name, b.release, b.fingerprint,
            COALESCE(u.email, b.user_email) AS reporter,
            sr.id AS sentinel_run_id, sr.status AS sentinel_status,
            sr.result->>'severity' AS sentinel_severity, sr.result->>'summary' AS sentinel_summary
     FROM bug_reports b
     LEFT JOIN users u ON u.id = b.user_id
     LEFT JOIN applications a ON a.id = b.application_id
     LEFT JOIN LATERAL (
       SELECT r.id, r.status, r.result FROM sentinel_runs r
       WHERE r.kind = 'bug' AND (r.bug_report_id = b.id OR (b.fingerprint IS NOT NULL AND r.fingerprint = b.fingerprint))
       ORDER BY (r.status IN ('queued', 'running')) DESC, r.created_at DESC
       LIMIT 1) sr ON TRUE
     WHERE ${where.join(' AND ')}
     ORDER BY b.created_at DESC LIMIT $${params.length}`,
    params
  );
  return rows;
}

/** Captured JS errors for one scope: grouped by fingerprint, and per day. */
async function errors(db, { scope, days } = {}) {
  if (!sentinelDb.isScope(scope)) throw Object.assign(new Error('scope is required: "hub" or an application id'), { status: 400 });
  const d = clampDays(days);
  const [groups, byDay] = await Promise.all([sentinelDb.errorGroups(db, scope, d, 20), sentinelDb.errorsByDay(db, scope, d)]);
  return { days: d, groups, by_day: byDay };
}

module.exports = { overview, runs, run, bugReports, errors, clampDays, clampLimit };
