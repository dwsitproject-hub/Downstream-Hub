import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiRequest } from '../../api';
import { resolveIconSrc } from '../../utils/resolveIconSrc';
import { applicationInitials } from '../../utils/applicationInitials';
import { Icon } from '../HubIcons';

/**
 * Admin → Application access overview. Read-only.
 *
 * Who can open what, from two sides: per department (its applications and its registered
 * users) and per application (the departments that can open it, and their users), plus a
 * department × application matrix. Same rule as the user dashboard: an application with no
 * department is Global, open to everyone; a user without a department sees Global apps only.
 */

const VIEWS = [
  ['department', 'By department'],
  ['application', 'By application'],
  ['matrix', 'Matrix'],
];

const STATUS = {
  active: { label: 'Active', bg: 'var(--color-success-bg)', fg: 'var(--color-success-fg)' },
  pending: { label: 'Pending activation', bg: 'var(--color-warning-bg)', fg: 'var(--color-warning-fg)' },
  locked: { label: 'Locked', bg: 'var(--color-error-bg)', fg: 'var(--color-destructive)' },
};

const norm = (v) => String(v || '').toLowerCase();

function AppIcon({ app, size = 24 }) {
  const src = resolveIconSrc(app?.icon_url);
  const box = { width: size, height: size, borderRadius: Math.round(size / 4), flexShrink: 0 };
  return src
    ? <img src={src} alt="" style={{ ...box, objectFit: 'cover', display: 'block' }} />
    : <span style={{ ...box, ...s.iconFallback, fontSize: Math.round(size / 3) }} aria-hidden="true">{applicationInitials(app?.name || '?')}</span>;
}

function StatusBadge({ status }) {
  const st = STATUS[status] || STATUS.active;
  return <span style={{ ...s.badge, background: st.bg, color: st.fg }}>{st.label}</span>;
}

function UsersTable({ users, deptName }) {
  if (users.length === 0) return <p style={s.empty}>No registered users.</p>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={s.table}>
        <thead>
          <tr>
            <th style={s.th}>Name</th>
            <th style={s.th}>Email</th>
            {deptName && <th style={s.th}>Department</th>}
            <th style={s.th}>Role</th>
            <th style={s.th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td style={s.td}>{u.name || '—'}</td>
              <td style={{ ...s.td, wordBreak: 'break-all' }}>{u.email}</td>
              {deptName && <td style={s.td}>{deptName(u)}</td>}
              <td style={s.td}>{u.role}</td>
              <td style={s.td}><StatusBadge status={u.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Kpi({ label, value, caption, warn }) {
  return (
    <div style={{ ...s.panel, ...s.kpi }}>
      <span style={s.kpiLabel}>{label}</span>
      <span style={{ ...s.kpiValue, color: warn ? 'var(--color-accent)' : 'var(--color-text-charcoal)' }}>{value}</span>
      {caption && <span style={s.kpiCaption}>{caption}</span>}
    </div>
  );
}

/** One row per user × application they can open, for audits. Guarded against CSV formula injection. */
function exportCsv(data, deptById) {
  const cell = (v) => {
    let t = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
    return `"${t.replace(/"/g, '""')}"`;
  };
  const rows = [['Department', 'User', 'Email', 'Role', 'Status', 'Application', 'Access']];
  const deptName = (u) => (u.department_id ? deptById.get(u.department_id)?.name : null);
  // Grouped by department (users without one last), then by person.
  const users = [...data.users].sort((x, y) => (deptName(x) === null) - (deptName(y) === null)
    || String(deptName(x) || '').localeCompare(String(deptName(y) || ''))
    || String(x.name || x.email).localeCompare(String(y.name || y.email)));
  for (const u of users) {
    const dept = u.department_id ? deptById.get(u.department_id) : null;
    for (const a of data.applications) {
      const viaDept = !a.global && u.department_id && a.department_ids.includes(u.department_id);
      if (!a.global && !viaDept) continue;
      rows.push([dept ? dept.name : 'No department', u.name || '', u.email, u.role, STATUS[u.status]?.label || u.status,
        a.name, a.global ? 'Global (everyone)' : 'Department']);
    }
  }
  const csv = '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `application-access-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function AccessOverview() {
  const [params, setParams] = useSearchParams();
  const view = VIEWS.some(([v]) => v === params.get('view')) ? params.get('view') : 'department';
  const [q, setQ] = useState(params.get('q') || '');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    setError('');
    apiRequest('/api/access-overview')
      .then(setData)
      .catch((e) => setError(e.message || 'Failed to load the access overview'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const setView = (v, query) => {
    const next = new URLSearchParams(params);
    next.set('view', v);
    if (query !== undefined) { setQ(query); if (query) next.set('q', query); else next.delete('q'); }
    setParams(next, { replace: true });
  };
  const onSearch = (value) => {
    setQ(value);
    const next = new URLSearchParams(params);
    if (value) next.set('q', value); else next.delete('q');
    setParams(next, { replace: true });
  };

  const idx = useMemo(() => {
    if (!data) return null;
    return {
      dept: new Map(data.departments.map((d) => [d.id, d])),
      app: new Map(data.applications.map((a) => [a.id, a])),
      user: new Map(data.users.map((u) => [u.id, u])),
      globals: data.applications.filter((a) => a.global),
    };
  }, [data]);

  const query = norm(q).trim();
  const userMatches = (u) => !query || norm(u.name).includes(query) || norm(u.email).includes(query);

  return (
    <section style={s.wrap}>
      <div style={s.header}>
        <div>
          <h2 style={s.title}>Application Access Overview</h2>
          <p style={s.subtitle}>
            Which department can open which application, and who is registered in each. Applications with no
            department are <b>Global</b>: everyone can open them. Users without a department see Global applications only.
          </p>
        </div>
        <div style={s.controls}>
          <div role="group" aria-label="View" style={{ display: 'flex' }}>
            {VIEWS.map(([v, l]) => (
              <button key={v} type="button" className="an-seg" aria-pressed={view === v} onClick={() => setView(v)}>{l}</button>
            ))}
          </div>
          <input
            type="search"
            className="form-input"
            style={s.search}
            placeholder={view === 'matrix' ? 'Filter departments or applications' : 'Search department, application or user'}
            value={q}
            onChange={(e) => onSearch(e.target.value)}
            aria-label="Search"
          />
          <button type="button" className="btn-secondary" onClick={() => exportCsv(data, idx.dept)} disabled={!data}>Export CSV</button>
          <button type="button" className="btn-secondary" onClick={load} disabled={loading}>Refresh</button>
        </div>
      </div>

      {error && <div style={s.error}>{error}</div>}
      {loading && !data && <p style={s.empty}>Loading…</p>}

      {data && idx && (
        <>
          <div className="an-kpi-grid">
            <Kpi label="Departments" value={data.summary.departments} />
            <Kpi label="Applications" value={data.summary.applications} caption={`${data.summary.global_applications} Global`} />
            <Kpi label="Registered users" value={data.summary.users} />
            <Kpi label="Without department" value={data.summary.users_without_department} caption="See Global apps only" warn={data.summary.users_without_department > 0} />
            <Kpi label="Apps nobody can open" value={data.summary.applications_without_users} caption="Linked departments have no users" warn={data.summary.applications_without_users > 0} />
          </div>

          {view === 'department' && (
            <DepartmentView data={data} idx={idx} query={query} userMatches={userMatches} onApp={(a) => setView('application', a.name)} />
          )}
          {view === 'application' && (
            <ApplicationView data={data} idx={idx} query={query} userMatches={userMatches} onDept={(d) => setView('department', d.name)} />
          )}
          {view === 'matrix' && <MatrixView data={data} idx={idx} query={query} onDept={(d) => setView('department', d.name)} onApp={(a) => setView('application', a.name)} />}
        </>
      )}
    </section>
  );
}

/** A collapsible panel with a visible chevron; opens by itself when a search narrows the list. */
function Panel({ summary, defaultOpen, children }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => { setOpen(defaultOpen); }, [defaultOpen]);
  return (
    <details style={s.panel} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="ao-summary" style={s.summary}>
        {summary}
        <Icon name="chevronDown" size={18} style={{ ...s.chevron, transform: open ? 'rotate(180deg)' : 'none' }} />
      </summary>
      {open && children}
    </details>
  );
}

function AppChip({ app, onClick, muted }) {
  return (
    <button type="button" className="an-link" style={{ ...s.chip, ...(muted ? s.chipMuted : null) }} onClick={() => onClick(app)} title={`Open ${app.name} in the application view`}>
      <AppIcon app={app} size={20} />
      <span>{app.name}</span>
    </button>
  );
}

function DepartmentView({ data, idx, query, userMatches, onApp }) {
  const rows = data.departments
    .map((d) => {
      const apps = d.app_ids.map((id) => idx.app.get(id)).filter(Boolean);
      const users = d.user_ids.map((id) => idx.user.get(id)).filter(Boolean);
      if (!query || norm(d.name).includes(query)) return { d, apps, users };
      const matchedUsers = users.filter(userMatches);
      const appHit = apps.some((a) => norm(a.name).includes(query));
      if (matchedUsers.length === 0 && !appHit) return null;
      return { d, apps, users: matchedUsers.length ? matchedUsers : users };
    })
    .filter(Boolean);

  if (rows.length === 0) return <p style={s.empty}>No department matches “{query}”.</p>;
  return (
    <div style={s.list}>
      {rows.map(({ d, apps, users }) => (
        <Panel
          key={d.id || 'none'}
          defaultOpen={Boolean(query) || rows.length <= 3}
          summary={(
            <>
              <Icon name={d.id ? 'building' : 'alert'} size={18} style={{ color: d.id ? 'var(--color-text-steel)' : 'var(--color-accent)' }} />
              <span style={s.summaryName}>{d.name}</span>
              <span style={s.summaryMeta}>
                {d.user_ids.length} user{d.user_ids.length === 1 ? '' : 's'} · {apps.length + idx.globals.length} application{apps.length + idx.globals.length === 1 ? '' : 's'}
                {idx.globals.length > 0 && ` (${idx.globals.length} Global)`}
              </span>
            </>
          )}
        >
          {!d.id && (
            <p style={s.note}>These users can open Global applications only. Assign them a department under <b>Users</b>.</p>
          )}
          <div style={s.twoCol}>
            <div>
              <h3 style={s.h3}>Applications</h3>
              {apps.length === 0 && idx.globals.length === 0 && <p style={s.empty}>No applications.</p>}
              {apps.length > 0 && (
                <div style={s.chips}>{apps.map((a) => <AppChip key={a.id} app={a} onClick={onApp} />)}</div>
              )}
              {d.id && apps.length === 0 && <p style={s.empty}>No department-specific applications.</p>}
              {idx.globals.length > 0 && (
                <>
                  <span style={s.subLabel}>Global (everyone)</span>
                  <div style={s.chips}>{idx.globals.map((a) => <AppChip key={a.id} app={a} onClick={onApp} muted />)}</div>
                </>
              )}
            </div>
            <div style={{ minWidth: 0 }}>
              <h3 style={s.h3}>Registered users ({users.length}{users.length !== d.user_ids.length ? ` of ${d.user_ids.length}` : ''})</h3>
              <UsersTable users={users} />
            </div>
          </div>
        </Panel>
      ))}
    </div>
  );
}

function ApplicationView({ data, idx, query, userMatches, onDept }) {
  const allDepts = data.departments; // includes "No department" when it has users
  const rows = data.applications
    .map((a) => {
      const depts = a.global ? allDepts : a.department_ids.map((id) => idx.dept.get(id)).filter(Boolean);
      const groups = depts.map((d) => ({ d, users: d.user_ids.map((id) => idx.user.get(id)).filter(Boolean) }));
      if (!query || norm(a.name).includes(query) || norm(a.group_name).includes(query)) return { a, depts, groups };
      const deptHit = !a.global && depts.some((d) => norm(d.name).includes(query));
      const userGroups = groups.map((g) => ({ ...g, users: g.users.filter(userMatches) })).filter((g) => g.users.length);
      if (!deptHit && userGroups.length === 0) return null;
      return { a, depts, groups: deptHit ? groups : userGroups };
    })
    .filter(Boolean);

  if (rows.length === 0) return <p style={s.empty}>No application matches “{query}”.</p>;
  return (
    <div style={s.list}>
      {rows.map(({ a, depts, groups }) => {
        const shown = groups.reduce((n, g) => n + g.users.length, 0);
        return (
          <Panel
            key={a.id}
            defaultOpen={Boolean(query) || rows.length <= 3}
            summary={(
              <>
                <AppIcon app={a} size={26} />
                <span style={s.summaryName}>{a.name}</span>
                {a.group_name && <span style={s.groupTag}>{a.group_name}</span>}
                <span style={{ ...s.summaryMeta, color: !a.global && a.user_count === 0 ? 'var(--color-accent)' : undefined }}>
                  {a.global ? 'Global · all departments' : `${depts.length} department${depts.length === 1 ? '' : 's'}`} · {a.user_count} user{a.user_count === 1 ? '' : 's'} can open it
                </span>
              </>
            )}
          >
            {!a.global && depts.length > 0 && a.user_count === 0 && (
              <p style={s.note}>Nobody can open this today: its departments have no registered users.</p>
            )}
            <div style={{ ...s.chips, margin: 'var(--space-3) 0' }}>
              {a.global
                ? <span style={{ ...s.chip, ...s.chipMuted, cursor: 'default' }}><Icon name="globe" size={16} /> Every department, and users without one</span>
                : depts.map((d) => (
                  <button key={d.id} type="button" className="an-link" style={s.chip} onClick={() => onDept(d)} title={`Open ${d.name} in the department view`}>
                    <Icon name="building" size={16} /> {d.name} <span style={s.count}>{d.user_ids.length}</span>
                  </button>
                ))}
            </div>
            {shown === 0 ? <p style={s.empty}>No registered users.</p> : (
              <UsersTable
                users={groups.flatMap((g) => g.users)}
                deptName={(u) => (u.department_id ? idx.dept.get(u.department_id)?.name : 'No department')}
              />
            )}
          </Panel>
        );
      })}
    </div>
  );
}

function MatrixView({ data, idx, query, onDept, onApp }) {
  const appHits = data.applications.filter((a) => norm(a.name).includes(query));
  const deptHits = data.departments.filter((d) => norm(d.name).includes(query));
  const apps = query && appHits.length ? appHits : data.applications;
  const depts = query && deptHits.length ? deptHits : data.departments;
  if (apps.length === 0) return <p style={s.empty}>No applications yet.</p>;

  return (
    <div style={s.panel}>
      <p style={s.caption}>
        <span style={{ ...s.mark, ...s.markDept }}>✓</span> department access
        <span style={{ ...s.mark, ...s.markGlobal, marginLeft: 'var(--space-3)' }}>G</span> Global application
        — click a department or application to open it.
      </p>
      <div style={s.matrixScroll}>
        <table style={{ ...s.table, width: 'auto' }}>
          <thead>
            <tr>
              <th style={{ ...s.th, ...s.stickyCol, verticalAlign: 'bottom' }}>Department (users)</th>
              {apps.map((a) => (
                <th key={a.id} style={s.matrixHead}>
                  <button type="button" className="an-link" style={s.vertical} onClick={() => onApp(a)} title={a.name}>{a.name}</button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {depts.map((d) => (
              <tr key={d.id || 'none'}>
                <td style={{ ...s.td, ...s.stickyCol, whiteSpace: 'nowrap' }}>
                  <button type="button" className="an-link" onClick={() => onDept(d)}>{d.name}</button>
                  <span style={s.count}>{d.user_ids.length}</span>
                </td>
                {apps.map((a) => {
                  const has = !a.global && d.id && a.department_ids.includes(d.id);
                  return (
                    <td key={a.id} style={s.matrixCell} title={`${d.name} → ${a.name}: ${a.global ? 'Global' : has ? 'access' : 'no access'}`}>
                      {a.global ? <span style={{ ...s.mark, ...s.markGlobal }}>G</span> : has ? <span style={{ ...s.mark, ...s.markDept }}>✓</span> : ''}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <td style={{ ...s.td, ...s.stickyCol, fontWeight: 'var(--font-weight-semibold)' }}>Users who can open it</td>
              {apps.map((a) => <td key={a.id} style={{ ...s.matrixCell, fontWeight: 'var(--font-weight-semibold)', color: a.user_count ? undefined : 'var(--color-accent)' }}>{a.user_count}</td>)}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

const s = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', marginBottom: 'var(--space-6)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 'var(--space-3)', flexWrap: 'wrap' },
  controls: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' },
  search: { width: 280, maxWidth: '100%' },
  title: { margin: 0, fontSize: 'var(--text-h2)', fontFamily: 'var(--font-heading)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-charcoal)' },
  subtitle: { margin: 'var(--space-1) 0 0', fontSize: 'var(--text-small)', color: 'var(--color-text-steel)', maxWidth: 760, lineHeight: 1.5 },
  error: { padding: 'var(--space-3)', background: 'var(--color-error-bg)', color: 'var(--color-destructive)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-small)' },
  empty: { color: 'var(--color-text-steel)', fontSize: 'var(--text-small)', margin: 'var(--space-2) 0' },
  caption: { color: 'var(--color-text-steel)', fontSize: 'var(--text-small)', margin: '0 0 var(--space-3)' },
  note: { margin: 'var(--space-3) 0 0', padding: 'var(--space-2) var(--space-3)', background: 'var(--color-warning-bg)', color: 'var(--color-warning-fg)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-small)' },
  panel: { background: 'var(--color-bg-white)', border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)', padding: 'var(--space-4)', minWidth: 0 },
  kpi: { display: 'flex', flexDirection: 'column', gap: 4 },
  kpiLabel: { fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-steel)' },
  kpiValue: { fontSize: 'clamp(26px, 2vw, 34px)', lineHeight: 1.1, fontWeight: 'var(--font-weight-bold)', fontFamily: 'var(--font-heading)' },
  kpiCaption: { fontSize: 'var(--text-small)', color: 'var(--color-text-steel)' },
  list: { display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' },
  summary: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer', flexWrap: 'wrap', listStyle: 'none' },
  chevron: { color: 'var(--color-text-steel)', transition: 'transform var(--duration-fast) var(--easing-default)', flexShrink: 0 },
  summaryName: { fontWeight: 'var(--font-weight-semibold)', fontSize: 'var(--text-body)', color: 'var(--color-text-charcoal)' },
  summaryMeta: { fontSize: 'var(--text-small)', color: 'var(--color-text-steel)', marginLeft: 'auto' },
  groupTag: { fontSize: 'var(--text-xs)', padding: '1px 8px', borderRadius: 999, background: 'var(--color-bg-lighter)', border: '1px solid var(--color-border-light)', color: 'var(--color-text-steel)' },
  twoCol: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 'var(--space-4)', marginTop: 'var(--space-3)' },
  h3: { margin: '0 0 var(--space-2)', fontFamily: 'inherit', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-steel)', fontWeight: 'var(--font-weight-semibold)' },
  subLabel: { display: 'block', margin: 'var(--space-3) 0 var(--space-1)', fontSize: 'var(--text-xs)', color: 'var(--color-text-steel)' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' },
  chip: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px 4px 4px', border: '1px solid var(--color-border-light)', borderRadius: 999, background: 'var(--color-bg-white)', color: 'var(--color-text-charcoal)', fontSize: 'var(--text-small)', textDecoration: 'none' },
  chipMuted: { background: 'var(--color-bg-lighter)', color: 'var(--color-text-steel)', paddingLeft: 8 },
  count: { marginLeft: 6, fontSize: 'var(--text-xs)', color: 'var(--color-text-steel)', fontVariantNumeric: 'tabular-nums' },
  badge: { display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 'var(--text-xs)', fontWeight: 'var(--font-weight-semibold)', whiteSpace: 'nowrap' },
  iconFallback: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: '#A84335', color: '#fff', fontWeight: 700, letterSpacing: '0.03em' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-small)' },
  th: { textAlign: 'left', padding: '8px 10px', borderBottom: '2px solid var(--color-border-light)', color: 'var(--color-text-steel)', fontWeight: 'var(--font-weight-semibold)', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' },
  td: { textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid var(--color-border-light)', color: 'var(--color-text-charcoal)', verticalAlign: 'middle' },
  matrixScroll: { overflowX: 'auto', maxWidth: '100%' },
  stickyCol: { position: 'sticky', left: 0, background: 'var(--color-bg-white)', zIndex: 1 },
  matrixHead: { padding: '8px 6px', borderBottom: '2px solid var(--color-border-light)', verticalAlign: 'bottom', height: 200 },
  vertical: { writingMode: 'vertical-rl', transform: 'rotate(180deg)', whiteSpace: 'nowrap', maxHeight: 190, overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 'var(--text-small)' },
  matrixCell: { textAlign: 'center', padding: '6px', borderBottom: '1px solid var(--color-border-light)', borderLeft: '1px solid var(--color-border-light)', minWidth: 34, fontVariantNumeric: 'tabular-nums' },
  mark: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 6, fontSize: 12, fontWeight: 700 },
  markDept: { background: 'var(--color-success-bg)', color: 'var(--color-success-fg)' },
  markGlobal: { background: 'var(--color-info-bg)', color: 'var(--color-info-fg)' },
};
