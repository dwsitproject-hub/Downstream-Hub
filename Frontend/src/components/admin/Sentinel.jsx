import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from '../../api';
import AdminModal from './AdminModal';
import Markdown from './Markdown';

/*
 * Sentinel — the Hub's AI production-support agent, in the Analytic page:
 *   <SentinelBugAnalysis>  root-cause analysis inside a bug report
 *   <SentinelCard>         health report + "Ask Sentinel" for the Hub or one application
 *   <SentinelPill>         analysis state in bug lists
 */

const POLL_MS = 2500;
const ACTIVE = ['queued', 'running'];

const SEVERITY_TONE = { critical: 'red', high: 'red', medium: 'amber', low: 'grey' };
const HEALTH_TONE = { healthy: 'green', watch: 'amber', degraded: 'red', critical: 'red' };
const FINDING_TONE = { high: 'red', medium: 'amber', low: 'blue', info: 'grey' };
const PRIORITY_LABEL = { now: 'Now', soon: 'Soon', later: 'Later' };
const PRIORITY_TONE = { now: 'red', soon: 'amber', later: 'grey' };
const CATEGORY_LABEL = {
  code_defect: 'Code defect',
  data: 'Data issue',
  configuration: 'Configuration',
  infrastructure: 'Infrastructure',
  integration: 'Integration',
  user_error: 'User error',
  browser_or_extension: 'Browser / extension',
  unknown: 'Unclear',
};

let statusPromise = null;
function loadStatus(force = false) {
  if (!statusPromise || force) {
    statusPromise = apiRequest('/api/sentinel/status').catch(() => null);
  }
  return statusPromise;
}

function useSentinelStatus() {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    let ignore = false;
    loadStatus().then((s) => { if (!ignore) setStatus(s); });
    return () => { ignore = true; };
  }, []);
  return status;
}

/** Keep a run fresh while Sentinel works on it. */
function useRunPolling(run, onUpdate) {
  const id = run?.id;
  const active = ACTIVE.includes(run?.status);
  const cb = useRef(onUpdate);
  cb.current = onUpdate;
  useEffect(() => {
    if (!id || !active) return undefined;
    let stop = false;
    const t = setInterval(() => {
      apiRequest(`/api/sentinel/runs/${id}`)
        .then((d) => { if (!stop && d.run) cb.current(d.run); })
        .catch(() => {});
    }, POLL_MS);
    return () => { stop = true; clearInterval(t); };
  }, [id, active]);
}

function useElapsed(since, running) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  if (!since) return '';
  const secs = Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

function fmtTokens(n) {
  const v = Number(n || 0);
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

function fmtWhen(v) {
  return v ? new Date(v).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
}

/* ---------- building blocks ---------- */

export function SentinelMark({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3z" fill="#4338CA" />
      <circle cx="12" cy="11" r="3.2" fill="none" stroke="#fff" strokeWidth="1.8" />
      <circle cx="12" cy="11" r="1.1" fill="#fff" />
    </svg>
  );
}

function Pill({ tone = 'grey', children, title }) {
  const tones = {
    green: { background: '#DCFCE7', color: '#166534' },
    grey: { background: 'var(--color-bg-light)', color: 'var(--color-text-steel)' },
    red: { background: '#FEE2E2', color: '#B91C1C' },
    blue: { background: '#E0E7FF', color: '#3730A3' },
    amber: { background: '#FEF3C7', color: '#92400E' },
  };
  return <span title={title} style={{ ...s.pill, ...(tones[tone] || tones.grey) }}>{children}</span>;
}

/** Compact state for bug lists. */
export function SentinelPill({ status, severity, summary }) {
  if (!status) return <span style={s.muted}>—</span>;
  if (ACTIVE.includes(status)) return <Pill tone="blue" title="Sentinel is analysing this report">Analysing…</Pill>;
  if (status === 'done') return <Pill tone={SEVERITY_TONE[severity] || 'grey'} title={summary || undefined}>{severity ? `${severity[0].toUpperCase()}${severity.slice(1)}` : 'Analysed'}</Pill>;
  if (status === 'skipped') return <Pill tone="grey" title="Daily automatic limit reached">Not analysed</Pill>;
  return <Pill tone="grey">Analysis failed</Pill>;
}

function CopyButton({ text, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn-secondary btn-compact"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard blocked */ }
      }}
    >
      {copied ? 'Copied ✓' : label}
    </button>
  );
}

function Working({ run, label }) {
  const elapsed = useElapsed(run?.started_at || run?.created_at, true);
  return (
    <div style={s.working} role="status">
      <span className="sentinel-pulse" style={s.pulse} aria-hidden="true" />
      <span>
        <strong>{run?.status === 'queued' ? 'Queued' : label}</strong>
        <span style={s.muted}> · {elapsed} — investigations usually take 1–3 minutes. You can close this and come back.</span>
      </span>
    </div>
  );
}

function RunMeta({ run }) {
  if (!run) return null;
  const secs = run.result?.duration_ms ? Math.round(run.result.duration_ms / 1000) : null;
  return (
    <div style={s.meta}>
      {run.trigger === 'auto' ? 'Automatic' : `Requested by ${run.requested_by_email || 'an admin'}`}
      {' · '}{fmtWhen(run.finished_at || run.created_at)}
      {secs !== null && ` · ${secs}s`}
      {run.model && ` · ${run.model}`}
      {run.usage && ` · ${fmtTokens(run.usage.input_tokens)} in / ${fmtTokens(run.usage.output_tokens)} out tokens`}
      {run.tool_calls ? ` · ${run.tool_calls} tool call${run.tool_calls === 1 ? '' : 's'}` : ''}
    </div>
  );
}

/* ---------- bug analysis ---------- */

function AnalysisResult({ run, shared }) {
  const r = run.result || {};
  const evidence = Array.isArray(r.evidence) ? r.evidence : [];
  const steps = Array.isArray(r.next_steps) ? r.next_steps : [];
  const files = Array.isArray(r.files_examined) ? r.files_examined : [];
  return (
    <div>
      {shared && (
        <div style={s.note}>This is the same error as an earlier report; showing Sentinel&rsquo;s analysis of that occurrence.</div>
      )}
      <div style={s.summary}>{r.summary}</div>
      <div style={s.pillRow}>
        {r.severity && <Pill tone={SEVERITY_TONE[r.severity]}>Severity: {r.severity}</Pill>}
        {r.category && <Pill tone="blue">{CATEGORY_LABEL[r.category] || r.category}</Pill>}
        {r.confidence && <Pill tone={r.confidence === 'high' ? 'green' : r.confidence === 'medium' ? 'amber' : 'grey'}>Confidence: {r.confidence}</Pill>}
        {r.code_available === false && <Pill tone="amber" title="Connect the repository in Sentinel settings for code-level analysis">No source code</Pill>}
        {r.repo?.commit && <Pill tone="grey" title={`${r.repo.repo} @ ${r.repo.ref}`}>{r.repo.repo} @ {String(r.repo.commit).slice(0, 7)}</Pill>}
      </div>
      {r.impact && (<><h5 style={s.h5}>Impact</h5><Markdown text={r.impact} /></>)}
      <h5 style={s.h5}>Root cause</h5>
      <Markdown text={r.root_cause} />
      {evidence.length > 0 && (
        <>
          <h5 style={s.h5}>Evidence</h5>
          <ul style={s.evidence}>
            {evidence.map((e, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                <Pill tone="grey">{e.source}</Pill>{' '}
                {e.file && <code style={s.code}>{e.file}{e.line ? `:${e.line}` : ''}</code>}{' '}
                <span>{e.detail}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h5 style={s.h5}>Proposed fix</h5>
      <Markdown text={r.proposed_fix} />
      {r.patch && (
        <>
          <div style={s.patchHead}>
            <h5 style={{ ...s.h5, margin: 0 }}>Suggested patch</h5>
            <CopyButton text={r.patch} label="Copy patch" />
          </div>
          <pre style={s.diff}>{r.patch}</pre>
          <div style={s.meta}>Review before applying — Sentinel proposes, engineers decide. Apply with <code style={s.code}>git apply</code>.</div>
        </>
      )}
      {r.workaround && (<><h5 style={s.h5}>Workaround until fixed</h5><Markdown text={r.workaround} /></>)}
      {steps.length > 0 && (
        <>
          <h5 style={s.h5}>Next steps</h5>
          <ol style={s.list}>{steps.map((x, i) => <li key={i}>{x}</li>)}</ol>
        </>
      )}
      {files.length > 0 && (
        <details style={s.details}>
          <summary style={s.detailsSummary}>Files examined ({files.length})</summary>
          <div style={s.fileList}>{files.map((f) => <code key={f} style={s.code}>{f}</code>)}</div>
        </details>
      )}
      <RunMeta run={run} />
    </div>
  );
}

export function SentinelBugAnalysis({ report }) {
  const [state, setState] = useState({ loading: true, run: null, enabled: false, error: '' });
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let ignore = false;
    setState({ loading: true, run: null, enabled: false, error: '' });
    apiRequest(`/api/sentinel/bug-reports/${report.id}/analysis`)
      .then((d) => { if (!ignore) setState({ loading: false, run: d.run, enabled: d.enabled, error: '' }); })
      .catch((err) => { if (!ignore) setState({ loading: false, run: null, enabled: false, error: err.error || 'Could not load Sentinel' }); });
    return () => { ignore = true; };
  }, [report.id]);

  useRunPolling(state.run, (run) => setState((st) => ({ ...st, run })));

  async function analyze() {
    setStarting(true);
    try {
      const d = await apiRequest(`/api/sentinel/bug-reports/${report.id}/analyze`, { method: 'POST', body: '{}' });
      setState((st) => ({ ...st, run: d.run, error: '' }));
    } catch (err) {
      setState((st) => ({ ...st, error: err.error || 'Could not start the analysis' }));
    } finally {
      setStarting(false);
    }
  }

  const { run } = state;
  const active = ACTIVE.includes(run?.status);
  const canRun = state.enabled && !active;

  return (
    <section style={s.box} aria-label="Sentinel analysis">
      <div style={s.boxHead}>
        <div style={s.title}><SentinelMark /> <span>Sentinel analysis</span></div>
        {canRun && (
          <button type="button" className={run ? 'btn-secondary btn-compact' : 'btn-primary btn-compact'} onClick={analyze} disabled={starting}>
            {starting ? 'Starting…' : run ? 'Re-analyse' : 'Analyse with Sentinel'}
          </button>
        )}
      </div>
      {state.loading && <p style={s.muted}>Loading…</p>}
      {state.error && <div style={s.error}>{state.error}</div>}
      {!state.loading && !run && (
        <p style={s.muted}>
          {state.enabled
            ? 'Not analysed yet. Sentinel reads the report, the user’s session and the application’s code, then proposes the root cause and a fix.'
            : 'Sentinel is not configured on this server. An administrator adds ANTHROPIC_API_KEY to the backend environment to switch it on.'}
        </p>
      )}
      {active && <Working run={run} label="Sentinel is investigating" />}
      {run?.status === 'done' && <AnalysisResult run={run} shared={run.own === false} />}
      {run?.status === 'failed' && <div style={s.error}>The analysis failed: {run.error || 'unknown error'}</div>}
      {run?.status === 'skipped' && <p style={s.muted}>{run.error || 'Not analysed automatically.'}</p>}
    </section>
  );
}

/* ---------- breadcrumbs (shown in the bug view) ---------- */

export function Breadcrumbs({ context, release }) {
  const crumbs = Array.isArray(context?.breadcrumbs) ? context.breadcrumbs : [];
  if (crumbs.length === 0 && !release) return null;
  return (
    <>
      {crumbs.length > 0 && (
        <>
          <h5 style={s.h5}>What happened before (breadcrumbs)</h5>
          <ol style={s.crumbs}>
            {crumbs.map((c, i) => {
              const at = c.t ? new Date(c.t).toLocaleTimeString() : '';
              let body;
              if (c.type === 'http') {
                const bad = !c.status || c.status >= 400;
                body = <><Pill tone={bad ? 'red' : 'grey'}>{c.status || 'failed'}</Pill> <code style={s.code}>{c.method} {c.url}</code>{c.ms !== null && c.ms !== undefined && <span style={s.muted}> {c.ms} ms</span>}</>;
              } else if (c.type === 'console') body = <><Pill tone="amber">console.error</Pill> {c.message}</>;
              else if (c.type === 'nav') body = <><Pill tone="blue">page</Pill> <code style={s.code}>{c.path}</code></>;
              else body = <><Pill tone="grey">action</Pill> <code style={s.code}>{c.name}</code></>;
              return <li key={i} style={s.crumb}><span style={s.crumbTime}>{at}</span><span style={{ minWidth: 0 }}>{body}</span></li>;
            })}
          </ol>
        </>
      )}
      {release && <div style={s.meta}>App release: <code style={s.code}>{release}</code></div>}
    </>
  );
}

/* ---------- health report & questions for a scope ---------- */

function HealthResult({ run }) {
  const r = run.result || {};
  const metrics = Array.isArray(r.metrics) ? r.metrics : [];
  const findings = Array.isArray(r.findings) ? r.findings : [];
  const recs = Array.isArray(r.recommendations) ? r.recommendations : [];
  return (
    <div>
      <div style={s.pillRow}>
        <Pill tone={HEALTH_TONE[r.status] || 'grey'}>{r.status ? r.status[0].toUpperCase() + r.status.slice(1) : 'Report'}</Pill>
        <span style={s.muted}>Last {r.days || run.input?.days || 30} days</span>
      </div>
      <div style={s.summary}>{r.headline}</div>
      {metrics.length > 0 && (
        <div style={s.metricGrid}>
          {metrics.map((m, i) => (
            <div key={i} style={s.metric}>
              <div style={s.metricLabel}>{m.label}</div>
              <div style={s.metricValue}>{m.value}</div>
              {m.change && <div style={{ ...s.metricChange, color: m.direction === 'better' ? '#166534' : m.direction === 'worse' ? '#B91C1C' : 'var(--color-text-steel)' }}>{m.change}</div>}
            </div>
          ))}
        </div>
      )}
      <Markdown text={r.summary} />
      {findings.length > 0 && (
        <>
          <h5 style={s.h5}>Findings</h5>
          {findings.map((f, i) => (
            <div key={i} style={s.item}>
              <div style={s.itemHead}><Pill tone={FINDING_TONE[f.severity]}>{f.severity}</Pill> <strong>{f.title}</strong></div>
              <Markdown text={f.detail} compact />
            </div>
          ))}
        </>
      )}
      {recs.length > 0 && (
        <>
          <h5 style={s.h5}>Recommendations</h5>
          {recs.map((x, i) => (
            <div key={i} style={s.item}>
              <div style={s.itemHead}><Pill tone={PRIORITY_TONE[x.priority]}>{PRIORITY_LABEL[x.priority] || x.priority}</Pill> <strong>{x.title}</strong></div>
              <Markdown text={x.detail} compact />
            </div>
          ))}
        </>
      )}
      <RunMeta run={run} />
    </div>
  );
}

function AskThread({ thread, onUpdate }) {
  const last = thread[thread.length - 1];
  useRunPolling(last, (run) => onUpdate(run));
  return (
    <div>
      {thread.map((run) => (
        <div key={run.id} style={{ marginBottom: 'var(--space-3)' }}>
          <div style={s.question}>{run.input?.question}</div>
          {ACTIVE.includes(run.status) && <Working run={run} label="Sentinel is looking into it" />}
          {run.status === 'done' && (
            <div style={s.answer}>
              <Markdown text={run.result?.answer} />
              <RunMeta run={run} />
            </div>
          )}
          {run.status === 'failed' && <div style={s.error}>Sentinel could not answer: {run.error}</div>}
        </div>
      ))}
    </div>
  );
}

const SUGGESTIONS = {
  app: [
    'Which pages lose the most users, and why might that be?',
    'Who stopped using the app this month?',
    'What are the top 3 problems users hit this week?',
  ],
  hub: [
    'Which applications are growing or declining?',
    'Are there login or SSO problems this week?',
    'Which departments use the Hub the least?',
  ],
};

export function SentinelCard({ scope, scopeName, days }) {
  const status = useSentinelStatus();
  const [config, setConfig] = useState(null);
  const [recent, setRecent] = useState([]);
  const [view, setView] = useState(null); // { kind: 'health', run } | { kind: 'ask', thread }
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  const loadRecent = useCallback(() => {
    apiRequest(`/api/sentinel/runs?scope=${scope}&limit=12`)
      .then((d) => setRecent((d.runs || []).filter((r) => r.kind !== 'bug')))
      .catch(() => setRecent([]));
  }, [scope]);

  useEffect(() => {
    setView(null);
    setQuestion('');
    setError('');
    loadRecent();
    apiRequest(`/api/sentinel/config/${scope}`).then((d) => setConfig(d.config)).catch(() => setConfig(null));
  }, [scope, loadRecent]);

  const enabled = Boolean(status?.enabled);

  async function startHealth() {
    setBusy(true);
    setError('');
    try {
      const d = await apiRequest(`/api/sentinel/scopes/${scope}/health`, { method: 'POST', body: JSON.stringify({ days }) });
      setView({ kind: 'health', run: d.run });
      loadRecent();
    } catch (err) {
      setError(err.error || 'Could not start the health report');
    } finally {
      setBusy(false);
    }
  }

  async function ask(text) {
    const q = String(text || '').trim();
    if (!q) return;
    setBusy(true);
    setError('');
    const thread = view?.kind === 'ask' ? view.thread : [];
    const parent = [...thread].reverse().find((r) => r.status === 'done');
    try {
      const d = await apiRequest(`/api/sentinel/scopes/${scope}/ask`, {
        method: 'POST',
        body: JSON.stringify({ question: q, parent_id: parent?.id }),
      });
      setView({ kind: 'ask', thread: [...thread, d.run] });
      setQuestion('');
      loadRecent();
    } catch (err) {
      setError(err.error || 'Could not send the question');
    } finally {
      setBusy(false);
    }
  }

  function openRun(run) {
    setView(run.kind === 'health' ? { kind: 'health', run } : { kind: 'ask', thread: [run] });
  }

  const healthRun = view?.kind === 'health' ? view.run : null;
  useRunPolling(healthRun, (run) => { setView({ kind: 'health', run }); if (!ACTIVE.includes(run.status)) loadRecent(); });
  const threadBusy = view?.kind === 'ask' && ACTIVE.includes(view.thread[view.thread.length - 1]?.status);
  const suggestions = SUGGESTIONS[scope === 'hub' ? 'hub' : 'app'];

  return (
    <section style={s.card} aria-label="Sentinel">
      <div style={s.cardHead}>
        <div style={{ minWidth: 0 }}>
          <div style={s.title}><SentinelMark size={22} /> <span style={{ fontSize: 'var(--text-base)' }}>Sentinel</span>
            {status && (enabled ? <Pill tone="green">On</Pill> : <Pill tone="grey">Off</Pill>)}
          </div>
          <div style={s.sub}>
            AI production support for {scopeName}: root-causes bugs automatically, reports on health, answers questions.
            {' '}{config?.repo
              ? <>Reads code from <code style={s.code}>{config.repo}@{config.branch}</code>.</>
              : <span style={{ color: '#92400E' }}>No repository connected — analyses use runtime evidence only.</span>}
          </div>
        </div>
        <div style={s.actions}>
          <button type="button" className="btn-primary btn-compact" disabled={!enabled || busy || ACTIVE.includes(healthRun?.status)} onClick={startHealth}>
            Health report ({days} days)
          </button>
          <button type="button" className="btn-secondary btn-compact" onClick={() => setShowSettings(true)}>Sentinel settings</button>
        </div>
      </div>

      {status && !enabled && (
        <div style={s.note}>
          Sentinel is off on this server. To switch it on, add <code style={s.code}>ANTHROPIC_API_KEY</code> (and optionally <code style={s.code}>SENTINEL_GITHUB_TOKEN</code>) to the backend <code style={s.code}>.env</code> and rebuild the backend. You can already connect repositories in Sentinel settings.
        </div>
      )}

      {enabled && (
        <form
          style={s.askRow}
          onSubmit={(e) => { e.preventDefault(); ask(question); }}
        >
          <input
            className="form-input"
            style={{ flex: 1, minWidth: 0 }}
            value={question}
            maxLength={2000}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={view?.kind === 'ask' ? 'Ask a follow-up…' : `Ask Sentinel about ${scopeName}…`}
            aria-label="Question for Sentinel"
            disabled={busy || threadBusy}
          />
          <button type="submit" className="btn-primary btn-compact" disabled={busy || threadBusy || !question.trim()}>Ask</button>
          {view?.kind === 'ask' && (
            <button type="button" className="btn-secondary btn-compact" onClick={() => setView(null)}>New question</button>
          )}
        </form>
      )}
      {enabled && !view && (
        <div style={s.suggestions}>
          {suggestions.map((q) => (
            <button key={q} type="button" className="an-seg" style={s.suggestion} onClick={() => ask(q)} disabled={busy}>{q}</button>
          ))}
        </div>
      )}

      {error && <div style={s.error}>{error}</div>}

      {view && (
        <div style={s.result}>
          <div style={s.resultHead}>
            <strong>{view.kind === 'health' ? 'Health report' : 'Conversation'}</strong>
            <button type="button" className="an-link" onClick={() => setView(null)}>Close</button>
          </div>
          {view.kind === 'health' && ACTIVE.includes(view.run.status) && <Working run={view.run} label="Sentinel is reviewing the data" />}
          {view.kind === 'health' && view.run.status === 'done' && <HealthResult run={view.run} />}
          {view.kind === 'health' && view.run.status === 'failed' && <div style={s.error}>The health report failed: {view.run.error}</div>}
          {view.kind === 'ask' && (
            <AskThread
              thread={view.thread}
              onUpdate={(run) => {
                setView((v) => (v?.kind === 'ask' ? { kind: 'ask', thread: v.thread.map((r) => (r.id === run.id ? run : r)) } : v));
                if (!ACTIVE.includes(run.status)) loadRecent();
              }}
            />
          )}
        </div>
      )}

      {recent.length > 0 && (
        <details style={s.details}>
          <summary style={s.detailsSummary}>Recent reports and questions ({recent.length})</summary>
          <ul style={s.recent}>
            {recent.map((r) => (
              <li key={r.id}>
                <button type="button" className="an-link" style={s.recentBtn} onClick={() => openRun(r)}>
                  {r.kind === 'health' ? `Health report · ${r.input?.days || 30} days` : `“${String(r.input?.question || '').slice(0, 90)}”`}
                </button>
                <span style={s.muted}> · {fmtWhen(r.created_at)}{r.status !== 'done' ? ` · ${r.status}` : ''}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {showSettings && (
        <SentinelSettingsModal
          scope={scope}
          scopeName={scopeName}
          githubToken={status?.github_token}
          onClose={() => setShowSettings(false)}
          onSaved={(c) => { setConfig(c); setShowSettings(false); }}
        />
      )}
    </section>
  );
}

/* ---------- settings ---------- */

function SentinelSettingsModal({ scope, scopeName, githubToken, onClose, onSaved }) {
  const [form, setForm] = useState({ repo: '', branch: 'main', source_root: '', notes: '', auto_analyze: true });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    apiRequest(`/api/sentinel/config/${scope}`)
      .then((d) => {
        const c = d.config || {};
        setForm({ repo: c.repo || '', branch: c.branch || 'main', source_root: c.source_root || '', notes: c.notes || '', auto_analyze: c.auto_analyze !== false });
      })
      .catch((err) => setError(err.error || 'Could not load settings'))
      .finally(() => setLoading(false));
  }, [scope]);

  const set = (k) => (e) => { setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })); setTest(null); };

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest(await apiRequest(`/api/sentinel/config/${scope}/test`, { method: 'POST', body: JSON.stringify(form) }));
    } catch (err) {
      setTest({ ok: false, error: err.error || 'Test failed' });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      const d = await apiRequest(`/api/sentinel/config/${scope}`, { method: 'PUT', body: JSON.stringify(form) });
      onSaved(d.config);
    } catch (err) {
      setError(err.error || 'Could not save');
      setSaving(false);
    }
  }

  return (
    <AdminModal
      title={`Sentinel settings · ${scopeName}`}
      size="lg"
      onClose={onClose}
      disableClose={saving}
      footer={(
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-2)' }}>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="btn-primary" onClick={save} disabled={saving || loading}>{saving ? 'Saving…' : 'Save settings'}</button>
        </div>
      )}
    >
      {loading ? <p style={s.muted}>Loading…</p> : (
        <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
          <p style={{ ...s.muted, margin: 0 }}>
            Connect the application&rsquo;s repository so Sentinel can read the code behind an error and propose a concrete fix.
            Access is read-only; Sentinel never changes code.
          </p>
          <label style={s.label}>
            GitHub repository
            <input className="form-input" value={form.repo} onChange={set('repo')} placeholder="dwsitproject-hub/klip-frontend" />
            <span style={s.hint}>owner/name or a github.com URL. Leave empty to analyse without code.</span>
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
            <label style={s.label}>
              Branch
              <input className="form-input" value={form.branch} onChange={set('branch')} placeholder="main" />
              <span style={s.hint}>Used unless the app reports its release (data-release).</span>
            </label>
            <label style={s.label}>
              Application folder (optional)
              <input className="form-input" value={form.source_root} onChange={set('source_root')} placeholder="frontend/" />
              <span style={s.hint}>For monorepos: where this app&rsquo;s code lives.</span>
            </label>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <button type="button" className="btn-secondary btn-compact" onClick={runTest} disabled={testing || !form.repo.trim()}>
              {testing ? 'Checking…' : 'Test repository access'}
            </button>
            {test?.ok && <span style={{ color: '#166534', fontSize: 'var(--text-small)' }}>✓ Can read {test.repo} @ {test.branch} ({String(test.commit).slice(0, 7)}{test.private ? ', private' : ''})</span>}
            {test && !test.ok && <span style={{ color: 'var(--color-destructive)', fontSize: 'var(--text-small)' }}>{test.error}</span>}
          </div>
          {!githubToken && (
            <div style={s.note}>No <code style={s.code}>SENTINEL_GITHUB_TOKEN</code> on the server, so only public repositories can be read.</div>
          )}
          <label style={s.label}>
            Notes for Sentinel (optional)
            <textarea className="form-input" rows={5} value={form.notes} onChange={set('notes')} maxLength={4000}
              placeholder={'Stack, architecture, known quirks, who owns what. e.g.\nReact 18 + Vite SPA; API is Express at /api; orders sync from SAP nightly at 01:00.'} />
            <span style={s.hint}>Context Sentinel reads before every investigation.</span>
          </label>
          <label style={{ ...s.label, flexDirection: 'row', alignItems: 'center', gap: 'var(--space-2)' }}>
            <input type="checkbox" checked={form.auto_analyze} onChange={set('auto_analyze')} />
            Analyse new bug reports and JS errors automatically
          </label>
          <span style={{ ...s.hint, marginTop: -8 }}>Repeats of the same error are analysed once. Turn off to analyse only on request.</span>
          {error && <div style={s.error}>{error}</div>}
        </div>
      )}
    </AdminModal>
  );
}

/* ---------- styles ---------- */

const s = {
  card: { background: 'linear-gradient(180deg, #EEF2FF 0%, var(--color-bg-white) 90px)', border: '1px solid #C7D2FE', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)', padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', minWidth: 0 },
  cardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--space-3)', flexWrap: 'wrap' },
  title: { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 'var(--font-weight-semibold)', color: 'var(--color-text-charcoal)' },
  sub: { fontSize: 'var(--text-small)', color: 'var(--color-text-steel)', marginTop: 4, maxWidth: 760 },
  actions: { display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' },
  askRow: { display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' },
  suggestions: { display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginTop: -4 },
  suggestion: { fontSize: 'var(--text-xs)', borderRadius: 999 },
  result: { background: 'var(--color-bg-white)', border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3) var(--space-4)' },
  resultHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-2)' },
  question: { fontWeight: 'var(--font-weight-semibold)', fontSize: 'var(--text-small)', background: 'var(--color-bg-light)', borderRadius: 'var(--radius-md)', padding: '8px 12px', marginBottom: 'var(--space-2)', whiteSpace: 'pre-wrap' },
  answer: { paddingLeft: 4 },
  recent: { listStyle: 'none', margin: 'var(--space-2) 0 0', padding: 0, display: 'grid', gap: 4, fontSize: 'var(--text-small)' },
  recentBtn: { textAlign: 'left' },

  box: { marginTop: 'var(--space-4)', border: '1px solid #C7D2FE', background: '#F8FAFF', borderRadius: 'var(--radius-md)', padding: 'var(--space-3) var(--space-4)' },
  boxHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-2)', marginBottom: 'var(--space-2)' },
  summary: { fontWeight: 'var(--font-weight-semibold)', fontSize: 'var(--text-base)', color: 'var(--color-text-charcoal)', margin: 'var(--space-1) 0 var(--space-2)', lineHeight: 1.4 },
  pillRow: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 'var(--space-2)' },
  pill: { display: 'inline-block', padding: '2px 10px', borderRadius: 999, fontSize: 'var(--text-xs)', fontWeight: 600, whiteSpace: 'nowrap' },
  h5: { margin: 'var(--space-3) 0 var(--space-1)', fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-steel)', fontWeight: 'var(--font-weight-semibold)' },
  evidence: { margin: 0, paddingLeft: 18, fontSize: 'var(--text-small)' },
  list: { margin: 0, paddingLeft: 20, fontSize: 'var(--text-small)' },
  patchHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: 'var(--space-3) 0 var(--space-1)' },
  diff: { whiteSpace: 'pre', background: '#0B1220', color: '#E5E7EB', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)', fontSize: 12, lineHeight: 1.5, overflow: 'auto', maxHeight: 360, margin: 0 },
  details: { marginTop: 'var(--space-2)', fontSize: 'var(--text-small)' },
  detailsSummary: { cursor: 'pointer', color: 'var(--color-text-steel)' },
  fileList: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  code: { fontFamily: 'Consolas, Menlo, monospace', fontSize: 12, background: 'var(--color-bg-light)', padding: '1px 6px', borderRadius: 4, wordBreak: 'break-all' },
  meta: { marginTop: 'var(--space-3)', fontSize: 'var(--text-xs)', color: 'var(--color-text-steel)' },
  muted: { color: 'var(--color-text-steel)', fontSize: 'var(--text-small)', margin: 0 },
  note: { padding: '8px 12px', background: '#FEF3C7', color: '#78350F', border: '1px solid #FCD34D', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-small)' },
  error: { padding: '8px 12px', background: '#FEE2E2', color: 'var(--color-destructive)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-small)' },
  working: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: '#EEF2FF', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-small)', color: '#3730A3' },
  pulse: { width: 10, height: 10, borderRadius: '50%', background: '#4F46E5', flexShrink: 0 },
  item: { borderLeft: '3px solid var(--color-border-light)', padding: '2px 0 2px 10px', marginBottom: 'var(--space-2)' },
  itemHead: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 2, fontSize: 'var(--text-small)' },
  metricGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 'var(--space-2)', margin: 'var(--space-2) 0 var(--space-3)' },
  metric: { border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-md)', padding: '8px 10px', background: 'var(--color-bg-white)' },
  metricLabel: { fontSize: 'var(--text-xs)', color: 'var(--color-text-steel)', textTransform: 'uppercase', letterSpacing: '0.04em' },
  metricValue: { fontSize: 20, fontWeight: 'var(--font-weight-bold)', color: 'var(--color-text-charcoal)' },
  metricChange: { fontSize: 'var(--text-xs)' },
  crumbs: { listStyle: 'none', margin: 0, padding: 0, fontSize: 'var(--text-small)', display: 'grid', gap: 4 },
  crumb: { display: 'flex', gap: 10, alignItems: 'baseline' },
  crumbTime: { color: 'var(--color-text-steel)', fontSize: 'var(--text-xs)', fontVariantNumeric: 'tabular-nums', minWidth: 70 },
  label: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--text-small)', fontWeight: 'var(--font-weight-medium)', color: 'var(--color-text-charcoal)' },
  hint: { fontSize: 'var(--text-xs)', color: 'var(--color-text-steel)', fontWeight: 'var(--font-weight-normal)' },
};
