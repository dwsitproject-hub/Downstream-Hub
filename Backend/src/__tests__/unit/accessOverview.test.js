/**
 * The access overview must say exactly what the user dashboard shows
 * (applicationsDb.listActive): Global apps (no department links) for everyone, linked apps
 * for users in those departments, and only Global apps for users without a department.
 */
const { buildAccessOverview } = require('../../db/accessOverviewDb');

const NOW = Date.parse('2026-11-10T08:00:00Z');
const raw = () => ({
  departments: [{ id: 'd-it', name: 'IT' }, { id: 'd-fin', name: 'Finance' }, { id: 'd-empty', name: 'Legal' }],
  applications: [
    { id: 'a-hub', name: 'Portal', icon_url: null, sso_mode: 'oidc', group_name: 'General' },
    { id: 'a-klip', name: 'KLIP', icon_url: null, sso_mode: 'oidc' },
    { id: 'a-tas', name: 'TAS', icon_url: null, sso_mode: 'oidc' },
    { id: 'a-legal', name: 'Contracts', icon_url: null, sso_mode: 'none' },
  ],
  links: [
    { application_id: 'a-klip', business_unit_id: 'd-it' },
    { application_id: 'a-klip', business_unit_id: 'd-fin' },
    { application_id: 'a-tas', business_unit_id: 'd-it' },
    { application_id: 'a-legal', business_unit_id: 'd-empty' },
    { application_id: 'a-gone', business_unit_id: 'd-it' }, // a deleted app: ignored
  ],
  users: [
    { id: 'u1', name: 'Rio', email: 'rio@x.com', role: 'Employee', business_unit_id: 'd-it', is_active: true, locked_until: null },
    { id: 'u2', name: null, email: 'fin@x.com', role: 'Employee', business_unit_id: 'd-fin', is_active: false, locked_until: null },
    { id: 'u3', name: 'Lee', email: 'lee@x.com', role: 'Admin', business_unit_id: 'd-it', is_active: true, locked_until: '2026-11-10T09:00:00Z' },
    { id: 'u4', name: 'Nod', email: 'nod@x.com', role: 'Employee', business_unit_id: null, is_active: true, locked_until: null },
    { id: 'u5', name: 'Old', email: 'old@x.com', role: 'Employee', business_unit_id: 'd-deleted', is_active: true, locked_until: null },
  ],
});

describe('buildAccessOverview', () => {
  const o = buildAccessOverview(raw(), NOW);
  const app = (id) => o.applications.find((a) => a.id === id);
  const dept = (id) => o.departments.find((d) => d.id === id);

  it('treats an app with no department links as Global, open to every user', () => {
    expect(app('a-hub')).toMatchObject({ global: true, department_ids: [], user_count: 5 });
    expect(o.global_app_ids).toEqual(['a-hub']);
  });

  it('counts users of a linked app from its departments only', () => {
    expect(app('a-klip')).toMatchObject({ global: false, department_ids: ['d-it', 'd-fin'], user_count: 3 });
    expect(app('a-tas').user_count).toBe(2);
  });

  it('flags an app linked only to departments nobody is in', () => {
    expect(app('a-legal').user_count).toBe(0);
    expect(o.summary.applications_without_users).toBe(1);
  });

  it('lists each department\'s own apps and registered users', () => {
    expect(dept('d-it')).toMatchObject({ app_ids: ['a-klip', 'a-tas'], user_ids: ['u1', 'u3'] });
    expect(dept('d-fin')).toMatchObject({ app_ids: ['a-klip'], user_ids: ['u2'] });
    expect(dept('d-empty').user_ids).toEqual([]);
  });

  it('puts users without a department, or in a deleted one, under "No department"', () => {
    expect(dept(null)).toMatchObject({ name: 'No department', app_ids: [], user_ids: ['u4', 'u5'] });
    expect(o.users.find((u) => u.id === 'u5').department_id).toBeNull();
    expect(o.summary.users_without_department).toBe(2);
  });

  it('ignores links to deleted apps', () => {
    expect(dept('d-it').app_ids).not.toContain('a-gone');
  });

  it('reports each user\'s status: pending activation, locked, active', () => {
    const status = Object.fromEntries(o.users.map((u) => [u.id, u.status]));
    expect(status).toEqual({ u1: 'active', u2: 'pending', u3: 'locked', u4: 'active', u5: 'active' });
  });

  it('adds no "No department" entry when everyone has one', () => {
    const r = raw();
    r.users = r.users.slice(0, 3);
    expect(buildAccessOverview(r, NOW).departments.some((d) => d.id === null)).toBe(false);
  });

  it('summarises the totals', () => {
    expect(o.summary).toEqual({
      departments: 3, applications: 4, global_applications: 1, users: 5,
      users_without_department: 2, applications_without_users: 1,
    });
  });
});
