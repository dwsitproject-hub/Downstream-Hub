/**
 * Application groups and the dashboard layout: which group each application is in, and the
 * order of groups and of applications inside them. One group per application (or none).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_GROUPS = 50;
const MAX_NAME = 60;

async function listGroups(db) {
  const { rows } = await db.query(
    `SELECT g.id, g.name, g.sort_order,
            COUNT(a.id) FILTER (WHERE a.deleted_at IS NULL)::int AS app_count
     FROM application_groups g
     LEFT JOIN applications a ON a.group_id = g.id
     GROUP BY g.id
     ORDER BY g.sort_order, lower(g.name)`
  );
  return rows;
}

/** Current layout, for the audit log: groups in order with their apps' names. */
async function layoutSummary(db) {
  const groups = await listGroups(db);
  const { rows } = await db.query(
    `SELECT a.name, a.group_id FROM applications a WHERE a.deleted_at IS NULL ORDER BY a.sort_order, lower(a.name)`
  );
  return {
    groups: groups.map((g) => ({ name: g.name, apps: rows.filter((a) => a.group_id === g.id).map((a) => a.name) })),
    ungrouped: rows.filter((a) => !a.group_id).map((a) => a.name),
  };
}

/**
 * Validate a layout from the Organize screen:
 *   { groups: [{ id?, name, apps: [appId…] }], ungrouped: [appId…] }
 * Returns { value } or { error }.
 */
function validateLayout(body) {
  const groupsIn = body?.groups;
  const ungroupedIn = body?.ungrouped ?? [];
  if (!Array.isArray(groupsIn) || !Array.isArray(ungroupedIn)) return { error: 'groups and ungrouped must be lists.' };
  if (groupsIn.length > MAX_GROUPS) return { error: `At most ${MAX_GROUPS} groups.` };
  const names = new Set();
  const seenApps = new Set();
  const seenGroupIds = new Set();
  const checkApps = (list, where) => {
    if (!Array.isArray(list)) return `The apps of ${where} must be a list.`;
    for (const id of list) {
      if (typeof id !== 'string' || !UUID_RE.test(id)) return `Invalid application id in ${where}.`;
      if (seenApps.has(id)) return 'An application can only be in one group.';
      seenApps.add(id);
    }
    return null;
  };
  const groups = [];
  for (const g of groupsIn) {
    const name = typeof g?.name === 'string' ? g.name.trim().replace(/\s+/g, ' ') : '';
    if (!name) return { error: 'Every group needs a name.' };
    if (name.length > MAX_NAME) return { error: `Group names are limited to ${MAX_NAME} characters ("${name.slice(0, 20)}…").` };
    if (names.has(name.toLowerCase())) return { error: `There are two groups called "${name}".` };
    names.add(name.toLowerCase());
    let id = null;
    if (g.id !== undefined && g.id !== null && g.id !== '') {
      if (typeof g.id !== 'string' || !UUID_RE.test(g.id) || seenGroupIds.has(g.id)) return { error: 'Invalid group id.' };
      seenGroupIds.add(g.id);
      id = g.id;
    }
    const err = checkApps(g.apps ?? [], `"${name}"`);
    if (err) return { error: err };
    groups.push({ id, name, apps: g.apps ?? [] });
  }
  const err = checkApps(ungroupedIn, 'Ungrouped');
  if (err) return { error: err };
  return { value: { groups, ungrouped: ungroupedIn, appIds: [...seenApps] } };
}

/**
 * Apply a validated layout in one transaction (caller provides a client inside BEGIN).
 * Groups missing from the layout are deleted (their apps become ungrouped). Apps not
 * mentioned keep their place. Throws { status: 400 } for unknown groups or apps.
 */
async function saveLayout(client, layout) {
  const existing = await client.query('SELECT id FROM application_groups');
  const existingIds = new Set(existing.rows.map((r) => r.id));
  for (const g of layout.groups) {
    if (g.id && !existingIds.has(g.id)) throw Object.assign(new Error('A group was deleted by someone else. Reload and try again.'), { status: 400 });
  }
  if (layout.appIds.length) {
    const { rows } = await client.query(
      'SELECT id FROM applications WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL',
      [layout.appIds]
    );
    if (rows.length !== layout.appIds.length) {
      throw Object.assign(new Error('One of the applications no longer exists. Reload and try again.'), { status: 400 });
    }
  }

  // Delete groups that were removed, then park kept names so renames can swap freely
  // (e.g. A→B and B→A) without tripping the unique-name index mid-transaction.
  const keep = layout.groups.filter((g) => g.id).map((g) => g.id);
  await client.query('DELETE FROM application_groups WHERE NOT (id = ANY($1::uuid[]))', [keep]);
  if (keep.length) {
    await client.query("UPDATE application_groups SET name = '~' || id::text WHERE id = ANY($1::uuid[])", [keep]);
  }

  const groupIds = [];
  for (let i = 0; i < layout.groups.length; i += 1) {
    const g = layout.groups[i];
    if (g.id) {
      await client.query('UPDATE application_groups SET name = $2, sort_order = $3, updated_at = now() WHERE id = $1', [g.id, g.name, i]);
      groupIds.push(g.id);
    } else {
      const { rows } = await client.query('INSERT INTO application_groups (name, sort_order) VALUES ($1, $2) RETURNING id', [g.name, i]);
      groupIds.push(rows[0].id);
    }
  }

  const place = async (appIds, groupId) => {
    for (let pos = 0; pos < appIds.length; pos += 1) {
      await client.query('UPDATE applications SET group_id = $2, sort_order = $3 WHERE id = $1', [appIds[pos], groupId, pos]);
    }
  };
  for (let i = 0; i < layout.groups.length; i += 1) await place(layout.groups[i].apps, groupIds[i]);
  await place(layout.ungrouped, null);
  return listGroups(client);
}

module.exports = { listGroups, layoutSummary, validateLayout, saveLayout, MAX_NAME };
