import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { apiRequest } from '../api';
import { useAuth } from '../context/AuthContext';

export default function ActivateAccount() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { setSession } = useAuth();
  const token = useMemo(() => searchParams.get('token') || '', [searchParams]);

  const [checking, setChecking] = useState(true);
  const [valid, setValid] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    let active = true;
    async function check() {
      if (!token) {
        if (active) { setError('Missing activation token.'); setChecking(false); }
        return;
      }
      try {
        const info = await apiRequest(`/api/auth/activate-account/token-info?token=${encodeURIComponent(token)}`);
        if (!active) return;
        if (info.valid) {
          setValid(true);
          setEmail(info.email || '');
        } else {
          setError('This activation link is invalid or has expired. Ask your administrator to resend it.');
        }
      } catch {
        if (active) setError('Could not verify the activation link. Please try again.');
      } finally {
        if (active) setChecking(false);
      }
    }
    check();
    return () => { active = false; };
  }, [token]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await apiRequest('/api/auth/activate-account', {
        method: 'POST',
        body: JSON.stringify({ token, new_password: password, new_password_retype: confirm }),
      });
      setDone(true);
      if (result.user) {
        // Session cookie is set by the server — go straight into the Hub.
        setSession(null, result.user);
        navigate('/', { replace: true });
      } else {
        navigate('/login', { replace: true });
      }
    } catch (err) {
      setError(err.error || 'Failed to activate account.');
      setSubmitting(false);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>Complete your registration</h1>

        {checking && <p style={styles.subtitle}>Checking your activation link…</p>}

        {!checking && !valid && (
          <>
            {error && <div style={styles.error}>{error}</div>}
            <p style={styles.footer}><Link to="/login">Go to sign in</Link></p>
          </>
        )}

        {!checking && valid && !done && (
          <form onSubmit={handleSubmit}>
            <p style={styles.subtitle}>
              {email ? <>Set a password for <strong>{email}</strong> to finish setting up your account.</> : 'Set a password to finish setting up your account.'}
            </p>
            {error && <div style={styles.error}>{error}</div>}
            <label style={styles.label}>
              New password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={styles.input}
                autoComplete="new-password"
                required
                minLength={8}
              />
            </label>
            <label style={styles.label}>
              Confirm password
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                style={styles.input}
                autoComplete="new-password"
                required
                minLength={8}
              />
            </label>
            <button type="submit" className="btn-primary" style={styles.button} disabled={submitting}>
              {submitting ? 'Activating…' : 'Activate & sign in'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-3)', background: 'var(--color-bg-light)' },
  card: { background: 'var(--color-bg-white)', padding: 'var(--space-5)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-md)', maxWidth: 420, width: '100%' },
  title: { margin: '0 0 var(--space-2)', fontSize: 'var(--text-h3)', fontFamily: 'var(--font-heading)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-charcoal)' },
  subtitle: { margin: '0 0 var(--space-3)', color: 'var(--color-text-steel)', fontSize: 'var(--text-small)' },
  label: { display: 'block', marginBottom: 'var(--space-3)', fontSize: 'var(--text-small)', color: 'var(--color-text-charcoal)', fontWeight: 'var(--font-weight-medium)' },
  input: { display: 'block', width: '100%', marginTop: 'var(--space-1)', padding: 'var(--space-2)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)', fontSize: 'var(--text-body)', boxSizing: 'border-box' },
  button: { width: '100%', marginTop: 'var(--space-1)' },
  error: { padding: 'var(--space-2)', background: '#FEE2E2', color: 'var(--color-destructive)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-small)', marginBottom: 'var(--space-3)' },
  footer: { marginTop: 'var(--space-3)', fontSize: 'var(--text-small)', color: 'var(--color-text-steel)', textAlign: 'center' },
};
