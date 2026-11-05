import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { apiRequest } from '../api';
import { applicationInitials } from '../utils/applicationInitials';
import { resolveIconSrc } from '../utils/resolveIconSrc';
import SsoBadge from '../components/SsoBadge';
import ThemeToggle from '../components/ThemeToggle';
import { Icon } from '../components/HubIcons';

const OTHER = 'other';
const MAX_ORBIT = 8;
const MAX_RECENT = 4;

/* Group colour slots, in the admin's group order. The last slot is for ungrouped apps. */
const PALETTE = [
  { tile: 'var(--hub-tile-ops)', dot: '#E0483D', glow: 'rgba(210,63,53,0.85)' },
  { tile: 'var(--hub-tile-com)', dot: '#F5A623', glow: 'rgba(245,166,35,0.75)' },
  { tile: 'var(--hub-tile-ppl)', dot: '#2DD4BF', glow: 'rgba(45,212,191,0.7)' },
  { tile: 'var(--hub-tile-it)', dot: '#7AA2F7', glow: 'rgba(122,162,247,0.75)' },
  { tile: 'var(--hub-tile-violet)', dot: '#A78BFA', glow: 'rgba(167,139,250,0.75)' },
];
const NEUTRAL = { tile: 'var(--hub-tile-slate)', dot: '#9CA3AF', glow: 'rgba(156,163,175,0.6)' };

function readList(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function saveList(key, list) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* storage unavailable — keep in memory only */
  }
}

/** "jerry.hakim@energi-up.com" → "Jerry" */
function firstNameFromEmail(email) {
  const local = String(email || '').split('@')[0];
  const first = local.split(/[._-]+/).find(Boolean) || '';
  return first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : '';
}

function greetingFor(date) {
  const h = date.getHours();
  if (h < 5) return 'Working late';
  if (h < 11) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  if (h < 22) return 'Good evening';
  return 'Working late';
}

function useNow(intervalMs) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** App icon: the uploaded image when there is one, else initials on the group's colour. */
function AppTile({ app, size = 48, radius = 14, fontSize = 14 }) {
  const src = resolveIconSrc(app.icon_url);
  const base = {
    width: size,
    height: size,
    flexShrink: 0,
    borderRadius: radius,
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: `0 10px 26px -12px ${app.color.glow}, inset 0 1px 0 rgba(255,255,255,0.18)`,
  };
  if (src) {
    return (
      <span style={{ ...base, background: 'var(--color-bg-white)' }}>
        <img src={src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </span>
    );
  }
  return (
    <span aria-hidden="true" style={{ ...base, background: app.color.tile, color: '#FFFFFF', fontWeight: 700, fontSize, letterSpacing: '0.02em', fontFamily: 'var(--font-primary)' }}>
      {applicationInitials(app.name)}
    </span>
  );
}

function AccountMenu({ user, onSignOut }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const initials = applicationInitials(String(user?.email || '').split('@')[0].replace(/[._-]+/g, ' ')).slice(0, 2);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="hub-icon-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} style={{ height: 48, padding: '0 8px 0 6px', gap: 10, color: 'var(--color-text-charcoal)' }}>
        <span style={s.avatarRing}>
          <span style={s.avatar}>{initials}</span>
        </span>
        <span className="hub-hide-sm" style={s.accountText}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{firstNameFromEmail(user?.email) || 'Account'}</span>
          <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{user?.business_unit_name || user?.email}</span>
        </span>
        <Icon name="chevronDown" size={16} style={{ color: 'var(--color-text-muted)' }} />
      </button>
      {open && (
        <div role="menu" className="hub-glass hub-rise" style={s.menu}>
          <div style={s.menuHead}>
            <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--color-text-charcoal)', overflowWrap: 'anywhere' }}>{user?.email}</span>
            {user?.business_unit_name && <span style={{ fontSize: 12, color: 'var(--color-text-steel)' }}>Department: {user.business_unit_name}</span>}
          </div>
          <Link role="menuitem" to="/change-password" className="hub-menu-item" style={s.menuItem} onClick={() => setOpen(false)}>
            <Icon name="key" size={17} /> Change password
          </Link>
          <button role="menuitem" type="button" className="hub-menu-item" style={s.menuItem} onClick={onSignOut}>
            <Icon name="logout" size={17} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function Orbit({ apps, onOpen, disabled }) {
  const n = apps.length;
  const C = 230;
  const nodes = apps.map((app, i) => {
    const deg = -90 + (360 / Math.max(n, 1)) * i + (n % 2 ? 0 : 22);
    const r = i % 2 ? 150 : 196;
    const rad = (deg * Math.PI) / 180;
    return { app, deg, len: r - 40, x: Math.round(C + r * Math.cos(rad) - 48), y: Math.round(C + r * Math.sin(rad) - 30), delay: `${(i * 0.7).toFixed(1)}s` };
  });
  return (
    <div style={{ position: 'relative', width: 460, height: 460, marginBottom: 28 }}>
      <div className="hub-ring-a" aria-hidden="true" style={{ ...s.ring, width: 450, height: 450, border: '1px dashed var(--hub-ring)' }} />
      <div className="hub-ring-b" aria-hidden="true" style={{ ...s.ring, width: 340, height: 340, border: '1px solid var(--hub-ring)', borderTopColor: 'var(--hub-ring-accent)' }} />
      <div className="hub-ring-c" aria-hidden="true" style={{ ...s.ring, width: 220, height: 220, border: '1px dashed rgba(217,49,79,0.35)' }} />
      {nodes.map((nd) => (
        <div key={`beam-${nd.app.id}`} className="hub-beam" aria-hidden="true" style={{ position: 'absolute', left: C, top: C, width: nd.len, height: 1, transformOrigin: '0 50%', transform: `rotate(${nd.deg}deg)`, background: 'linear-gradient(90deg, rgba(245,166,35,0.65), rgba(217,49,79,0.04))', animationDelay: nd.delay }} />
      ))}
      <div className="hub-core" style={s.core}>
        <img src="/logo.png" alt="" style={{ width: 44, height: 44, objectFit: 'contain' }} />
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.16em', color: 'var(--color-text-muted)' }}>HUB</span>
      </div>
      {nodes.map((nd) => (
        <div key={nd.app.id} className="hub-node" style={{ position: 'absolute', left: nd.x, top: nd.y, width: 96, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, animationDelay: nd.delay }}>
          <button type="button" className="hub-node-btn hub-glass" onClick={() => onOpen(nd.app)} disabled={disabled} aria-label={`Open ${nd.app.name}`} style={s.nodeBtn}>
            <AppTile app={nd.app} size={44} radius={13} fontSize={13} />
          </button>
          <span style={s.nodeLabel}>{nd.app.name}</span>
        </div>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const { user, logout } = useAuth();
  const [applications, setApplications] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [redirecting, setRedirecting] = useState(null);
  const [launching, setLaunching] = useState(null);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState('all');
  const pinKey = `hub.pinned.${user?.id ?? 'me'}`;
  const recentKey = `hub.recent.${user?.id ?? 'me'}`;
  const [pinned, setPinned] = useState(() => readList(pinKey) || []);
  const [recent, setRecent] = useState(() => readList(recentKey) || []);
  const searchRef = useRef(null);
  const toastTimer = useRef(null);
  const now = useNow(15000);

  useEffect(() => {
    apiRequest('/api/applications/for-me')
      .then((data) => {
        setApplications(data.applications || []);
        setGroups(data.groups || []);
      })
      .catch((err) => setError(err.error || 'Failed to load applications'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // Ctrl/Cmd+K or "/" jumps to the search box.
  useEffect(() => {
    function onKey(e) {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName) || e.target?.isContentEditable;
      if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Each app carries its group's colour.
  const apps = useMemo(() => {
    const slot = new Map(groups.map((g, i) => [g.id, PALETTE[i % PALETTE.length]]));
    return applications.map((a) => ({ ...a, color: slot.get(a.group_id) || NEUTRAL }));
  }, [applications, groups]);

  const byId = useMemo(() => new Map(apps.map((a) => [a.id, a])), [apps]);

  // Sections in the admin's order; apps arrive already ordered within each group.
  const allSections = useMemo(() => {
    const known = new Set(groups.map((g) => g.id));
    const list = groups.map((g, i) => ({ key: g.id, name: g.name, dot: PALETTE[i % PALETTE.length].dot, apps: apps.filter((a) => a.group_id === g.id) }));
    list.push({ key: OTHER, name: groups.length ? 'Other applications' : 'Applications', dot: NEUTRAL.dot, apps: apps.filter((a) => !a.group_id || !known.has(a.group_id)) });
    return list.filter((sec) => sec.apps.length > 0);
  }, [apps, groups]);

  const q = query.trim().toLowerCase();
  const sections = useMemo(() => {
    const match = (a) => !q || a.name.toLowerCase().includes(q) || (a.description || '').toLowerCase().includes(q);
    return allSections
      .filter((sec) => tab === 'all' || sec.key === tab)
      .map((sec) => ({ ...sec, apps: sec.apps.filter((a) => match(a) || (q && sec.name.toLowerCase().includes(q))) }))
      .filter((sec) => sec.apps.length > 0);
  }, [allSections, tab, q]);

  const shown = sections.reduce((n, sec) => n + sec.apps.length, 0);
  const pinnedApps = pinned.map((id) => byId.get(id)).filter(Boolean);
  const recentApps = recent.map((id) => byId.get(id)).filter(Boolean);
  const orbitApps = (pinnedApps.length ? pinnedApps : recentApps.length ? recentApps : apps).slice(0, MAX_ORBIT);
  const orbitIsSuggested = pinnedApps.length === 0;

  const togglePin = useCallback((id) => {
    setPinned((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id].slice(-MAX_ORBIT);
      saveList(pinKey, next);
      return next;
    });
  }, [pinKey]);

  async function handleAppClick(app) {
    setRedirecting(app.id);
    setError('');
    setLaunching(app.name);
    clearTimeout(toastTimer.current);
    setRecent((prev) => {
      const next = [app.id, ...prev.filter((x) => x !== app.id)].slice(0, MAX_RECENT);
      saveList(recentKey, next);
      return next;
    });
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
      toastTimer.current = setTimeout(() => setLaunching(null), 1800);
    } catch (err) {
      setLaunching(null);
      if (err.code === 'EMAIL_VERIFICATION_REQUIRED' || err.code === 'APP_VERIFICATION_REQUIRED') {
        setError(err.error || 'Verification email sent. Check your inbox, then try again.');
      } else {
        setError(err.error || 'Redirect failed');
      }
      setRedirecting(null);
    }
  }

  function onSearchKeyDown(e) {
    if (e.key === 'Enter') {
      const first = sections[0]?.apps[0];
      if (first && q) {
        e.preventDefault();
        handleAppClick(first);
      }
    } else if (e.key === 'Escape') {
      setQuery('');
    }
  }

  const firstName = firstNameFromEmail(user?.email);
  const dateShort = now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const clock = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const tabs = [{ key: 'all', name: 'All', dot: 'var(--color-text-charcoal)', count: apps.length }, ...allSections.map((sec) => ({ key: sec.key, name: sec.name, dot: sec.dot, count: sec.apps.length }))];

  return (
    <div className="hub-backdrop" style={{ fontSize: 15, lineHeight: 1.5 }}>
      <header style={s.header}>
        <div style={s.headerInner}>
          <Link to="/" style={s.brand}>
            <img src="/logo.png" alt="" width={34} height={34} style={{ objectFit: 'contain', filter: 'drop-shadow(0 0 10px rgba(232,116,58,0.55))' }} />
            <span style={s.brandText}>Downstream Hub</span>
          </Link>
          <div style={{ flexGrow: 1 }} />
          <div className="hub-hide-sm" style={s.sessionPill}>
            <span className="hub-live-dot" style={s.liveDot} />
            Secure session
            <span style={s.pillDivider} />
            <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--color-text-charcoal)', fontWeight: 600 }}>{clock}</span>
          </div>
          <ThemeToggle />
          {user?.role === 'Admin' && (
            <Link to="/admin" className="hub-icon-btn">
              <Icon name="shield" size={18} />
              <span className="hub-hide-sm">Admin</span>
            </Link>
          )}
          <AccountMenu user={user} onSignOut={logout} />
        </div>
      </header>

      <main style={s.main}>
        <section aria-label="Command center" style={s.hero}>
          <div style={s.heroLeft}>
            <span className="hub-kicker">Command center · {dateShort}</span>
            <h1 style={s.h1}>
              {greetingFor(now)}{firstName ? ',' : '.'}
              {firstName && <><br /><span className="hub-grad-text">{firstName}.</span></>}
            </h1>
            <p style={s.lead}>Your whole Downstream toolkit, one secure sign-in away. Launch an app or search to jump straight in.</p>
            <span id="hub-search-hint" style={s.srOnly}>Press Enter to open the first matching application.</span>

            <div className="hub-cmd hub-glass" style={s.cmd}>
              <label htmlFor="hub-search" style={s.srOnly}>Search applications</label>
              <Icon name="search" size={22} style={{ color: 'var(--color-accent)' }} />
              <input
                id="hub-search"
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onSearchKeyDown}
                placeholder="Search apps…"
                aria-describedby="hub-search-hint"
                autoComplete="off"
                style={s.cmdInput}
              />
              <span className="hub-hide-sm" style={{ display: 'flex', gap: 4 }} aria-hidden="true">
                <kbd style={s.kbd}>Ctrl</kbd>
                <kbd style={s.kbd}>K</kbd>
              </span>
            </div>

            {recentApps.length > 0 && (
              <QuickRow label="Recent" apps={recentApps} onOpen={handleAppClick} disabled={!!redirecting} />
            )}
            {/* On narrow screens the orbit is hidden, so pinned apps get a row of their own. */}
            {pinnedApps.length > 0 && (
              <div className="hub-show-md">
                <QuickRow label="Pinned" apps={pinnedApps} onOpen={handleAppClick} disabled={!!redirecting} />
              </div>
            )}
          </div>

          {!loading && orbitApps.length > 0 && (
            <div className="hub-hide-md" style={s.heroRight}>
              <Orbit apps={orbitApps} onOpen={handleAppClick} disabled={!!redirecting} />
              <span style={{ fontSize: 12, color: 'var(--color-text-muted)', textAlign: 'center' }}>
                {orbitIsSuggested ? 'Star apps below to build your own orbit' : 'Your pinned apps · star any app to add it'}
              </span>
            </div>
          )}
        </section>

        <section aria-label="At a glance" style={s.stats}>
          <Stat label="Apps available" value={loading ? '—' : apps.length} />
          <Stat label="In your orbit" value={pinnedApps.length} accent />
          <Stat label="Groups" value={loading ? '—' : allSections.length} />
          <Stat label="Local time" value={clock} />
        </section>

        <section aria-labelledby="launch-pad" style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          <div style={s.launchHead}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <h2 id="launch-pad" style={s.h2}>Launch pad</h2>
              <span style={{ fontSize: 14, color: 'var(--color-text-steel)' }} aria-live="polite">
                {loading ? 'Loading your applications…' : shown === apps.length ? `${apps.length} application${apps.length === 1 ? '' : 's'} ready for launch` : `Showing ${shown} of ${apps.length} applications`}
              </span>
            </div>
            {tabs.length > 2 && (
              <nav aria-label="Filter by group" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {tabs.map((t) => {
                  const on = tab === t.key;
                  return (
                    <button key={t.key} type="button" aria-pressed={on} onClick={() => setTab(t.key)} className="hub-chip" style={{ ...s.tab, ...(on ? s.tabOn : null) }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: t.dot, boxShadow: `0 0 10px ${t.dot}` }} />
                      {t.name}
                      <span style={{ fontSize: 12, fontWeight: 600, color: on ? 'var(--color-accent)' : 'var(--color-text-muted)' }}>{t.count}</span>
                    </button>
                  );
                })}
              </nav>
            )}
          </div>

          {error && (
            <div role="alert" style={s.error}>
              <Icon name="alert" size={18} />
              <span style={{ flex: 1 }}>{error}</span>
              <button type="button" className="hub-icon-btn" aria-label="Dismiss message" onClick={() => setError('')} style={{ color: 'inherit', minWidth: 36, height: 36, padding: 0 }}>
                <Icon name="x" size={16} />
              </button>
            </div>
          )}

          {loading ? (
            <div style={s.grid}>
              {Array.from({ length: 8 }).map((_, i) => <div key={i} className="hub-skeleton" style={{ height: 78, borderRadius: 18 }} />)}
            </div>
          ) : apps.length === 0 ? (
            <div className="hub-glass" style={s.empty}>
              <p style={{ margin: 0, fontWeight: 600, fontSize: 17 }}>No applications yet</p>
              <p style={{ margin: 0, fontSize: 14, color: 'var(--color-text-steel)' }}>
                {user?.role === 'Admin' ? <>Add some in <Link to="/admin/applications">Admin › Applications</Link>.</> : 'Ask your Hub admin to give you access.'}
              </p>
            </div>
          ) : shown === 0 ? (
            <div className="hub-glass" style={s.empty}>
              <p style={{ margin: 0, fontWeight: 600, fontSize: 17 }}>No application matches “{query.trim()}”</p>
              <p style={{ margin: 0, fontSize: 14, color: 'var(--color-text-steel)' }}>Check the spelling, or ask your Hub admin for access.</p>
              <button type="button" className="hub-chip" onClick={() => { setQuery(''); setTab('all'); }} style={s.clearBtn}>Clear search</button>
            </div>
          ) : (
            sections.map((sec) => (
              <div key={sec.key} id={`apps-${sec.key}`} style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 6 }}>
                {(allSections.length > 1 || groups.length > 0) && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <h3 style={s.sectionTitle}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: sec.dot }} />
                      {sec.name}
                    </h3>
                    <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{sec.apps.length}</span>
                    <span style={s.rule} />
                  </div>
                )}
                <div style={s.grid}>
                  {sec.apps.map((app) => {
                    const isPinned = pinned.includes(app.id);
                    const opening = redirecting === app.id;
                    return (
                      <div key={app.id} className="hub-card" style={s.card} title={app.description ? `${app.name} — ${app.description}` : app.name}>
                        <button type="button" onClick={() => handleAppClick(app)} disabled={!!redirecting} style={s.cardOpen}>
                          <AppTile app={app} size={50} radius={15} fontSize={app.name.split(/\s+/).length > 2 ? 13 : 15} />
                          <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                              <span style={s.cardName}>{app.name}</span>
                              <Icon name="arrowUpRight" size={15} strokeWidth={2.4} className="hub-go" style={{ color: 'var(--color-accent)' }} />
                            </span>
                            {opening ? (
                              <span style={{ fontSize: 13, color: 'var(--color-accent)', fontWeight: 500 }}>Opening…</span>
                            ) : (
                              <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                                <SsoBadge ssoMode={app.sso_mode} style={{ flexShrink: 0, padding: '0 6px', fontSize: 11 }} />
                                <span style={s.cardDesc}>{app.description || ''}</span>
                              </span>
                            )}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="hub-pin"
                          aria-label={isPinned ? `Remove ${app.name} from your orbit` : `Add ${app.name} to your orbit`}
                          aria-pressed={isPinned}
                          onClick={() => togglePin(app.id)}
                          style={s.pinBtn}
                        >
                          <Icon
                            name="star"
                            size={20}
                            fill={isPinned ? '#F5A623' : 'none'}
                            style={{ color: isPinned ? '#E8950F' : 'var(--color-text-muted)', filter: isPinned ? 'drop-shadow(0 0 6px rgba(245,166,35,0.7))' : 'none' }}
                          />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </section>

        <footer style={s.footer}>
          <span>Can’t find an app you need? Ask your Hub admin for access.</span>
          <span className="hub-hide-sm">Tip: press <kbd style={s.kbd}>/</kbd> to search from anywhere on this page.</span>
        </footer>
      </main>

      {launching && (
        <div role="status" className="hub-glass" style={s.toast}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>Launching {launching}</span>
          <span style={{ fontSize: 12, color: 'var(--color-text-steel)' }}>Secure handoff · opens in a new tab</span>
          <span className="hub-toast-bar" style={s.toastBar} />
        </div>
      )}
    </div>
  );
}

function QuickRow({ label, apps, onOpen, disabled }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <span className="hub-label" style={{ marginRight: 6 }}>{label}</span>
      {apps.map((app) => (
        <button key={app.id} type="button" className="hub-chip" onClick={() => onOpen(app)} disabled={disabled} style={s.recentChip}>
          <AppTile app={app} size={26} radius={8} fontSize={10} />
          {app.name}
        </button>
      ))}
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div className="hub-glass" style={s.stat}>
      <span className="hub-label">{label}</span>
      <span style={{ ...s.statValue, color: accent ? 'var(--color-accent)' : 'var(--color-text-charcoal)' }}>{value}</span>
    </div>
  );
}

const s = {
  header: { position: 'relative', borderBottom: '1px solid var(--hub-glass-border)' },
  headerInner: { maxWidth: 1360, margin: '0 auto', padding: '0 clamp(16px, 4vw, 40px)', height: 76, display: 'flex', alignItems: 'center', gap: 8 },
  brand: { display: 'flex', alignItems: 'center', gap: 12, color: 'var(--color-text-charcoal)', textDecoration: 'none' },
  brandText: { fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 'clamp(16px, 4vw, 19px)', whiteSpace: 'nowrap' },
  sessionPill: { display: 'flex', alignItems: 'center', gap: 10, height: 36, padding: '0 14px', marginRight: 4, borderRadius: 999, border: '1px solid var(--hub-glass-border)', background: 'var(--hub-glass)', fontSize: 13, color: 'var(--color-text-steel)' },
  liveDot: { width: 8, height: 8, borderRadius: '50%', background: '#2DD4BF' },
  pillDivider: { width: 1, height: 14, background: 'var(--hub-glass-border-strong)' },
  avatarRing: { width: 36, height: 36, borderRadius: '50%', padding: 2, boxSizing: 'border-box', background: 'linear-gradient(135deg, #F5A623, #D9314F)', flexShrink: 0 },
  avatar: { width: '100%', height: '100%', borderRadius: '50%', background: 'var(--hub-core-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 12, color: 'var(--color-text-charcoal)' },
  accountText: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1.25, maxWidth: 200, overflow: 'hidden' },
  menu: { position: 'absolute', right: 0, top: 'calc(100% + 8px)', zIndex: 30, minWidth: 260, padding: 6, borderRadius: 16, background: 'var(--hub-overlay)', boxShadow: 'var(--shadow-lg)' },
  menuHead: { display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 12px 12px', marginBottom: 4, borderBottom: '1px solid var(--hub-glass-border)' },
  menuItem: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', height: 44, padding: '0 12px', border: 0, borderRadius: 10, background: 'none', color: 'var(--color-text-charcoal)', font: 'inherit', fontSize: 14, textAlign: 'left', textDecoration: 'none', cursor: 'pointer' },
  main: { position: 'relative', maxWidth: 1360, margin: '0 auto', padding: '40px clamp(16px, 4vw, 40px) 64px', display: 'flex', flexDirection: 'column', gap: 44 },
  hero: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 40 },
  heroLeft: { flex: '1 1 520px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 22 },
  heroRight: { flex: '0 0 460px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 },
  h1: { margin: 0, fontFamily: 'var(--font-heading)', fontWeight: 900, fontSize: 'clamp(36px, 5vw, 60px)', lineHeight: 1.08, letterSpacing: '-0.02em', color: 'var(--color-text-charcoal)' },
  lead: { margin: 0, fontSize: 18, color: 'var(--color-text-steel)', maxWidth: 520 },
  cmd: { position: 'relative', display: 'flex', alignItems: 'center', gap: 12, height: 64, padding: '0 10px 0 20px', borderRadius: 18, maxWidth: 620, borderColor: 'var(--hub-glass-border-strong)' },
  cmdInput: { flex: 1, minWidth: 0, height: '100%', border: 0, background: 'transparent', color: 'var(--color-text-charcoal)', font: 'inherit', fontSize: 16 },
  kbd: { padding: '4px 8px', borderRadius: 8, border: '1px solid var(--hub-glass-border-strong)', background: 'var(--hub-glass)', color: 'var(--color-text-steel)', fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-primary)' },
  srOnly: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' },
  recentChip: { display: 'inline-flex', alignItems: 'center', gap: 8, height: 38, padding: '0 14px 0 6px', borderRadius: 999, border: '1px solid var(--hub-glass-border)', background: 'var(--hub-glass)', color: 'var(--color-text-charcoal)', font: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer' },
  ring: { position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', borderRadius: '50%' },
  core: { position: 'absolute', left: '50%', top: '50%', width: 112, height: 112, transform: 'translate(-50%, -50%)', borderRadius: '50%', background: 'var(--hub-core-bg)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4 },
  nodeBtn: { width: 60, height: 60, padding: 0, borderRadius: 18, borderColor: 'var(--hub-glass-border-strong)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' },
  nodeLabel: { fontSize: 12, fontWeight: 500, color: 'var(--color-text-steel)', textAlign: 'center', lineHeight: 1.25, maxWidth: 96, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' },
  stats: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 14 },
  stat: { display: 'flex', flexDirection: 'column', gap: 6, padding: '18px 20px', borderRadius: 18 },
  statValue: { fontFamily: 'var(--font-heading)', fontSize: 30, fontWeight: 700, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' },
  launchHead: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 },
  h2: { margin: 0, fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 28, letterSpacing: '-0.01em', color: 'var(--color-text-charcoal)' },
  tab: { display: 'inline-flex', alignItems: 'center', gap: 8, height: 44, padding: '0 16px', borderRadius: 999, border: '1px solid var(--hub-glass-border)', background: 'var(--hub-glass)', color: 'var(--color-text-steel)', font: 'inherit', fontSize: 14, fontWeight: 500, cursor: 'pointer' },
  tabOn: { background: 'var(--hub-tab-active-bg)', borderColor: 'var(--hub-tab-active-border)', color: 'var(--hub-tab-active-fg)', boxShadow: '0 0 24px -8px rgba(232,116,58,0.6)' },
  sectionTitle: { margin: 0, display: 'flex', alignItems: 'center', gap: 10, fontFamily: 'var(--font-primary)', fontSize: 12, fontWeight: 600, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--color-text-steel)' },
  rule: { flexGrow: 1, height: 1, background: 'linear-gradient(90deg, var(--hub-glass-border-strong), transparent)' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))', gap: 14 },
  card: { display: 'flex', alignItems: 'center', gap: 6, padding: '10px 8px 10px 14px', borderRadius: 18, minWidth: 0 },
  cardOpen: { flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 14, padding: '6px 0', border: 0, background: 'none', font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer' },
  cardName: { fontWeight: 600, fontSize: 15, lineHeight: 1.3, color: 'var(--color-text-charcoal)', overflow: 'hidden', overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' },
  cardDesc: { fontSize: 13, color: 'var(--color-text-steel)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  pinBtn: { flexShrink: 0, width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 0, borderRadius: 12, background: 'none', cursor: 'pointer' },
  error: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 10px 10px 16px', borderRadius: 14, background: 'var(--color-error-bg)', border: '1px solid var(--color-error-border)', color: 'var(--color-error-fg)', fontSize: 14 },
  empty: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '56px 24px', borderRadius: 22, borderStyle: 'dashed', textAlign: 'center', color: 'var(--color-text-charcoal)' },
  clearBtn: { marginTop: 6, height: 44, padding: '0 18px', borderRadius: 12, border: '1px solid var(--hub-glass-border-strong)', background: 'var(--hub-glass)', color: 'var(--color-text-charcoal)', font: 'inherit', fontSize: 14, fontWeight: 500, cursor: 'pointer' },
  footer: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingTop: 20, borderTop: '1px solid var(--hub-glass-border)', fontSize: 13, color: 'var(--color-text-muted)' },
  toast: { position: 'fixed', left: '50%', bottom: 28, transform: 'translateX(-50%)', zIndex: 40, width: 340, maxWidth: 'calc(100% - 32px)', boxSizing: 'border-box', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 4, padding: '14px 18px 16px', borderRadius: 16, background: 'var(--hub-overlay)', borderColor: 'rgba(245,166,35,0.4)', boxShadow: 'var(--shadow-lg), 0 0 40px -10px rgba(232,116,58,0.45)', color: 'var(--color-text-charcoal)' },
  toastBar: { position: 'absolute', left: 0, bottom: 0, height: 3, background: 'linear-gradient(90deg, #F5A623, #D9314F)' },
};
