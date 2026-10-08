import { useMemo, useState } from 'react';
import MultiSelectDropdown from './MultiSelectDropdown';
import SsoBadge from '../SsoBadge';
import { resolveIconSrc } from '../../utils/resolveIconSrc';
import { applicationInitials } from '../../utils/applicationInitials';

const VIEW_KEY = 'hub.admin.applicationsView';

function readView() {
  try {
    return localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'cards';
  } catch {
    return 'cards';
  }
}

function saveView(view) {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    /* storage unavailable — keep in memory only */
  }
}

function redirectCount(app) {
  const raw = app.oidc_redirect_uris;
  if (Array.isArray(raw)) return raw.filter(Boolean).length;
  if (typeof raw === 'string') return raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).length;
  return 0;
}

function departmentNames(app) {
  if (Array.isArray(app.target_bu_names) && app.target_bu_names.length > 0) return app.target_bu_names;
  return app.target_bu_name ? [app.target_bu_name] : [];
}

function AppIcon({ app, size }) {
  const src = resolveIconSrc(app.icon_url);
  const box = { width: size, height: size, borderRadius: Math.round(size / 4), flexShrink: 0 };
  return src ? (
    <img src={src} alt="" style={{ ...box, objectFit: 'cover', display: 'block', background: 'var(--color-bg-lighter)' }} />
  ) : (
    <span style={{ ...box, ...s.initials, fontSize: Math.round(size / 3.4) }}>{applicationInitials(app.name)}</span>
  );
}

function Visibility({ app }) {
  const names = departmentNames(app);
  if (names.length === 0) return <span style={{ ...s.chip, ...s.chipGlobal }}>Global · all users</span>;
  return (
    <span style={s.chipRow}>
      {names.map((n) => <span key={n} style={s.chip}>{n}</span>)}
    </span>
  );
}

function stop(fn) {
  return (e) => {
    e.stopPropagation();
    fn();
  };
}

/**
 * Applications admin page: header, filters and the app list (cards or table).
 * Search/department filter state lives in Admin.jsx (it is synced to the URL);
 * the SSO filter and view mode are local to this view.
 */
export default function ApplicationsView({
  applications,
  filteredApplications,
  loading,
  businessUnits,
  search,
  onSearchChange,
  buFilterIds,
  onBuFilterChange,
  buIncludeGlobal,
  onBuIncludeGlobalChange,
  hasFilters,
  onClearFilters,
  onAdd,
  onEdit,
  onDelete,
}) {
  const [view, setView] = useState(readView);
  const [ssoFilter, setSsoFilter] = useState('all');

  const counts = useMemo(() => {
    const sso = filteredApplications.filter((a) => a.sso_mode === 'oidc').length;
    return { all: filteredApplications.length, oidc: sso, none: filteredApplications.length - sso };
  }, [filteredApplications]);

  const visible = useMemo(() => {
    const list = filteredApplications.filter((a) => (
      ssoFilter === 'all' ? true : ssoFilter === 'oidc' ? a.sso_mode === 'oidc' : a.sso_mode !== 'oidc'
    ));
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [filteredApplications, ssoFilter]);

  const filtersActive = hasFilters || ssoFilter !== 'all';
  const clearAll = () => {
    setSsoFilter('all');
    onClearFilters();
  };
  const changeView = (v) => {
    setView(v);
    saveView(v);
  };

  return (
    <section style={s.wrap}>
      <div style={s.header}>
        <div>
          <h2 style={s.title}>Applications</h2>
          <p style={s.subtitle}>Manage internal apps, who can see them, and how they sign in.</p>
        </div>
        <button type="button" className="btn-primary" onClick={onAdd}>+ Add application</button>
      </div>

      <div style={s.toolbar}>
        <input
          type="search"
          className="form-input"
          placeholder="Search by name, description or URL…"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          style={s.search}
          aria-label="Search applications"
        />
        <MultiSelectDropdown
          options={businessUnits.map((bu) => ({ id: bu.id, label: bu.name }))}
          selected={buFilterIds}
          onChange={onBuFilterChange}
          placeholder="All departments"
          includeAllOption
          includeGlobal={buIncludeGlobal}
          onIncludeGlobalChange={onBuIncludeGlobalChange}
        />
        <div role="group" aria-label="Sign-in type" style={{ display: 'flex' }}>
          {[['all', 'All', counts.all], ['oidc', 'SSO', counts.oidc], ['none', 'Direct', counts.none]].map(([v, label, n]) => (
            <button key={v} type="button" className="an-seg" aria-pressed={ssoFilter === v} onClick={() => setSsoFilter(v)}>
              {label} <span style={s.segCount}>{n}</span>
            </button>
          ))}
        </div>
        {filtersActive && (
          <button type="button" className="btn-secondary" onClick={clearAll}>Clear filters</button>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex' }} role="group" aria-label="View">
          <button type="button" className="an-seg" aria-pressed={view === 'cards'} onClick={() => changeView('cards')}>▦ Cards</button>
          <button type="button" className="an-seg" aria-pressed={view === 'table'} onClick={() => changeView('table')}>☰ Table</button>
        </div>
      </div>

      {!loading && applications.length > 0 && (
        <p style={s.count}>
          {visible.length === applications.length
            ? `${applications.length} application${applications.length === 1 ? '' : 's'}`
            : `Showing ${visible.length} of ${applications.length} applications`}
        </p>
      )}

      {loading ? (
        <p style={s.muted}>Loading…</p>
      ) : applications.length === 0 ? (
        <div style={s.empty}>
          <p style={s.emptyTitle}>No applications yet</p>
          <p style={s.muted}>Add your first internal app so users can open it from the Hub.</p>
          <button type="button" className="btn-primary" onClick={onAdd}>+ Add application</button>
        </div>
      ) : visible.length === 0 ? (
        <div style={s.empty}>
          <p style={s.emptyTitle}>No applications match these filters</p>
          <button type="button" className="btn-secondary" onClick={clearAll}>Clear filters</button>
        </div>
      ) : view === 'cards' ? (
        <div style={s.grid}>
          {visible.map((app) => (
            <div
              key={app.id}
              className="app-card"
              role="button"
              tabIndex={0}
              title={`Edit ${app.name}`}
              onClick={() => onEdit(app)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onEdit(app);
                }
              }}
              style={s.card}
            >
              <div style={s.cardTop}>
                <AppIcon app={app} size={52} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={s.cardName}>{app.name}</div>
                  <div style={s.cardDesc}>{app.description || <span style={{ fontStyle: 'italic' }}>No description</span>}</div>
                </div>
                <SsoBadge ssoMode={app.sso_mode} />
              </div>

              <dl style={s.meta}>
                <dt style={s.metaKey}>URL</dt>
                <dd style={s.metaVal}>
                  <a href={app.target_url} target="_blank" rel="noopener noreferrer" style={s.url} onClick={(e) => e.stopPropagation()} title={app.target_url}>
                    {app.target_url}
                  </a>
                </dd>
                <dt style={s.metaKey}>Visible to</dt>
                <dd style={s.metaVal}><Visibility app={app} /></dd>
                {app.sso_mode === 'oidc' && (
                  <>
                    <dt style={s.metaKey}>Client ID</dt>
                    <dd style={s.metaVal}>
                      {app.oauth_client_id ? <code style={s.code}>{app.oauth_client_id}</code> : <span style={s.warn}>Not set</span>}
                    </dd>
                    <dt style={s.metaKey}>Redirects</dt>
                    <dd style={s.metaVal}>
                      {redirectCount(app) > 0
                        ? `${redirectCount(app)} URI${redirectCount(app) === 1 ? '' : 's'}`
                        : <span style={s.warn}>None — SSO will fail</span>}
                    </dd>
                  </>
                )}
              </dl>

              <div style={s.cardFoot}>
                <button type="button" className="btn-secondary btn-compact" onClick={stop(() => onEdit(app))}>Edit</button>
                <a
                  href={app.target_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-secondary btn-compact"
                  style={{ textDecoration: 'none' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  Open ↗
                </a>
                <button type="button" style={s.deleteBtn} onClick={stop(() => onDelete(app))}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Application</th>
                <th style={s.th}>Target URL</th>
                <th style={s.th}>Visible to</th>
                <th style={s.th}>Sign-in</th>
                <th style={{ ...s.th, width: 1 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((app) => (
                <tr key={app.id} className="an-row" onClick={() => onEdit(app)} title={`Edit ${app.name}`}>
                  <td style={s.td}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                      <AppIcon app={app} size={36} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 'var(--font-weight-semibold)' }}>{app.name}</div>
                        {app.description && <div style={s.sub}>{app.description}</div>}
                      </div>
                    </div>
                  </td>
                  <td style={{ ...s.td, maxWidth: 360 }}>
                    <a href={app.target_url} target="_blank" rel="noopener noreferrer" style={{ ...s.url, display: 'block' }} onClick={(e) => e.stopPropagation()} title={app.target_url}>
                      {app.target_url}
                    </a>
                  </td>
                  <td style={s.td}><Visibility app={app} /></td>
                  <td style={s.td}>
                    <SsoBadge ssoMode={app.sso_mode} />
                    {app.sso_mode === 'oidc' && (
                      <div style={s.sub}>{app.oauth_client_id ? <code style={s.code}>{app.oauth_client_id}</code> : <span style={s.warn}>No client ID</span>}</div>
                    )}
                  </td>
                  <td style={{ ...s.td, whiteSpace: 'nowrap' }}>
                    <div style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'center' }}>
                      <button type="button" className="btn-secondary btn-compact" onClick={stop(() => onEdit(app))}>Edit</button>
                      <button type="button" style={s.deleteBtn} onClick={stop(() => onDelete(app))}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const s = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginBottom: 'var(--space-6)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 'var(--space-3)', flexWrap: 'wrap' },
  title: { margin: 0, fontSize: 'var(--text-h2)', fontFamily: 'var(--font-heading)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-charcoal)' },
  subtitle: { margin: 'var(--space-1) 0 0', fontSize: 'var(--text-small)', color: 'var(--color-text-steel)' },
  toolbar: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap', padding: 'var(--space-3)', background: 'var(--color-bg-white)', border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)' },
  search: { flex: '1 1 280px', maxWidth: 440 },
  segCount: { marginLeft: 4, opacity: 0.75, fontVariantNumeric: 'tabular-nums' },
  count: { margin: 0, fontSize: 'var(--text-small)', color: 'var(--color-text-steel)' },
  muted: { margin: 0, fontSize: 'var(--text-small)', color: 'var(--color-text-steel)' },
  empty: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-2)', padding: 'var(--space-6)', background: 'var(--color-bg-white)', border: '1px dashed var(--color-border-medium)', borderRadius: 'var(--radius-lg)', textAlign: 'center' },
  emptyTitle: { margin: 0, fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-charcoal)' },

  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 'var(--space-3)' },
  card: { display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', padding: 'var(--space-4)', minWidth: 0 },
  cardTop: { display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)' },
  cardName: { fontWeight: 'var(--font-weight-semibold)', fontSize: 'var(--text-base)', color: 'var(--color-text-charcoal)', lineHeight: 1.3, overflowWrap: 'anywhere' },
  cardDesc: { marginTop: 2, fontSize: 'var(--text-small)', color: 'var(--color-text-steel)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
  meta: { display: 'grid', gridTemplateColumns: '84px minmax(0, 1fr)', gap: '6px var(--space-2)', margin: 0, paddingTop: 'var(--space-3)', borderTop: '1px solid var(--color-border-light)', fontSize: 'var(--text-small)' },
  metaKey: { color: 'var(--color-text-steel)', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', paddingTop: 2 },
  metaVal: { margin: 0, minWidth: 0, color: 'var(--color-text-charcoal)' },
  url: { color: 'var(--color-action-blue)', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block', fontSize: 'var(--text-small)' },
  code: { fontFamily: 'Consolas, Menlo, monospace', fontSize: 12, background: 'var(--color-bg-light)', padding: '1px 6px', borderRadius: 4 },
  warn: { color: '#B45309', fontSize: 'var(--text-small)' },
  cardFoot: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'auto', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--color-border-light)' },
  deleteBtn: { marginLeft: 'auto', background: 'none', border: 'none', padding: '3px var(--space-2)', color: 'var(--color-destructive)', fontSize: 'var(--text-xs)', cursor: 'pointer' },

  chipRow: { display: 'flex', flexWrap: 'wrap', gap: 4 },
  chip: { display: 'inline-block', padding: '1px 8px', borderRadius: 999, background: '#E0ECFF', color: '#1D4ED8', fontSize: 'var(--text-xs)', fontWeight: 600, whiteSpace: 'nowrap' },
  chipGlobal: { background: 'var(--color-bg-light)', color: 'var(--color-text-steel)' },
  initials: { display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#A84335', color: '#fff', fontWeight: 700, letterSpacing: '0.04em', fontFamily: 'var(--font-heading, system-ui, sans-serif)' },

  tableWrap: { background: 'var(--color-bg-white)', border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)', overflowX: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-small)' },
  th: { textAlign: 'left', padding: '10px var(--space-3)', borderBottom: '2px solid var(--color-border-light)', color: 'var(--color-text-steel)', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 'var(--font-weight-semibold)', whiteSpace: 'nowrap' },
  td: { padding: '10px var(--space-3)', borderBottom: '1px solid var(--color-border-light)', color: 'var(--color-text-charcoal)', verticalAlign: 'middle', overflow: 'hidden' },
  sub: { marginTop: 2, fontSize: 'var(--text-xs)', color: 'var(--color-text-steel)' },
};
