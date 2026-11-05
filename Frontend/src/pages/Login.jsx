import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { apiRequest } from '../api';
import { resolveIconSrc } from '../utils/resolveIconSrc';
import { getSsoLoginParams, resumeAfterLogin, ssoLoginBodyExtras } from '../lib/ssoReturnTo';
import ThemeToggle from '../components/ThemeToggle';
import { Icon } from '../components/HubIcons';

export default function Login() {
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [mfaChallenge, setMfaChallenge] = useState(null);
  const [magicLinkPending, setMagicLinkPending] = useState(null);
  const [otp, setOtp] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [appContext, setAppContext] = useState(null);
  const { login, verifyMfa, resendMagicLink } = useAuth();
  const navigate = useNavigate();
  const successMessage = location.state?.message;
  const { returnTo, clientId } = useMemo(
    () => getSsoLoginParams(location.search),
    [location.search]
  );
  const ssoExtras = useMemo(
    () => ssoLoginBodyExtras(returnTo, clientId),
    [returnTo, clientId]
  );

  useEffect(() => {
    const params = new URLSearchParams(location.search || '');
    const token = params.get('sso_verify');
    if (!token) return;
    let ignore = false;
    (async () => {
      try {
        const data = await apiRequest(`/api/auth/oidc/auto-link/verify?token=${encodeURIComponent(token)}`);
        if (!ignore) setError(data.message === 'linked' ? '' : 'Failed to verify SSO link');
      } catch (err) {
        if (!ignore) setError(err.error || 'SSO link verification failed');
      }
    })();
    return () => {
      ignore = true;
    };
  }, [location.search]);

  useEffect(() => {
    if (!clientId) {
      setAppContext(null);
      return undefined;
    }
    let ignore = false;
    (async () => {
      try {
        const data = await apiRequest(`/api/sso/login-context?client_id=${encodeURIComponent(clientId)}`);
        if (!ignore) setAppContext(data);
      } catch {
        if (!ignore) setAppContext(null);
      }
    })();
    return () => {
      ignore = true;
    };
  }, [clientId]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const result = await login(email, password, ssoExtras);
      if (result?.magic_link_required) {
        setMagicLinkPending(result);
        setMfaChallenge(null);
        setError('');
        return;
      }
      if (result?.mfa_required) {
        setMfaChallenge(result);
        setMagicLinkPending(null);
        setError('');
        return;
      }
      resumeAfterLogin(returnTo, navigate);
    } catch (err) {
      if (err.code === 'PASSWORD_EXPIRED') {
        navigate('/change-password-expired', {
          state: { email, returnTo, clientId },
          replace: true,
        });
        return;
      }
      if (err.status === 423 && err.code === 'ACCOUNT_LOCKED') {
        const until = err.locked_until ? new Date(err.locked_until).toLocaleString() : '';
        setError(err.error ? `${err.error} Try again after ${until || 'the lockout period'} or contact an administrator.` : 'Account locked. Try again later or contact an administrator.');
        return;
      }
      setError(err.error || 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleMfaSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await verifyMfa(mfaChallenge?.challenge_id, otp);
      resumeAfterLogin(returnTo, navigate);
    } catch (err) {
      setError(err.error || 'Verification failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResendMagicLink() {
    setSubmitting(true);
    setError('');
    try {
      const result = await resendMagicLink(email, password, magicLinkPending?.pending_id, ssoExtras);
      setMagicLinkPending(result);
    } catch (err) {
      setError(err.error || 'Failed to resend sign-in link');
    } finally {
      setSubmitting(false);
    }
  }

  const appIconSrc = appContext?.icon_url ? resolveIconSrc(appContext.icon_url) : null;

  return (
    <div className="hub-backdrop" style={s.page}>
      <div style={s.themeCorner}><ThemeToggle /></div>

      <section className="hub-hide-md" aria-label="About Downstream Hub" style={s.showcase}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <img src="/logo.png" alt="" width={38} height={38} style={{ objectFit: 'contain', filter: 'drop-shadow(0 0 12px rgba(232,116,58,0.55))' }} />
          <span style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 20 }}>Downstream Hub</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 48, flexWrap: 'wrap' }}>
          <Constellation />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 420 }}>
            <span className="hub-kicker">One secure gateway</span>
            <h1 style={s.h1}>Every tool.<br /><span className="hub-grad-text">One sign-in.</span></h1>
            <p style={{ margin: 0, fontSize: 17, color: 'var(--color-text-steel)' }}>
              From the jetty to the contract desk, every Downstream application connects through the Hub. Sign in once and you are ready to go.
            </p>
          </div>
        </div>

        <span style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>Single sign-on for your Downstream applications</span>
      </section>

      <main style={s.main}>
        <div style={s.cardEdge}>
          <div style={s.card}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <img src="/logo.png" alt="Downstream Hub" width={46} height={46} style={{ objectFit: 'contain', marginBottom: 6, filter: 'drop-shadow(0 0 12px rgba(232,116,58,0.5))' }} />
              <h2 style={s.h2}>{mfaChallenge ? 'Check your email' : magicLinkPending ? 'Check your inbox' : 'Welcome back'}</h2>
              {appContext?.app_name ? (
                <div style={s.appBanner}>
                  {appIconSrc && <img src={appIconSrc} alt="" style={s.appIcon} />}
                  <p style={{ margin: 0, fontSize: 14, color: 'var(--color-text-steel)', lineHeight: 1.4 }}>
                    Sign in to continue to <strong style={{ color: 'var(--color-text-charcoal)' }}>{appContext.app_name}</strong>
                  </p>
                </div>
              ) : (
                <p style={{ margin: 0, color: 'var(--color-text-steel)' }}>
                  {mfaChallenge ? 'Enter the verification code we sent you.' : 'Sign in with your work email to open your tools.'}
                </p>
              )}
            </div>

            {!mfaChallenge && !magicLinkPending ? (
              <form onSubmit={handleSubmit} style={s.form}>
                {successMessage && <div role="status" style={s.success}>{successMessage}</div>}
                {error && <div role="alert" style={s.error}>{error}</div>}
                <div style={s.field}>
                  <label htmlFor="login-email" style={s.label}>Work email</label>
                  <input
                    id="login-email"
                    className="hub-field"
                    type="email"
                    placeholder="name@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                  />
                </div>
                <div style={s.field}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                    <label htmlFor="login-password" style={s.label}>Password</label>
                    <Link to="/forgot-password" style={{ fontSize: 13, fontWeight: 500 }}>Forgot password?</Link>
                  </div>
                  <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                    <input
                      id="login-password"
                      className="hub-field"
                      type={showPassword ? 'text' : 'password'}
                      placeholder="Your password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      autoComplete="current-password"
                      style={{ paddingRight: 56 }}
                    />
                    <button
                      type="button"
                      className="hub-icon-btn"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      aria-pressed={showPassword}
                      onClick={() => setShowPassword((v) => !v)}
                      style={{ position: 'absolute', right: 4, padding: 0 }}
                    >
                      <Icon name={showPassword ? 'eyeOff' : 'eye'} size={20} />
                    </button>
                  </div>
                </div>
                <button type="submit" disabled={submitting} className="hub-btn-primary" style={s.submit}>
                  {submitting ? 'Signing in…' : <>Sign in <Icon name="arrowRight" size={18} strokeWidth={2.2} /></>}
                </button>
              </form>
            ) : magicLinkPending ? (
              <div style={s.form}>
                <div role="status" style={s.success}>
                  {magicLinkPending.message || 'We sent a sign-in link to your email. Open it on this device to continue.'}
                </div>
                {error && <div role="alert" style={s.error}>{error}</div>}
                <button type="button" disabled={submitting} className="hub-btn-primary" style={s.submit} onClick={handleResendMagicLink}>
                  {submitting ? 'Sending…' : 'Resend sign-in link'}
                </button>
                <button type="button" className="hub-icon-btn" style={s.secondary} onClick={() => { setMagicLinkPending(null); setError(''); }}>
                  <Icon name="arrowLeft" size={17} /> Back to sign in
                </button>
              </div>
            ) : (
              <form onSubmit={handleMfaSubmit} style={s.form}>
                <div role="status" style={s.success}>Verification code sent to your email.</div>
                {error && <div role="alert" style={s.error}>{error}</div>}
                <div style={s.field}>
                  <label htmlFor="login-otp" style={s.label}>Verification code</label>
                  <input
                    id="login-otp"
                    className="hub-field"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="6-digit code"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value)}
                    required
                    style={{ letterSpacing: '0.3em', fontSize: 18, fontVariantNumeric: 'tabular-nums' }}
                  />
                </div>
                <button type="submit" disabled={submitting} className="hub-btn-primary" style={s.submit}>
                  {submitting ? 'Verifying…' : 'Verify and continue'}
                </button>
              </form>
            )}

            <div style={s.note}>
              <Icon name="shield" size={20} style={{ color: '#14A396', marginTop: 1 }} />
              <p style={{ margin: 0, fontSize: 13, color: 'var(--color-text-steel)' }}>
                Signing in here also signs you in to every connected application. No more separate passwords.
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

/* Decorative orbit of the logo with abstract app nodes (no data is shown before sign-in). */
const NODES = [
  { icon: 'grid', tile: 'var(--hub-tile-ops)' },
  { icon: 'chart', tile: 'var(--hub-tile-com)' },
  { icon: 'users', tile: 'var(--hub-tile-ppl)' },
  { icon: 'globe', tile: 'var(--hub-tile-it)' },
  { icon: 'pulse', tile: 'var(--hub-tile-ops)' },
  { icon: 'building', tile: 'var(--hub-tile-com)' },
  { icon: 'calendar', tile: 'var(--hub-tile-ppl)' },
  { icon: 'lock', tile: 'var(--hub-tile-it)' },
];

function Constellation() {
  const C = 220;
  const n = NODES.length;
  return (
    <div aria-hidden="true" style={{ position: 'relative', flex: '0 0 440px', width: 440, height: 440 }}>
      <div className="hub-ring-a" style={{ ...s.ring, width: 430, height: 430, border: '1px dashed var(--hub-ring)' }} />
      <div className="hub-ring-b" style={{ ...s.ring, width: 310, height: 310, border: '1px solid var(--hub-ring)', borderTopColor: 'var(--hub-ring-accent)', borderRightColor: 'rgba(217,49,79,0.5)' }} />
      <div className="hub-ring-c" style={{ ...s.ring, width: 196, height: 196, border: '1px dashed rgba(217,49,79,0.35)' }} />
      {NODES.map((nd, i) => {
        const deg = -90 + (360 / n) * i;
        const r = i % 2 ? 155 : 210;
        const rad = (deg * Math.PI) / 180;
        const delay = `${(i * 0.6).toFixed(1)}s`;
        return (
          <div key={i}>
            <div className="hub-beam" style={{ position: 'absolute', left: C, top: C, width: r - 42, height: 1, transformOrigin: '0 50%', transform: `rotate(${deg}deg)`, background: 'linear-gradient(90deg, rgba(245,166,35,0.6), rgba(217,49,79,0.04))', animationDelay: delay }} />
            <span className="hub-node hub-glass" style={{ position: 'absolute', left: Math.round(C + r * Math.cos(rad) - 24), top: Math.round(C + r * Math.sin(rad) - 24), width: 48, height: 48, boxSizing: 'border-box', borderRadius: 15, display: 'flex', alignItems: 'center', justifyContent: 'center', animationDelay: delay }}>
              <span style={{ width: 36, height: 36, borderRadius: 11, background: nd.tile, color: '#FFFFFF', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name={nd.icon} size={18} />
              </span>
            </span>
          </div>
        );
      })}
      <div className="hub-core" style={{ ...s.ring, width: 120, height: 120, background: 'var(--hub-core-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <img src="/logo.png" alt="" width={56} height={56} style={{ objectFit: 'contain' }} />
      </div>
    </div>
  );
}

const s = {
  page: { display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', fontSize: 15, lineHeight: 1.5 },
  themeCorner: { position: 'absolute', top: 16, right: 16, zIndex: 2 },
  showcase: { position: 'relative', flex: '1 1 620px', padding: '48px 56px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 32 },
  h1: { margin: 0, fontFamily: 'var(--font-heading)', fontWeight: 900, fontSize: 50, lineHeight: 1.08, letterSpacing: '-0.02em', color: 'var(--color-text-charcoal)' },
  ring: { position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', borderRadius: '50%' },
  main: { position: 'relative', flex: '999 1 460px', minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '64px clamp(16px, 5vw, 64px)', boxSizing: 'border-box' },
  cardEdge: { width: '100%', maxWidth: 440, padding: 1, borderRadius: 28, background: 'linear-gradient(150deg, rgba(245,166,35,0.65), var(--hub-glass-border) 35%, var(--hub-glass-border) 65%, rgba(217,49,79,0.55))', boxShadow: 'var(--shadow-lg), 0 0 80px -30px rgba(232,116,58,0.45)' },
  card: { borderRadius: 27, background: 'var(--hub-overlay)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', padding: 'clamp(24px, 4vw, 40px)', display: 'flex', flexDirection: 'column', gap: 26, color: 'var(--color-text-charcoal)' },
  h2: { margin: 0, fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 30, letterSpacing: '-0.01em', color: 'var(--color-text-charcoal)' },
  appBanner: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 14, background: 'var(--hub-glass)', border: '1px solid var(--hub-glass-border)' },
  appIcon: { width: 32, height: 32, borderRadius: 8, objectFit: 'contain', flexShrink: 0 },
  form: { display: 'flex', flexDirection: 'column', gap: 18, margin: 0 },
  field: { display: 'flex', flexDirection: 'column', gap: 8 },
  label: { fontSize: 13, fontWeight: 600, color: 'var(--color-text-charcoal)' },
  submit: { height: 54, marginTop: 6, fontSize: 16 },
  secondary: { height: 48, width: '100%', border: '1px solid var(--hub-glass-border-strong)', color: 'var(--color-text-charcoal)' },
  success: { padding: '10px 14px', borderRadius: 12, background: 'var(--color-success-bg)', border: '1px solid var(--color-success-border)', color: 'var(--color-success-fg)', fontSize: 14 },
  error: { padding: '10px 14px', borderRadius: 12, background: 'var(--color-error-bg)', border: '1px solid var(--color-error-border)', color: 'var(--color-error-fg)', fontSize: 14 },
  note: { display: 'flex', alignItems: 'flex-start', gap: 12, padding: '14px 16px', borderRadius: 16, border: '1px solid rgba(20,163,150,0.3)', background: 'rgba(20,163,150,0.07)' },
};
