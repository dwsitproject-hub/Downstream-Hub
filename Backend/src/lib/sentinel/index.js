/**
 * Sentinel — the Hub's AI production-support agent.
 *
 *   onBugReport(db, report)  queue an automatic analysis for a new bug / JS error
 *   startWorker(db)          process the queue in the background (one run at a time)
 *   executeRun(db, run)      do one run: bug analysis, health report, or answer
 */
const sentinelDb = require('../../db/sentinelDb');
const { sentinelConfig } = require('./config');
const settings = require('./settings');
const { Pseudonymizer } = require('./privacy');
const { buildTools, appAnalytics, hubAnalytics } = require('./tools');
const { runAgent } = require('./agent');
const prompts = require('./prompts');

const RELEASE_REF_RE = /^(v?\d+\.\d+[\w.-]*|[0-9a-f]{7,40})$/i;

/** Queue an automatic analysis. Never throws: ingestion must not fail because of Sentinel. */
async function onBugReport(db, report) {
  try {
    const cfg = sentinelConfig();
    if (!cfg.enabled || !report?.id) return null;
    const scope = report.application_id || 'hub';
    const config = await sentinelDb.getConfig(db, scope);
    if (!config.auto_analyze) return null;
    if (report.fingerprint && await sentinelDb.recentForFingerprint(db, report.fingerprint)) return null;
    return await sentinelDb.createRun(db, {
      kind: 'bug',
      scope,
      bugReportId: report.id,
      fingerprint: report.fingerprint,
      trigger: 'auto',
    });
  } catch (err) {
    if (err.code !== '23505') console.error('Sentinel enqueue failed:', err.message); // 23505: same error already queued
    return null;
  }
}

async function snapshotFor(ctx, days) {
  const q = (report) => (ctx.hub ? hubAnalytics(ctx, { report, days }) : appAnalytics(ctx, { report, days }));
  if (ctx.hub) {
    const [summary, apps, errors, bugs] = await Promise.all([q('summary'), q('apps'), q('errors'), q('bug_reports')]);
    return { summary, top_apps: apps.apps?.slice(0, 10), errors: errors.error_groups, recent_reports: bugs.reports?.slice(0, 15) };
  }
  const [summary, daily, pages, errors, bugs, actions] = await Promise.all([
    q('summary'), q('daily'), q('pages'), q('errors'), q('bug_reports'), q('tracked_actions'),
  ]);
  return {
    summary,
    daily,
    pages: pages.pages,
    errors: errors.error_groups,
    recent_reports: bugs.reports?.slice(0, 15),
    tracked_actions: actions.actions,
  };
}

/** Run one queued job to completion and store the outcome. */
/** The model a run actually used: the configured one, plus any refusal-fallback model. */
function modelLabel(configured, servedBy = []) {
  const others = servedBy.filter((m) => m && m !== configured);
  return (others.length ? `${configured} (fallback: ${others.join(', ')})` : configured).slice(0, 80);
}

async function executeRun(db, run) {
  const cfg = { ...sentinelConfig(), model: (await settings.currentModel(db)).model };
  const started = Date.now();
  const privacy = new Pseudonymizer();
  try {
    if (!cfg.enabled) throw new Error('Sentinel is not configured on this server (ANTHROPIC_API_KEY is missing).');
    const info = await sentinelDb.scopeInfo(db, run.scope);
    if (!info) throw new Error('The application no longer exists.');
    const config = await sentinelDb.getConfig(db, run.scope);
    const ctx = {
      db, cfg, privacy, config,
      scope: run.scope,
      hub: run.scope === 'hub',
      defaultDays: 30,
      filesRead: new Set(),
      repoInfo: null,
    };

    let outcome;
    if (run.kind === 'bug') {
      const bug = await sentinelDb.getBug(db, run.bug_report_id);
      if (!bug) throw new Error('The bug report no longer exists.');
      ctx.bug = bug;
      ctx.release = bug.release && RELEASE_REF_RE.test(bug.release) ? bug.release : null;
      const { defs, handlers, withCode } = buildTools(ctx, 'bug');
      const repoRef = ctx.release ? `${ctx.release} (the release the user was running; falls back to ${config.branch})` : config.branch;
      outcome = await runAgent({
        cfg, privacy, tools: defs, handlers, finalTool: 'submit_analysis',
        task: prompts.bugTask({ info, config, bug, withCode, repoRef, maxSteps: cfg.maxSteps }),
      });
      const files = new Set([...(outcome.result.files_examined || []), ...ctx.filesRead]);
      outcome.result = { ...outcome.result, files_examined: [...files].slice(0, 60), code_available: withCode, repo: ctx.repoInfo };
    } else if (run.kind === 'health') {
      const days = Math.max(1, Math.min(365, parseInt(run.input?.days, 10) || 30));
      ctx.defaultDays = days;
      const { defs, handlers } = buildTools(ctx, 'health');
      const snapshot = await snapshotFor(ctx, days);
      outcome = await runAgent({
        cfg, privacy, tools: defs, handlers, finalTool: 'submit_health_report',
        task: prompts.healthTask({ info, config, days, snapshot }),
      });
      outcome.result = { ...outcome.result, days };
    } else if (run.kind === 'ask') {
      const question = String(run.input?.question || '').trim();
      if (!question) throw new Error('Empty question.');
      const chain = await sentinelDb.askChain(db, run.parent_id);
      const { defs, handlers, withCode } = buildTools(ctx, 'ask');
      outcome = await runAgent({
        cfg, privacy, tools: defs, handlers, finalTool: null,
        task: prompts.askTask({ info, config, withCode, repoRef: config.branch, chain, question }),
      });
      outcome.result = { answer: outcome.text || '(Sentinel returned no answer.)', files_examined: [...ctx.filesRead] };
    } else {
      throw new Error(`Unknown run kind ${run.kind}`);
    }

    const result = privacy.inboundDeep({ ...outcome.result, duration_ms: Date.now() - started });
    await sentinelDb.finishRun(db, run.id, {
      status: 'done',
      result,
      model: modelLabel(cfg.model, outcome.servedBy),
      inputTokens: outcome.usage.input,
      outputTokens: outcome.usage.output,
      toolCalls: outcome.toolCalls,
    });
    return result;
  } catch (err) {
    console.error(`Sentinel run ${run.id} (${run.kind}) failed:`, err.message);
    await sentinelDb.finishRun(db, run.id, {
      status: 'failed',
      model: cfg.model,
      inputTokens: err.usage?.input || 0,
      outputTokens: err.usage?.output || 0,
      toolCalls: err.toolCalls || 0,
      error: String(err.message || err).slice(0, 1000),
    }).catch((e) => console.error('Sentinel could not record failure:', e.message));
    return null;
  }
}

/* ---------- background worker ---------- */

const worker = { timer: null, busy: false };

async function tick(db) {
  if (worker.busy) return;
  worker.busy = true;
  try {
    for (;;) {
      const cfg = sentinelConfig();
      if (!cfg.enabled) break;
      const run = await sentinelDb.claimNext(db);
      if (!run) break;
      if (run.trigger === 'auto' && await sentinelDb.autoRunsToday(db) > cfg.autoDailyLimit) {
        await sentinelDb.finishRun(db, run.id, { status: 'skipped', error: `Daily limit of ${cfg.autoDailyLimit} automatic analyses reached. Use "Analyze" to run it manually.` });
        continue;
      }
      await executeRun(db, run);
    }
  } catch (err) {
    console.error('Sentinel worker error:', err.message);
  } finally {
    worker.busy = false;
  }
}

async function startWorker(db) {
  const cfg = sentinelConfig();
  if (!cfg.enabled) {
    console.log(cfg.switchedOff ? 'Sentinel: switched off (SENTINEL_ENABLED=0)' : 'Sentinel: off (set ANTHROPIC_API_KEY to enable)');
    return;
  }
  const requeued = await sentinelDb.requeueInterrupted(db).catch(() => 0);
  worker.timer = setInterval(() => { tick(db); }, cfg.pollMs);
  worker.timer.unref();
  const current = await settings.currentModel(db).catch(() => ({ model: cfg.model, from: 'env' }));
  console.log(`Sentinel: on — model ${current.model}${current.from === 'milo' ? ' (set from Milo)' : ''}, code access ${cfg.githubToken ? 'token configured' : 'public repositories only'}${requeued ? `, ${requeued} interrupted run(s) re-queued` : ''}`);
  tick(db);
}

/** Wake the worker now instead of waiting for the next poll. */
function nudge(db) {
  if (worker.timer) setImmediate(() => tick(db));
}

module.exports = { onBugReport, executeRun, startWorker, nudge, tick };
