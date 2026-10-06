import { useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { apiRequest } from '../api';
import BugReportButton from './BugReportButton';

const HEARTBEAT_MS = 45 * 1000;

function postSilently(path, body) {
  apiRequest(path, { method: 'POST', body: JSON.stringify(body) }).catch(() => {
    /* best-effort telemetry; never surface to the user */
  });
}

/**
 * Invisible tracker rendered for the whole app. While a user is signed in it:
 *  - sends periodic heartbeats so the Hub can measure time-in-app, and
 *  - forwards uncaught JS errors / promise rejections to the server.
 * It also renders the floating "Report a bug" button for signed-in users.
 */
export default function ActivityTracker() {
  const { user } = useAuth();
  const loggedIn = !!user;
  const lastErrorRef = useRef({ msg: '', at: 0 });

  // Heartbeat loop (only while signed in).
  useEffect(() => {
    if (!loggedIn) return undefined;
    let cancelled = false;
    const beat = () => { if (!cancelled) postSilently('/api/activity/heartbeat', {}); };
    beat();
    const id = setInterval(beat, HEARTBEAT_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') beat(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loggedIn]);

  // Global client-error capture (only while signed in).
  useEffect(() => {
    if (!loggedIn) return undefined;

    const report = (message, stack) => {
      const msg = String(message || '').slice(0, 500);
      if (!msg) return;
      const now = Date.now();
      // de-dupe identical errors fired in quick succession
      if (lastErrorRef.current.msg === msg && now - lastErrorRef.current.at < 10000) return;
      lastErrorRef.current = { msg, at: now };
      postSilently('/api/activity/client-error', {
        message: msg,
        stack: stack ? String(stack).slice(0, 4000) : undefined,
        page_url: window.location.href,
      });
    };

    const onError = (event) => {
      report(event.message || (event.error && event.error.message), event.error && event.error.stack);
    };
    const onRejection = (event) => {
      const reason = event.reason;
      report(
        (reason && (reason.message || String(reason))) || 'Unhandled promise rejection',
        reason && reason.stack
      );
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, [loggedIn]);

  if (!loggedIn) return null;
  return <BugReportButton />;
}
