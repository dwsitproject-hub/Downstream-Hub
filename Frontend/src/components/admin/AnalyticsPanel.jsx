import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { apiRequest } from '../../api';
import { resolveIconSrc } from '../../utils/resolveIconSrc';
import { applicationInitials } from '../../utils/applicationInitials';
import { Breadcrumbs, SentinelBugAnalysis, SentinelCard, SentinelPill } from './Sentinel';

const PERIODS = [7, 30, 90];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/* ---------- formatting helpers ---------- */

const num = (v) => Number(v || 0);
const fmtNum = (v) => num(v).toLocaleString();
const plural = (n, word) => `${fmtNum(n)} ${word}${num(n) === 1 ? '' : 's'}`;

function fmtMinutes(v) {
  const n = num(v);
  if (n > 0 && n < 1) return `${Math.max(1, Math.round(n * 60))}s`; // short visits: "18s", not "0m"
  const total = Math.round(n);
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

/** Continuous daily series for charts (fills empty days; keeps every server bucket). */
function buildSeries(rows, days, field) {
  const counts = new Map(rows.map((r) => [r.day, num(r[field])]));
  const keys = new Set(counts.keys());
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    keys.add(dayKey(d));
  }
  return [...keys].sort().map((day) => ({ day, value: counts.get(day) || 0 }));
}

/** SDK health for an application, from the last time it sent anything. */
function sdkState(app) {
  if (app.sdk_enabled === false) return { tone: 'grey', label: 'SDK disabled' };
  if (!app.sdk_last_seen) return { tone: 'amber', label: 'SDK not installed' };
  if (Date.now() - new Date(app.sdk_last_seen).getTime() < LIVE_WINDOW_MS) return { tone: 'green', label: 'Live' };
  return { tone: 'grey', label: `Last data ${fmtRelative(app.sdk_last_seen)}` };
}

/* ---------- drill-down views ---------- */

function viewTitle(view) {
  const who = view.who ? ` · ${view.who}` : '';
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
    case 'appUsers':
      return `${view.appName} · Users`;
    case 'appSessions':
      return `${view.appName} · ${view.sort === 'longest' ? 'Longest sessions' : 'Sessions'}${who}`;
    case 'appPages': {
      const parts = [view.appName, 'Page views'];
      if (view.path) parts.push(view.path);
      if (view.day) parts.push(fmtDay(view.day));
      return parts.join(' · ') + who;
    }
    case 'appUser':
      return `${view.who || 'User'} · ${view.appName}`;
    case 'bug':
      return view.report.kind === 'client_error' ? 'Error report' : 'Bug report';
    default:
      return 'Details';
  }
}

function addWho(q, view) {
  if (view.userId) q.set('user_id', view.userId);
  else if (view.email) q.set('email', view.email);
}

function viewUrl(view, days) {
  const q = new URLSearchParams({ days: String(days) });
  const usage = (suffix) => `/api/analytics/apps/${view.appId}/usage/${suffix}?${q}`;
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
    case 'appUsers':
      return usage('users');
    case 'appSessions':
      q.set('sort', view.sort || 'recent');
      addWho(q, view);
      return usage('sessions');
    case 'appPages':
      if (view.path) q.set('path', view.path);
      if (view.day) q.set('day', view.day);
      addWho(q, view);
      return usage('pages');
    case 'appUser':
      addWho(q, view);
      return usage('user');
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

function AppIcon({ app, size = 28 }) {
  const src = resolveIconSrc(app?.icon_url);
  const box = { width: size, height: size, borderRadius: Math.round(size / 4), flexShrink: 0 };
  if (app?.hub) return <span style={{ ...box, ...s.iconFallback, background: 'var(--color-brand-red)', fontSize: Math.round(size / 2.6) }} aria-hidden="true">DH</span>;
  return src
    ? <img src={src} alt="" style={{ ...box, objectFit: 'cover', display: 'block' }} />
    : <span style={{ ...box, ...s.iconFallback, fontSize: Math.round(size / 3.2) }} aria-hidden="true">{applicationInitials(app?.name || '?')}</span>;
}

function KpiGrid({ items }) {
  return (
    <div className="an-kpi-grid">
      {items.map((k) => (
        <button key={k.key} type="button" className="an-card" style={{ ...s.kpi, borderTop: `3px solid ${k.accent}` }} onClick={k.onClick}>
          <div style={s.kpiLabel}>{k.label}</div>
          <div style={{ ...s.kpiValue, color: k.danger ? 'var(--color-destructive)' : 'var(--color-text-charcoal)' }}>{k.value}</div>
          <div style={s.kpiCaption}>{k.caption}</div>
          <div className="an-card-cta" style={s.cta}>{k.cta}</div>
        </button>
      ))}
    </div>
  );
}

function DayChart({ title, rows, days, field, noun, color = '#7C3AED', onBarClick, emptyText }) {
  const series = useMemo(() => buildSeries(rows || [], days, field), [rows, days, field]);
  const max = Math.max(0, ...series.map((p) => p.value));
  const labelEvery = Math.max(1, Math.ceil(series.length / 10));
  return (
    <div style={s.panel}>
      <div style={s.panelHead}>
        <h3 style={s.h3}>{title}</h3>
        {max > 0 && <span style={s.muted}>Click a bar to see that day’s {noun}s</span>}
      </div>
      {max === 0 ? <Empty>{emptyText}</Empty> : (
        <div style={s.chart}>
          <div style={s.chartAxis}>
            <span>{fmtNum(max)}</span>
            <span>{fmtNum(Math.round(max / 2))}</span>
            <span>0</span>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={s.bars}>
              {series.map((p) => {
                const h = p.value > 0 ? Math.max(3, (p.value / max) * 100) : 0;
                return (
                  <div key={p.day} style={s.barSlot}>
                    {p.value > 0 ? (
                      <button
                        type="button"
                        className="an-bar"
                        title={`${fmtDay(p.day)}: ${plural(p.value, noun)}`}
                        aria-label={`${fmtDay(p.day)}: ${plural(p.value, noun)}`}
                        style={{ ...s.bar, background: color, height: `${h}%` }}
                        onClick={() => onBarClick(p.day)}
                      />
                    ) : (
                      <div style={s.barEmpty} title={`${fmtDay(p.day)}: no ${noun}s`} />
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
  );
}

/* ---------- detail modal ---------- */

function SessionTable({ rows, showUser, onUser }) {
  return (
    <table style={s.table}>
      <thead><tr>
        {showUser && <th style={s.th}>User</th>}
        <th style={s.th}>Started</th><th style={s.th}>Last activity</th>
        <th style={s.thR}>Duration</th>
        {rows.some((r) => r.page_views !== undefined) && <th style={s.thR}>Pages</th>}
        <th style={s.th}>Status</th>
      </tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            {showUser && (
              <td style={s.td}>
                {r.email ? <Link onClick={() => onUser(r.user_id, r.email)}>{r.email}</Link> : <span style={s.muted}>Anonymous</span>}
              </td>
            )}
            <td style={s.td}>{fmtDateTime(r.started_at)}</td>
            <td style={s.td}>{fmtDateTime(r.last_seen_at)}</td>
            <td style={s.tdR}><strong>{fmtMinutes(r.minutes)}</strong></td>
            {r.page_views !== undefined && <td style={s.tdR}>{fmtNum(r.page_views)}</td>}
            <td style={s.td}>{r.is_active ? <Pill tone="green">Active now</Pill> : <Pill tone="grey">Ended</Pill>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

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
  // Inside one application: who = a Hub user id, or the email the app reported.
  const appCtx = { appId: view.appId, appName: view.appName };
  const whoOf = (userId, email) => ({ userId: userId || undefined, email: userId ? undefined : email, who: email });
  const toAppUser = (userId, email) => go({ type: 'appUser', ...appCtx, ...whoOf(userId, email) });
  const viewWho = { userId: view.userId, email: view.email, who: view.who };

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
          {data.total > rows.length ? `Showing the latest ${rows.length} of ${fmtNum(data.total)} opens.` : `${plural(data.total, 'open')}.`}
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
          {data.total > rows.length ? `Showing ${rows.length} of ${fmtNum(data.total)} sessions.` : `${plural(data.total, 'session')}.`}
          {' '}A session is a continuous visit; it ends after a few minutes without activity.
        </p>
        <SessionTable rows={rows} showUser={!view.userId} onUser={toUser} />
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
        <h4 style={s.h4}>Applications opened from the Hub</h4>
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
        {sessions.length === 0 ? <Empty>No Hub sessions in the last {days} days.</Empty> : <SessionTable rows={sessions} showUser={false} />}
      </>
    );
  } else if (view.type === 'appUsers') {
    const users = data?.users || [];
    const anon = num(data?.anonymous_sessions);
    const maxVal = Math.max(0, ...users.map((u) => num(u.minutes)));
    body = (
      <>
        <p style={s.caption}>
          {plural(users.length, 'identified user')} in the last {days} days
          {anon > 0 && <> · {plural(anon, 'anonymous session')} (the app did not call <code style={s.code}>DwsHub.identify</code>)</>}.
        </p>
        {users.length === 0 ? <Empty>No identified users yet.</Empty> : (
          <table style={s.table}>
            <thead><tr>
              <th style={s.th}>User</th><th style={s.th}>Department</th>
              <th style={s.thR}>Sessions</th><th style={s.thR}>Time in app</th><th style={s.thR}>Page views</th>
              <th style={s.th}>Last seen</th><th style={{ ...s.th, width: 140 }} />
            </tr></thead>
            <tbody>
              {users.map((u) => {
                const who = whoOf(u.user_id, u.email);
                return (
                  <tr key={u.user_id || u.email} {...rowProps(() => toAppUser(u.user_id, u.email))}>
                    <td style={s.td}>
                      <strong>{u.email}</strong>
                      {!u.is_hub_user && <div style={s.subtle}><Pill tone="grey">Not a Hub account</Pill></div>}
                    </td>
                    <td style={s.td}>{u.department || '—'}</td>
                    <td style={s.tdR}><Link onClick={() => go({ type: 'appSessions', ...appCtx, ...who })}>{fmtNum(u.sessions)}</Link></td>
                    <td style={s.tdR}><Link onClick={() => go({ type: 'appSessions', sort: 'longest', ...appCtx, ...who })}>{fmtMinutes(u.minutes)}</Link></td>
                    <td style={s.tdR}><Link onClick={() => go({ type: 'appPages', ...appCtx, ...who })}>{fmtNum(u.page_views)}</Link></td>
                    <td style={s.td} title={fmtDateTime(u.last_seen)}>{fmtRelative(u.last_seen)}</td>
                    <td style={s.td}><ShareBar value={u.minutes} max={maxVal} color="#0891B2" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </>
    );
  } else if (view.type === 'appSessions') {
    const rows = data?.rows || [];
    body = rows.length === 0 ? <Empty>No sessions match this view.</Empty> : (
      <>
        <p style={s.caption}>
          {data.total > rows.length ? `Showing ${rows.length} of ${fmtNum(data.total)} sessions.` : `${plural(data.total, 'session')}.`}
          {' '}A session ends after 30 minutes without activity; time counts only while the app is on screen.
        </p>
        <SessionTable rows={rows} showUser={!view.who} onUser={toAppUser} />
      </>
    );
  } else if (view.type === 'appPages') {
    const rows = data?.rows || [];
    body = rows.length === 0 ? <Empty>No page views match this view.</Empty> : (
      <>
        <p style={s.caption}>
          {data.total > rows.length ? `Showing the latest ${rows.length} of ${fmtNum(data.total)} page views.` : `${plural(data.total, 'page view')}.`}
        </p>
        <table style={s.table}>
          <thead><tr><th style={s.th}>When</th><th style={s.th}>Page</th>{!view.who && <th style={s.th}>User</th>}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={s.td}>{fmtDateTime(r.created_at)}</td>
                <td style={s.td}>
                  {view.path ? <code style={s.code}>{r.path}</code> : (
                    <Link title="All views of this page" onClick={() => go({ type: 'appPages', ...appCtx, ...viewWho, path: r.path })}><code style={s.code}>{r.path}</code></Link>
                  )}
                  {r.title && <div style={s.subtle}>{r.title}</div>}
                </td>
                {!view.who && (
                  <td style={s.td}>{r.email ? <Link onClick={() => toAppUser(r.user_id, r.email)}>{r.email}</Link> : <span style={s.muted}>Anonymous</span>}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </>
    );
  } else if (view.type === 'appUser' && data) {
    const sm = data.summary || {};
    const pages = data.pages || [];
    const events = data.events || [];
    const maxPage = Math.max(0, ...pages.map((p) => num(p.views)));
    body = (
      <>
        <div style={s.profile}>
          <span><span style={s.metaKey}>Email</span> {sm.email || view.who}</span>
          <span><span style={s.metaKey}>Department</span> {sm.department || '—'}</span>
          <span><span style={s.metaKey}>Account</span> {sm.is_hub_user ? <Pill tone="green">Hub user</Pill> : <Pill tone="grey">Reported by the app only</Pill>}</span>
          <span><span style={s.metaKey}>First seen</span> {fmtDateTime(sm.first_seen)}</span>
        </div>
        <div style={s.statRow}>
          <button type="button" className="an-card" style={s.miniCard} onClick={() => go({ type: 'appSessions', ...appCtx, ...viewWho })}>
            <div style={s.miniLabel}>Sessions</div><div style={s.miniValue}>{fmtNum(sm.sessions)}</div><div className="an-card-cta" style={s.cta}>View sessions →</div>
          </button>
          <button type="button" className="an-card" style={s.miniCard} onClick={() => go({ type: 'appSessions', sort: 'longest', ...appCtx, ...viewWho })}>
            <div style={s.miniLabel}>Time in app</div><div style={s.miniValue}>{fmtMinutes(sm.minutes)}</div><div className="an-card-cta" style={s.cta}>Longest sessions →</div>
          </button>
          <button type="button" className="an-card" style={s.miniCard} onClick={() => go({ type: 'appPages', ...appCtx, ...viewWho })}>
            <div style={s.miniLabel}>Page views</div><div style={s.miniValue}>{fmtNum(sm.page_views)}</div><div className="an-card-cta" style={s.cta}>View page views →</div>
          </button>
          <div style={{ ...s.miniCard, cursor: 'default' }}>
            <div style={s.miniLabel}>Last seen</div><div style={s.miniValue}>{fmtRelative(sm.last_seen)}</div>
          </div>
        </div>
        <h4 style={s.h4}>Pages visited</h4>
        {pages.length === 0 ? <Empty>No page views in the last {days} days.</Empty> : (
          <table style={s.table}>
            <thead><tr><th style={s.th}>Page</th><th style={s.thR}>Views</th><th style={s.th}>Last viewed</th><th style={{ ...s.th, width: 160 }} /></tr></thead>
            <tbody>
              {pages.map((p) => (
                <tr key={p.path} {...rowProps(() => go({ type: 'appPages', ...appCtx, ...viewWho, path: p.path }))}>
                  <td style={s.td}><code style={s.code}>{p.path}</code>{p.title && <div style={s.subtle}>{p.title}</div>}</td>
                  <td style={s.tdR}><strong>{fmtNum(p.views)}</strong></td>
                  <td style={s.td} title={fmtDateTime(p.last_viewed)}>{fmtRelative(p.last_viewed)}</td>
                  <td style={s.td}><ShareBar value={p.views} max={maxPage} color="#7C3AED" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {events.length > 0 && (
          <>
            <h4 style={s.h4}>Tracked actions</h4>
            <table style={s.table}>
              <thead><tr><th style={s.th}>Action</th><th style={s.thR}>Count</th><th style={s.th}>Last</th></tr></thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.name}>
                    <td style={s.td}><code style={s.code}>{e.name}</code></td>
                    <td style={s.tdR}><strong>{fmtNum(e.count)}</strong></td>
                    <td style={s.td} title={fmtDateTime(e.last_at)}>{fmtRelative(e.last_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <h4 style={s.h4}>Recent sessions</h4>
        {(data.sessions || []).length === 0 ? <Empty>No sessions in the last {days} days.</Empty> : <SessionTable rows={data.sessions} showUser={false} />}
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
          <dt style={s.dt}>Application</dt>
          <dd style={s.dd}>{r.application_name || 'Downstream Hub'}</dd>
          <dt style={s.dt}>Reporter</dt>
          <dd style={s.dd}>{r.user_id ? <Link onClick={() => toUser(r.user_id, r.reporter_email)}>{r.reporter_email}</Link> : (r.reporter_email || 'Anonymous')}</dd>
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
        <Breadcrumbs context={r.context} release={r.release} />
        <SentinelBugAnalysis report={r} />
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

/* ---------- bug reports (Hub, one application, or all) ---------- */

function BugSection({ scope, reloadKey, onOpen, onChanged, focusSignal, onSelectScope, title = 'Bug reports & errors' }) {
  const [status, setStatus] = useState('open');
  const [kind, setKind] = useState('');
  const [bugs, setBugs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const ref = useRef(null);
  const showApp = scope === 'all';

  useEffect(() => {
    if (!focusSignal) return;
    setStatus('open');
    setKind('');
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focusSignal]);

  useEffect(() => {
    let ignore = false;
    setLoading(true);
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    if (kind) q.set('kind', kind);
    if (scope !== 'all') q.set('scope', scope);
    apiRequest(`/api/analytics/bug-reports?${q}`)
      .then((d) => { if (!ignore) { setBugs(d.reports || []); setError(''); } })
      .catch((err) => { if (!ignore) { setBugs([]); setError(err.error || 'Failed to load reports'); } })
      .finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [scope, status, kind, reloadKey]);

  async function quickToggle(report) {
    try {
      await apiRequest(`/api/analytics/bug-reports/${report.id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ resolved: report.status !== 'resolved' }),
      });
      onChanged();
    } catch (err) {
      setError(err.error || 'Failed to update report');
    }
  }

  return (
    <div style={s.panel} ref={ref}>
      <div style={s.panelHead}>
        <h3 style={s.h3}>{title}</h3>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <div role="group" aria-label="Status" style={{ display: 'flex' }}>
            {[['open', 'Open'], ['resolved', 'Resolved'], ['', 'All']].map(([v, l]) => (
              <button key={l} type="button" className="an-seg" aria-pressed={status === v} onClick={() => setStatus(v)}>{l}</button>
            ))}
          </div>
          <div role="group" aria-label="Type" style={{ display: 'flex' }}>
            {[['', 'All types'], ['user_report', 'Reports'], ['client_error', 'Errors']].map(([v, l]) => (
              <button key={l} type="button" className="an-seg" aria-pressed={kind === v} onClick={() => setKind(v)}>{l}</button>
            ))}
          </div>
        </div>
      </div>
      {error && <div style={{ ...s.error, marginBottom: 'var(--space-3)' }}>{error}</div>}
      {loading ? <p style={s.muted}>Loading…</p> : bugs.length === 0 ? <Empty>No reports in this view.</Empty> : (
        <table style={s.table}>
          <thead><tr>
            <th style={{ ...s.th, width: 100 }}>Type</th>
            {showApp && <th style={s.th}>Application</th>}
            <th style={s.th}>Message</th><th style={s.th}>Reporter</th>
            <th style={{ ...s.th, width: 120 }}>Sentinel</th>
            <th style={{ ...s.th, width: 110 }}>When</th><th style={{ ...s.th, width: 110 }} />
          </tr></thead>
          <tbody>
            {bugs.map((b) => (
              <tr key={b.id} {...rowProps(() => onOpen({ type: 'bug', report: b }))}>
                <td style={s.td}>{b.kind === 'client_error' ? <Pill tone="red">Error</Pill> : <Pill tone="blue">Report</Pill>}</td>
                {showApp && (
                  <td style={s.td}>
                    <Link title="Open this application's analytics" onClick={() => onSelectScope(b.application_id || 'hub')}>
                      {b.application_name || 'Downstream Hub'}
                    </Link>
                  </td>
                )}
                <td style={s.td}>
                  <div style={s.clamp}>{b.message}</div>
                  {b.sentinel_status === 'done' && b.sentinel_summary
                    ? <div style={{ ...s.subtle, color: '#3730A3' }}>Sentinel: {b.sentinel_summary}</div>
                    : b.page_url && <div style={s.subtle}>{b.page_url}</div>}
                </td>
                <td style={s.td}>
                  {b.user_id
                    ? <Link onClick={() => onOpen({ type: 'user', userId: b.user_id, email: b.reporter_email })}>{b.reporter_email}</Link>
                    : (b.reporter_email || <span style={s.muted}>Anonymous</span>)}
                </td>
                <td style={s.td}><SentinelPill status={b.sentinel_status} severity={b.sentinel_severity} summary={b.sentinel_summary} /></td>
                <td style={s.td} title={fmtDateTime(b.created_at)}>{fmtRelative(b.created_at)}</td>
                <td style={s.tdR}>
                  <button
                    type="button"
                    className={`${b.status === 'resolved' ? 'btn-secondary' : 'btn-primary'} btn-compact`}
                    onClick={(e) => { e.stopPropagation(); quickToggle(b); }}
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
  );
}

/** Load JSON for a view; re-fetches when the URL or the refresh key changes. */
function useApi(url, reloadKey, onLoaded) {
  const [state, setState] = useState({ data: null, loading: true, error: '' });
  useEffect(() => {
    let ignore = false;
    setState((st) => ({ ...st, loading: true, error: '' }));
    apiRequest(url)
      .then((d) => { if (!ignore) { setState({ data: d, loading: false, error: '' }); onLoaded?.(); } })
      .catch((err) => { if (!ignore) setState({ data: null, loading: false, error: err.error || 'Failed to load analytics' }); });
    return () => { ignore = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, reloadKey]);
  return state;
}

/* ---------- scope: all applications ---------- */

const OVERVIEW_SORTS = {
  sessions: (r) => num(r.sessions),
  active_users: (r) => num(r.active_users),
  minutes: (r) => num(r.minutes),
  page_views: (r) => num(r.page_views),
  errors: (r) => num(r.errors),
  open_bugs: (r) => num(r.open_bugs),
};

function OverviewView({ days, reloadKey, open, onSelectScope, onLoaded, onBugsChanged }) {
  const { data, loading, error } = useApi(`/api/analytics/overview?days=${days}`, reloadKey, onLoaded);
  const [sort, setSort] = useState('sessions');
  const [bugFocus, setBugFocus] = useState(0);
  const tableRef = useRef(null);

  if (loading && !data) return <p style={s.muted}>Loading analytics…</p>;
  if (error) return <div style={s.error}>{error}</div>;
  if (!data) return null;

  const apps = data.apps || [];
  const hub = data.hub || {};
  const reporting = apps.filter((a) => num(a.sessions) > 0).length;
  const installed = apps.filter((a) => a.sdk_last_seen).length;
  const sum = (key) => apps.reduce((acc, a) => acc + num(a[key]), 0);
  const openBugs = sum('open_bugs') + num(hub.open_bugs);
  const sortBy = (key) => {
    setSort(key);
    tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const sorted = [...apps].sort((a, b) => OVERVIEW_SORTS[sort](b) - OVERVIEW_SORTS[sort](a) || a.name.localeCompare(b.name));
  const maxSort = Math.max(0, ...apps.map(OVERVIEW_SORTS[sort]));

  const kpis = [
    { key: 'apps', label: 'Apps reporting', value: `${reporting} / ${apps.length}`, caption: `${installed} have sent data at least once`, cta: 'Rank by sessions →', accent: 'var(--color-action-blue)', onClick: () => sortBy('sessions') },
    { key: 'users', label: 'Active users', value: fmtNum(sum('active_users')), caption: 'Summed per application', cta: 'Rank by users →', accent: '#0891B2', onClick: () => sortBy('active_users') },
    { key: 'time', label: 'Time in apps', value: fmtMinutes(sum('minutes')), caption: 'On-screen time, all apps', cta: 'Rank by time →', accent: '#D97706', onClick: () => sortBy('minutes') },
    { key: 'pages', label: 'Page views', value: fmtNum(sum('page_views')), caption: 'Across all apps', cta: 'Rank by page views →', accent: '#7C3AED', onClick: () => sortBy('page_views') },
    { key: 'errors', label: 'JS errors', value: fmtNum(sum('errors')), caption: 'Auto-captured in this period', cta: 'Rank by errors →', accent: '#B91C1C', danger: sum('errors') > 0, onClick: () => sortBy('errors') },
    { key: 'bugs', label: 'Open bug reports', value: fmtNum(openBugs), caption: 'All apps + the Hub', cta: 'Review →', accent: 'var(--color-brand-red)', danger: openBugs > 0, onClick: () => setBugFocus((n) => n + 1) },
  ];

  const header = (key, label) => (
    <th style={s.thR} aria-sort={sort === key ? 'descending' : 'none'}>
      <button type="button" className="an-link" style={s.sortBtn} onClick={() => setSort(key)} title={`Rank by ${label.toLowerCase()}`}>
        {label}{sort === key ? ' ↓' : ''}
      </button>
    </th>
  );

  return (
    <>
      <KpiGrid items={kpis} />

      <div style={s.panel} ref={tableRef}>
        <div style={s.panelHead}>
          <h3 style={s.h3}>Applications</h3>
          <span style={s.muted}>Click an application to open its analytics · click a column to rank</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={s.table}>
            <thead><tr>
              <th style={s.th}>Application</th><th style={s.th}>SDK</th>
              {header('active_users', 'Users')}{header('sessions', 'Sessions')}{header('minutes', 'Time in app')}
              {header('page_views', 'Page views')}
              <th style={s.thR}>Opened from Hub</th>
              {header('errors', 'Errors')}{header('open_bugs', 'Open bugs')}
              <th style={{ ...s.th, width: 120 }} />
            </tr></thead>
            <tbody>
              <tr {...rowProps(() => onSelectScope('hub'))}>
                <td style={s.td}>
                  <div style={s.appCell}><AppIcon app={{ hub: true }} /><div><strong>Downstream Hub</strong><div style={s.subtle}>The portal itself</div></div></div>
                </td>
                <td style={s.td}><Pill tone="green">Built in</Pill></td>
                <td style={s.tdR}>{fmtNum(hub.active_users)}</td>
                <td style={s.tdR}>{fmtNum(hub.total_sessions)}</td>
                <td style={s.tdR}>{fmtMinutes(hub.total_minutes)}</td>
                <td style={s.tdR}><span style={s.muted}>—</span></td>
                <td style={s.tdR}><span style={s.muted}>—</span></td>
                <td style={s.tdR}><span style={s.muted}>—</span></td>
                <td style={s.tdR}>{num(hub.open_bugs) > 0 ? <strong style={{ color: 'var(--color-destructive)' }}>{fmtNum(hub.open_bugs)}</strong> : '0'}</td>
                <td style={s.td} />
              </tr>
              {sorted.map((a) => {
                const st = sdkState(a);
                const ctx = { appId: a.id, appName: a.name };
                return (
                  <tr key={a.id} {...rowProps(() => onSelectScope(a.id))}>
                    <td style={s.td}><div style={s.appCell}><AppIcon app={a} /><strong>{a.name}</strong></div></td>
                    <td style={s.td}><Pill tone={st.tone}>{st.label}</Pill></td>
                    <td style={s.tdR}>{num(a.active_users) ? <Link title="Users of this app" onClick={() => open({ type: 'appUsers', ...ctx })}>{fmtNum(a.active_users)}</Link> : '0'}</td>
                    <td style={s.tdR}>{num(a.sessions) ? <Link title="Sessions in this app" onClick={() => open({ type: 'appSessions', ...ctx })}>{fmtNum(a.sessions)}</Link> : '0'}</td>
                    <td style={s.tdR}>{num(a.minutes) ? <Link title="Longest sessions" onClick={() => open({ type: 'appSessions', sort: 'longest', ...ctx })}>{fmtMinutes(a.minutes)}</Link> : '0m'}</td>
                    <td style={s.tdR}>{num(a.page_views) ? <Link title="Page views" onClick={() => open({ type: 'appPages', ...ctx })}>{fmtNum(a.page_views)}</Link> : '0'}</td>
                    <td style={s.tdR}>{num(a.launches) ? <Link title="Opens from the Hub" onClick={() => open({ type: 'launches', ...ctx })}>{fmtNum(a.launches)}</Link> : '0'}</td>
                    <td style={s.tdR}>{num(a.errors) ? <strong style={{ color: 'var(--color-destructive)' }}>{fmtNum(a.errors)}</strong> : '0'}</td>
                    <td style={s.tdR}>{num(a.open_bugs) ? <strong style={{ color: 'var(--color-destructive)' }}>{fmtNum(a.open_bugs)}</strong> : '0'}</td>
                    <td style={s.td}><ShareBar value={OVERVIEW_SORTS[sort](a)} max={maxSort} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <BugSection
        scope="all"
        title="Bug reports & errors · all applications"
        reloadKey={reloadKey}
        onOpen={open}
        onChanged={onBugsChanged}
        focusSignal={bugFocus}
        onSelectScope={onSelectScope}
      />
    </>
  );
}

/* ---------- scope: Downstream Hub itself ---------- */

function HubView({ days, reloadKey, open, onLoaded, onBugsChanged, onSelectScope }) {
  const { data: summary, loading, error } = useApi(`/api/analytics/summary?days=${days}`, reloadKey, onLoaded);
  const [bugFocus, setBugFocus] = useState(0);

  if (loading && !summary) return <p style={s.muted}>Loading analytics…</p>;
  if (error) return <div style={s.error}>{error}</div>;
  if (!summary) return null;

  const ov = summary.overview;
  const topApps = summary.topApps || [];
  const topUsers = summary.topUsers || [];
  const maxApp = Math.max(0, ...topApps.map((a) => num(a.launches)));
  const maxUser = Math.max(0, ...topUsers.map((u) => num(u.launches)));
  const openBugs = summary.bugCounts?.open ?? 0;

  const kpis = [
    { key: 'users', label: 'Active users', value: fmtNum(ov.active_users), caption: 'Signed in or opened an app', cta: 'See who →', accent: 'var(--color-action-blue)', onClick: () => open({ type: 'activeUsers', order: 'launches' }) },
    { key: 'opens', label: 'App opens', value: fmtNum(ov.total_launches), caption: 'Apps launched from the Hub', cta: 'See every open →', accent: '#7C3AED', onClick: () => open({ type: 'launches' }) },
    { key: 'sessions', label: 'Hub sessions', value: fmtNum(ov.total_sessions), caption: 'Continuous visits to the Hub', cta: 'See sessions →', accent: '#0891B2', onClick: () => open({ type: 'sessions', sort: 'recent' }) },
    { key: 'avg', label: 'Avg session', value: fmtMinutes(ov.avg_session_minutes), caption: 'Average time per visit', cta: 'Longest sessions →', accent: '#059669', onClick: () => open({ type: 'sessions', sort: 'longest' }) },
    { key: 'time', label: 'Total time in Hub', value: fmtMinutes(ov.total_minutes), caption: 'Across all users', cta: 'Time by user →', accent: '#D97706', onClick: () => open({ type: 'activeUsers', order: 'minutes' }) },
    { key: 'bugs', label: 'Open bug reports', value: fmtNum(openBugs), caption: `${fmtNum(summary.bugCounts?.client_errors)} auto-captured errors total`, cta: 'Review →', accent: 'var(--color-brand-red)', danger: openBugs > 0, onClick: () => setBugFocus((n) => n + 1) },
  ];

  return (
    <>
      <KpiGrid items={kpis} />
      <SentinelCard scope="hub" scopeName="Downstream Hub" days={days} />
      <DayChart
        title="App opens per day"
        rows={summary.launchesByDay}
        days={days}
        field="launches"
        noun="open"
        emptyText={`No app opens in the last ${days} days yet.`}
        onBarClick={(day) => open({ type: 'launches', day })}
      />
      <div style={s.twoCol}>
        <div style={s.panel}>
          <div style={s.panelHead}>
            <h3 style={s.h3}>Most-opened applications</h3>
            {topApps.length > 0 && <Link onClick={() => open({ type: 'launches' })}>All opens →</Link>}
          </div>
          {topApps.length === 0 ? <Empty>No app opens in this period.</Empty> : (
            <table style={s.table}>
              <thead><tr><th style={{ ...s.th, width: 28 }}>#</th><th style={s.th}>Application</th><th style={s.thR}>Opens</th><th style={s.thR}>Users</th><th style={{ ...s.th, width: '28%' }} /></tr></thead>
              <tbody>
                {topApps.map((a, i) => (
                  <tr key={a.id} {...rowProps(() => onSelectScope(a.id))}>
                    <td style={{ ...s.td, color: 'var(--color-text-steel)' }}>{i + 1}</td>
                    <td style={s.td}><strong>{a.name}</strong></td>
                    <td style={s.tdR}><Link title="See every open of this app" onClick={() => open({ type: 'launches', appId: a.id, appName: a.name })}>{fmtNum(a.launches)}</Link></td>
                    <td style={s.tdR}><Link title="See who opens this app" onClick={() => open({ type: 'app', appId: a.id, appName: a.name })}>{fmtNum(a.unique_users)}</Link></td>
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
      <BugSection scope="hub" reloadKey={reloadKey} onOpen={open} onChanged={onBugsChanged} focusSignal={bugFocus} onSelectScope={onSelectScope} />
    </>
  );
}

/* ---------- scope: one application ---------- */

function AppView({ appId, days, reloadKey, open, onLoaded, onBugsChanged, onSelectScope }) {
  const { data, loading, error } = useApi(`/api/analytics/apps/${appId}/usage?days=${days}`, reloadKey, onLoaded);
  const [bugFocus, setBugFocus] = useState(0);

  if (loading && !data) return <p style={s.muted}>Loading analytics…</p>;
  if (error) {
    return (
      <div style={s.error}>
        {error} <Link onClick={() => onSelectScope('overview')}>Back to all applications</Link>
      </div>
    );
  }
  if (!data) return null;

  const { app, kpi } = data;
  const ctx = { appId: app.id, appName: app.name };
  const st = sdkState(app);
  const topPages = data.topPages || [];
  const topUsers = data.topUsers || [];
  const topEvents = data.topEvents || [];
  const maxPage = Math.max(0, ...topPages.map((p) => num(p.views)));
  const maxUser = Math.max(0, ...topUsers.map((u) => num(u.minutes)));

  const kpis = [
    { key: 'users', label: 'Active users', value: fmtNum(kpi.active_users), caption: kpi.anonymous_sessions ? `${plural(kpi.anonymous_sessions, 'anonymous session')}` : 'People who used the app', cta: 'See who →', accent: 'var(--color-action-blue)', onClick: () => open({ type: 'appUsers', ...ctx }) },
    { key: 'sessions', label: 'Sessions', value: fmtNum(kpi.sessions), caption: 'Visits to the app', cta: 'See sessions →', accent: '#0891B2', onClick: () => open({ type: 'appSessions', ...ctx }) },
    { key: 'avg', label: 'Avg session', value: fmtMinutes(kpi.avg_session_minutes), caption: 'On-screen time per visit', cta: 'Longest sessions →', accent: '#059669', onClick: () => open({ type: 'appSessions', sort: 'longest', ...ctx }) },
    { key: 'time', label: 'Time in app', value: fmtMinutes(kpi.total_minutes), caption: 'Across all users', cta: 'Time by user →', accent: '#D97706', onClick: () => open({ type: 'appUsers', ...ctx }) },
    { key: 'pages', label: 'Page views', value: fmtNum(kpi.page_views), caption: 'Screens visited', cta: 'See page views →', accent: '#7C3AED', onClick: () => open({ type: 'appPages', ...ctx }) },
    { key: 'bugs', label: 'Open bug reports', value: fmtNum(kpi.open_bugs), caption: `${plural(kpi.errors, 'JS error')} in this period`, cta: 'Review →', accent: 'var(--color-brand-red)', danger: num(kpi.open_bugs) > 0, onClick: () => setBugFocus((n) => n + 1) },
  ];

  return (
    <>
      <div style={s.appHead}>
        <AppIcon app={app} size={44} />
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <h3 style={{ ...s.h3, fontSize: 'var(--text-h3)' }}>{app.name}</h3>
            <Pill tone={st.tone}>{st.label}</Pill>
          </div>
          <div style={s.subtle}>
            {num(kpi.launches) > 0
              ? <>Opened <Link onClick={() => open({ type: 'launches', ...ctx })}>{plural(kpi.launches, 'time')}</Link> from the Hub in this period</>
              : 'Not opened from the Hub in this period'}
            {app.target_url && <> · <a href={app.target_url} target="_blank" rel="noopener noreferrer" style={s.ext}>{app.target_url}</a></>}
          </div>
        </div>
      </div>

      {!app.sdk_last_seen && (
        <div style={s.banner}>
          <strong>This application is not sending usage data yet.</strong>{' '}
          Add the Hub SDK to it: go to <RouterLink to="/admin/applications" style={s.ext}>Applications</RouterLink>, find <strong>{app.name}</strong> and click <strong>SDK</strong> to copy the snippet.
          Opens from the Hub and bug reports from the Hub still appear below.
        </div>
      )}

      <KpiGrid items={kpis} />

      <SentinelCard scope={app.id} scopeName={app.name} days={days} />

      <DayChart
        title="Page views per day"
        rows={data.pageViewsByDay}
        days={days}
        field="value"
        noun="page view"
        color="#0891B2"
        emptyText={`No page views in the last ${days} days.`}
        onBarClick={(day) => open({ type: 'appPages', ...ctx, day })}
      />

      <div style={s.twoCol}>
        <div style={s.panel}>
          <div style={s.panelHead}>
            <h3 style={s.h3}>Most-viewed pages</h3>
            {topPages.length > 0 && <Link onClick={() => open({ type: 'appPages', ...ctx })}>All page views →</Link>}
          </div>
          {topPages.length === 0 ? <Empty>No page views in this period.</Empty> : (
            <table style={s.table}>
              <thead><tr><th style={s.th}>Page</th><th style={s.thR}>Views</th><th style={s.thR}>Visitors</th><th style={{ ...s.th, width: '24%' }} /></tr></thead>
              <tbody>
                {topPages.map((p) => (
                  <tr key={p.path} {...rowProps(() => open({ type: 'appPages', ...ctx, path: p.path }))}>
                    <td style={s.td}><code style={s.code}>{p.path}</code>{p.title && <div style={s.subtle}>{p.title}</div>}</td>
                    <td style={s.tdR}><strong>{fmtNum(p.views)}</strong></td>
                    <td style={s.tdR}>{fmtNum(p.visitors)}</td>
                    <td style={s.td}><ShareBar value={p.views} max={maxPage} color="#0891B2" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div style={s.panel}>
          <div style={s.panelHead}>
            <h3 style={s.h3}>Most active users</h3>
            {topUsers.length > 0 && <Link onClick={() => open({ type: 'appUsers', ...ctx })}>All users →</Link>}
          </div>
          {topUsers.length === 0 ? <Empty>No identified users in this period.</Empty> : (
            <table style={s.table}>
              <thead><tr><th style={s.th}>User</th><th style={s.thR}>Sessions</th><th style={s.thR}>Time</th><th style={s.thR}>Pages</th><th style={{ ...s.th, width: '20%' }} /></tr></thead>
              <tbody>
                {topUsers.map((u) => {
                  const who = { userId: u.user_id || undefined, email: u.user_id ? undefined : u.email, who: u.email };
                  return (
                    <tr key={u.user_id || u.email} {...rowProps(() => open({ type: 'appUser', ...ctx, ...who }))}>
                      <td style={s.td}><strong>{u.email}</strong>{u.department && <div style={s.subtle}>{u.department}</div>}</td>
                      <td style={s.tdR}><Link onClick={() => open({ type: 'appSessions', ...ctx, ...who })}>{fmtNum(u.sessions)}</Link></td>
                      <td style={s.tdR}><Link onClick={() => open({ type: 'appSessions', sort: 'longest', ...ctx, ...who })}>{fmtMinutes(u.minutes)}</Link></td>
                      <td style={s.tdR}><Link onClick={() => open({ type: 'appPages', ...ctx, ...who })}>{fmtNum(u.page_views)}</Link></td>
                      <td style={s.td}><ShareBar value={u.minutes} max={maxUser} color="#0891B2" /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {topEvents.length > 0 && (
        <div style={s.panel}>
          <div style={s.panelHead}>
            <h3 style={s.h3}>Tracked actions</h3>
            <span style={s.muted}>Sent by the app with <code style={s.code}>DwsHub.track(…)</code></span>
          </div>
          <table style={s.table}>
            <thead><tr><th style={s.th}>Action</th><th style={s.thR}>Count</th><th style={s.thR}>Users</th></tr></thead>
            <tbody>
              {topEvents.map((e) => (
                <tr key={e.name}>
                  <td style={s.td}><code style={s.code}>{e.name}</code></td>
                  <td style={s.tdR}><strong>{fmtNum(e.count)}</strong></td>
                  <td style={s.tdR}>{fmtNum(e.users)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <BugSection scope={app.id} reloadKey={reloadKey} onOpen={open} onChanged={onBugsChanged} focusSignal={bugFocus} onSelectScope={onSelectScope} />
    </>
  );
}

/* ---------- shell: scope navigation, period, refresh, drill-down stack ---------- */

export default function AnalyticsPanel() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawScope = searchParams.get('view') || 'overview';
  const scope = rawScope === 'hub' || UUID_RE.test(rawScope) ? rawScope : 'overview';
  const [days, setDays] = useState(30);
  const [reloadKey, setReloadKey] = useState(0);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [apps, setApps] = useState([]);
  const [stack, setStack] = useState([]);

  useEffect(() => {
    apiRequest('/api/applications')
      .then((d) => setApps((d.applications || []).map((a) => ({ id: a.id, name: a.name })).sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => setApps([]));
  }, []);

  const selectScope = useCallback((next) => {
    setStack([]);
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      if (!next || next === 'overview') params.delete('view');
      else params.set('view', next);
      return params;
    });
  }, [setSearchParams]);

  const open = useCallback((view) => setStack([view]), []);
  const push = useCallback((view) => setStack((st) => [...st, view]), []);
  const back = useCallback(() => setStack((st) => st.slice(0, -1)), []);
  const close = useCallback(() => setStack([]), []);
  const refresh = useCallback(() => setReloadKey((k) => k + 1), []);
  const onLoaded = useCallback(() => setUpdatedAt(new Date()), []);

  const onBugChanged = useCallback((report) => {
    // keep the open detail view in sync, then refresh lists + counters
    setStack((st) => st.map((v) => (v.type === 'bug' && v.report.id === report.id ? { ...v, report } : v)));
    setReloadKey((k) => k + 1);
  }, []);

  const scopeName = scope === 'overview' ? null : scope === 'hub' ? 'Downstream Hub' : (apps.find((a) => a.id === scope)?.name || 'Application');
  const subtitle = scope === 'overview'
    ? 'Usage across every application that embeds the Hub SDK, plus the Hub itself. Click an application to drill in.'
    : scope === 'hub'
      ? 'How people use the Downstream Hub portal itself. Click any number to see the details behind it.'
      : 'In-app usage reported by the Hub SDK. Click any number to see the details behind it.';
  const viewProps = { days, reloadKey, open, onLoaded, onBugsChanged: refresh, onSelectScope: selectScope };

  return (
    <section style={s.wrap}>
      <div style={s.header}>
        <div style={{ minWidth: 0 }}>
          <nav aria-label="Breadcrumb" style={s.crumbs}>
            {scope === 'overview' ? <span>All applications</span> : (
              <>
                <button type="button" className="an-link" onClick={() => selectScope('overview')}>All applications</button>
                <span aria-hidden="true">›</span>
                <span aria-current="page">{scopeName}</span>
              </>
            )}
          </nav>
          <h2 style={s.title}>{scopeName ? `Analytic · ${scopeName}` : 'Analytic'}</h2>
          <p style={s.subtitle}>
            {subtitle}
            {updatedAt && <span style={s.updated}> Updated {updatedAt.toLocaleTimeString()}.</span>}
          </p>
        </div>
        <div style={s.controls}>
          <select
            className="form-input"
            style={s.scopeSelect}
            value={scope}
            onChange={(e) => selectScope(e.target.value)}
            aria-label="Choose what to analyse"
          >
            <option value="overview">All applications</option>
            <option value="hub">Downstream Hub</option>
            {apps.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <div role="group" aria-label="Period" style={{ display: 'flex' }}>
            {PERIODS.map((p) => (
              <button key={p} type="button" className="an-seg" aria-pressed={days === p} onClick={() => setDays(p)}>
                {p} days
              </button>
            ))}
          </div>
          <button type="button" className="btn-secondary" onClick={refresh}>Refresh</button>
        </div>
      </div>

      {scope === 'overview' && <OverviewView {...viewProps} />}
      {scope === 'hub' && <HubView {...viewProps} />}
      {scope !== 'overview' && scope !== 'hub' && <AppView key={scope} appId={scope} {...viewProps} />}

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
  crumbs: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--text-small)', color: 'var(--color-text-steel)', marginBottom: 'var(--space-1)' },
  controls: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' },
  scopeSelect: { width: 'auto', minWidth: 220, maxWidth: 320 },
  title: { margin: 0, fontSize: 'var(--text-h2)', fontFamily: 'var(--font-heading)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-charcoal)' },
  subtitle: { margin: 'var(--space-1) 0 0', fontSize: 'var(--text-small)', color: 'var(--color-text-steel)' },
  updated: { color: 'var(--color-text-steel)', opacity: 0.8 },
  error: { padding: 'var(--space-3)', background: '#FEE2E2', color: 'var(--color-destructive)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-small)' },
  banner: { padding: 'var(--space-3) var(--space-4)', background: '#FEF3C7', color: '#78350F', border: '1px solid #FCD34D', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-small)', lineHeight: 1.6 },
  muted: { color: 'var(--color-text-steel)', fontSize: 'var(--text-small)', margin: 0 },
  empty: { color: 'var(--color-text-steel)', fontSize: 'var(--text-small)', margin: 'var(--space-3) 0' },
  caption: { color: 'var(--color-text-steel)', fontSize: 'var(--text-small)', margin: '0 0 var(--space-3)' },
  subtle: { fontSize: 'var(--text-xs)', color: 'var(--color-text-steel)', marginTop: 2, wordBreak: 'break-all' },
  code: { fontFamily: 'Consolas, Menlo, monospace', fontSize: 12, background: 'var(--color-bg-light)', padding: '1px 6px', borderRadius: 4, wordBreak: 'break-all' },

  sortBtn: { color: 'inherit', fontSize: 'inherit', fontWeight: 'inherit', textTransform: 'inherit', letterSpacing: 'inherit' },
  appHead: { display: 'flex', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-3) var(--space-4)', background: 'var(--color-bg-white)', border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)' },
  appCell: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)' },
  iconFallback: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: '#A84335', color: '#fff', fontWeight: 700, letterSpacing: '0.03em' },

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
