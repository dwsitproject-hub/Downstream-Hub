import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { apiRequest } from '../api';
import { useAuth } from '../context/AuthContext';

export default function HubRevalidate() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = useMemo(() => searchParams.get('token') || '', [searchParams]);
  const reason = useMemo(() => searchParams.get('reason') || '', [searchParams]);
  const { user } = useAuth();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    async function runVerify() {
      if (!token) return;
      setMessage('Confirming your session...');
      setError('');
      try {
        const info = await apiRequest(`/api/auth/hub-session-revalidation/token-info?token=${encodeURIComponent(token)}`);
        if (!info.valid) {
          setError('This link is invalid or has expired.');
          setMessage('');
          return;
        }
        await apiRequest('/api/auth/hub-session-revalidation/verify', {
          method: 'POST',
          body: JSON.stringify({ token }),
        });
        navigate('/', { replace: true });
      } catch (err) {
        setError(err.error || 'Failed to confirm session.');
        setMessage('');
      }
    }
    runVerify();
  }, [token, navigate]);

  async function handleResend() {
    setError('');
    setSending(true);
    try {
      const result = await apiRequest('/api/auth/hub-session-revalidation/request', { method: 'POST' });
      setMessage(result.message || 'Check your email for the session confirmation link.');
    } catch (err) {
      setError(err.error || 'Could not send email.');
    } finally {
      setSending(false);
    }
  }

  if (token) {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <h1 style={styles.title}>Hub session</h1>
          {message && <p style={styles.subtitle}>{message}</p>}
          {error && <div style={styles.error}>{error}</div>}
          {!message && !error && <p style={styles.subtitle}>Confirming…</p>}
          <p style={styles.footer}>
            <Link to="/login">Back to sign in</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>Hub session revalidation</h1>
        {reason === 'session' && (
          <p style={styles.subtitle}>
            Your session must be reconfirmed. We can send a confirmation link to your email address on file.
          </p>
        )}
        {(reason === 'login' || !reason) && (
          <p style={styles.subtitle}>
            Check your email for the confirmation link. After you open it, you will be signed in to Downstream Hub.
          </p>
        )}
        {message && <div style={styles.success}>{message}</div>}
        {error && <div style={styles.error}>{error}</div>}
        {reason === 'session' && user && (
          <button type="button" className="btn-primary" style={styles.button} disabled={sending} onClick={handleResend}>
            {sending ? 'Sending…' : 'Email me the confirmation link'}
          </button>
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
  card: { background: 'var(--color-bg-white)', padding: 'var(--space-5)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-md)', maxWidth: 440, width: '100%' },
  title: { margin: '0 0 var(--space-2)', fontSize: 'var(--text-h3)', fontFamily: 'var(--font-heading)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-charcoal)' },
  subtitle: { margin: '0 0 var(--space-3)', color: 'var(--color-text-steel)', fontSize: 'var(--text-small)' },
  success: { padding: 'var(--space-2)', background: 'var(--color-success-bg)', color: 'var(--color-text-charcoal)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-small)', marginBottom: 'var(--space-3)' },
  error: { padding: 'var(--space-2)', background: 'var(--color-error-bg)', color: 'var(--color-destructive)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-small)', marginBottom: 'var(--space-3)' },
  button: { marginTop: 'var(--space-2)' },
  footer: { marginTop: 'var(--space-3)', fontSize: 'var(--text-small)', color: 'var(--color-text-steel)', textAlign: 'center' },
};
