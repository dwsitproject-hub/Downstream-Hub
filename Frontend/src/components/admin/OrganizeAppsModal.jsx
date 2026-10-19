import { useMemo, useState } from 'react';
import AdminModal from './AdminModal';
import { apiRequest } from '../../api';
import { resolveIconSrc } from '../../utils/resolveIconSrc';
import { applicationInitials } from '../../utils/applicationInitials';

const UNGROUPED = 'ungrouped';
const MAX_NAME = 60;

const bySort = (a, b) => (a.sort_order ?? 1e6) - (b.sort_order ?? 1e6) || a.name.localeCompare(b.name);

function initialLayout(applications, groups) {
  const known = new Set(groups.map((g) => g.id));
  return {
    groups: groups.map((g) => ({
      key: g.id,
      id: g.id,
      name: g.name,
      apps: applications.filter((a) => a.group_id === g.id).sort(bySort).map((a) => a.id),
    })),
    ungrouped: applications.filter((a) => !a.group_id || !known.has(a.group_id)).sort(bySort).map((a) => a.id),
  };
}

function visibilityText(app) {
  const names = Array.isArray(app.target_bu_names) ? app.target_bu_names : [];
  return names.length === 0 ? 'All users' : names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

function AppIcon({ app }) {
  const src = resolveIconSrc(app.icon_url);
  const box = { width: 28, height: 28, borderRadius: 7, flexShrink: 0 };
  return src
    ? <img src={src} alt="" style={{ ...box, objectFit: 'cover', background: 'var(--color-bg-lighter)' }} />
    : <span style={{ ...box, ...s.initials }} aria-hidden="true">{applicationInitials(app.name)}</span>;
}

/**
 * Organize dashboard: put applications into named groups and order the groups and the apps
 * inside them. Nothing is saved until "Save layout"; Cancel discards everything.
 */
export default function OrganizeAppsModal({ applications, groups, onClose, onSaved }) {
  const appsById = useMemo(() => new Map(applications.map((a) => [a.id, a])), [applications]);
  const [start] = useState(() => initialLayout(applications, groups));
  const [layout, setLayout] = useState(start);
  const [newCount, setNewCount] = useState(0);
  const [dragId, setDragId] = useState(null);
  const [dropTarget, setDropTarget] = useState(null); // `${listKey}:${index}`
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const dirty = JSON.stringify(layout) !== JSON.stringify(start);
  const lists = [...layout.groups.map((g) => ({ key: g.key, name: g.name, apps: g.apps, group: g })), { key: UNGROUPED, name: 'Ungrouped', apps: layout.ungrouped }];
  const listOf = (appId) => lists.find((l) => l.apps.includes(appId));

  const nameProblem = useMemo(() => {
    const seen = new Set();
    for (const g of layout.groups) {
      const n = g.name.trim().toLowerCase();
      if (!n) return 'Every group needs a name.';
      if (seen.has(n)) return `There are two groups called "${g.name.trim()}".`;
      seen.add(n);
    }
    return '';
  }, [layout.groups]);

  /* ---------- edits (all pure, on a copy) ---------- */

  function update(fn) {
    setLayout((prev) => {
      const next = { groups: prev.groups.map((g) => ({ ...g, apps: [...g.apps] })), ungrouped: [...prev.ungrouped] };
      fn(next);
      return next;
    });
    setError('');
  }
  const appsOf = (l, key) => (key === UNGROUPED ? l.ungrouped : l.groups.find((g) => g.key === key).apps);

  function moveApp(appId, toKey, toIndex) {
    update((l) => {
      const fromKey = l.ungrouped.includes(appId) ? UNGROUPED : l.groups.find((g) => g.apps.includes(appId)).key;
      const from = appsOf(l, fromKey);
      const fromIndex = from.indexOf(appId);
      from.splice(fromIndex, 1);
      const to = appsOf(l, toKey);
      let at = toIndex === undefined ? to.length : toIndex;
      if (fromKey === toKey && fromIndex < at) at -= 1; // the list shrank above the drop point
      to.splice(Math.max(0, Math.min(at, to.length)), 0, appId);
    });
  }

  function nudgeApp(appId, dir) {
    update((l) => {
      const list = l.ungrouped.includes(appId) ? l.ungrouped : l.groups.find((g) => g.apps.includes(appId)).apps;
      const i = list.indexOf(appId);
      const j = i + dir;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
    });
  }

  function sortAz(key) {
    update((l) => {
      appsOf(l, key).sort((a, b) => appsById.get(a).name.localeCompare(appsById.get(b).name));
    });
  }

  function addGroup() {
    const key = `new-${newCount + 1}`;
    setNewCount((n) => n + 1);
    update((l) => { l.groups.push({ key, id: null, name: '', apps: [] }); });
  }

  function renameGroup(key, name) {
    update((l) => { l.groups.find((g) => g.key === key).name = name.slice(0, MAX_NAME); });
  }

  function moveGroup(key, dir) {
    update((l) => {
      const i = l.groups.findIndex((g) => g.key === key);
      const j = i + dir;
      if (j < 0 || j >= l.groups.length) return;
      [l.groups[i], l.groups[j]] = [l.groups[j], l.groups[i]];
    });
  }

  function removeGroup(key) {
    update((l) => {
      const i = l.groups.findIndex((g) => g.key === key);
      l.ungrouped.push(...l.groups[i].apps);
      l.groups.splice(i, 1);
    });
  }

  /* ---------- drag and drop (mouse); every action also has buttons ---------- */

  const onDragStart = (appId) => (e) => {
    setDragId(appId);
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', appId); } catch { /* some browsers */ }
  };
  const onDragOver = (key, index) => (e) => {
    if (!dragId) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(`${key}:${index}`);
  };
  const onDrop = (key, index) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (dragId) moveApp(dragId, key, index);
    setDragId(null);
    setDropTarget(null);
  };
  const onDragEnd = () => { setDragId(null); setDropTarget(null); };

  /* ---------- save ---------- */

  async function save() {
    if (nameProblem) { setError(nameProblem); return; }
    setSaving(true);
    setError('');
    try {
      const body = {
        groups: layout.groups.map((g) => ({ ...(g.id ? { id: g.id } : {}), name: g.name.trim(), apps: g.apps })),
        ungrouped: layout.ungrouped,
      };
      await apiRequest('/api/app-groups/layout', { method: 'PUT', body: JSON.stringify(body) });
      onSaved();
    } catch (err) {
      setError(err.error || 'Could not save the layout');
      setSaving(false);
    }
  }

  function cancel() {
    if (dirty && !window.confirm('Discard your changes to the dashboard layout?')) return;
    onClose();
  }

  const groupKeys = layout.groups.map((g) => g.key);

  return (
    <AdminModal
      title="Organize dashboard"
      size="xxl"
      onClose={cancel}
      disableClose={saving}
      footer={(
        <div style={s.footer}>
          <span style={s.hint}>
            {error ? <span style={s.error} role="alert">{error}</span>
              : nameProblem ? <span style={s.warn}>{nameProblem}</span>
                : dirty ? 'Unsaved changes. Saving updates every user’s dashboard.' : 'No changes yet.'}
          </span>
          <button type="button" className="btn-secondary" onClick={cancel} disabled={saving}>Cancel</button>
          <button type="button" className="btn-primary" onClick={save} disabled={saving || !dirty || !!nameProblem}>
            {saving ? 'Saving…' : 'Save layout'}
          </button>
        </div>
      )}
    >
      <p style={s.intro}>
        Group applications so people find them faster. Users see the groups in this order, each with the apps they are
        allowed to open; a group with none of their apps is hidden. Drag an app to move it, or use the arrows and
        <em> Move to</em>.
      </p>

      <div style={s.columns}>
        {lists.map((list, li) => {
          const isUngrouped = list.key === UNGROUPED;
          const gi = groupKeys.indexOf(list.key);
          return (
            <section
              key={list.key}
              style={{ ...s.panel, ...(isUngrouped ? s.panelUngrouped : null), ...(dropTarget === `${list.key}:end` ? s.panelDrop : null) }}
              onDragOver={onDragOver(list.key, 'end')}
              onDrop={onDrop(list.key, undefined)}
              aria-label={isUngrouped ? 'Ungrouped applications' : `Group ${list.name || '(unnamed)'}`}
            >
              <div style={s.panelHead}>
                {isUngrouped ? (
                  <div style={s.ungroupedTitle}>Ungrouped <span style={s.count}>{list.apps.length}</span></div>
                ) : (
                  <>
                    <input
                      className="form-input"
                      style={s.nameInput}
                      value={list.group.name}
                      placeholder="Group name, e.g. Logistics"
                      maxLength={MAX_NAME}
                      autoFocus={!list.group.id && list.group.name === ''}
                      onChange={(e) => renameGroup(list.key, e.target.value)}
                      aria-label={`Name of group ${li + 1}`}
                    />
                    <span style={s.count}>{list.apps.length}</span>
                    <button type="button" className="btn-secondary btn-compact" onClick={() => moveGroup(list.key, -1)} disabled={gi === 0} title="Move group up" aria-label="Move group up">↑</button>
                    <button type="button" className="btn-secondary btn-compact" onClick={() => moveGroup(list.key, 1)} disabled={gi === groupKeys.length - 1} title="Move group down" aria-label="Move group down">↓</button>
                  </>
                )}
                <button type="button" className="btn-secondary btn-compact" onClick={() => sortAz(list.key)} disabled={list.apps.length < 2} title="Sort A–Z">A–Z</button>
                {!isUngrouped && (
                  <button type="button" style={s.removeBtn} onClick={() => removeGroup(list.key)} title="Delete group: its apps move to Ungrouped">Delete</button>
                )}
              </div>

              {list.apps.length === 0 ? (
                <div style={s.emptyDrop}>{isUngrouped ? 'Every application is in a group.' : 'Drag apps here, or use “Move to”.'}</div>
              ) : (
                <ol style={s.list}>
                  {list.apps.map((appId, i) => {
                    const app = appsById.get(appId);
                    if (!app) return null;
                    return (
                      <li
                        key={appId}
                        draggable
                        onDragStart={onDragStart(appId)}
                        onDragEnd={onDragEnd}
                        onDragOver={onDragOver(list.key, i)}
                        onDrop={onDrop(list.key, i)}
                        style={{ ...s.row, ...(dragId === appId ? s.rowDragging : null), ...(dropTarget === `${list.key}:${i}` ? s.rowDrop : null) }}
                      >
                        <span style={s.grip} aria-hidden="true">⠿</span>
                        <AppIcon app={app} />
                        <span style={s.appText}>
                          <span style={s.appName}>{app.name}</span>
                          <span style={s.appSub}>{visibilityText(app)}</span>
                        </span>
                        <button type="button" className="btn-secondary btn-compact" onClick={() => nudgeApp(appId, -1)} disabled={i === 0} aria-label={`Move ${app.name} up`}>↑</button>
                        <button type="button" className="btn-secondary btn-compact" onClick={() => nudgeApp(appId, 1)} disabled={i === list.apps.length - 1} aria-label={`Move ${app.name} down`}>↓</button>
                        <select
                          className="form-input"
                          style={s.moveSelect}
                          value=""
                          onChange={(e) => e.target.value && moveApp(appId, e.target.value)}
                          aria-label={`Move ${app.name} to another group`}
                        >
                          <option value="">Move to…</option>
                          {layout.groups.filter((g) => g.key !== list.key).map((g) => (
                            <option key={g.key} value={g.key}>{g.name.trim() || '(unnamed group)'}</option>
                          ))}
                          {!isUngrouped && <option value={UNGROUPED}>Ungrouped</option>}
                        </select>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>
          );
        })}
      </div>

      <button type="button" className="btn-secondary" style={s.addBtn} onClick={addGroup} disabled={layout.groups.length >= 50}>+ Add group</button>
    </AdminModal>
  );
}

const s = {
  intro: { margin: '0 0 var(--space-3)', fontSize: 'var(--text-small)', color: 'var(--color-text-steel)', lineHeight: 1.6 },
  columns: { display: 'grid', gap: 'var(--space-3)' },
  panel: { border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-md)', background: 'var(--color-bg-white)', padding: 'var(--space-3)' },
  panelUngrouped: { background: 'var(--color-bg-lighter)', borderStyle: 'dashed' },
  panelDrop: { outline: '2px dashed var(--color-action-blue)', outlineOffset: 2 },
  panelHead: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-2)', flexWrap: 'wrap' },
  ungroupedTitle: { flex: 1, fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-steel)', fontSize: 'var(--text-small)' },
  nameInput: { flex: '1 1 220px', fontWeight: 'var(--font-weight-semibold)' },
  count: { display: 'inline-block', minWidth: 22, textAlign: 'center', padding: '1px 7px', borderRadius: 999, background: 'var(--color-bg-light)', color: 'var(--color-text-steel)', fontSize: 'var(--text-xs)', fontWeight: 600 },
  removeBtn: { background: 'none', border: 'none', color: 'var(--color-destructive)', fontSize: 'var(--text-xs)', cursor: 'pointer', padding: '3px 6px' },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 },
  row: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)', padding: '6px 8px', border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg-white)', cursor: 'grab' },
  rowDragging: { opacity: 0.45 },
  rowDrop: { boxShadow: 'inset 0 3px 0 var(--color-action-blue)' },
  grip: { color: 'var(--color-border-dark)', fontSize: 14, lineHeight: 1, userSelect: 'none' },
  appText: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
  appName: { fontSize: 'var(--text-small)', fontWeight: 'var(--font-weight-medium)', color: 'var(--color-text-charcoal)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  appSub: { fontSize: 'var(--text-xs)', color: 'var(--color-text-steel)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  moveSelect: { width: 150, padding: '4px 8px', fontSize: 'var(--text-xs)' },
  emptyDrop: { padding: 'var(--space-3)', textAlign: 'center', fontSize: 'var(--text-xs)', color: 'var(--color-text-steel)', border: '1px dashed var(--color-border-medium)', borderRadius: 'var(--radius-sm)' },
  addBtn: { marginTop: 'var(--space-3)' },
  initials: { display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#A84335', color: '#fff', fontWeight: 700, fontSize: 10 },
  footer: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)', justifyContent: 'flex-end' },
  hint: { marginRight: 'auto', fontSize: 'var(--text-small)', color: 'var(--color-text-steel)' },
  warn: { color: '#B45309' },
  error: { color: 'var(--color-destructive)' },
};
