/**
 * Password policy (single row). password_expiry_days, complexity, history, lockout.
 * New columns have defaults for backward compatibility.
 */
const { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } = require('../lib/passwordValidation');
const { MAX_BYPASS_DAYS } = require('../lib/deviceTrust');

const BYPASS_MODES = ['rolling_24h', 'calendar_day', 'rolling_days'];

const DEFAULTS = {
  password_expiry_days: 0,
  min_password_length: MIN_PASSWORD_LENGTH,
  require_uppercase: true,
  require_lowercase: true,
  require_number: true,
  require_symbol: true,
  password_history_count: 5,
  max_login_attempts: 5,
  lockout_duration_mins: 30,
  mfa_reverify_days: 14,
  mfa_risk_threshold: 50,
  login_mfa_bypass_mode: 'rolling_24h',
  login_mfa_bypass_hours: 24,
  login_mfa_bypass_days: 7,
  login_mfa_bypass_timezone: 'UTC',
};

async function get(db) {
  const { rows } = await db.query(
    `SELECT password_expiry_days, min_password_length, require_uppercase, require_lowercase,
            require_number, require_symbol, password_history_count, max_login_attempts, lockout_duration_mins,
            mfa_reverify_days, mfa_risk_threshold,
            login_mfa_bypass_mode, login_mfa_bypass_hours, login_mfa_bypass_days, login_mfa_bypass_timezone
     FROM password_policy WHERE id = 1`
  );
  const row = rows[0];
  if (!row) return { ...DEFAULTS };
  return {
    password_expiry_days: row.password_expiry_days ?? DEFAULTS.password_expiry_days,
    min_password_length: row.min_password_length ?? DEFAULTS.min_password_length,
    require_uppercase: row.require_uppercase ?? DEFAULTS.require_uppercase,
    require_lowercase: row.require_lowercase ?? DEFAULTS.require_lowercase,
    require_number: row.require_number ?? DEFAULTS.require_number,
    require_symbol: row.require_symbol ?? DEFAULTS.require_symbol,
    password_history_count: row.password_history_count ?? DEFAULTS.password_history_count,
    max_login_attempts: row.max_login_attempts ?? DEFAULTS.max_login_attempts,
    lockout_duration_mins: row.lockout_duration_mins ?? DEFAULTS.lockout_duration_mins,
    mfa_reverify_days: row.mfa_reverify_days ?? DEFAULTS.mfa_reverify_days,
    mfa_risk_threshold: row.mfa_risk_threshold ?? DEFAULTS.mfa_risk_threshold,
    login_mfa_bypass_mode: row.login_mfa_bypass_mode ?? DEFAULTS.login_mfa_bypass_mode,
    login_mfa_bypass_hours: row.login_mfa_bypass_hours ?? DEFAULTS.login_mfa_bypass_hours,
    login_mfa_bypass_days: row.login_mfa_bypass_days ?? DEFAULTS.login_mfa_bypass_days,
    login_mfa_bypass_timezone: row.login_mfa_bypass_timezone ?? DEFAULTS.login_mfa_bypass_timezone,
  };
}

async function update(db, payload) {
  const updates = [];
  const values = [];
  let idx = 1;

  if (payload.password_expiry_days !== undefined) {
    const days = Math.max(0, Math.min(365, parseInt(String(payload.password_expiry_days), 10) || 0));
    updates.push(`password_expiry_days = $${idx++}`);
    values.push(days);
  }
  if (payload.min_password_length !== undefined) {
    const v = Math.max(
      MIN_PASSWORD_LENGTH,
      Math.min(MAX_PASSWORD_LENGTH, parseInt(String(payload.min_password_length), 10) || MIN_PASSWORD_LENGTH)
    );
    updates.push(`min_password_length = $${idx++}`);
    values.push(v);
  }
  if (payload.require_uppercase !== undefined) {
    updates.push(`require_uppercase = $${idx++}`);
    values.push(!!payload.require_uppercase);
  }
  if (payload.require_lowercase !== undefined) {
    updates.push(`require_lowercase = $${idx++}`);
    values.push(!!payload.require_lowercase);
  }
  if (payload.require_number !== undefined) {
    updates.push(`require_number = $${idx++}`);
    values.push(!!payload.require_number);
  }
  if (payload.require_symbol !== undefined) {
    updates.push(`require_symbol = $${idx++}`);
    values.push(!!payload.require_symbol);
  }
  if (payload.password_history_count !== undefined) {
    const v = Math.max(0, Math.min(24, parseInt(String(payload.password_history_count), 10) || 0));
    updates.push(`password_history_count = $${idx++}`);
    values.push(v);
  }
  if (payload.max_login_attempts !== undefined) {
    const v = Math.max(1, Math.min(10, parseInt(String(payload.max_login_attempts), 10) || 5));
    updates.push(`max_login_attempts = $${idx++}`);
    values.push(v);
  }
  if (payload.lockout_duration_mins !== undefined) {
    const v = Math.max(1, Math.min(1440, parseInt(String(payload.lockout_duration_mins), 10) || 30));
    updates.push(`lockout_duration_mins = $${idx++}`);
    values.push(v);
  }
  if (payload.mfa_reverify_days !== undefined) {
    const v = Math.max(1, Math.min(90, parseInt(String(payload.mfa_reverify_days), 10) || 14));
    updates.push(`mfa_reverify_days = $${idx++}`);
    values.push(v);
  }
  if (payload.mfa_risk_threshold !== undefined) {
    const v = Math.max(0, Math.min(100, parseInt(String(payload.mfa_risk_threshold), 10) || 50));
    updates.push(`mfa_risk_threshold = $${idx++}`);
    values.push(v);
  }
  if (payload.login_mfa_bypass_mode !== undefined) {
    const mode = String(payload.login_mfa_bypass_mode).trim();
    const allowed = BYPASS_MODES.includes(mode) ? mode : 'rolling_24h';
    updates.push(`login_mfa_bypass_mode = $${idx++}`);
    values.push(allowed);
  }
  if (payload.login_mfa_bypass_hours !== undefined) {
    const v = Math.max(1, Math.min(168, parseInt(String(payload.login_mfa_bypass_hours), 10) || 24));
    updates.push(`login_mfa_bypass_hours = $${idx++}`);
    values.push(v);
  }
  if (payload.login_mfa_bypass_days !== undefined) {
    const v = Math.max(1, Math.min(MAX_BYPASS_DAYS, parseInt(String(payload.login_mfa_bypass_days), 10) || 7));
    updates.push(`login_mfa_bypass_days = $${idx++}`);
    values.push(v);
  }
  if (payload.login_mfa_bypass_timezone !== undefined) {
    const tz = String(payload.login_mfa_bypass_timezone).trim().slice(0, 64) || 'UTC';
    updates.push(`login_mfa_bypass_timezone = $${idx++}`);
    values.push(tz);
  }

  if (updates.length === 0) return get(db);
  values.push(1);
  await db.query(
    `UPDATE password_policy SET ${updates.join(', ')}, updated_at = now() WHERE id = $${idx}`,
    values
  );
  return get(db);
}

module.exports = { get, update, BYPASS_MODES };
