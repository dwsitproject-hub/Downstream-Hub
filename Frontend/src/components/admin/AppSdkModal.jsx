import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AdminModal from './AdminModal';
import { apiRequest } from '../../api';

function fmtRelative(v) {
  if (!v) return null;
  const mins = Math.round((Date.now() - new Date(v).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

function CodeBlock({ code, label }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div style={s.codeWrap}>
      <pre style={s.code} aria-label={label}>{code}</pre>
      <button type="button" className="btn-secondary btn-compact" style={s.copyBtn} onClick={copy}>
        {copied ? 'Copied ✓' : 'Copy'}
      </button>
    </div>
  );
}

/**
 * Per-application settings for the embeddable Hub SDK: the snippet to paste,
 * the publishable key, which origins may send data, and whether data is arriving.
 */
export default function AppSdkModal({ app, onClose }) {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [originsText, setOriginsText] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);

  function apply(data) {
    setSettings(data);
    setOriginsText((data.allowed_origins || []).join('\n'));
    setEnabled(data.sdk_enabled !== false);
  }

  useEffect(() => {
    let ignore = false;
    apiRequest(`/api/applications/${app.id}/sdk`)
      .then((d) => { if (!ignore) apply(d); })
      .catch((err) => { if (!ignore) setError(err.error || 'Failed to load SDK settings'); })
      .finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [app.id]);

  async function save() {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const allowed = originsText.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
      const data = await apiRequest(`/api/applications/${app.id}/sdk`, {
        method: 'PUT',
        body: JSON.stringify({ enabled, allowed_origins: allowed }),
      });
      apply(data);
      setNotice('SDK settings saved.');
    } catch (err) {
      setError(err.error || 'Failed to save SDK settings');
    } finally {
      setSaving(false);
    }
  }

  async function rotate() {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const data = await apiRequest(`/api/applications/${app.id}/sdk/rotate-key`, { method: 'POST' });
      apply(data);
      setConfirmRotate(false);
      setNotice('New key issued. Update the snippet in the application — the old key no longer works.');
    } catch (err) {
      setError(err.error || 'Failed to rotate the key');
    } finally {
      setSaving(false);
    }
  }

  const hubOrigin = window.location.origin;
  const scriptTag = settings
    ? `<script src="${hubOrigin}/api/sdk/v1/hub-sdk.js"\n        data-app-key="${settings.sdk_key}" defer></script>`
    : '';
  const identifyCode = [
    '// After the user signs in through Downstream Hub (OIDC), with the verified id_token claims:',
    'window.DwsHub && DwsHub.identify({ id: claims.sub, email: claims.email });',
    '',
    '// On sign-out:',
    'window.DwsHub && DwsHub.reset();',
    '',
    '// Optional — record a business action:',
    "window.DwsHub && DwsHub.track('report_exported', { format: 'xlsx' });",
  ].join('\n');

  const status = settings?.status;
  const lastSeen = fmtRelative(status?.last_event_at);
  const live = status?.last_event_at && Date.now() - new Date(status.last_event_at).getTime() < 24 * 60 * 60 * 1000;

  return (
    <AdminModal
      title={`Analytics SDK · ${app.name}`}
      size="xl"
      onClose={onClose}
      disableClose={saving}
      footer={(
        <div style={s.footer}>
          <Link to={`/admin/analytics?view=${app.id}`} className="btn-secondary" style={{ textDecoration: 'none' }}>View analytics</Link>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Close</button>
            <button type="button" className="btn-primary" onClick={save} disabled={saving || loading || !settings}>
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </div>
      )}
    >
      {loading && <p style={s.muted}>Loading…</p>}
      {error && <div style={s.error}>{error}</div>}
      {notice && <div style={s.success}>{notice}</div>}

      {settings && (
        <>
          <div style={{ ...s.status, ...(live ? s.statusLive : lastSeen ? s.statusIdle : s.statusNone) }}>
            {live && <><strong>Receiving data</strong> · last event {lastSeen}</>}
            {!live && lastSeen && <><strong>No recent data</strong> · last event {lastSeen}</>}
            {!lastSeen && <><strong>No data received yet.</strong> Add the snippet below to the application.</>}
            {status && (
              <span style={s.statusCounts}>
                Last 24 h: {status.sessions_24h} sessions · {status.events_24h} events · {status.errors_24h} errors
              </span>
            )}
          </div>

          <h4 style={s.h4}>1. Add the script to every page</h4>
          <p style={s.help}>Paste it in the page <code>&lt;head&gt;</code>, before the app’s own script. Page views, time in app, JS errors and the “Report a bug” button work automatically.</p>
          <CodeBlock code={scriptTag} label="Script tag" />

          <h4 style={s.h4}>2. Tell the SDK who is signed in</h4>
          <p style={s.help}>Use the Hub user id (the OIDC <code>sub</code> claim) so activity links to the right person.</p>
          <CodeBlock code={identifyCode} label="Identify snippet" />
          <p style={s.help}>
            Options on the script tag: <code>data-bug-button="false"</code> (hide the button),{' '}
            <code>data-bug-button-position="bottom-left"</code>, <code>data-auto-page-views="false"</code>,{' '}
            <code>data-capture-errors="false"</code>. Full guide: <code>Docs/SDK-INTEGRATION-GUIDE.md</code>.
          </p>

          <h4 style={s.h4}>Allowed origins</h4>
          <p style={s.help}>
            Data is only accepted from these web addresses. Leave empty to use the application’s registered URLs:{' '}
            <strong>{(settings.default_origins || []).join(', ') || 'none — set the Target URL first'}</strong>.
          </p>
          <textarea
            className="form-input"
            rows={3}
            value={originsText}
            onChange={(e) => setOriginsText(e.target.value)}
            placeholder={(settings.default_origins || []).join('\n') || 'https://app.example.com'}
            style={{ fontFamily: 'Consolas, Menlo, monospace', fontSize: 13 }}
            aria-label="Allowed origins, one per line"
          />
          <p style={s.help}>Currently accepting: {(settings.effective_origins || []).join(', ') || <em>nothing — data will be rejected</em>}</p>

          <label style={s.toggle}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Accept data from this application
          </label>

          <h4 style={s.h4}>Key</h4>
          <p style={s.help}>
            <code style={s.key}>{settings.sdk_key}</code> — a publishable key: it is safe in web pages because data is also checked against the allowed origins.
          </p>
          {!confirmRotate ? (
            <button type="button" className="btn-secondary btn-compact" onClick={() => setConfirmRotate(true)} disabled={saving}>Issue a new key…</button>
          ) : (
            <div style={s.confirm}>
              The current key stops working immediately; the application sends nothing until its snippet is updated.
              <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                <button type="button" className="btn-danger btn-compact" onClick={rotate} disabled={saving}>Issue new key</button>
                <button type="button" className="btn-secondary btn-compact" onClick={() => setConfirmRotate(false)} disabled={saving}>Cancel</button>
              </div>
            </div>
          )}
        </>
      )}
    </AdminModal>
  );
}

const s = {
  muted: { color: 'var(--color-text-steel)', fontSize: 'var(--text-small)' },
  error: { padding: 'var(--space-2) var(--space-3)', background: '#FEE2E2', color: 'var(--color-destructive)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-small)', marginBottom: 'var(--space-3)' },
  success: { padding: 'var(--space-2) var(--space-3)', background: '#DCFCE7', color: '#166534', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-small)', marginBottom: 'var(--space-3)' },
  status: { display: 'flex', flexWrap: 'wrap', gap: '4px var(--space-3)', alignItems: 'baseline', padding: 'var(--space-3)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-small)', border: '1px solid transparent' },
  statusLive: { background: '#DCFCE7', color: '#166534', borderColor: '#BBF7D0' },
  statusIdle: { background: 'var(--color-bg-light)', color: 'var(--color-text-charcoal)', borderColor: 'var(--color-border-light)' },
  statusNone: { background: '#FEF3C7', color: '#78350F', borderColor: '#FCD34D' },
  statusCounts: { marginLeft: 'auto', fontSize: 'var(--text-xs)', opacity: 0.85 },
  h4: { margin: 'var(--space-4) 0 var(--space-1)', fontSize: 'var(--text-small)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-charcoal)' },
  help: { margin: '0 0 var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--color-text-steel)', lineHeight: 1.6 },
  codeWrap: { position: 'relative', marginBottom: 'var(--space-2)' },
  code: { margin: 0, padding: 'var(--space-3)', paddingRight: 80, background: '#111827', color: '#E5E7EB', borderRadius: 'var(--radius-md)', fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'Consolas, Menlo, monospace' },
  copyBtn: { position: 'absolute', top: 8, right: 8, background: 'var(--color-bg-white)' },
  key: { fontFamily: 'Consolas, Menlo, monospace', fontSize: 12, background: 'var(--color-bg-light)', padding: '2px 6px', borderRadius: 4, color: 'var(--color-text-charcoal)', wordBreak: 'break-all' },
  toggle: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-3)', fontSize: 'var(--text-small)', color: 'var(--color-text-charcoal)', cursor: 'pointer' },
  confirm: { padding: 'var(--space-3)', background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-small)', color: '#7F1D1D' },
  footer: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-2)', width: '100%' },
};
