import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { apiRequest } from '../api';
import { resumeAfterLogin } from '../lib/ssoReturnTo';
import usePasswordRequirements from '../hooks/usePasswordRequirements';
import { passwordLengthHint } from '../lib/passwordRequirements';

export default function ChangePasswordExpired() {
  const location = useLocation();
  const navigate = useNavigate();
  const { setSession } = useAuth();
  const passwordRequirements = usePasswordRequirements();
  const minPasswordLength = passwordRequirements?.min_password_length ?? 6;
  const returnTo = location.state?.returnTo || '';
  const [email, setEmail] = useState(location.state?.email || '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPasswordRetype, setNewPasswordRetype] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
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
      const data = await apiRequest('/api/auth/change-password-expired', {
        method: 'POST',
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          current_password: currentPassword,
          new_password: newPassword,
          new_password_retype: newPasswordRetype,
        }),
      });
      if (data.user) {
        setSession(null, data.user);
        resumeAfterLogin(returnTo, navigate);
      } else {
        navigate('/login', { state: { message: 'Password updated. Please sign in.' }, replace: true });
      }
    } catch (err) {
      setError(err.error || 'Failed to update password');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>Password expired</h1>
        <p style={styles.subtitle}>Your password has expired. Enter your current password and choose a new one.</p>
        <form onSubmit={handleSubmit} style={styles.form}>
          {error && <div style={styles.error}>{error}</div>}
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            style={styles.input}
          />
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
        <p style={styles.footer}>
          <Link to="/login">Back to sign in</Link>
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
  form: { display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' },
  error: { padding: 'var(--space-2)', background: 'var(--color-error-bg)', color: 'var(--color-destructive)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-small)' },
  input: { padding: 'var(--space-2) var(--space-3)', border: '1px solid var(--color-border-medium)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-base)' },
  button: {},
  footer: { marginTop: 'var(--space-3)', fontSize: 'var(--text-small)', color: 'var(--color-text-steel)', textAlign: 'center' },
};
