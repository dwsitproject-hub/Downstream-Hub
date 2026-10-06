import { useState } from 'react';
import { apiRequest } from '../api';

/** Floating "Report a bug" button + modal, shown for signed-in users. */
export default function BugReportButton() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  function reset() {
    setMessage('');
    setError('');
    setSent(false);
    setSubmitting(false);
  }

  function close() {
    setOpen(false);
    reset();
  }

  async function submit(e) {
    e.preventDefault();
    const text = message.trim();
    if (!text) { setError('Please describe the problem.'); return; }
    setSubmitting(true);
    setError('');
    try {
      await apiRequest('/api/activity/bug-report', {
        method: 'POST',
        body: JSON.stringify({ message: text, page_url: window.location.href }),
      });
      setSent(true);
    } catch (err) {
      setError(err.error || 'Could not submit. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} style={styles.fab} title="Report a bug" aria-label="Report a bug">
        <span style={styles.fabIcon} aria-hidden="true">🐞</span>
        <span style={styles.fabText}>Report a bug</span>
      </button>

      {open && (
        <div style={styles.overlay} onClick={close}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h2 style={styles.title}>Report a bug</h2>
            {sent ? (
              <>
                <p style={styles.subtitle}>Thanks — your report has been sent to the team.</p>
                <button type="button" className="btn-primary" style={styles.button} onClick={close}>Close</button>
              </>
            ) : (
              <form onSubmit={submit}>
                <p style={styles.subtitle}>Tell us what went wrong. We’ll include the page you’re on automatically.</p>
                {error && <div style={styles.error}>{error}</div>}
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  className="form-input"
                  style={styles.textarea}
                  rows={5}
                  placeholder="What happened? What did you expect?"
                  maxLength={5000}
                  autoFocus
                />
                <div style={styles.actions}>
                  <button type="button" className="btn-secondary" onClick={close} disabled={submitting}>Cancel</button>
                  <button type="submit" className="btn-primary" disabled={submitting}>
                    {submitting ? 'Sending…' : 'Send report'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}

const styles = {
  fab: {
    position: 'fixed', right: 'var(--space-4)', bottom: 'var(--space-4)', zIndex: 900,
    display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)',
    padding: '10px 14px', borderRadius: '999px', border: '1px solid var(--color-border-light)',
    background: 'var(--color-bg-white)', boxShadow: 'var(--shadow-md)', cursor: 'pointer',
    fontSize: 'var(--text-small)', color: 'var(--color-text-charcoal)', fontWeight: 'var(--font-weight-medium)',
  },
  fabIcon: { fontSize: '16px', lineHeight: 1 },
  fabText: {},
  overlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-3)',
  },
  modal: { background: 'var(--color-bg-white)', borderRadius: 'var(--radius-md)', padding: 'var(--space-5)', maxWidth: 460, width: '100%', boxShadow: 'var(--shadow-lg)' },
  title: { margin: '0 0 var(--space-2)', fontSize: 'var(--text-h3)', fontFamily: 'var(--font-heading)', fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-charcoal)' },
  subtitle: { margin: '0 0 var(--space-3)', color: 'var(--color-text-steel)', fontSize: 'var(--text-small)' },
  textarea: { resize: 'vertical', minHeight: 120 },
  actions: { display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)', marginTop: 'var(--space-3)' },
  button: { width: '100%' },
  error: { padding: 'var(--space-2)', background: '#FEE2E2', color: 'var(--color-destructive)', borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-small)', marginBottom: 'var(--space-3)' },
};
