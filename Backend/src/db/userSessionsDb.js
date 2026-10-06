/**
 * Hub usage sessions, tracked via periodic heartbeats from the SPA.
 * A "session" is a continuous visit: it starts on the first heartbeat and is
 * extended while heartbeats keep arriving within the idle window. After a gap
 * longer than the idle window, the next heartbeat opens a new session.
 */

// A session is considered idle/closed if no heartbeat for this many minutes.
const IDLE_WINDOW_MINUTES = Math.max(2, parseInt(process.env.ACTIVITY_IDLE_WINDOW_MINUTES || '5', 10));

/**
 * Record a heartbeat for a user. Extends the current open session when the last
 * heartbeat was recent; otherwise closes any stale open sessions and opens a new one.
 * Returns the active session id.
 */
async function heartbeat(db, { userId, ipAddress, userAgent }) {
  // Try to extend an open, non-idle session.
  const extend = await db.query(
    `UPDATE user_activity_sessions
       SET last_seen_at = now()
     WHERE id = (
       SELECT id FROM user_activity_sessions
       WHERE user_id = $1 AND ended_at IS NULL
         AND last_seen_at > now() - ($2 || ' minutes')::interval
       ORDER BY last_seen_at DESC
       LIMIT 1
     )
     RETURNING id`,
    [userId, String(IDLE_WINDOW_MINUTES)]
  );
  if (extend.rows[0]) return extend.rows[0].id;

  // Close any stale open sessions for this user (set ended_at to their last_seen_at).
  await db.query(
    `UPDATE user_activity_sessions
       SET ended_at = last_seen_at
     WHERE user_id = $1 AND ended_at IS NULL`,
    [userId]
  );

  // Open a new session.
  const { rows } = await db.query(
    `INSERT INTO user_activity_sessions (user_id, started_at, last_seen_at, ip_address, user_agent)
     VALUES ($1, now(), now(), $2, $3)
     RETURNING id`,
    [userId, ipAddress || null, userAgent ? String(userAgent).slice(0, 500) : null]
  );
  return rows[0].id;
}

/** Explicitly end the user's current open session (e.g. on sign out). */
async function endOpenSessions(db, userId) {
  await db.query(
    `UPDATE user_activity_sessions
       SET ended_at = now()
     WHERE user_id = $1 AND ended_at IS NULL`,
    [userId]
  );
}

module.exports = { heartbeat, endOpenSessions, IDLE_WINDOW_MINUTES };
