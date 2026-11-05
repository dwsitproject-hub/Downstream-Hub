import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { apiRequest } from '../api';

export default function VerifyAppLogin() {
  const [searchParams] = useSearchParams();
  const token = useMemo(() => searchParams.get('token') || '', [searchParams]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('Checking verification link...');
  const [error, setError] = useState('');

  useEffect(() => {
    async function verify() {
      if (!token) {
        setError('Missing verification token.');
        setLoading(false);
        setMessage('');
        return;
      }
      try {
        const info = await apiRequest(`/api/sso/verify-app-login/token-info?token=${encodeURIComponent(token)}`);
        if (!info.valid) {
          setError('This verification link is invalid or has expired.');
          setMessage('');
          setLoading(false);
          return;
        }
        setMessage('Verifying first-time application access...');
        const result = await apiRequest('/api/sso/verify-app-login', {
          method: 'POST',
          body: JSON.stringify({ token }),
        });
        setMessage(result.message || 'Verification complete. Return to dashboard and open the app again.');
      } catch (err) {
        setError(err.error || 'Failed to verify app access.');
        setMessage('');
      } finally {
        setLoading(false);
      }
    }
    verify();
  }, [token]);

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>Verify application access</h1>
        {message && <p style={styles.subtitle}>{message}</p>}
        {error && <div style={styles.error}>{error}</div>}
        {!loading && (
          <p style={styles.footer}>
            <Link to="/">Back to dashboard</Link>
          </p>
        )}
      </div>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-3)', background: 'var(--color-bg-light)' },
  card: { background: 'var(--color-bg-white)', padding: 'var(--space-5)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-md)', maxWidth: 460, width: '100%' },
  title: { margin: '0 0 var(--space-2)', fontSize: 'var(--text-h3)', fontFamily: 'var(--font-heading)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-charcoal)' },
  subtitle: { margin: '0 0 var(--space-3)', color: 'var(--color-text-steel)', fontSize: 'var(--text-small)' },
  error: { padding: 'var(--space-2)', background: 'var(--color-error-bg)', color: 'var(--color-destructive)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-small)' },
  footer: { marginTop: 'var(--space-3)', fontSize: 'var(--text-small)', color: 'var(--color-text-steel)', textAlign: 'center' },
};
