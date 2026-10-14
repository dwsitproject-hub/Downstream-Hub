/**
 * The tools Sentinel can call. Each tool returns plain JSON; the agent loop pseudonymises
 * it before it reaches the model. Everything here is read-only.
 */
const analyticsDb = require('../../db/analyticsDb');
const sentinelDb = require('../../db/sentinelDb');
const { getSnapshot } = require('./github');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ---------- tool definitions (JSON schema for the model) ---------- */

const APP_REPORTS = ['summary', 'daily', 'pages', 'users', 'user_activity', 'page_activity', 'tracked_actions', 'errors', 'bug_reports'];
const HUB_REPORTS = ['summary', 'daily', 'apps', 'users', 'user_activity', 'errors', 'bug_reports'];

function queryAnalyticsDef(hub) {
  const reports = hub ? HUB_REPORTS : APP_REPORTS;
  const help = hub
    ? 'summary = headline usage of the Hub portal + bug counts; daily = app opens and errors per day; apps = most-opened applications; users = most active users; user_activity = one user (needs email); errors = JS errors grouped by fingerprint; bug_reports = recent reports (filter by status/kind).'
    : 'summary = this period vs the previous period (sessions, users, time, page views, errors, new and lapsed users); daily = page views, sessions and errors per day; pages = pages with views now vs before; users = identified users with sessions/time; user_activity = one user\'s sessions, pages and actions (needs email); page_activity = recent views of one page (needs path); tracked_actions = custom events; errors = JS errors grouped by fingerprint; bug_reports = recent reports (filter by status/kind).';
  return {
    name: 'query_analytics',
    description: `Read usage analytics and bug data for the application under investigation. ${help} Users appear as pseudonymous emails; pass them back exactly as you saw them.`,
    input_schema: {
      type: 'object',
      properties: {
        report: { type: 'string', enum: reports },
        days: { type: 'integer', minimum: 1, maximum: 365, description: 'Look-back window in days (default 30).' },
        email: { type: 'string', description: 'For user_activity.' },
        path: { type: 'string', description: 'For page_activity, e.g. "/orders".' },
        status: { type: 'string', enum: ['open', 'resolved'], description: 'For bug_reports.' },
        kind: { type: 'string', enum: ['user_report', 'client_error'], description: 'For bug_reports.' },
      },
      required: ['report'],
    },
  };
}

const CODE_TOOL_DEFS = [
  {
    name: 'list_files',
    description: 'List the application repository. Give `path` for a directory listing, or `pattern` to find files whose path contains that text (e.g. "OrderForm", "api/orders"). Only text/source files are included (no node_modules, builds, lockfiles).',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, pattern: { type: 'string' } },
    },
  },
  {
    name: 'search_code',
    description: 'Search every source file for a string (case-insensitive) or a regular expression. Returns "path:line: text" matches. Use distinctive text from the error message, function or component names from the stack, or API paths from breadcrumbs.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        regex: { type: 'boolean', description: 'Treat query as a JavaScript regular expression.' },
        path: { type: 'string', description: 'Only search under this directory.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a source file with line numbers (up to 400 lines per call; use start_line/end_line for long files).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        start_line: { type: 'integer', minimum: 1 },
        end_line: { type: 'integer', minimum: 1 },
      },
      required: ['path'],
    },
  },
];

const BUG_TOOL_DEFS = [
  {
    name: 'get_session_timeline',
    description: 'The user\'s browser session in the app around the time of the bug: pages viewed and tracked actions in order, session start, browser, and other reports in the same session.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'find_related_reports',
    description: 'How widespread this error is (occurrences, affected users, first/last seen, app releases) and other errors captured for the same user/session within 30 minutes of the report.',
    input_schema: { type: 'object', properties: {} },
  },
];

const GET_BUG_DEF = {
  name: 'get_bug_report',
  description: 'Full details of one bug report (message, stack, page, breadcrumbs) and Sentinel\'s latest analysis of it, by report id.',
  input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

const SUBMIT_ANALYSIS_DEF = {
  name: 'submit_analysis',
  description: 'Submit the finished root-cause analysis. Call exactly once, when the investigation is complete.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One sentence: what is broken and why.' },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
      category: { type: 'string', enum: ['code_defect', 'data', 'configuration', 'infrastructure', 'integration', 'user_error', 'browser_or_extension', 'unknown'] },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      impact: { type: 'string', description: 'Who/what is affected and how badly, using the numbers you found.' },
      root_cause: { type: 'string', description: 'Markdown. The causal chain, citing file:line you actually read.' },
      evidence: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            source: { type: 'string', enum: ['stack', 'code', 'session', 'breadcrumbs', 'analytics', 'report'] },
            detail: { type: 'string' },
            file: { type: 'string' },
            line: { type: 'integer' },
          },
          required: ['source', 'detail'],
        },
      },
      proposed_fix: { type: 'string', description: 'Markdown. What to change and why, step by step.' },
      patch: { type: 'string', description: 'Optional unified diff (git format) against files you read. Only when confident.' },
      workaround: { type: 'string', description: 'Optional: what users or support can do until the fix ships.' },
      next_steps: { type: 'array', items: { type: 'string' }, description: 'Verification steps, tests to add, or information still needed.' },
      files_examined: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'severity', 'category', 'confidence', 'impact', 'root_cause', 'proposed_fix'],
  },
};

const SUBMIT_HEALTH_DEF = {
  name: 'submit_health_report',
  description: 'Submit the finished health report. Call exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      headline: { type: 'string', description: 'One sentence verdict.' },
      status: { type: 'string', enum: ['healthy', 'watch', 'degraded', 'critical'] },
      summary: { type: 'string', description: 'Markdown, 3-6 sentences.' },
      metrics: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            value: { type: 'string' },
            change: { type: 'string', description: 'e.g. "+12% vs previous period"' },
            direction: { type: 'string', enum: ['better', 'worse', 'neutral'] },
          },
          required: ['label', 'value'],
        },
      },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            detail: { type: 'string', description: 'Markdown with the supporting numbers.' },
            severity: { type: 'string', enum: ['info', 'low', 'medium', 'high'] },
          },
          required: ['title', 'detail', 'severity'],
        },
      },
      recommendations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            detail: { type: 'string' },
            priority: { type: 'string', enum: ['now', 'soon', 'later'] },
          },
          required: ['title', 'detail', 'priority'],
        },
      },
    },
    required: ['headline', 'status', 'summary', 'findings', 'recommendations'],
  },
};

/* ---------- handlers ---------- */

function days(input, fallback = 30) {
  return Math.max(1, Math.min(365, parseInt(input?.days, 10) || fallback));
}

/** The model passes pseudonyms back; map them to the real address for the query. */
function realEmail(ctx, value) {
  const v = String(value || '').trim();
  const real = ctx.privacy.toEmail.get(v.toLowerCase()) || v;
  return EMAIL_RE.test(real) ? real : null;
}

async function appAnalytics(ctx, input) {
  const { db, scope } = ctx;
  const d = days(input, ctx.defaultDays);
  switch (input.report) {
    case 'summary': {
      const [cmp, usage] = await Promise.all([sentinelDb.appPeriodComparison(db, scope, d), analyticsDb.appUsage(db, scope, d)]);
      return { period_days: d, comparison_with_previous_period: cmp, kpi: usage.kpi };
    }
    case 'daily': {
      const [usage, errs] = await Promise.all([analyticsDb.appUsage(db, scope, d), sentinelDb.errorsByDay(db, scope, d)]);
      return { period_days: d, page_views_by_day: usage.pageViewsByDay, sessions_by_day: usage.sessionsByDay, errors_by_day: errs };
    }
    case 'pages':
      return { period_days: d, pages: await sentinelDb.pageTrends(db, scope, d, 25) };
    case 'users': {
      const r = await analyticsDb.appUsersUsage(db, scope, d);
      return { period_days: d, users: r.users.slice(0, 30), total_identified_users: r.users.length, anonymous_sessions: r.anonymous_sessions };
    }
    case 'user_activity': {
      const email = realEmail(ctx, input.email);
      if (!email) return { error: 'user_activity needs the email of a user you saw in another result.' };
      return { period_days: d, ...(await analyticsDb.appUserUsage(db, scope, d, { email })) };
    }
    case 'page_activity': {
      if (!input.path) return { error: 'page_activity needs a path.' };
      const r = await analyticsDb.appPageViews(db, scope, d, { path: String(input.path).slice(0, 500), limit: 50 });
      return { period_days: d, total: r.total, recent_views: r.rows };
    }
    case 'tracked_actions':
      return { period_days: d, actions: (await analyticsDb.appUsage(db, scope, d)).topEvents };
    case 'errors':
      return { period_days: d, error_groups: await sentinelDb.errorGroups(db, scope, d, 20) };
    case 'bug_reports':
      return { period_days: d, reports: await sentinelDb.bugReports(db, scope, { status: input.status, kind: input.kind, days: d }) };
    default:
      return { error: `Unknown report "${input.report}". Use one of: ${APP_REPORTS.join(', ')}.` };
  }
}

async function hubAnalytics(ctx, input) {
  const { db } = ctx;
  const d = days(input, ctx.defaultDays);
  switch (input.report) {
    case 'summary': {
      const [ov, prev] = await Promise.all([analyticsDb.overview(db, d), analyticsDb.overview(db, Math.min(365, d * 2))]);
      return { period_days: d, current: ov, current_plus_previous_period: prev };
    }
    case 'daily': {
      const [opens, errs] = await Promise.all([analyticsDb.launchesByDay(db, d), sentinelDb.errorsByDay(db, 'hub', d)]);
      return { period_days: d, app_opens_by_day: opens, errors_by_day: errs };
    }
    case 'apps':
      return { period_days: d, apps: await analyticsDb.topApps(db, d, 25) };
    case 'users':
      return { period_days: d, users: await analyticsDb.activeUsers(db, d, { limit: 30, orderBy: 'launches' }) };
    case 'user_activity': {
      const email = realEmail(ctx, input.email);
      if (!email) return { error: 'user_activity needs the email of a user you saw in another result.' };
      const { rows } = await db.query('SELECT id FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL', [email]);
      if (!rows[0]) return { error: 'No Hub user with that email.' };
      const [summary, apps, sessions] = await Promise.all([
        analyticsDb.userSummary(db, rows[0].id, d),
        analyticsDb.appsForUser(db, rows[0].id, d),
        analyticsDb.sessions(db, d, { userId: rows[0].id, limit: 15 }),
      ]);
      return { period_days: d, user: summary, apps, recent_sessions: sessions.rows };
    }
    case 'errors':
      return { period_days: d, error_groups: await sentinelDb.errorGroups(db, 'hub', d, 20) };
    case 'bug_reports':
      return { period_days: d, reports: await sentinelDb.bugReports(db, 'hub', { status: input.status, kind: input.kind, days: d }) };
    default:
      return { error: `Unknown report "${input.report}". Use one of: ${HUB_REPORTS.join(', ')}.` };
  }
}

async function snapshot(ctx) {
  if (!ctx.snapshotPromise) {
    const { config } = ctx;
    ctx.snapshotPromise = getSnapshot(ctx.cfg, {
      repo: config.repo,
      ref: ctx.release || config.branch,
      fallbackRef: config.branch,
      sourceRoot: config.source_root,
    });
  }
  const snap = await ctx.snapshotPromise;
  ctx.repoInfo = snap.describe();
  return snap;
}

async function codeTool(ctx, name, input) {
  let snap;
  try {
    snap = await snapshot(ctx);
  } catch (err) {
    ctx.snapshotPromise = null;
    return { error: `Source code unavailable: ${err.message}` };
  }
  if (name === 'list_files') return snap.list(input || {});
  if (name === 'search_code') {
    if (!input?.query) return { error: 'query is required' };
    return snap.search({ query: String(input.query).slice(0, 200), regex: Boolean(input.regex), path: input.path });
  }
  const r = snap.read(input || {});
  if (!r.error) ctx.filesRead.add(r.path);
  return r;
}

async function getBugReport(ctx, input) {
  const bug = await sentinelDb.getBug(ctx.db, input?.id);
  if (!bug || (bug.application_id || 'hub') !== ctx.scope) return { error: 'No bug report with that id in this application.' };
  const run = await sentinelDb.latestForBug(ctx.db, bug);
  return {
    report: { ...bug, user_id: undefined },
    sentinel_analysis: run?.status === 'done' ? run.result : run ? { status: run.status } : null,
  };
}

/**
 * Tool set for a run. ctx: { db, cfg, scope, hub, config, bug?, release?, privacy, filesRead }
 * Returns { defs, handlers } — handlers[name](input) -> { data, code }.
 */
function buildTools(ctx, kind) {
  const defs = [queryAnalyticsDef(ctx.hub)];
  const handlers = {
    query_analytics: async (input) => ({ data: await (ctx.hub ? hubAnalytics(ctx, input || {}) : appAnalytics(ctx, input || {})) }),
  };
  const withCode = Boolean(ctx.config.repo) && kind !== 'health';
  if (withCode) {
    defs.push(...CODE_TOOL_DEFS);
    for (const def of CODE_TOOL_DEFS) {
      handlers[def.name] = async (input) => ({ data: await codeTool(ctx, def.name, input), code: true });
    }
  }
  if (kind === 'bug') {
    defs.push(...BUG_TOOL_DEFS, SUBMIT_ANALYSIS_DEF);
    handlers.get_session_timeline = async () => ({
      data: (await sentinelDb.sessionTimeline(ctx.db, ctx.bug)) || { note: 'No in-app session recorded for this report (reported from the Hub itself, or before the SDK was installed).' },
    });
    handlers.find_related_reports = async () => ({ data: await sentinelDb.similarReports(ctx.db, ctx.bug) });
  }
  if (kind === 'health') defs.push(SUBMIT_HEALTH_DEF);
  if (kind === 'ask') {
    defs.push(GET_BUG_DEF);
    handlers.get_bug_report = async (input) => ({ data: await getBugReport(ctx, input) });
  }
  return { defs, handlers, withCode };
}

module.exports = { buildTools, appAnalytics, hubAnalytics };
