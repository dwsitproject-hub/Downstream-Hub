import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { apiRequest } from '../api';
import { applicationInitials } from '../utils/applicationInitials';
import { resolveIconSrc } from '../utils/resolveIconSrc';
import SsoBadge from '../components/SsoBadge';
import HubLogo from '../components/HubLogo';

const COLLAPSED_KEY = 'hub.dashboard.collapsed';
const OTHER = 'other';
const SEARCH_FROM = 8; // show the search box once there are this many apps

function readCollapsed() {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]');
    return new Set(Array.isArray(v) ? v : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(set) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...set]));
  } catch {
    /* storage unavailable — keep in memory only */
  }
}

export default function Dashboard() {
  const { user, logout } = useAuth();
  const [applications, setApplications] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [redirecting, setRedirecting] = useState(null);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(readCollapsed);

  useEffect(() => {
    apiRequest('/api/applications/for-me')
      .then((data) => {
        setApplications(data.applications || []);
        setGroups(data.groups || []);
      })
      .catch((err) => setError(err.error || 'Failed to load applications'))
      .finally(() => setLoading(false));
  }, []);

  // Sections in the admin's order; apps arrive already ordered within each group.
  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (a) => !q || a.name.toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q);
    const known = new Set(groups.map((g) => g.id));
    const list = groups.map((g) => ({ key: g.id, name: g.name, apps: applications.filter((a) => a.group_id === g.id && match(a)) }));
    const others = applications.filter((a) => (!a.group_id || !known.has(a.group_id)) && match(a));
    list.push({ key: OTHER, name: groups.length ? 'Other applications' : null, apps: others });
    return list.filter((sec) => sec.apps.length > 0);
  }, [applications, groups, query]);

  const grouped = groups.length > 0;
  const searching = query.trim() !== '';
  const shown = sections.reduce((n, sec) => n + sec.apps.length, 0);

  function toggle(key) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsed(next);
      return next;
    });
  }

  function jumpTo(key) {
    if (collapsed.has(key)) toggle(key);
    setTimeout(() => document.getElementById(`apps-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  }

  async function handleAppClick(app) {
    setRedirecting(app.id);
    setError('');
    try {
      const { bridgeUrl } = await apiRequest(
        `/api/sso/redirect?applicationId=${encodeURIComponent(app.id)}`
      );
      // Do not pass noopener in open() — with noopener many browsers return null even when the tab opens,
      // which falsely looked like "popup blocked". Open first, then drop opener reference.
      const newTab = window.open(bridgeUrl, '_blank');
      if (newTab) {
        try {
          newTab.opener = null;
        } catch {
          /* ignore */
        }
      } else {
        window.location.href = bridgeUrl;
      }
      setRedirecting(null);
    } catch (err) {
      if (err.code === 'EMAIL_VERIFICATION_REQUIRED' || err.code === 'APP_VERIFICATION_REQUIRED') {
        setError(err.error || 'Verification email sent. Check your inbox, then try again.');
      } else {
        setError(err.error || 'Redirect failed');
      }
      setRedirecting(null);
    }
  }

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <HubLogo titleStyle={styles.title} iconSize={36} />
        <div style={styles.userRow}>
          <span style={styles.userEmail}>{user?.email}</span>
          {user?.business_unit_name != null && user.business_unit_name !== '' && (
            <span style={styles.userBu}>Department: {user.business_unit_name}</span>
          )}
          {user?.role === 'Admin' && (
            <Link to="/admin" style={styles.adminLink}>Admin</Link>
          )}
          <Link to="/change-password" style={styles.adminLink}>Change password</Link>
          <button type="button" onClick={logout} className="btn-secondary" style={styles.logoutBtn}>Sign out</button>
        </div>
      </header>
      <main style={styles.main}>
        {error && <div style={styles.error}>{error}</div>}
        {loading ? (
          <p>Loading applications…</p>
        ) : applications.length === 0 ? (
          <p style={styles.empty}>No applications yet. {user?.role === 'Admin' && 'Add some in Admin.'}</p>
        ) : (
          <>
            {(applications.length >= SEARCH_FROM || (grouped && sections.length > 1)) && (
              <div style={styles.tools}>
                {applications.length >= SEARCH_FROM && (
                  <input
                    type="search"
                    className="form-input"
                    style={styles.search}
                    placeholder="Find an application…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    aria-label="Find an application"
                  />
                )}
                {grouped && sections.length > 1 && !searching && (
                  <nav aria-label="Jump to a group" style={styles.chips}>
                    {sections.map((sec) => (
                      <button key={sec.key} type="button" className="an-seg" style={styles.chip} onClick={() => jumpTo(sec.key)}>
                        {sec.name} <span style={styles.chipCount}>{sec.apps.length}</span>
                      </button>
                    ))}
                  </nav>
                )}
              </div>
            )}
            {searching && shown === 0 && <p style={styles.empty}>No application matches “{query.trim()}”.</p>}
            {sections.map((sec) => {
              const isCollapsed = !searching && !!sec.name && collapsed.has(sec.key);
              return (
                <section key={sec.key} id={`apps-${sec.key}`} style={styles.section} aria-label={sec.name || 'Applications'}>
                  {sec.name && (
                    <button
                      type="button"
                      style={styles.sectionHead}
                      onClick={() => toggle(sec.key)}
                      aria-expanded={!isCollapsed}
                      disabled={searching}
                    >
                      <span style={styles.caret} aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
                      <span style={styles.sectionTitle}>{sec.name}</span>
                      <span style={styles.chipCount}>{sec.apps.length}</span>
                    </button>
                  )}
                  {!isCollapsed && (
          <div style={styles.grid}>
            {sec.apps.map((app) => {
              const iconSrc = resolveIconSrc(app.icon_url);
              return (
              <button
                key={app.id}
                type="button"
                className="dashboard-app-card"
                style={styles.card}
                onClick={() => handleAppClick(app)}
                disabled={!!redirecting}
              >
                <span style={styles.cardBadge}>
                  <SsoBadge ssoMode={app.sso_mode} />
                </span>
                <div style={styles.cardBody}>
                  <div style={styles.cardIcon}>
                    {iconSrc ? (
                      <img src={iconSrc} alt="" style={styles.iconImg} />
                    ) : (
                      <span style={styles.iconInitials} title={app.name}>
                        {applicationInitials(app.name)}
                      </span>
                    )}
                  </div>
                  <div style={styles.cardName}>{app.name}</div>
                  <div style={styles.cardDesc}>{app.description || ''}</div>
                </div>
                {redirecting === app.id && <div style={styles.redirecting}>Opening…</div>}
              </button>
              );
            })}
          </div>
                  )}
                </section>
              );
            })}
          </>
        )}
      </main>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', background: 'var(--color-bg-light)' },
  header: { background: 'var(--color-bg-white)', padding: 'var(--space-3) var(--space-4)', boxShadow: 'var(--shadow-sm)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-3)' },
  title: { margin: 0, fontSize: 'var(--text-h3)', fontFamily: 'var(--font-heading)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-charcoal)' },
  userRow: { display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' },
  userEmail: { fontSize: 'var(--text-small)', color: 'var(--color-text-steel)' },
  userBu: { fontSize: 'var(--text-small)', color: 'var(--color-text-steel)', fontStyle: 'italic' },
  adminLink: { color: 'var(--color-primary)', textDecoration: 'none', fontSize: 'var(--text-small)', fontWeight: 'var(--font-weight-medium)' },
  logoutBtn: {},
  main: { maxWidth: 960, margin: '0 auto', padding: 'var(--space-4)' },
  error: { padding: 'var(--space-3)', background: '#FEE2E2', color: 'var(--color-destructive)', borderRadius: 'var(--radius-sm)', marginBottom: 'var(--space-3)', fontSize: 'var(--text-small)' },
  empty: { color: 'var(--color-text-steel)', fontSize: 'var(--text-small)' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 'var(--space-3)', alignItems: 'stretch' },
  tools: { display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' },
  search: { maxWidth: 420 },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' },
  chip: { borderRadius: 999 },
  chipCount: { display: 'inline-block', marginLeft: 6, padding: '0 7px', borderRadius: 999, background: 'var(--color-bg-light)', color: 'var(--color-text-steel)', fontSize: 'var(--text-xs)', fontWeight: 600 },
  section: { marginBottom: 'var(--space-5)', scrollMarginTop: 'var(--space-4)' },
  sectionHead: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)', width: '100%', padding: '0 0 var(--space-2)', marginBottom: 'var(--space-3)', background: 'none', border: 'none', borderBottom: '1px solid var(--color-border-light)', cursor: 'pointer', textAlign: 'left', color: 'var(--color-text-charcoal)' },
  caret: { width: 14, color: 'var(--color-text-steel)', fontSize: 12 },
  sectionTitle: { fontFamily: 'var(--font-heading)', fontSize: 'var(--text-base)', fontWeight: 'var(--font-weight-semibold)' },
  card: {
    borderRadius: 'var(--radius-md)',
    padding: 'var(--space-4)',
    paddingTop: 'var(--space-5)',
    textAlign: 'center',
    cursor: 'pointer',
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    height: '100%',
    width: '100%',
  },
  cardBadge: { position: 'absolute', top: 'var(--space-2)', right: 'var(--space-2)' },
  cardBody: { display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, width: '100%' },
  cardIcon: { width: 48, height: 48, flexShrink: 0, marginBottom: 'var(--space-3)', borderRadius: '12px', overflow: 'hidden', background: 'var(--color-bg-lighter)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  iconImg: { width: '100%', height: '100%', objectFit: 'cover' },
  iconInitials: {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#A84335',
    color: '#fff',
    fontWeight: 700,
    fontSize: '13px',
    letterSpacing: '0.04em',
    fontFamily: 'var(--font-heading, system-ui, sans-serif)',
  },
  cardName: {
    fontWeight: 'var(--font-weight-semibold)',
    fontSize: 'var(--text-small)',
    lineHeight: 'var(--line-height-default)',
    marginBottom: 'var(--space-1)',
    color: 'var(--color-text-charcoal)',
    width: '100%',
    minHeight: 'calc(2 * var(--text-small) * var(--line-height-default))',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  cardDesc: {
    fontSize: 'var(--text-xs)',
    color: 'var(--color-text-steel)',
    lineHeight: 'var(--line-height-default)',
    width: '100%',
    minHeight: 'calc(3 * var(--text-xs) * var(--line-height-default))',
    display: '-webkit-box',
    WebkitLineClamp: 3,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  redirecting: { marginTop: 'auto', paddingTop: 'var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--color-primary)' },
};
