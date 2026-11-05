import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { apiRequest } from '../api';
import { useAuth } from '../context/AuthContext';

export default function LoginRiskVerify() {
  const { setSession } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = useMemo(() => searchParams.get('token') || '', [searchParams]);
  const initialEmail = location.state?.email || '';
  const [email, setEmail] = useState(initialEmail);
  const [loading, setLoading] = useState(!!token);
  const [message, setMessage] = useState(token ? 'Checking verification link...' : '');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    async function verifyByToken() {
      if (!token) return;
      try {
        const info = await apiRequest(`/api/auth/login-risk/token-info?token=${encodeURIComponent(token)}`);
        if (!info.valid) {
          setError('This login verification link is invalid or has expired.');
          setMessage('');
          return;
        }
        setMessage('Verifying unusual login...');
        const result = await apiRequest('/api/auth/login-risk/verify', {
          method: 'POST',
          body: JSON.stringify({ token }),
        });
        setSession(null, result.user);
        navigate('/', { replace: true });
      } catch (err) {
        setError(err.error || 'Failed to verify login context.');
        setMessage('');
      } finally {
        setLoading(false);
      }
    }
    verifyByToken();
  }, [token, navigate, setSession]);

  async function resend() {
    setError('');
    if (!email.trim()) {
      setError('Enter your email to resend the login verification link.');
      return;
    }
    setSending(true);
    try {
      const result = await apiRequest('/api/auth/login-risk/request', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      setMessage(result.message || 'If an account is associated with this email, a verification link has been sent.');
    } catch (err) {
      setError(err.error || 'Could not send verification email.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>Verify unusual login</h1>
        <p style={styles.subtitle}>
          We detected an unusual login context. Confirm this sign-in from your email link.
        </p>
        {message && <div style={styles.success}>{message}</div>}
        {error && <div style={styles.error}>{error}</div>}
        {!loading && (
          <>
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              style={styles.input}
            />
            <button type="button" className="btn-secondary" disabled={sending} onClick={resend}>
              {sending ? 'Sending…' : 'Resend verification email'}
            </button>
          </>
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
  card: { background: 'var(--color-bg-white)', padding: 'var(--space-5)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-md)', maxWidth: 460, width: '100%', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' },
  title: { margin: '0 0 var(--space-1)', fontSize: 'var(--text-h3)', fontFamily: 'var(--font-heading)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-charcoal)' },
  subtitle: { margin: 0, color: 'var(--color-text-steel)', fontSize: 'var(--text-small)' },
  success: { padding: 'var(--space-2)', background: 'var(--color-success-bg)', color: 'var(--color-text-charcoal)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-small)' },
  error: { padding: 'var(--space-2)', background: 'var(--color-error-bg)', color: 'var(--color-destructive)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-small)' },
  input: { padding: 'var(--space-2) var(--space-3)', border: '1px solid var(--color-border-medium)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-base)' },
  footer: { margin: 0, fontSize: 'var(--text-small)', color: 'var(--color-text-steel)', textAlign: 'center' },
};
