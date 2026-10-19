/**
 * Applications data access. All reads exclude soft-deleted (deleted_at IS NULL).
 * Deletes are soft: UPDATE ... SET deleted_at = now().
 *
 * BU visibility model (post-migration 013):
 *   - Global app  = zero rows in application_business_units
 *   - Scoped app  = one or more rows; visible to users whose BU matches any linked BU
 *   - Users with no BU see only Global apps
 */
const NOT_DELETED = ' AND a.deleted_at IS NULL';

/**
 * Replace all BU assignments for an app in a single transaction-safe operation.
 * Pass an empty array for buIds to make the app Global.
 */
async function setApplicationBusinessUnits(db, appId, buIds) {
  await db.query(
    'DELETE FROM application_business_units WHERE application_id = $1',
    [appId]
  );
  for (const buId of buIds) {
    await db.query(
      'INSERT INTO application_business_units (application_id, business_unit_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [appId, buId]
    );
  }
}

/**
 * List apps visible to a user in a given BU (or Global apps if buId is null).
 * Used by GET /api/applications/for-me.
 */
async function listActive(db, businessUnitId) {
  const { rows } = await db.query(
    `SELECT a.id, a.name, a.description, a.icon_url, a.target_url, a.target_bu_id,
            a.oauth_client_id, a.oidc_redirect_uris, a.sso_mode, a.created_at, a.updated_at,
            a.group_id, a.sort_order
     FROM applications a
     WHERE a.deleted_at IS NULL
       AND (
         -- Global app: no rows in junction table
         NOT EXISTS (
           SELECT 1 FROM application_business_units abu WHERE abu.application_id = a.id
         )
         ${businessUnitId ? 'OR EXISTS (SELECT 1 FROM application_business_units abu WHERE abu.application_id = a.id AND abu.business_unit_id = $1)' : ''}
       )
     ORDER BY a.sort_order, a.name`,
    businessUnitId ? [businessUnitId] : []
  );
  return rows;
}

/**
 * List all non-deleted apps with their BU names aggregated (admin use).
 * Returns target_bu_ids[] and target_bu_names[] alongside legacy target_bu_id.
 */
async function listAllWithBuName(db) {
  const { rows } = await db.query(
    `SELECT a.id, a.name, a.description, a.icon_url, a.target_url, a.target_bu_id,
            a.oauth_client_id, a.oidc_redirect_uris, a.sso_mode, a.created_at, a.updated_at,
            a.group_id, a.sort_order,
            (SELECT g.name FROM application_groups g WHERE g.id = a.group_id) AS group_name,
            COALESCE(
              array_agg(bu.id ORDER BY bu.name) FILTER (WHERE bu.id IS NOT NULL),
              '{}'
            ) AS target_bu_ids,
            COALESCE(
              array_agg(bu.name ORDER BY bu.name) FILTER (WHERE bu.name IS NOT NULL),
              '{}'
            ) AS target_bu_names
     FROM applications a
     LEFT JOIN application_business_units abu ON abu.application_id = a.id
     LEFT JOIN business_units bu ON bu.id = abu.business_unit_id AND bu.deleted_at IS NULL
     WHERE a.deleted_at IS NULL
     GROUP BY a.id
     ORDER BY a.name`
  );
  return rows.map((r) => ({
    ...r,
    // Convenience: first BU name for legacy single-BU display
    target_bu_name: r.target_bu_names.length > 0 ? r.target_bu_names[0] : null,
    target_bu_names: r.target_bu_names,
    target_bu_ids: r.target_bu_ids,
  }));
}

/**
 * Filtered variant of listAllWithBuName for the admin table filter endpoint.
 * buIds: string[] — filter to apps that have ANY of these BUs assigned.
 * includeGlobal: bool — also include apps with no BU assignment.
 */
async function listAllWithBuNameFiltered(db, buIds = [], includeGlobal = false) {
  if (buIds.length === 0 && !includeGlobal) {
    return listAllWithBuName(db);
  }
  const conditions = [];
  const params = [];

  if (includeGlobal) {
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM application_business_units abu2 WHERE abu2.application_id = a.id)`
    );
  }
  if (buIds.length > 0) {
    params.push(buIds);
    conditions.push(
      `EXISTS (SELECT 1 FROM application_business_units abu2 WHERE abu2.application_id = a.id AND abu2.business_unit_id = ANY($${params.length}))`
    );
  }

  const { rows } = await db.query(
    `SELECT a.id, a.name, a.description, a.icon_url, a.target_url, a.target_bu_id,
            a.oauth_client_id, a.oidc_redirect_uris, a.sso_mode, a.created_at, a.updated_at,
            a.group_id, a.sort_order,
            (SELECT g.name FROM application_groups g WHERE g.id = a.group_id) AS group_name,
            COALESCE(
              array_agg(bu.id ORDER BY bu.name) FILTER (WHERE bu.id IS NOT NULL),
              '{}'
            ) AS target_bu_ids,
            COALESCE(
              array_agg(bu.name ORDER BY bu.name) FILTER (WHERE bu.name IS NOT NULL),
              '{}'
            ) AS target_bu_names
     FROM applications a
     LEFT JOIN application_business_units abu ON abu.application_id = a.id
     LEFT JOIN business_units bu ON bu.id = abu.business_unit_id AND bu.deleted_at IS NULL
     WHERE a.deleted_at IS NULL
       AND (${conditions.join(' OR ')})
     GROUP BY a.id
     ORDER BY a.name`,
    params
  );
  return rows.map((r) => ({
    ...r,
    target_bu_name: r.target_bu_names.length > 0 ? r.target_bu_names[0] : null,
    target_bu_names: r.target_bu_names,
    target_bu_ids: r.target_bu_ids,
  }));
}

async function getById(db, id) {
  const { rows } = await db.query(
    `SELECT a.id, a.name, a.description, a.icon_url, a.target_url, a.target_bu_id,
            a.oauth_client_id, a.oidc_redirect_uris, a.sso_mode, a.created_at, a.updated_at,
            COALESCE(
              array_agg(bu.id ORDER BY bu.name) FILTER (WHERE bu.id IS NOT NULL),
              '{}'
            ) AS target_bu_ids,
            COALESCE(
              array_agg(bu.name ORDER BY bu.name) FILTER (WHERE bu.name IS NOT NULL),
              '{}'
            ) AS target_bu_names
     FROM applications a
     LEFT JOIN application_business_units abu ON abu.application_id = a.id
     LEFT JOIN business_units bu ON bu.id = abu.business_unit_id AND bu.deleted_at IS NULL
     WHERE a.id = $1${NOT_DELETED}
     GROUP BY a.id`,
    [id]
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    ...r,
    target_bu_name: r.target_bu_names.length > 0 ? r.target_bu_names[0] : null,
    target_bu_names: r.target_bu_names,
    target_bu_ids: r.target_bu_ids,
  };
}

async function getByIdForUpdate(db, id) {
  const { rows } = await db.query(
    'SELECT id, name, description, icon_url, target_url, target_bu_id, oauth_client_id, oidc_redirect_uris, sso_mode FROM applications WHERE id = $1 AND deleted_at IS NULL',
    [id]
  );
  return rows[0] || null;
}

async function getByOAuthClientId(db, clientId) {
  const { rows } = await db.query(
    `SELECT id, name, icon_url, oauth_client_id, sso_mode
     FROM applications
     WHERE oauth_client_id = $1 AND deleted_at IS NULL AND sso_mode = 'oidc'`,
    [clientId]
  );
  return rows[0] || null;
}

async function create(db, { name, description, icon_url, target_url, target_bu_id, oauth_client_id, oidc_redirect_uris, sso_mode }) {
  const { rows } = await db.query(
    `INSERT INTO applications (name, description, icon_url, target_url, target_bu_id, oauth_client_id, oidc_redirect_uris, sso_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, name, description, icon_url, target_url, target_bu_id, oauth_client_id, oidc_redirect_uris, sso_mode, created_at, updated_at`,
    [name, description, icon_url || '', target_url, target_bu_id, oauth_client_id || null, oidc_redirect_uris || [], sso_mode || 'none']
  );
  return rows[0];
}

async function update(db, id, { name, description, icon_url, target_url, target_bu_id, oauth_client_id, oidc_redirect_uris, sso_mode }) {
  await db.query(
    `UPDATE applications
     SET name = $1, description = $2, icon_url = $3, target_url = $4, target_bu_id = $5,
         oauth_client_id = $6, oidc_redirect_uris = $7, sso_mode = $8, updated_at = now()
     WHERE id = $9 AND deleted_at IS NULL`,
    [name, description, icon_url || '', target_url, target_bu_id, oauth_client_id || null, oidc_redirect_uris || [], sso_mode || 'none', id]
  );
  const { rows } = await db.query(
    'SELECT id, name, description, icon_url, target_url, target_bu_id, oauth_client_id, oidc_redirect_uris, sso_mode, created_at, updated_at FROM applications WHERE id = $1',
    [id]
  );
  return rows[0] || null;
}

async function softDelete(db, id) {
  const { rowCount } = await db.query(
    'UPDATE applications SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL',
    [id]
  );
  return rowCount > 0;
}

module.exports = {
  setApplicationBusinessUnits,
  listActive,
  listAllWithBuName,
  listAllWithBuNameFiltered,
  getById,
  getByIdForUpdate,
  getByOAuthClientId,
  create,
  update,
  softDelete,
};
