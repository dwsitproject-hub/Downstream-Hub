import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { apiRequest } from '../api';
import { useAuth } from '../context/AuthContext';
import { getSsoLoginParams, resumeAfterLogin } from '../lib/ssoReturnTo';

const MAGIC_LINK_INVALID_MESSAGE =
  'This link was replaced by a newer sign-in request. Use the latest email or sign in again.';

export default function MagicLinkLogin() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { loginWithMagicToken } = useAuth();
  const token = useMemo(() => searchParams.get('token') || '', [searchParams]);
  const { returnTo } = useMemo(
    () => getSsoLoginParams(searchParams.toString() ? `?${searchParams.toString()}` : ''),
    [searchParams]
  );
  const [message, setMessage] = useState('Checking your sign-in link...');
  const [error, setError] = useState('');

  useEffect(() => {
    async function run() {
      if (!token) {
        setError('Missing sign-in token.');
        setMessage('');
        return;
      }

      try {
        const info = await apiRequest(`/api/auth/magic-link/token-info?token=${encodeURIComponent(token)}`);
        if (!info.valid) {
          setError(MAGIC_LINK_INVALID_MESSAGE);
          setMessage('');
          return;
        }
        setMessage('Signing you in...');
        await loginWithMagicToken(token);
        resumeAfterLogin(returnTo, navigate);
      } catch (err) {
        if (err.code === 'PASSWORD_EXPIRED') {
          navigate('/change-password-expired', {
            state: {
              returnTo,
              clientId: searchParams.get('client_id') || '',
            },
            replace: true,
          });
          return;
        }
        if (err.status === 423 && err.code === 'ACCOUNT_LOCKED') {
          const until = err.locked_until ? new Date(err.locked_until).toLocaleString() : '';
          setError(`Account locked. Try again after ${until || 'the lockout period'} or contact an administrator.`);
          setMessage('');
          return;
        }
        if (err.status === 400 && (err.code === 'MAGIC_LINK_INVALID' || /invalid|expired|link/i.test(err.error || ''))) {
          setError(MAGIC_LINK_INVALID_MESSAGE);
        } else {
          setError(err.error || 'Failed to complete magic link sign-in.');
        }
        setMessage('');
      }
    }
    run();
  }, [token, returnTo, loginWithMagicToken, navigate, searchParams]);

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>Magic link sign-in</h1>
        {message && <p style={styles.subtitle}>{message}</p>}
        {error && <div style={styles.error}>{error}</div>}
        <p style={styles.footer}>
          <Link to="/login">Back to sign in</Link>
        </p>
      </div>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-3)', background: 'var(--color-bg-light)' },
  card: { background: 'var(--color-bg-white)', padding: 'var(--space-5)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-md)', maxWidth: 420, width: '100%' },
  title: { margin: '0 0 var(--space-2)', fontSize: 'var(--text-h3)', fontFamily: 'var(--font-heading)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-charcoal)' },
  subtitle: { margin: '0 0 var(--space-3)', color: 'var(--color-text-steel)', fontSize: 'var(--text-small)' },
  error: { padding: 'var(--space-2)', background: 'var(--color-error-bg)', color: 'var(--color-destructive)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-small)' },
  footer: { marginTop: 'var(--space-3)', fontSize: 'var(--text-small)', color: 'var(--color-text-steel)', textAlign: 'center' },
};
