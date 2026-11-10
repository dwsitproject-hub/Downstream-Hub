/**
 * Application access overview (Admin): which department can open which application, and who
 * is registered in each department.
 *
 * Access follows exactly the rule the user dashboard uses (applicationsDb.listActive):
 *   - an application with NO department links is Global: every user sees it;
 *   - otherwise a user sees it when their department is one of its links.
 * A user with no department - or whose department was deleted - sees Global applications only.
 */

/** Read everything the overview needs in three queries. Soft-deleted rows are left out. */
async function loadAccessData(db) {
  const [departments, applications, links, users] = await Promise.all([
    db.query('SELECT id, name FROM business_units WHERE deleted_at IS NULL ORDER BY lower(name)'),
    db.query(
      `SELECT a.id, a.name, a.icon_url, a.sso_mode, g.name AS group_name
       FROM applications a
       LEFT JOIN application_groups g ON g.id = a.group_id
       WHERE a.deleted_at IS NULL
       ORDER BY lower(a.name)`
    ),
    db.query(
      `SELECT abu.application_id, abu.business_unit_id
       FROM application_business_units abu
       JOIN applications a ON a.id = abu.application_id AND a.deleted_at IS NULL
       JOIN business_units bu ON bu.id = abu.business_unit_id AND bu.deleted_at IS NULL`
    ),
    db.query(
      `SELECT id, name, email, role, business_unit_id, is_active, locked_until, created_at
       FROM users
       WHERE deleted_at IS NULL
       ORDER BY lower(COALESCE(name, email))`
    ),
  ]);
  return { departments: departments.rows, applications: applications.rows, links: links.rows, users: users.rows };
}

function userStatus(u, now) {
  if (u.is_active === false) return 'pending';
  if (u.locked_until && new Date(u.locked_until).getTime() > now) return 'locked';
  return 'active';
}

/**
 * Turn the raw rows into both views. Pure, so the access rule is unit-tested.
 * Department and application lists carry ids; the client joins them to `users`.
 */
function buildAccessOverview({ departments, applications, links, users }, now = Date.now()) {
  const deptIds = new Set(departments.map((d) => d.id));
  const appDepts = new Map(applications.map((a) => [a.id, []]));
  const deptApps = new Map(departments.map((d) => [d.id, []]));
  for (const l of links) {
    if (!appDepts.has(l.application_id) || !deptApps.has(l.business_unit_id)) continue;
    appDepts.get(l.application_id).push(l.business_unit_id);
    deptApps.get(l.business_unit_id).push(l.application_id);
  }

  const outUsers = users.map((u) => ({
    id: u.id,
    name: u.name || null,
    email: u.email,
    role: u.role,
    // A deleted department grants nothing: such a user sees Global apps only, like no department.
    department_id: u.business_unit_id && deptIds.has(u.business_unit_id) ? u.business_unit_id : null,
    status: userStatus(u, now),
    created_at: u.created_at,
  }));
  const usersByDept = new Map();
  for (const u of outUsers) {
    const k = u.department_id;
    if (!usersByDept.has(k)) usersByDept.set(k, []);
    usersByDept.get(k).push(u.id);
  }
  const countIn = (deptId) => (usersByDept.get(deptId) || []).length;

  const globalIds = applications.filter((a) => appDepts.get(a.id).length === 0).map((a) => a.id);

  const outApps = applications.map((a) => {
    const dIds = appDepts.get(a.id);
    const global = dIds.length === 0;
    return {
      id: a.id,
      name: a.name,
      icon_url: a.icon_url,
      sso_mode: a.sso_mode,
      group_name: a.group_name || null,
      global,
      department_ids: dIds,
      user_count: global ? outUsers.length : dIds.reduce((n, d) => n + countIn(d), 0),
    };
  });

  const outDepts = departments.map((d) => ({
    id: d.id,
    name: d.name,
    app_ids: deptApps.get(d.id),
    user_ids: usersByDept.get(d.id) || [],
  }));
  if (countIn(null) > 0) {
    outDepts.push({ id: null, name: 'No department', app_ids: [], user_ids: usersByDept.get(null) });
  }

  return {
    summary: {
      departments: departments.length,
      applications: applications.length,
      global_applications: globalIds.length,
      users: outUsers.length,
      users_without_department: countIn(null),
      // Linked to departments that nobody is registered in: no one can open it today.
      applications_without_users: outApps.filter((a) => !a.global && a.user_count === 0).length,
    },
    global_app_ids: globalIds,
    departments: outDepts,
    applications: outApps,
    users: outUsers,
  };
}

module.exports = { loadAccessData, buildAccessOverview };
