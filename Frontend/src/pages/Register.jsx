import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { apiRequest } from '../api';
import HubLogo from '../components/HubLogo';
import usePasswordRequirements from '../hooks/usePasswordRequirements';
import { passwordLengthHint } from '../lib/passwordRequirements';

export default function Register() {
  const passwordRequirements = usePasswordRequirements();
  const minPasswordLength = passwordRequirements?.min_password_length ?? 6;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordRetype, setPasswordRetype] = useState('');
  const [businessUnitId, setBusinessUnitId] = useState('');
  const [businessUnits, setBusinessUnits] = useState([]);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { register } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    apiRequest('/api/auth/registration-options')
      .then((data) => setBusinessUnits(data.business_units || []))
      .catch(() => setBusinessUnits([]));
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (password !== passwordRetype) {
      setError('Password and confirm password do not match');
      return;
    }
    if (password.length < minPasswordLength) {
      setError(`Password must be at least ${minPasswordLength} characters`);
      return;
    }
    setSubmitting(true);
    try {
      await register(email, password, {
        password_retype: passwordRetype,
        business_unit_id: businessUnitId || undefined,
      });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.error || 'Registration failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <HubLogo titleStyle={styles.title} iconSize={44} style={{ marginBottom: 'var(--space-1)' }} />
        <p style={styles.subtitle}>Create an account</p>
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
            placeholder={passwordLengthHint(minPasswordLength)}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="new-password"
            style={styles.input}
          />
          <input
            type="password"
            placeholder="Confirm password"
            value={passwordRetype}
            onChange={(e) => setPasswordRetype(e.target.value)}
            required
            autoComplete="new-password"
            style={styles.input}
          />
          <select
            value={businessUnitId}
            onChange={(e) => setBusinessUnitId(e.target.value)}
            style={styles.input}
            aria-label="Department"
          >
            <option value="">— No department —</option>
            {businessUnits.map((bu) => (
              <option key={bu.id} value={bu.id}>
                {bu.name}
              </option>
            ))}
          </select>
          <button type="submit" disabled={submitting} className="btn-primary" style={styles.button}>
            {submitting ? 'Creating account…' : 'Register'}
          </button>
        </form>
        <p style={styles.footer}>
          Already have an account? <Link to="/login">Sign in</Link>
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
