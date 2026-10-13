/**
 * Bug reports: user-submitted reports and auto-captured client errors.
 */
const VALID_KINDS = ['user_report', 'client_error'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function insert(db, { userId, kind, message, pageUrl, stack, userAgent, ipAddress }) {
  const k = VALID_KINDS.includes(kind) ? kind : 'user_report';
  const { rows } = await db.query(
    `INSERT INTO bug_reports (user_id, kind, message, page_url, stack, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, kind, status, created_at`,
    [
      userId || null,
      k,
      String(message).slice(0, 5000),
      pageUrl ? String(pageUrl).slice(0, 1000) : null,
      stack ? String(stack).slice(0, 8000) : null,
      userAgent ? String(userAgent).slice(0, 500) : null,
      ipAddress || null,
    ]
  );
  return rows[0];
}

/**
 * scope: 'hub' (the Hub itself, application_id IS NULL), an application UUID, or 'all' (default).
 */
function scopeClause(scope, params) {
  if (scope === 'hub') return 'b.application_id IS NULL';
  if (typeof scope === 'string' && UUID_RE.test(scope)) {
    params.push(scope);
    return `b.application_id = $${params.length}`;
  }
  return null;
}

async function list(db, { status, kind, scope, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (status && ['open', 'resolved'].includes(status)) {
    params.push(status);
    where.push(`b.status = $${params.length}`);
  }
  if (kind && VALID_KINDS.includes(kind)) {
    params.push(kind);
    where.push(`b.kind = $${params.length}`);
  }
  const sc = scopeClause(scope, params);
  if (sc) where.push(sc);
  params.push(Math.min(500, Math.max(1, limit)));
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await db.query(
    `SELECT b.id, b.kind, b.message, b.page_url, b.stack, b.user_agent, b.status, b.created_at,
            b.resolved_at, b.user_id, COALESCE(u.email, b.user_email) AS reporter_email,
            b.application_id, a.name AS application_name
     FROM bug_reports b
     LEFT JOIN users u ON u.id = b.user_id
     LEFT JOIN applications a ON a.id = b.application_id
     ${whereSql}
     ORDER BY b.created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}

async function setStatus(db, id, status, resolvedBy) {
  const resolved = status === 'resolved';
  const { rows } = await db.query(
    `UPDATE bug_reports
       SET status = $2,
           resolved_at = CASE WHEN $2 = 'resolved' THEN now() ELSE NULL END,
           resolved_by = CASE WHEN $2 = 'resolved' THEN $3 ELSE NULL END
     WHERE id = $1
     RETURNING id, status, resolved_at`,
    [id, resolved ? 'resolved' : 'open', resolvedBy || null]
  );
  return rows[0] || null;
}

async function counts(db, scope) {
  const params = [];
  const sc = scopeClause(scope, params);
  const { rows } = await db.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE b.status = 'open')::int AS open,
       COUNT(*) FILTER (WHERE b.kind = 'client_error')::int AS client_errors
     FROM bug_reports b ${sc ? `WHERE ${sc}` : ''}`,
    params
  );
  return rows[0];
}

module.exports = { insert, list, setStatus, counts, VALID_KINDS };
