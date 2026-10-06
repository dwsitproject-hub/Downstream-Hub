import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest } from '../../api';

const PERIODS = [7, 30, 90];

/* ---------- formatting helpers ---------- */

const num = (v) => Number(v || 0);
const fmtNum = (v) => num(v).toLocaleString();

function fmtMinutes(v) {
  const total = Math.round(num(v));
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function fmtDateTime(v) {
  return v ? new Date(v).toLocaleString() : '—';
}

function fmtRelative(v) {
  if (!v) return '—';
  const mins = Math.round((Date.now() - new Date(v).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

function fmtDay(day) {
  return new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Continuous daily series for the chart (fills empty days; keeps every server bucket). */
function buildSeries(rows, days) {
  const counts = new Map(rows.map((r) => [r.day, num(r.launches)]));
  const keys = new Set(counts.keys());
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    keys.add(dayKey(d));
  }
  return [...keys].sort().map((day) => ({ day, launches: counts.get(day) || 0 }));
}

/* ---------- drill-down views ---------- */

function viewTitle(view) {
  switch (view.type) {
    case 'activeUsers':
      return view.order === 'minutes' ? 'Time in Hub by user' : 'Active users';
    case 'launches': {
      const parts = [];
      if (view.appName) parts.push(view.appName);
      if (view.userEmail) parts.push(view.userEmail);
      if (view.day) parts.push(fmtDay(view.day));
      return parts.length ? `App opens · ${parts.join(' · ')}` : 'All app opens';
    }
    case 'sessions':
      return `${view.sort === 'longest' ? 'Longest Hub sessions' : 'Hub sessions'}${view.userEmail ? ` · ${view.userEmail}` : ''}`;
    case 'app':
      return view.appName || 'Application';
    case 'user':
      return view.email || 'User';
    case 'bug':
      return view.report.kind === 'client_error' ? 'Error report' : 'Bug report';
    default:
      return 'Details';
  }
}

function viewUrl(view, days) {
  const q = new URLSearchParams({ days: String(days) });
  switch (view.type) {
    case 'activeUsers':
      q.set('order', view.order || 'launches');
      return `/api/analytics/active-users?${q}`;
    case 'launches':
      if (view.appId) q.set('app_id', view.appId);
      if (view.userId) q.set('user_id', view.userId);
      if (view.day) q.set('day', view.day);
      return `/api/analytics/launches?${q}`;
    case 'sessions':
      q.set('sort', view.sort || 'recent');
      if (view.userId) q.set('user_id', view.userId);
      return `/api/analytics/sessions?${q}`;
    case 'app':
      return `/api/analytics/apps/${view.appId}/users?${q}`;
    case 'user':
      return `/api/analytics/users/${view.userId}?${q}`;
    default:
      return null;
  }
}

/* ---------- small building blocks ---------- */

function Link({ onClick, children, title }) {
  return (
    <button
      type="button"
      className="an-link"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

function ShareBar({ value, max, color = 'var(--color-action-blue)' }) {
  const pct = max > 0 ? Math.max(2, Math.round((num(value) / max) * 100)) : 0;
  return (
    <div style={s.shareTrack} aria-hidden="true">
      <div style={{ ...s.shareFill, width: `${pct}%`, background: color }} />
    </div>
  );
}

function Pill({ tone, children }) {
  const tones = {
    green: { background: '#DCFCE7', color: '#166534' },
    grey: { background: 'var(--color-bg-light)', color: 'var(--color-text-steel)' },
    red: { background: '#FEE2E2', color: '#B91C1C' },
    blue: { background: '#E0ECFF', color: '#1D4ED8' },
    amber: { background: '#FEF3C7', color: '#92400E' },
  };
  return <span style={{ ...s.pill, ...(tones[tone] || tones.grey) }}>{children}</span>;
}

function rowProps(onActivate) {
  return {
    className: 'an-row',
    tabIndex: 0,
    role: 'button',
    onClick: onActivate,
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onActivate();
      }
    },
  };
}

function Empty({ children }) {
  return <p style={s.empty}>{children}</p>;
}

/* ---------- detail modal ---------- */

function DetailModal({ stack, days, onNavigate, onBack, onClose, onBugChanged }) {
  const view = stack[stack.length - 1];
  const url = viewUrl(view, days);
  // Loaded data is tagged with the URL it came from, so a view never renders the
  // previous view's payload during the render before its own fetch starts.
  const [result, setResult] = useState({ url: null, data: null, error: '' });
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef(null);

  const settled = result.url === url;
  const data = settled ? result.data : null;
  const loading = Boolean(url) && !settled;
  const loadError = settled ? result.error : '';

  useEffect(() => {
    dialogRef.current?.focus();
  }, [view]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => { setActionError(''); }, [view]);

  useEffect(() => {
    if (!url) return undefined;
    let ignore = false;
    apiRequest(url)
      .then((d) => { if (!ignore) setResult({ url, data: d, error: '' }); })
      .catch((err) => { if (!ignore) setResult({ url, data: null, error: err.error || 'Failed to load details' }); });
    return () => { ignore = true; };
  }, [url]);

  const go = onNavigate;
  const toUser = (id, email) => go({ type: 'user', userId: id, email });
  const toApp = (id, name) => go({ type: 'app', appId: id, appName: name });

  async function toggleBug(report) {
    setBusy(true);
    try {
      const next = report.status !== 'resolved';
      const updated = await apiRequest(`/api/analytics/bug-reports/${report.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ resolved: next }),
      });
      onBugChanged({ ...report, status: updated.status, resolved_at: updated.resolved_at });
    } catch (err) {
      setActionError(err.error || 'Failed to update report');
    } finally {
      setBusy(false);
    }
  }

  let body = null;
  if (loading) body = <p style={s.muted}>Loading…</p>;
  else if (loadError) body = <div style={s.error}>{loadError}</div>;
  else if (view.type === 'activeUsers') {
    const users = data?.users || [];
    const maxVal = Math.max(0, ...users.map((u) => num(view.order === 'minutes' ? u.minutes : u.launches)));
    body = users.length === 0 ? <Empty>No activity in this period.</Empty> : (
      <>
        <p style={s.caption}>{users.length} user{users.length === 1 ? '' : 's'} signed in or opened an app in the last {days} days.</p>
        <table style={s.table}>
          <thead><tr>
            <th style={s.th}>User</th><th style={s.th}>Department</th>
            <th style={s.thR}>Opens</th><th style={s.thR}>Sessions</th><th style={s.thR}>Time in Hub</th>
            <th style={s.th}>Last seen</th><th style={{ ...s.th, width: 140 }} />
          </tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} {...rowProps(() => toUser(u.id, u.email))}>
                <td style={s.td}><strong>{u.email}</strong></td>
                <td style={s.td}>{u.department || '—'}</td>
                <td style={s.tdR}><Link onClick={() => go({ type: 'launches', userId: u.id, userEmail: u.email })}>{fmtNum(u.launches)}</Link></td>
                <td style={s.tdR}><Link onClick={() => go({ type: 'sessions', userId: u.id, userEmail: u.email })}>{fmtNum(u.sessions)}</Link></td>
                <td style={s.tdR}><Link onClick={() => go({ type: 'sessions', sort: 'longest', userId: u.id, userEmail: u.email })}>{fmtMinutes(u.minutes)}</Link></td>
                <td style={s.td} title={fmtDateTime(u.last_seen)}>{fmtRelative(u.last_seen)}</td>
                <td style={s.td}><ShareBar value={view.order === 'minutes' ? u.minutes : u.launches} max={maxVal} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    );
  } else if (view.type === 'launches') {
    const rows = data?.rows || [];
    body = rows.length === 0 ? <Empty>No app opens match this view.</Empty> : (
      <>
        <p style={s.caption}>
          {data.total > rows.length ? `Showing the latest ${rows.length} of ${fmtNum(data.total)} opens.` : `${fmtNum(data.total)} open${data.total === 1 ? '' : 's'}.`}
        </p>
        <table style={s.table}>
          <thead><tr><th style={s.th}>When</th><th style={s.th}>User</th><th style={s.th}>Application</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={s.td}>{fmtDateTime(r.created_at)}</td>
                <td style={s.td}><Link onClick={() => toUser(r.user_id, r.email)}>{r.email}</Link></td>
                <td style={s.td}><Link onClick={() => toApp(r.app_id, r.app_name)}>{r.app_name}</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    );
  } else if (view.type === 'sessions') {
    const rows = data?.rows || [];
    body = rows.length === 0 ? <Empty>No Hub sessions in this period.</Empty> : (
      <>
        <p style={s.caption}>
          {data.total > rows.length ? `Showing ${rows.length} of ${fmtNum(data.total)} sessions.` : `${fmtNum(data.total)} session${data.total === 1 ? '' : 's'}.`}
          {' '}A session is a continuous visit; it ends after a few minutes without activity.
        </p>
        <table style={s.table}>
          <thead><tr>
            {!view.userId && <th style={s.th}>User</th>}
            <th style={s.th}>Started</th><th style={s.th}>Last activity</th>
            <th style={s.thR}>Duration</th><th style={s.th}>Status</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                {!view.userId && <td style={s.td}><Link onClick={() => toUser(r.user_id, r.email)}>{r.email}</Link></td>}
                <td style={s.td}>{fmtDateTime(r.started_at)}</td>
                <td style={s.td}>{fmtDateTime(r.last_seen_at)}</td>
                <td style={s.tdR}><strong>{fmtMinutes(r.minutes)}</strong></td>
                <td style={s.td}>{r.is_active ? <Pill tone="green">Active now</Pill> : <Pill tone="grey">Ended</Pill>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    );
  } else if (view.type === 'app') {
    const users = data?.users || [];
    const total = users.reduce((a, u) => a + num(u.launches), 0);
    const maxVal = Math.max(0, ...users.map((u) => num(u.launches)));
    body = (
      <>
        <div style={s.statRow}>
          <button type="button" className="an-card" style={s.miniCard} onClick={() => go({ type: 'launches', appId: view.appId, appName: view.appName })}>
            <div style={s.miniLabel}>App opens</div><div style={s.miniValue}>{fmtNum(total)}</div><div className="an-card-cta" style={s.cta}>View all opens →</div>
          </button>
          <div style={{ ...s.miniCard, cursor: 'default' }}>
            <div style={s.miniLabel}>Users</div><div style={s.miniValue}>{fmtNum(users.length)}</div>
          </div>
        </div>
        {users.length === 0 ? <Empty>Nobody opened this app in the last {days} days.</Empty> : (
          <table style={s.table}>
            <thead><tr><th style={s.th}>User</th><th style={s.th}>Department</th><th style={s.thR}>Opens</th><th style={s.th}>Last used</th><th style={{ ...s.th, width: 140 }} /></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} {...rowProps(() => toUser(u.id, u.email))}>
                  <td style={s.td}><strong>{u.email}</strong></td>
                  <td style={s.td}>{u.department || '—'}</td>
                  <td style={s.tdR}><Link onClick={() => go({ type: 'launches', appId: view.appId, appName: view.appName, userId: u.id, userEmail: u.email })}>{fmtNum(u.launches)}</Link></td>
                  <td style={s.td} title={fmtDateTime(u.last_used)}>{fmtRelative(u.last_used)}</td>
                  <td style={s.td}><ShareBar value={u.launches} max={maxVal} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </>
    );
  } else if (view.type === 'user' && data) {
    const u = data.user;
    const apps = data.apps || [];
    const sessions = data.sessions || [];
    const maxVal = Math.max(0, ...apps.map((a) => num(a.launches)));
    body = (
      <>
        <div style={s.profile}>
          <span><span style={s.metaKey}>Role</span> {u.role}</span>
          <span><span style={s.metaKey}>Department</span> {u.department || '—'}</span>
          <span><span style={s.metaKey}>Status</span> {u.is_active === false ? <Pill tone="amber">Pending activation</Pill> : <Pill tone="green">Active</Pill>}</span>
          <span><span style={s.metaKey}>Member since</span> {new Date(u.created_at).toLocaleDateString()}</span>
        </div>
        <div style={s.statRow}>
          <button type="button" className="an-card" style={s.miniCard} onClick={() => go({ type: 'launches', userId: u.id, userEmail: u.email })}>
            <div style={s.miniLabel}>App opens</div><div style={s.miniValue}>{fmtNum(u.launches)}</div><div className="an-card-cta" style={s.cta}>View opens →</div>
          </button>
          <button type="button" className="an-card" style={s.miniCard} onClick={() => go({ type: 'sessions', userId: u.id, userEmail: u.email })}>
            <div style={s.miniLabel}>Hub sessions</div><div style={s.miniValue}>{fmtNum(u.sessions)}</div><div className="an-card-cta" style={s.cta}>View sessions →</div>
          </button>
          <button type="button" className="an-card" style={s.miniCard} onClick={() => go({ type: 'sessions', sort: 'longest', userId: u.id, userEmail: u.email })}>
            <div style={s.miniLabel}>Time in Hub</div><div style={s.miniValue}>{fmtMinutes(u.minutes)}</div><div className="an-card-cta" style={s.cta}>Longest sessions →</div>
          </button>
          <div style={{ ...s.miniCard, cursor: 'default' }}>
            <div style={s.miniLabel}>Last seen</div><div style={s.miniValue}>{fmtRelative(u.last_seen)}</div>
          </div>
        </div>
        <h4 style={s.h4}>Applications used</h4>
        {apps.length === 0 ? <Empty>No app opens in the last {days} days.</Empty> : (
          <table style={s.table}>
            <thead><tr><th style={s.th}>Application</th><th style={s.thR}>Opens</th><th style={s.th}>Last used</th><th style={{ ...s.th, width: 180 }} /></tr></thead>
            <tbody>
              {apps.map((a) => (
                <tr key={a.id} {...rowProps(() => go({ type: 'launches', appId: a.id, appName: a.name, userId: u.id, userEmail: u.email }))}>
                  <td style={s.td}><Link onClick={() => toApp(a.id, a.name)}>{a.name}</Link></td>
                  <td style={s.tdR}><strong>{fmtNum(a.launches)}</strong></td>
                  <td style={s.td} title={fmtDateTime(a.last_used)}>{fmtRelative(a.last_used)}</td>
                  <td style={s.td}><ShareBar value={a.launches} max={maxVal} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <h4 style={s.h4}>Recent Hub sessions</h4>
        {sessions.length === 0 ? <Empty>No Hub sessions in the last {days} days.</Empty> : (
          <table style={s.table}>
            <thead><tr><th style={s.th}>Started</th><th style={s.th}>Last activity</th><th style={s.thR}>Duration</th><th style={s.th}>Status</th></tr></thead>
            <tbody>
              {sessions.map((r) => (
                <tr key={r.id}>
                  <td style={s.td}>{fmtDateTime(r.started_at)}</td>
                  <td style={s.td}>{fmtDateTime(r.last_seen_at)}</td>
                  <td style={s.tdR}><strong>{fmtMinutes(r.minutes)}</strong></td>
                  <td style={s.td}>{r.is_active ? <Pill tone="green">Active now</Pill> : <Pill tone="grey">Ended</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </>
    );
  } else if (view.type === 'bug') {
    const r = view.report;
    body = (
      <>
        <div style={s.profile}>
          <span>{r.kind === 'client_error' ? <Pill tone="red">Auto-captured error</Pill> : <Pill tone="blue">User report</Pill>}</span>
          <span>{r.status === 'resolved' ? <Pill tone="green">Resolved</Pill> : <Pill tone="amber">Open</Pill>}</span>
        </div>
        <dl style={s.dl}>
          <dt style={s.dt}>Reporter</dt>
          <dd style={s.dd}>{r.user_id ? <Link onClick={() => toUser(r.user_id, r.reporter_email)}>{r.reporter_email}</Link> : (r.reporter_email || '—')}</dd>
          <dt style={s.dt}>Reported</dt><dd style={s.dd}>{fmtDateTime(r.created_at)}</dd>
          {r.resolved_at && (<><dt style={s.dt}>Resolved</dt><dd style={s.dd}>{fmtDateTime(r.resolved_at)}</dd></>)}
          <dt style={s.dt}>Page</dt>
          <dd style={s.dd}>{r.page_url ? <a href={r.page_url} target="_blank" rel="noopener noreferrer" style={s.ext}>{r.page_url}</a> : '—'}</dd>
          <dt style={s.dt}>Browser</dt><dd style={{ ...s.dd, color: 'var(--color-text-steel)' }}>{r.user_agent || '—'}</dd>
        </dl>
        <h4 style={s.h4}>{r.kind === 'client_error' ? 'Error message' : 'Description'}</h4>
        <div style={s.messageBox}>{r.message}</div>
        {r.stack && (
          <>
            <h4 style={s.h4}>Stack trace</h4>
            <pre style={s.pre}>{r.stack}</pre>
          </>
        )}
        <div style={{ marginTop: 'var(--space-4)', display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" className={r.status === 'resolved' ? 'btn-secondary' : 'btn-primary'} disabled={busy} onClick={() => toggleBug(r)}>
            {busy ? 'Saving…' : r.status === 'resolved' ? 'Reopen report' : 'Mark as resolved'}
          </button>
        </div>
      </>
    );
  }

  return (
    <div style={s.overlay} onClick={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={viewTitle(view)}
        style={s.modal}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={s.modalHead}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', minWidth: 0 }}>
            {stack.length > 1 && (
              <button type="button" className="btn-secondary btn-compact" onClick={onBack} aria-label="Back">← Back</button>
            )}
            <div style={{ minWidth: 0 }}>
              <h3 style={s.modalTitle}>{viewTitle(view)}</h3>
              {view.type !== 'bug' && <div style={s.modalSub}>Last {days} days</div>}
            </div>
          </div>
          <button type="button" style={s.closeBtn} onClick={onClose} aria-label="Close">×</button>
        </div>
        <div style={s.modalBody}>
          {actionError && <div style={{ ...s.error, marginBottom: 'var(--space-3)' }}>{actionError}</div>}
          {body}
        </div>
      </div>
    </div>
  );
}

/* ---------- main panel ---------- */

export default function AnalyticsPanel() {
  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [updatedAt, setUpdatedAt] = useState(null);

  const [bugStatus, setBugStatus] = useState('open');
  const [bugKind, setBugKind] = useState('');
  const [bugs, setBugs] = useState([]);
  const [bugsLoading, setBugsLoading] = useState(true);

  const [stack, setStack] = useState([]);
  const bugSectionRef = useRef(null);

  useEffect(() => {
    let ignore = false;
    setLoading(true);
    setError('');
    apiRequest(`/api/analytics/summary?days=${days}`)
      .then((d) => { if (!ignore) { setSummary(d); setUpdatedAt(new Date()); } })
      .catch((err) => { if (!ignore) setError(err.error || 'Failed to load analytics'); })
      .finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [days, reloadKey]);

  useEffect(() => {
    let ignore = false;
    setBugsLoading(true);
    const q = new URLSearchParams();
    if (bugStatus) q.set('status', bugStatus);
    if (bugKind) q.set('kind', bugKind);
    apiRequest(`/api/analytics/bug-reports?${q}`)
      .then((d) => { if (!ignore) setBugs(d.reports || []); })
      .catch(() => { if (!ignore) setBugs([]); })
      .finally(() => { if (!ignore) setBugsLoading(false); });
    return () => { ignore = true; };
  }, [bugStatus, bugKind, reloadKey]);

  const open = useCallback((view) => setStack([view]), []);
  const push = useCallback((view) => setStack((st) => [...st, view]), []);
  const back = useCallback(() => setStack((st) => st.slice(0, -1)), []);
  const close = useCallback(() => setStack([]), []);

  const onBugChanged = useCallback((report) => {
    // keep the open detail view in sync, then refresh the list + counters
    setStack((st) => st.map((v) => (v.type === 'bug' && v.report.id === report.id ? { ...v, report } : v)));
    setReloadKey((k) => k + 1);
  }, []);

  async function quickToggleBug(report) {
    try {
      await apiRequest(`/api/analytics/bug-reports/${report.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ resolved: report.status !== 'resolved' }),
      });
      setReloadKey((k) => k + 1);
    } catch (err) {
      setError(err.error || 'Failed to update report');
    }
  }

  function showOpenBugs() {
    setBugStatus('open');
    setBugKind('');
    bugSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const series = useMemo(() => buildSeries(summary?.launchesByDay || [], days), [summary, days]);
  const seriesMax = Math.max(0, ...series.map((p) => p.launches));
  const labelEvery = Math.max(1, Math.ceil(series.length / 10));

  const ov = summary?.overview;
  const topApps = summary?.topApps || [];
  const topUsers = summary?.topUsers || [];
  const maxApp = Math.max(0, ...topApps.map((a) => num(a.launches)));
  const maxUser = Math.max(0, ...topUsers.map((u) => num(u.launches)));
  const openBugs = summary?.bugCounts?.open ?? 0;

  const kpis = ov ? [
    { key: 'users', label: 'Active users', value: fmtNum(ov.active_users), caption: 'Signed in or opened an app', cta: 'See who →', accent: 'var(--color-action-blue)', onClick: () => open({ type: 'activeUsers', order: 'launches' }) },
    { key: 'opens', label: 'App opens', value: fmtNum(ov.total_launches), caption: 'Apps launched from the Hub', cta: 'See every open →', accent: '#7C3AED', onClick: () => open({ type: 'launches' }) },
    { key: 'sessions', label: 'Hub sessions', value: fmtNum(ov.total_sessions), caption: 'Continuous visits to the Hub', cta: 'See sessions →', accent: '#0891B2', onClick: () => open({ type: 'sessions', sort: 'recent' }) },
    { key: 'avg', label: 'Avg session', value: fmtMinutes(ov.avg_session_minutes), caption: 'Average time per visit', cta: 'Longest sessions →', accent: '#059669', onClick: () => open({ type: 'sessions', sort: 'longest' }) },
    { key: 'time', label: 'Total time in Hub', value: fmtMinutes(ov.total_minutes), caption: 'Across all users', cta: 'Time by user →', accent: '#D97706', onClick: () => open({ type: 'activeUsers', order: 'minutes' }) },
    { key: 'bugs', label: 'Open bug reports', value: fmtNum(openBugs), caption: `${fmtNum(summary.bugCounts.client_errors)} auto-captured errors total`, cta: 'Review →', accent: 'var(--color-brand-red)', danger: openBugs > 0, onClick: showOpenBugs },
  ] : [];

  return (
    <section style={s.wrap}>
      {/* Header */}
      <div style={s.header}>
        <div>
          <h2 style={s.title}>Analytic</h2>
          <p style={s.subtitle}>
            How people use Downstream Hub. Click any number to see the details behind it.
            {updatedAt && <span style={s.updated}> Updated {updatedAt.toLocaleTimeString()}.</span>}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <div role="group" aria-label="Period" style={{ display: 'flex' }}>
            {PERIODS.map((p) => (
              <button key={p} type="button" className="an-seg" aria-pressed={days === p} onClick={() => setDays(p)}>
                {p} days
              </button>
            ))}
          </div>
          <button type="button" className="btn-secondary" onClick={() => setReloadKey((k) => k + 1)} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <div style={s.error}>{error}</div>}
      {loading && !summary && <p style={s.muted}>Loading analytics…</p>}

      {summary && (
        <>
          {/* KPI cards */}
          <div className="an-kpi-grid">
            {kpis.map((k) => (
              <button key={k.key} type="button" className="an-card" style={{ ...s.kpi, borderTop: `3px solid ${k.accent}` }} onClick={k.onClick}>
                <div style={s.kpiLabel}>{k.label}</div>
                <div style={{ ...s.kpiValue, color: k.danger ? 'var(--color-destructive)' : 'var(--color-text-charcoal)' }}>{k.value}</div>
                <div style={s.kpiCaption}>{k.caption}</div>
                <div className="an-card-cta" style={s.cta}>{k.cta}</div>
              </button>
            ))}
          </div>

          {/* Trend chart */}
          <div style={s.panel}>
            <div style={s.panelHead}>
              <h3 style={s.h3}>App opens per day</h3>
              <span style={s.muted}>Click a bar to see that day’s opens</span>
            </div>
            {seriesMax === 0 ? <Empty>No app opens in the last {days} days yet.</Empty> : (
              <div style={s.chart}>
                <div style={s.chartAxis}>
                  <span>{fmtNum(seriesMax)}</span>
                  <span>{fmtNum(Math.round(seriesMax / 2))}</span>
                  <span>0</span>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={s.bars}>
                    {series.map((p) => {
                      const h = p.launches > 0 ? Math.max(3, (p.launches / seriesMax) * 100) : 0;
                      return (
                        <div key={p.day} style={s.barSlot}>
                          {p.launches > 0 ? (
                            <button
                              type="button"
                              className="an-bar"
                              title={`${fmtDay(p.day)}: ${fmtNum(p.launches)} open${p.launches === 1 ? '' : 's'}`}
                              aria-label={`${fmtDay(p.day)}: ${p.launches} opens`}
                              style={{ ...s.bar, height: `${h}%` }}
                              onClick={() => open({ type: 'launches', day: p.day })}
                            />
                          ) : (
                            <div style={s.barEmpty} title={`${fmtDay(p.day)}: no opens`} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div style={s.xAxis}>
                    {series.map((p, i) => (
                      <span key={p.day} style={s.xLabel}>{i % labelEvery === 0 || i === series.length - 1 ? fmtDay(p.day) : ''}</span>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Top apps + top users */}
          <div style={s.twoCol}>
            <div style={s.panel}>
              <div style={s.panelHead}>
                <h3 style={s.h3}>Most-used applications</h3>
                {topApps.length > 0 && <Link onClick={() => open({ type: 'launches' })}>All opens →</Link>}
              </div>
              {topApps.length === 0 ? <Empty>No app opens in this period.</Empty> : (
                <table style={s.table}>
                  <thead><tr><th style={{ ...s.th, width: 28 }}>#</th><th style={s.th}>Application</th><th style={s.thR}>Opens</th><th style={s.thR}>Users</th><th style={{ ...s.th, width: '28%' }} /></tr></thead>
                  <tbody>
                    {topApps.map((a, i) => (
                      <tr key={a.id} {...rowProps(() => open({ type: 'app', appId: a.id, appName: a.name }))}>
                        <td style={{ ...s.td, color: 'var(--color-text-steel)' }}>{i + 1}</td>
                        <td style={s.td}><strong>{a.name}</strong></td>
                        <td style={s.tdR}><Link title="See every open of this app" onClick={() => open({ type: 'launches', appId: a.id, appName: a.name })}>{fmtNum(a.launches)}</Link></td>
                        <td style={s.tdR}><Link title="See who uses this app" onClick={() => open({ type: 'app', appId: a.id, appName: a.name })}>{fmtNum(a.unique_users)}</Link></td>
                        <td style={s.td}><ShareBar value={a.launches} max={maxApp} color="#7C3AED" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div style={s.panel}>
              <div style={s.panelHead}>
                <h3 style={s.h3}>Most active users</h3>
                {topUsers.length > 0 && <Link onClick={() => open({ type: 'activeUsers', order: 'launches' })}>All active users →</Link>}
              </div>
              {topUsers.length === 0 ? <Empty>No activity in this period.</Empty> : (
                <table style={s.table}>
                  <thead><tr><th style={{ ...s.th, width: 28 }}>#</th><th style={s.th}>User</th><th style={s.thR}>Opens</th><th style={s.thR}>Sessions</th><th style={s.thR}>Time</th><th style={{ ...s.th, width: '22%' }} /></tr></thead>
                  <tbody>
                    {topUsers.map((u, i) => (
                      <tr key={u.id} {...rowProps(() => open({ type: 'user', userId: u.id, email: u.email }))}>
                        <td style={{ ...s.td, color: 'var(--color-text-steel)' }}>{i + 1}</td>
                        <td style={s.td}>
                          <strong>{u.email}</strong>
                          {u.department && <div style={s.subtle}>{u.department}</div>}
                        </td>
                        <td style={s.tdR}><Link title="See this user's app opens" onClick={() => open({ type: 'launches', userId: u.id, userEmail: u.email })}>{fmtNum(u.launches)}</Link></td>
                        <td style={s.tdR}><Link title="See this user's Hub sessions" onClick={() => open({ type: 'sessions', userId: u.id, userEmail: u.email })}>{fmtNum(u.sessions)}</Link></td>
                        <td style={s.tdR}><Link title="See this user's longest sessions" onClick={() => open({ type: 'sessions', sort: 'longest', userId: u.id, userEmail: u.email })}>{fmtMinutes(u.minutes)}</Link></td>
                        <td style={s.td}><ShareBar value={u.launches} max={maxUser} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}

      {/* Bug reports */}
      <div style={s.panel} ref={bugSectionRef}>
        <div style={s.panelHead}>
          <h3 style={s.h3}>Bug reports &amp; errors</h3>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <div role="group" aria-label="Status" style={{ display: 'flex' }}>
              {[['open', 'Open'], ['resolved', 'Resolved'], ['', 'All']].map(([v, l]) => (
                <button key={l} type="button" className="an-seg" aria-pressed={bugStatus === v} onClick={() => setBugStatus(v)}>{l}</button>
              ))}
            </div>
            <div role="group" aria-label="Type" style={{ display: 'flex' }}>
              {[['', 'All types'], ['user_report', 'Reports'], ['client_error', 'Errors']].map(([v, l]) => (
                <button key={l} type="button" className="an-seg" aria-pressed={bugKind === v} onClick={() => setBugKind(v)}>{l}</button>
              ))}
            </div>
          </div>
        </div>
        {bugsLoading ? <p style={s.muted}>Loading…</p> : bugs.length === 0 ? <Empty>No reports in this view.</Empty> : (
          <table style={s.table}>
            <thead><tr><th style={{ ...s.th, width: 110 }}>Type</th><th style={s.th}>Message</th><th style={s.th}>Reporter</th><th style={{ ...s.th, width: 120 }}>When</th><th style={{ ...s.th, width: 120 }} /></tr></thead>
            <tbody>
              {bugs.map((b) => (
                <tr key={b.id} {...rowProps(() => open({ type: 'bug', report: b }))}>
                  <td style={s.td}>{b.kind === 'client_error' ? <Pill tone="red">Error</Pill> : <Pill tone="blue">Report</Pill>}</td>
                  <td style={s.td}>
                    <div style={s.clamp}>{b.message}</div>
                    {b.page_url && <div style={s.subtle}>{b.page_url}</div>}
                  </td>
                  <td style={s.td}>{b.user_id ? <Link onClick={() => open({ type: 'user', userId: b.user_id, email: b.reporter_email })}>{b.reporter_email}</Link> : (b.reporter_email || '—')}</td>
                  <td style={s.td} title={fmtDateTime(b.created_at)}>{fmtRelative(b.created_at)}</td>
                  <td style={s.tdR}>
                    <button
                      type="button"
                      className={`${b.status === 'resolved' ? 'btn-secondary' : 'btn-primary'} btn-compact`}
                      onClick={(e) => { e.stopPropagation(); quickToggleBug(b); }}
                    >
                      {b.status === 'resolved' ? 'Reopen' : 'Resolve'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {stack.length > 0 && (
        <DetailModal
          stack={stack}
          days={days}
          onNavigate={push}
          onBack={back}
          onClose={close}
          onBugChanged={onBugChanged}
        />
      )}
    </section>
  );
}

/* ---------- styles (design tokens only) ---------- */

const s = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', marginBottom: 'var(--space-6)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 'var(--space-3)', flexWrap: 'wrap' },
  title: { margin: 0, fontSize: 'var(--text-h2)', fontFamily: 'var(--font-heading)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-charcoal)' },
  subtitle: { margin: 'var(--space-1) 0 0', fontSize: 'var(--text-small)', color: 'var(--color-text-steel)' },
  updated: { color: 'var(--color-text-steel)', opacity: 0.8 },
  error: { padding: 'var(--space-3)', background: '#FEE2E2', color: 'var(--color-destructive)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-small)' },
  muted: { color: 'var(--color-text-steel)', fontSize: 'var(--text-small)', margin: 0 },
  empty: { color: 'var(--color-text-steel)', fontSize: 'var(--text-small)', margin: 'var(--space-3) 0' },
  caption: { color: 'var(--color-text-steel)', fontSize: 'var(--text-small)', margin: '0 0 var(--space-3)' },
  subtle: { fontSize: 'var(--text-xs)', color: 'var(--color-text-steel)', marginTop: 2, wordBreak: 'break-all' },

  kpi: { padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 4, minHeight: 150 },
  kpiLabel: { fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-steel)' },
  kpiValue: { fontSize: 'clamp(28px, 2.2vw, 40px)', lineHeight: 1.1, whiteSpace: 'nowrap', fontWeight: 'var(--font-weight-bold)', fontFamily: 'var(--font-heading)', marginTop: 'var(--space-1)' },
  kpiCaption: { fontSize: 'var(--text-small)', color: 'var(--color-text-steel)' },
  cta: { marginTop: 'auto', paddingTop: 'var(--space-2)', fontSize: 'var(--text-small)', fontWeight: 'var(--font-weight-medium)', color: 'var(--color-action-blue)' },

  panel: { background: 'var(--color-bg-white)', border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)', padding: 'var(--space-4)', minWidth: 0 },
  panelHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap', marginBottom: 'var(--space-3)' },
  h3: { margin: 0, fontSize: 'var(--text-base)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-charcoal)' },
  h4: { margin: 'var(--space-4) 0 var(--space-2)', fontSize: 'var(--text-small)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-steel)', fontWeight: 'var(--font-weight-semibold)' },
  twoCol: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))', gap: 'var(--space-4)' },

  chart: { display: 'flex', gap: 'var(--space-2)', height: 240 },
  chartAxis: { display: 'flex', flexDirection: 'column', justifyContent: 'space-between', fontSize: 'var(--text-xs)', color: 'var(--color-text-steel)', textAlign: 'right', minWidth: 28, paddingBottom: 22 },
  bars: { display: 'flex', alignItems: 'flex-end', gap: 3, height: 218, borderBottom: '1px solid var(--color-border-light)', backgroundImage: 'linear-gradient(var(--color-border-light) 1px, transparent 1px)', backgroundSize: '100% 50%' },
  barSlot: { flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end', minWidth: 0 },
  bar: { width: '100%', background: '#7C3AED', border: 'none', borderRadius: '4px 4px 0 0', padding: 0 },
  barEmpty: { width: '100%', height: 2, background: 'var(--color-border-light)' },
  xAxis: { display: 'flex', gap: 3, marginTop: 6, height: 16 },
  xLabel: { flex: 1, minWidth: 0, fontSize: 10, color: 'var(--color-text-steel)', whiteSpace: 'nowrap', overflow: 'visible' },

  table: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-small)' },
  th: { textAlign: 'left', padding: '8px 10px', borderBottom: '2px solid var(--color-border-light)', color: 'var(--color-text-steel)', fontWeight: 'var(--font-weight-semibold)', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' },
  thR: { textAlign: 'right', padding: '8px 10px', borderBottom: '2px solid var(--color-border-light)', color: 'var(--color-text-steel)', fontWeight: 'var(--font-weight-semibold)', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' },
  td: { textAlign: 'left', padding: '10px', borderBottom: '1px solid var(--color-border-light)', color: 'var(--color-text-charcoal)', verticalAlign: 'middle' },
  tdR: { textAlign: 'right', padding: '10px', borderBottom: '1px solid var(--color-border-light)', color: 'var(--color-text-charcoal)', verticalAlign: 'middle', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  clamp: { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', maxWidth: 560, wordBreak: 'break-word' },

  shareTrack: { height: 8, background: 'var(--color-bg-light)', borderRadius: 999, overflow: 'hidden', minWidth: 60 },
  shareFill: { height: '100%', borderRadius: 999 },
  pill: { display: 'inline-block', padding: '2px 10px', borderRadius: 999, fontSize: 'var(--text-xs)', fontWeight: 600, whiteSpace: 'nowrap' },

  overlay: { position: 'fixed', inset: 0, background: 'rgba(17, 24, 39, 0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-4)' },
  modal: { background: 'var(--color-bg-white)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)', width: '100%', maxWidth: 1080, maxHeight: '88vh', display: 'flex', flexDirection: 'column', outline: 'none' },
  modalHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-4) var(--space-5)', borderBottom: '1px solid var(--color-border-light)' },
  modalTitle: { margin: 0, fontSize: 'var(--text-h3)', fontFamily: 'var(--font-heading)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-charcoal)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  modalSub: { fontSize: 'var(--text-xs)', color: 'var(--color-text-steel)', marginTop: 2 },
  modalBody: { padding: 'var(--space-4) var(--space-5) var(--space-5)', overflowY: 'auto' },
  closeBtn: { background: 'none', border: 'none', fontSize: 28, lineHeight: 1, cursor: 'pointer', color: 'var(--color-text-steel)', padding: '0 4px' },

  statRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 'var(--space-3)', marginBottom: 'var(--space-2)' },
  miniCard: { padding: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 2, background: 'var(--color-bg-white)', border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-lg)', textAlign: 'left', minHeight: 96 },
  miniLabel: { fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-steel)', fontWeight: 'var(--font-weight-semibold)' },
  miniValue: { fontSize: 26, fontWeight: 'var(--font-weight-bold)', fontFamily: 'var(--font-heading)', color: 'var(--color-text-charcoal)' },

  profile: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2) var(--space-5)', alignItems: 'center', fontSize: 'var(--text-small)', color: 'var(--color-text-charcoal)', marginBottom: 'var(--space-4)' },
  metaKey: { fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-steel)', marginRight: 6 },
  dl: { display: 'grid', gridTemplateColumns: '120px 1fr', gap: 'var(--space-2) var(--space-3)', margin: 0, fontSize: 'var(--text-small)' },
  dt: { color: 'var(--color-text-steel)', fontWeight: 'var(--font-weight-medium)' },
  dd: { margin: 0, color: 'var(--color-text-charcoal)', wordBreak: 'break-all' },
  ext: { color: 'var(--color-action-blue)' },
  messageBox: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--color-bg-lighter)', border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)', fontSize: 'var(--text-small)', color: 'var(--color-text-charcoal)' },
  pre: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#111827', color: '#E5E7EB', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)', fontSize: 12, lineHeight: 1.5, maxHeight: 320, overflow: 'auto', margin: 0 },
};
