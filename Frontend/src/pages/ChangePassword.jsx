import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { apiRequest } from '../api';
import usePasswordRequirements from '../hooks/usePasswordRequirements';
import { passwordLengthHint } from '../lib/passwordRequirements';

export default function ChangePassword() {
  const { user, logout } = useAuth();
  const passwordRequirements = usePasswordRequirements();
  const minPasswordLength = passwordRequirements?.min_password_length ?? 6;
  const [searchParams] = useSearchParams();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordRetype, setNewPasswordRetype] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [ssoStatus, setSsoStatus] = useState({ loading: true, linked: false, subjectFingerprint: null });
  const [ssoMessage, setSsoMessage] = useState('');
  const [ssoError, setSsoError] = useState('');
  const [ssoSubmitting, setSsoSubmitting] = useState(false);

  useEffect(() => {
    let ignore = false;
    async function loadStatus() {
      try {
        const data = await apiRequest('/api/users/me/sso-status');
        if (!ignore) {
          setSsoStatus({
            loading: false,
            linked: !!data.linked,
            subjectFingerprint: data.subjectFingerprint || null,
            linkedAt: data.linkedAt || null,
            linkedByMode: data.linkedByMode || null,
          });
        }
      } catch {
        if (!ignore) setSsoStatus({ loading: false, linked: false, subjectFingerprint: null });
      }
    }
    loadStatus();
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    const verifyToken = searchParams.get('sso_verify');
    if (!verifyToken) return;
    let ignore = false;
    (async () => {
      setSsoSubmitting(true);
      setSsoError('');
      try {
        await apiRequest(`/api/users/sso/verify?token=${encodeURIComponent(verifyToken)}`);
        if (!ignore) {
          setSsoMessage('SSO linked successfully. You can sign in with either password or SSO.');
          const data = await apiRequest('/api/users/me/sso-status');
          setSsoStatus({
            loading: false,
            linked: !!data.linked,
            subjectFingerprint: data.subjectFingerprint || null,
            linkedAt: data.linkedAt || null,
            linkedByMode: data.linkedByMode || null,
          });
        }
      } catch (err) {
        if (!ignore) setSsoError(err.error || 'Failed to verify SSO link');
      } finally {
        if (!ignore) setSsoSubmitting(false);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [searchParams]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSuccess(false);
    if (newPassword !== newPasswordRetype) {
      setError('New password and confirm do not match');
      return;
    }
    if (newPassword.length < minPasswordLength) {
      setError(`New password must be at least ${minPasswordLength} characters`);
      return;
    }
    setSubmitting(true);
    try {
      await apiRequest('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
          new_password_retype: newPasswordRetype,
        }),
      });
      setSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setNewPasswordRetype('');
    } catch (err) {
      setError(err.error || 'Failed to update password');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStartSsoConnect() {
    setSsoSubmitting(true);
    setSsoError('');
    setSsoMessage('');
    try {
      const data = await apiRequest('/api/users/me/sso-connect/start', { method: 'POST' });
      setSsoMessage(data.message || 'Verification email sent. Please open the link in your inbox.');
    } catch (err) {
      setSsoError(err.error || 'Failed to start SSO connect');
    } finally {
      setSsoSubmitting(false);
    }
  }

  async function handleUnlinkSso() {
    setSsoSubmitting(true);
    setSsoError('');
    setSsoMessage('');
    try {
      await apiRequest('/api/users/me/sso-unlink', { method: 'POST' });
      setSsoStatus((s) => ({ ...s, linked: false, subjectFingerprint: null, linkedAt: null, linkedByMode: null }));
      setSsoMessage('SSO unlinked for this account.');
    } catch (err) {
      setSsoError(err.error || 'Failed to unlink SSO');
    } finally {
      setSsoSubmitting(false);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>Change password</h1>
        <p style={styles.subtitle}>Signed in as {user?.email}</p>
        <section style={styles.ssoCard}>
          <h2 style={styles.ssoTitle}>Sign-in methods</h2>
          <p style={styles.ssoDesc}>Manage seamless linking between local password login and OIDC SSO.</p>
          {ssoError && <div style={styles.error}>{ssoError}</div>}
          {ssoMessage && <div style={styles.success}>{ssoMessage}</div>}
          {ssoStatus.loading ? (
            <p style={styles.meta}>Loading SSO status…</p>
          ) : (
            <>
              <p style={styles.meta}>
                Status: <strong>{ssoStatus.linked ? 'Linked' : 'Not linked'}</strong>
                {ssoStatus.subjectFingerprint ? ` (${ssoStatus.subjectFingerprint})` : ''}
              </p>
              <div style={styles.ssoActions}>
                <button type="button" disabled={ssoSubmitting} className="btn-secondary" onClick={handleStartSsoConnect}>
                  {ssoSubmitting ? 'Working…' : 'Connect SSO'}
                </button>
                {ssoStatus.linked && (
                  <button type="button" disabled={ssoSubmitting} className="btn-secondary" onClick={handleUnlinkSso}>
                    Unlink SSO
                  </button>
                )}
              </div>
              <p style={styles.meta}>Connect SSO sends a verification email before linking.</p>
            </>
          )}
        </section>
        {success ? (
          <p style={styles.success}>Password updated successfully.</p>
        ) : (
          <form onSubmit={handleSubmit} style={styles.form}>
            {error && <div style={styles.error}>{error}</div>}
            <input
              type="password"
              placeholder="Current password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              autoComplete="current-password"
              style={styles.input}
            />
            <input
              type="password"
              placeholder={passwordLengthHint(minPasswordLength, 'New password')}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              autoComplete="new-password"
              style={styles.input}
            />
            <input
              type="password"
              placeholder="Confirm new password"
              value={newPasswordRetype}
              onChange={(e) => setNewPasswordRetype(e.target.value)}
              required
              autoComplete="new-password"
              style={styles.input}
            />
            <button type="submit" disabled={submitting} className="btn-primary" style={styles.button}>
              {submitting ? 'Updating…' : 'Update password'}
            </button>
          </form>
        )}
        <p style={styles.footer}>
          <Link to="/">Dashboard</Link>
          {' · '}
          <button type="button" onClick={logout} style={styles.linkBtn}>Sign out</button>
        </p>
      </div>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-3)', background: 'var(--color-bg-light)' },
  card: { background: 'var(--color-bg-white)', padding: 'var(--space-5)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-md)', maxWidth: 360, width: '100%' },
  title: { margin: '0 0 var(--space-1)', fontSize: 'var(--text-h3)', fontFamily: 'var(--font-heading)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-charcoal)' },
  subtitle: { margin: '0 0 var(--space-4)', color: 'var(--color-text-steel)', fontSize: 'var(--text-small)' },
  ssoCard: { marginBottom: 'var(--space-4)', border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)', background: 'var(--color-bg-light)' },
  ssoTitle: { margin: '0 0 var(--space-1)', fontSize: 'var(--text-base)' },
  ssoDesc: { margin: '0 0 var(--space-2)', color: 'var(--color-text-steel)', fontSize: 'var(--text-small)' },
  meta: { margin: '0 0 var(--space-2)', fontSize: 'var(--text-small)', color: 'var(--color-text-steel)' },
  ssoActions: { display: 'flex', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' },
  form: { display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' },
  error: { padding: 'var(--space-2)', background: 'var(--color-error-bg)', color: 'var(--color-destructive)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-small)' },
  success: { padding: 'var(--space-2)', background: 'var(--color-success-bg)', color: 'var(--color-text-charcoal)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-small)' },
  input: { padding: 'var(--space-2) var(--space-3)', border: '1px solid var(--color-border-medium)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-base)' },
  button: {},
  footer: { marginTop: 'var(--space-3)', fontSize: 'var(--text-small)', color: 'var(--color-text-steel)', textAlign: 'center' },
  linkBtn: { background: 'none', border: 'none', color: 'var(--color-primary)', cursor: 'pointer', padding: 0, fontSize: 'inherit' },
};
