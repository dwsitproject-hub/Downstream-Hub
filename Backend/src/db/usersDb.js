/**
 * Users data access. All reads exclude soft-deleted (deleted_at IS NULL).
 * Deletes are soft: UPDATE ... SET deleted_at = now().
 */
async function listWithBu(db) {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.role, u.business_unit_id, u.created_at,
            u.failed_login_attempts, u.locked_until, u.is_active,
            u.oidc_sub, u.oidc_linked_at, u.oidc_linked_by_mode,
            bu.name AS business_unit_name
     FROM users u
     LEFT JOIN business_units bu ON bu.id = u.business_unit_id AND bu.deleted_at IS NULL
     WHERE u.deleted_at IS NULL
     ORDER BY u.email`
  );
  return rows.map((r) => ({
    ...r,
    business_unit_name: r.business_unit_name || null,
  }));
}

async function getById(db, id) {
  const { rows } = await db.query(
    'SELECT id, email, role, business_unit_id, password_changed_at, failed_login_attempts, locked_until, token_version, oidc_sub, oidc_linked_at, oidc_linked_by_mode, hub_oidc_email_verified_at FROM users WHERE id = $1 AND deleted_at IS NULL',
    [id]
  );
  return rows[0] || null;
}

/** OIDC id_token / bridge JWT: user row fields needed for claims. */
async function getForSsoToken(db, id) {
  const { rows } = await db.query(
    'SELECT id, email, name, hub_oidc_email_verified_at FROM users WHERE id = $1 AND deleted_at IS NULL',
    [id]
  );
  return rows[0] || null;
}

/** Set after successful SSO magic-link inbox verification (sso_link_email_verifications consumed). */
async function setHubOidcEmailVerifiedAt(db, userId, at = new Date()) {
  await db.query(
    'UPDATE users SET hub_oidc_email_verified_at = $2 WHERE id = $1 AND deleted_at IS NULL',
    [userId, at]
  );
}

/** For /me: user with business_unit_name for display. */
async function getByIdWithBuName(db, id) {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.role, u.business_unit_id, bu.name AS business_unit_name
     FROM users u
     LEFT JOIN business_units bu ON bu.id = u.business_unit_id AND bu.deleted_at IS NULL
     WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [id]
  );
  const r = rows[0];
  return r ? { ...r, business_unit_name: r.business_unit_name || null } : null;
}

async function getByEmail(db, email) {
  const { rows } = await db.query(
    'SELECT id, email, password_hash, role, business_unit_id, password_changed_at, failed_login_attempts, locked_until, token_version, name, mfa_enabled, mfa_method, last_mfa_verified_at, is_active FROM users WHERE email = $1 AND deleted_at IS NULL',
    [email]
  );
  return rows[0] || null;
}

async function countActive(db) {
  const { rows } = await db.query(
    'SELECT COUNT(*)::int AS n FROM users WHERE deleted_at IS NULL'
  );
  return rows[0].n;
}

async function create(db, { email, password_hash, role, business_unit_id }) {
  const buId = business_unit_id || null;
  const { rows } = await db.query(
    `INSERT INTO users (email, password_hash, role, business_unit_id, password_changed_at) VALUES ($1, $2, $3, $4, now())
     RETURNING id, email, role, business_unit_id, created_at, token_version`,
    [email, password_hash, role, buId]
  );
  return rows[0];
}

/**
 * Create an invited user with NO password, marked inactive until they activate
 * via the emailed link. Login is blocked (is_active = false) until activation.
 */
async function createInvited(db, { email, role, business_unit_id }) {
  const buId = business_unit_id || null;
  const { rows } = await db.query(
    `INSERT INTO users (email, password_hash, role, business_unit_id, is_active)
     VALUES ($1, NULL, $2, $3, FALSE)
     RETURNING id, email, role, business_unit_id, created_at, token_version, is_active`,
    [email, role, buId]
  );
  return rows[0];
}

/**
 * Activate an invited user: set their first password, mark active + email verified.
 * The activation link was delivered to the user's inbox, so completing it proves
 * email ownership — that also satisfies the SSO email-verification gate
 * (hub_oidc_email_verified_at), so the user can open SSO apps immediately.
 * Bumps token_version so any stale sessions are invalidated.
 */
async function activateWithPassword(db, id, password_hash) {
  const { rows } = await db.query(
    `UPDATE users
     SET password_hash = $2,
         is_active = TRUE,
         email_verified_at = COALESCE(email_verified_at, now()),
         hub_oidc_email_verified_at = COALESCE(hub_oidc_email_verified_at, now()),
         password_changed_at = now(),
         token_version = COALESCE(token_version, 0) + 1,
         failed_login_attempts = 0,
         locked_until = NULL
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING id, email, role, business_unit_id`,
    [id, password_hash]
  );
  return rows[0] || null;
}

async function updatePassword(db, id, password_hash) {
  await db.query(
    'UPDATE users SET password_hash = $1, password_changed_at = now(), token_version = COALESCE(token_version, 0) + 1 WHERE id = $2 AND deleted_at IS NULL',
    [password_hash, id]
  );
}

/** Token version after password change (for JWT signing). */
async function getTokenVersion(db, id) {
  const { rows } = await db.query(
    'SELECT token_version FROM users WHERE id = $1 AND deleted_at IS NULL',
    [id]
  );
  return rows[0] ? Number(rows[0].token_version) : null;
}

async function updateBusinessUnit(db, id, business_unit_id) {
  return updateProfile(db, id, { business_unit_id });
}

/** Update role and/or business_unit_id. Only fields present in `fields` are updated. */
async function updateProfile(db, id, { role, business_unit_id }) {
  const sets = [];
  const params = [];
  let i = 1;
  if (role !== undefined) {
    sets.push(`role = $${i++}`);
    params.push(role);
  }
  if (business_unit_id !== undefined) {
    sets.push(`business_unit_id = $${i++}`);
    params.push(business_unit_id);
  }
  if (sets.length === 0) return null;
  params.push(id);
  await db.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${i} AND deleted_at IS NULL`,
    params
  );
  const { rows } = await db.query(
    'SELECT id, email, role, business_unit_id FROM users WHERE id = $1',
    [id]
  );
  return rows[0] || null;
}

async function softDelete(db, id) {
  const { rowCount } = await db.query(
    'UPDATE users SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL',
    [id]
  );
  return rowCount > 0;
}

/** Increment failed login count; set locked_until when attempts >= maxAttempts. */
async function incrementFailedLogin(db, userId, maxAttempts, lockoutMins) {
  const max = Math.max(1, parseInt(maxAttempts, 10) || 5);
  const mins = Math.max(1, Math.min(1440, parseInt(lockoutMins, 10) || 30));
  await db.query(
    `UPDATE users SET
       failed_login_attempts = COALESCE(failed_login_attempts, 0) + 1,
       locked_until = CASE WHEN (COALESCE(failed_login_attempts, 0) + 1) >= $2
         THEN now() + ($3 * interval '1 minute') ELSE locked_until END
     WHERE id = $1 AND deleted_at IS NULL`,
    [userId, max, mins]
  );
}

/** Clear lock state after successful login. */
async function resetFailedLogin(db, userId) {
  await db.query(
    'UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1 AND deleted_at IS NULL',
    [userId]
  );
}

/** Admin unlock: clear lock state. */
async function unlockUser(db, userId) {
  await db.query(
    'UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1 AND deleted_at IS NULL',
    [userId]
  );
}

module.exports = {
  listWithBu,
  getById,
  getForSsoToken,
  getByIdWithBuName,
  getByEmail,
  setHubOidcEmailVerifiedAt,
  countActive,
  create,
  createInvited,
  activateWithPassword,
  updatePassword,
  updateBusinessUnit,
  updateProfile,
  softDelete,
  incrementFailedLogin,
  resetFailedLogin,
  unlockUser,
  getTokenVersion,
};
