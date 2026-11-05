import { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { apiRequest } from '../api';
import usePasswordRequirements from '../hooks/usePasswordRequirements';
import { passwordLengthHint } from '../lib/passwordRequirements';

export default function ResetPassword() {
  const passwordRequirements = usePasswordRequirements();
  const minPasswordLength = passwordRequirements?.min_password_length ?? 6;
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [passwordRetype, setPasswordRetype] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [tokenOk, setTokenOk] = useState(null);

  useEffect(() => {
    if (!token) {
      setTokenOk(false);
      return;
    }
    apiRequest(`/api/auth/reset-token-info?token=${encodeURIComponent(token)}`)
      .then((data) => setTokenOk(data.valid === true))
      .catch(() => setTokenOk(false));
  }, [token]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await apiRequest('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({
          token,
          new_password: password,
          new_password_retype: passwordRetype,
        }),
      });
      navigate('/login', {
        replace: true,
        state: { message: 'Password updated. Please sign in with your new password.' },
      });
    } catch (err) {
      setError(err.error || 'Could not reset password');
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <h1 style={styles.title}>Invalid link</h1>
          <p style={styles.subtitle}>This reset link is missing a token. Request a new link from the sign-in page.</p>
          <p style={styles.footer}>
            <Link to="/login">Back to sign in</Link>
          </p>
        </div>
      </div>
    );
  }

  if (tokenOk === false) {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <h1 style={styles.title}>Link expired or invalid</h1>
          <p style={styles.subtitle}>Request a new password reset from the sign-in page.</p>
          <p style={styles.footer}>
            <Link to="/forgot-password">Request new link</Link> · <Link to="/login">Sign in</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>Set new password</h1>
        <p style={styles.subtitle}>Choose a strong password you have not used before.</p>
        {tokenOk === null && <p style={styles.hint}>Checking link…</p>}
        {tokenOk === true && (
          <form onSubmit={handleSubmit} style={styles.form}>
            {error && <div style={styles.error}>{error}</div>}
            <input
              type="password"
              placeholder={passwordLengthHint(minPasswordLength, 'New password')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
              minLength={minPasswordLength}
              style={styles.input}
            />
            <input
              type="password"
              placeholder="Confirm new password"
              value={passwordRetype}
              onChange={(e) => setPasswordRetype(e.target.value)}
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
          <Link to="/login">Back to sign in</Link>
        </p>
      </div>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-3)', background: 'var(--color-bg-light)' },
  card: { background: 'var(--color-bg-white)', padding: 'var(--space-5)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-md)', maxWidth: 400, width: '100%' },
  title: { margin: '0 0 var(--space-1)', fontSize: 'var(--text-h3)', fontFamily: 'var(--font-heading)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-charcoal)' },
  subtitle: { margin: '0 0 var(--space-4)', color: 'var(--color-text-steel)', fontSize: 'var(--text-small)' },
  hint: { fontSize: 'var(--text-small)', color: 'var(--color-text-steel)' },
  form: { display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' },
  error: { padding: 'var(--space-2)', background: 'var(--color-error-bg)', color: 'var(--color-destructive)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-small)' },
  input: { padding: 'var(--space-2) var(--space-3)', border: '1px solid var(--color-border-medium)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-base)' },
  button: {},
  footer: { marginTop: 'var(--space-3)', fontSize: 'var(--text-small)', color: 'var(--color-text-steel)', textAlign: 'center' },
};
