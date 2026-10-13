/**
 * Sentinel — AI production support. Admin only.
 *
 *   GET  /api/sentinel/status                     on/off, model, usage today
 *   GET  /api/sentinel/config/:scope              repository + context for 'hub' or an application
 *   PUT  /api/sentinel/config/:scope
 *   POST /api/sentinel/config/:scope/test         can Sentinel read the repository?
 *   GET  /api/sentinel/runs?scope=&kind=&limit=   recent work
 *   GET  /api/sentinel/runs/:id                   one run (poll while queued/running)
 *   GET  /api/sentinel/bug-reports/:id/analysis   latest analysis covering a bug
 *   POST /api/sentinel/bug-reports/:id/analyze    analyse (again) now
 *   POST /api/sentinel/scopes/:scope/health       { days } — health report
 *   POST /api/sentinel/scopes/:scope/ask          { question, parent_id? }
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db/pool');
const sentinelDb = require('../db/sentinelDb');
const sentinel = require('../lib/sentinel');
const { sentinelConfig } = require('../lib/sentinel/config');
const { checkAccess, validRepo, validRef } = require('../lib/sentinel/github');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { auditLog, getClientIp } = require('../middleware/audit');

const router = express.Router();
router.use(authMiddleware, requireAdmin);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_ROOT_RE = /^[A-Za-z0-9_.\-/]{0,200}$/;

// Each manual run costs real money; keep a human-scale ceiling per admin.
const runLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.SENTINEL_MANUAL_RUNS_PER_HOUR || '60', 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `sentinel:${req.user?.id || rateLimit.ipKeyGenerator(req.ip || '')}`,
  handler: (req, res) => res.status(429).json({ error: 'Too many Sentinel requests this hour. Try again later.' }),
});

function badRequest(res, error) {
  return res.status(400).json({ error });
}

function requireEnabled(req, res, next) {
  if (sentinelConfig().enabled) return next();
  return res.status(503).json({ error: 'Sentinel is not configured on this server. Set ANTHROPIC_API_KEY in the backend environment and restart it.' });
}

async function loadScope(req, res, next) {
  const { scope } = req.params;
  if (!sentinelDb.isScope(scope)) return badRequest(res, 'Invalid scope');
  try {
    const info = await sentinelDb.scopeInfo(pool, scope);
    if (!info) return res.status(404).json({ error: 'Application not found' });
    req.scopeInfo = info;
    return next();
  } catch (err) {
    return next(err);
  }
}

function runDto(run) {
  if (!run) return null;
  const { input_tokens: inTok, output_tokens: outTok, ...rest } = run;
  return { ...rest, usage: { input_tokens: inTok, output_tokens: outTok } };
}

// GET /status
router.get('/status', async (req, res) => {
  try {
    const cfg = sentinelConfig();
    const stats = await sentinelDb.stats(pool);
    res.json({
      enabled: cfg.enabled,
      reason: cfg.enabled ? null : cfg.switchedOff ? 'switched_off' : 'no_api_key',
      model: cfg.model,
      github_token: Boolean(cfg.githubToken),
      auto_daily_limit: cfg.autoDailyLimit,
      stats,
    });
  } catch (err) {
    console.error('Sentinel status error:', err);
    res.status(500).json({ error: 'Failed to load Sentinel status' });
  }
});

// GET /config/:scope
router.get('/config/:scope', loadScope, async (req, res) => {
  try {
    const config = await sentinelDb.getConfig(pool, req.params.scope);
    res.json({ config, scope: req.scopeInfo, github_token: Boolean(sentinelConfig().githubToken) });
  } catch (err) {
    console.error('Sentinel config error:', err);
    res.status(500).json({ error: 'Failed to load Sentinel settings' });
  }
});

function parseConfigBody(body) {
  const repo = String(body?.repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const branch = String(body?.branch || 'main').trim();
  const sourceRoot = String(body?.source_root || '').trim().replace(/^\/+/, '');
  const notes = String(body?.notes || '').trim();
  if (repo && !validRepo(repo)) return { error: 'Repository must look like "owner/name" (or a github.com URL).' };
  if (!validRef(branch)) return { error: 'Invalid branch name.' };
  if (!SOURCE_ROOT_RE.test(sourceRoot) || sourceRoot.includes('..')) return { error: 'Invalid source folder.' };
  if (notes.length > 4000) return { error: 'Notes are limited to 4,000 characters.' };
  return {
    value: {
      repo: repo || null,
      branch,
      sourceRoot: sourceRoot && !sourceRoot.endsWith('/') ? `${sourceRoot}/` : sourceRoot,
      notes: notes || null,
      autoAnalyze: body?.auto_analyze !== false,
    },
  };
}

// PUT /config/:scope
router.put('/config/:scope', loadScope, async (req, res) => {
  const parsed = parseConfigBody(req.body);
  if (parsed.error) return badRequest(res, parsed.error);
  try {
    const before = await sentinelDb.getConfig(pool, req.params.scope);
    const config = await sentinelDb.saveConfig(pool, req.params.scope, parsed.value, req.user.id);
    await auditLog(pool, {
      actorId: req.user.id,
      actionType: 'SENTINEL_CONFIG_UPDATE',
      targetEntity: `sentinel:${req.scopeInfo.name}`,
      payloadBefore: { repo: before.repo, branch: before.branch, source_root: before.source_root, auto_analyze: before.auto_analyze },
      payloadAfter: { repo: config.repo, branch: config.branch, source_root: config.source_root, auto_analyze: config.auto_analyze },
      ipAddress: getClientIp(req),
    });
    return res.json({ config });
  } catch (err) {
    console.error('Sentinel config save error:', err);
    return res.status(500).json({ error: 'Failed to save Sentinel settings' });
  }
});

// POST /config/:scope/test  { repo?, branch? } — test unsaved values, else the saved ones
router.post('/config/:scope/test', loadScope, async (req, res) => {
  try {
    const saved = await sentinelDb.getConfig(pool, req.params.scope);
    const parsed = req.body?.repo !== undefined ? parseConfigBody(req.body) : { value: { repo: saved.repo, branch: saved.branch } };
    if (parsed.error) return badRequest(res, parsed.error);
    if (!parsed.value.repo) return badRequest(res, 'Enter a repository first.');
    const result = await checkAccess(sentinelConfig(), parsed.value.repo, parsed.value.branch);
    return res.json(result);
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message });
  }
});

// GET /runs?scope=&kind=&limit=
router.get('/runs', async (req, res) => {
  const { scope, kind } = req.query;
  if (scope && !sentinelDb.isScope(scope)) return badRequest(res, 'Invalid scope');
  try {
    const runs = await sentinelDb.listRuns(pool, { scope, kind, limit: req.query.limit });
    return res.json({ runs: runs.map(runDto) });
  } catch (err) {
    console.error('Sentinel runs error:', err);
    return res.status(500).json({ error: 'Failed to load Sentinel activity' });
  }
});

// GET /runs/:id
router.get('/runs/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return badRequest(res, 'Invalid id');
  try {
    const run = await sentinelDb.getRun(pool, req.params.id);
    if (!run) return res.status(404).json({ error: 'Not found' });
    return res.json({ run: runDto(run) });
  } catch (err) {
    console.error('Sentinel run error:', err);
    return res.status(500).json({ error: 'Failed to load the analysis' });
  }
});

// GET /bug-reports/:id/analysis
router.get('/bug-reports/:id/analysis', async (req, res) => {
  try {
    const bug = await sentinelDb.getBug(pool, req.params.id);
    if (!bug) return res.status(404).json({ error: 'Report not found' });
    const run = await sentinelDb.latestForBug(pool, bug);
    return res.json({ run: runDto(run), enabled: sentinelConfig().enabled });
  } catch (err) {
    console.error('Sentinel bug analysis error:', err);
    return res.status(500).json({ error: 'Failed to load the analysis' });
  }
});

// POST /bug-reports/:id/analyze
router.post('/bug-reports/:id/analyze', requireEnabled, runLimit, async (req, res) => {
  try {
    const bug = await sentinelDb.getBug(pool, req.params.id);
    if (!bug) return res.status(404).json({ error: 'Report not found' });
    const active = await sentinelDb.activeForBug(pool, bug);
    if (active) return res.status(202).json({ run: runDto(await sentinelDb.getRun(pool, active.id)) });
    let run;
    try {
      run = await sentinelDb.createRun(pool, {
        kind: 'bug',
        scope: bug.application_id || 'hub',
        bugReportId: bug.id,
        fingerprint: bug.fingerprint,
        trigger: 'manual',
        requestedBy: req.user.id,
      });
    } catch (err) {
      if (err.code !== '23505') throw err; // the same error was queued a moment ago
      const again = await sentinelDb.activeForBug(pool, bug);
      return res.status(202).json({ run: runDto(again && await sentinelDb.getRun(pool, again.id)) });
    }
    sentinel.nudge(pool);
    return res.status(202).json({ run: runDto(run) });
  } catch (err) {
    console.error('Sentinel analyze error:', err);
    return res.status(500).json({ error: 'Failed to start the analysis' });
  }
});

// POST /scopes/:scope/health  { days }
router.post('/scopes/:scope/health', requireEnabled, runLimit, loadScope, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt(req.body?.days, 10) || 30));
    const run = await sentinelDb.createRun(pool, {
      kind: 'health', scope: req.params.scope, trigger: 'manual', input: { days }, requestedBy: req.user.id,
    });
    sentinel.nudge(pool);
    return res.status(202).json({ run: runDto(run) });
  } catch (err) {
    console.error('Sentinel health error:', err);
    return res.status(500).json({ error: 'Failed to start the health report' });
  }
});

// POST /scopes/:scope/ask  { question, parent_id? }
router.post('/scopes/:scope/ask', requireEnabled, runLimit, loadScope, async (req, res) => {
  const question = String(req.body?.question || '').trim();
  if (!question) return badRequest(res, 'Ask a question first.');
  if (question.length > 2000) return badRequest(res, 'Questions are limited to 2,000 characters.');
  const parentId = req.body?.parent_id;
  try {
    if (parentId) {
      const parent = UUID_RE.test(String(parentId)) ? await sentinelDb.getRun(pool, parentId) : null;
      if (!parent || parent.kind !== 'ask' || parent.scope !== req.params.scope) return badRequest(res, 'Invalid conversation');
    }
    const run = await sentinelDb.createRun(pool, {
      kind: 'ask', scope: req.params.scope, trigger: 'manual', input: { question }, parentId, requestedBy: req.user.id,
    });
    sentinel.nudge(pool);
    return res.status(202).json({ run: runDto(run) });
  } catch (err) {
    console.error('Sentinel ask error:', err);
    return res.status(500).json({ error: 'Failed to send the question' });
  }
});

module.exports = router;
