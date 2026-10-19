/**
 * Applications CRUD. List for all authenticated; create/update/delete for Admin only.
 * Delete is soft (deleted_at). Data access via applicationsDb (excludes soft-deleted).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { pool } = require('../db/pool');
const applicationsDb = require('../db/applicationsDb');
const appGroupsDb = require('../db/appGroupsDb');
const businessUnitsDb = require('../db/businessUnitsDb');
const usersDb = require('../db/usersDb');
const sdkDb = require('../db/sdkDb');
const sdkPolicy = require('../lib/sdkPolicy');
const { authMiddleware, requireAdmin } = require('../middleware/auth');
const { auditLog, getClientIp } = require('../middleware/audit');

const router = express.Router();

const URL_REGEX = /^https?:\/\/[^\s]+$/i;
const UPLOAD_ICON_PATH_REGEX = /^\/uploads\/app-icons\/[a-zA-Z0-9_.-]+\.(png|jpg|jpeg|webp|svg)$/i;

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'app-icons');
const MAX_ICON_BYTES = 100 * 1024;

const MIME_TO_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

const iconUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureUploadDir();
      cb(null, UPLOAD_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = MIME_TO_EXT[file.mimetype];
      if (!ext) {
        cb(new Error('Only PNG, JPEG, WebP, and SVG files are allowed'));
        return;
      }
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_ICON_BYTES },
  fileFilter: (_req, file, cb) => {
    if (MIME_TO_EXT[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new Error('Only PNG, JPEG, WebP, and SVG files are allowed'));
    }
  },
});

function isValidIconUrl(s) {
  if (!s || !String(s).trim()) return true;
  const t = String(s).trim();
  if (URL_REGEX.test(t)) return true;
  if (UPLOAD_ICON_PATH_REGEX.test(t)) return true;
  return false;
}

/**
 * Validate and normalise the application request body.
 * Accepts either:
 *   target_bu_ids: string[]  (new, multi-BU)
 *   target_bu_id: string     (legacy single-BU — coerced into target_bu_ids)
 * Returns { error } on validation failure, otherwise cleaned payload with target_bu_ids.
 */
function validateAppBody(body) {
  const { name, description, icon_url, target_url, target_bu_id, target_bu_ids, oauth_client_id, oidc_redirect_uris, sso_mode } = body || {};
  if (!name || typeof name !== 'string' || !name.trim()) return { error: 'Name is required' };
  if (!target_url || typeof target_url !== 'string' || !target_url.trim()) return { error: 'Target URL is required' };
  if (!URL_REGEX.test(target_url.trim())) return { error: 'Target URL must be a valid http(s) URL' };
  const iconTrim = icon_url != null ? String(icon_url).trim() : '';
  if (!isValidIconUrl(iconTrim)) {
    return { error: 'Icon must be empty, a valid http(s) URL, or a hub upload path under /uploads/app-icons/' };
  }
  const modeRaw = sso_mode == null ? 'none' : String(sso_mode).trim();
  const mode = modeRaw === 'oidc' ? 'oidc' : modeRaw === 'none' ? 'none' : null;
  if (!mode) return { error: 'sso_mode must be "none" or "oidc"' };
  const clientId = oauth_client_id == null ? '' : String(oauth_client_id).trim();
  const redirectUris = Array.isArray(oidc_redirect_uris) ? oidc_redirect_uris.map((u) => String(u).trim()).filter(Boolean) : [];
  if (mode === 'oidc') {
    if (!clientId) return { error: 'oauth_client_id is required when sso_mode is oidc' };
    if (redirectUris.length === 0) return { error: 'At least one oidc_redirect_uri is required when sso_mode is oidc' };
    for (const uri of redirectUris) {
      if (!URL_REGEX.test(uri)) return { error: `Invalid oidc_redirect_uri: ${uri}` };
    }
  }

  // Resolve BU IDs — prefer target_bu_ids array; fall back to legacy target_bu_id scalar
  let resolvedBuIds;
  if (Array.isArray(target_bu_ids)) {
    resolvedBuIds = target_bu_ids.map((id) => String(id).trim()).filter(Boolean);
  } else if (target_bu_id !== null && target_bu_id !== undefined && target_bu_id !== '') {
    resolvedBuIds = [String(target_bu_id).trim()];
  } else {
    resolvedBuIds = [];
  }
  // Deduplicate
  resolvedBuIds = [...new Set(resolvedBuIds)];

  // Legacy compat: expose first BU as target_bu_id for existing DB column writes
  const legacyBuId = resolvedBuIds.length > 0 ? resolvedBuIds[0] : null;

  return {
    name: name.trim(),
    description: description != null ? String(description).trim() : '',
    icon_url: iconTrim,
    target_url: target_url.trim(),
    target_bu_id: legacyBuId,
    target_bu_ids: resolvedBuIds,
    oauth_client_id: mode === 'oidc' ? clientId : null,
    oidc_redirect_uris: mode === 'oidc' ? redirectUris : [],
    sso_mode: mode,
  };
}

function publicBaseUrl(req) {
  const fromEnv = process.env.API_PUBLIC_URL || process.env.PUBLIC_APP_URL;
  if (fromEnv && String(fromEnv).trim()) {
    return String(fromEnv).replace(/\/$/, '');
  }
  return `${req.protocol}://${req.get('host')}`;
}

// POST /api/applications/icon-upload — Admin; multipart file field "file"
router.post('/icon-upload', authMiddleware, requireAdmin, (req, res, next) => {
  iconUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large (max 100 KB)' });
    }
    return res.status(400).json({ error: err.message || 'Upload failed' });
  });
}, (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded (use field name "file")' });
  }
  const base = publicBaseUrl(req);
  const icon_url = `${base}/uploads/app-icons/${req.file.filename}`;
  res.status(201).json({ icon_url });
});

function toPublicAppDto(app) {
  return {
    id: app.id,
    name: app.name,
    description: app.description,
    icon_url: app.icon_url,
    sso_mode: app.sso_mode,
    group_id: app.group_id ?? null,
    sort_order: app.sort_order ?? null,
    created_at: app.created_at,
    updated_at: app.updated_at,
  };
}

// GET /api/applications/for-me — list apps for current user's BU or Global (authenticated)
router.get('/for-me', authMiddleware, async (req, res) => {
  try {
    const user = await usersDb.getById(pool, req.user.id);
    const buId = user?.business_unit_id ?? null;
    const [applications, groups] = await Promise.all([
      applicationsDb.listActive(pool, buId),
      appGroupsDb.listGroups(pool),
    ]);
    // Only groups this user has something in; names and order only.
    const used = new Set(applications.map((a) => a.group_id).filter(Boolean));
    res.json({
      applications: applications.map(toPublicAppDto),
      groups: groups.filter((g) => used.has(g.id)).map((g) => ({ id: g.id, name: g.name })),
    });
  } catch (err) {
    console.error('List applications for-me error:', err);
    res.status(500).json({ error: 'Failed to list applications' });
  }
});

// GET /api/applications — list all (Admin only)
// Optional filter params: ?bu=<uuid>,<uuid>&global=true
router.get('/', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const buParam = req.query.bu ? String(req.query.bu) : '';
    const buIds = buParam ? buParam.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const includeGlobal = req.query.global === 'true' || req.query.global === '1';

    const rows = (buIds.length > 0 || includeGlobal)
      ? await applicationsDb.listAllWithBuNameFiltered(pool, buIds, includeGlobal)
      : await applicationsDb.listAllWithBuName(pool);

    res.json({ applications: rows });
  } catch (err) {
    console.error('List applications error:', err);
    res.status(500).json({ error: 'Failed to list applications' });
  }
});

// GET /api/applications/:id — Admin only
router.get('/:id', authMiddleware, requireAdmin, async (req, res) => {
  try {
    const app = await applicationsDb.getById(pool, req.params.id);
    if (!app) return res.status(404).json({ error: 'Application not found' });
    res.json(app);
  } catch (err) {
    console.error('Get application error:', err);
    res.status(500).json({ error: 'Failed to get application' });
  }
});

/* ---------- Embeddable SDK settings (Admin only) ---------- */

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SDK_ORIGINS = 20;

function sdkSettingsDto(row, status) {
  return {
    application_id: row.id,
    application_name: row.name,
    sdk_key: row.sdk_key,
    sdk_enabled: row.sdk_enabled,
    allowed_origins: row.sdk_allowed_origins || [],
    default_origins: sdkPolicy.defaultAllowedOrigins(row),
    effective_origins: sdkPolicy.effectiveAllowedOrigins(row),
    status,
  };
}

// GET /api/applications/:id/sdk — key (created on first view), origins, ingestion status
router.get('/:id/sdk', authMiddleware, requireAdmin, async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: 'Application not found' });
  try {
    let row = await sdkDb.getSettings(pool, req.params.id);
    if (!row) return res.status(404).json({ error: 'Application not found' });
    if (!row.sdk_key) {
      await sdkDb.ensureKey(pool, row.id);
      row = await sdkDb.getSettings(pool, row.id);
    }
    const status = await sdkDb.ingestionStatus(pool, row.id);
    res.json(sdkSettingsDto(row, status));
  } catch (err) {
    console.error('Get SDK settings error:', err);
    res.status(500).json({ error: 'Failed to load SDK settings' });
  }
});

// PUT /api/applications/:id/sdk — { enabled?: boolean, allowed_origins?: string[] }
router.put('/:id/sdk', authMiddleware, requireAdmin, async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: 'Application not found' });
  const body = req.body || {};
  let allowedOrigins;
  if (body.allowed_origins !== undefined) {
    if (!Array.isArray(body.allowed_origins)) return res.status(400).json({ error: 'allowed_origins must be a list' });
    const raw = body.allowed_origins.map((s) => String(s || '').trim()).filter(Boolean);
    const invalid = raw.filter((s) => !sdkPolicy.normalizeOrigin(s));
    if (invalid.length > 0) {
      return res.status(400).json({ error: `Not a valid http(s) origin: ${invalid.slice(0, 3).join(', ')}` });
    }
    allowedOrigins = [...new Set(raw.map(sdkPolicy.normalizeOrigin))];
    if (allowedOrigins.length > MAX_SDK_ORIGINS) {
      return res.status(400).json({ error: `At most ${MAX_SDK_ORIGINS} origins are allowed` });
    }
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be true or false' });
  }
  try {
    const before = await sdkDb.getSettings(pool, req.params.id);
    if (!before) return res.status(404).json({ error: 'Application not found' });
    const after = await sdkDb.updateSettings(pool, req.params.id, { enabled: body.enabled, allowedOrigins });
    await auditLog(pool, {
      actorId: req.user.id,
      actionType: 'SDK_SETTINGS_UPDATE',
      targetEntity: `application:${before.name}`,
      payloadBefore: { sdk_enabled: before.sdk_enabled, sdk_allowed_origins: before.sdk_allowed_origins },
      payloadAfter: { sdk_enabled: after.sdk_enabled, sdk_allowed_origins: after.sdk_allowed_origins },
      ipAddress: getClientIp(req),
    });
    const status = await sdkDb.ingestionStatus(pool, after.id);
    res.json(sdkSettingsDto(after, status));
  } catch (err) {
    console.error('Update SDK settings error:', err);
    res.status(500).json({ error: 'Failed to update SDK settings' });
  }
});

// POST /api/applications/:id/sdk/rotate-key — issue a new key; the old one stops working immediately
router.post('/:id/sdk/rotate-key', authMiddleware, requireAdmin, async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: 'Application not found' });
  try {
    const before = await sdkDb.getSettings(pool, req.params.id);
    if (!before) return res.status(404).json({ error: 'Application not found' });
    await sdkDb.rotateKey(pool, req.params.id);
    await auditLog(pool, {
      actorId: req.user.id,
      actionType: 'SDK_KEY_ROTATE',
      targetEntity: `application:${before.name}`,
      payloadBefore: null,
      payloadAfter: null,
      ipAddress: getClientIp(req),
    });
    const row = await sdkDb.getSettings(pool, req.params.id);
    const status = await sdkDb.ingestionStatus(pool, row.id);
    res.json(sdkSettingsDto(row, status));
  } catch (err) {
    console.error('Rotate SDK key error:', err);
    res.status(500).json({ error: 'Failed to rotate SDK key' });
  }
});

// POST /api/applications — Admin only
router.post('/', authMiddleware, requireAdmin, async (req, res) => {
  const validated = validateAppBody(req.body);
  if (validated.error) return res.status(400).json({ error: validated.error });
  // Validate each BU ID exists
  for (const buId of validated.target_bu_ids) {
    const bu = await businessUnitsDb.getById(pool, buId);
    if (!bu) return res.status(400).json({ error: `Department not found: ${buId}` });
  }
  const client = await pool.connect();
  try {
    const app = await applicationsDb.create(client, validated);
    await applicationsDb.setApplicationBusinessUnits(client, app.id, validated.target_bu_ids);
    await auditLog(client, {
      actorId: req.user.id,
      actionType: 'CREATE',
      targetEntity: app.name,
      payloadBefore: null,
      payloadAfter: { ...app, target_bu_ids: validated.target_bu_ids },
      ipAddress: getClientIp(req),
    });
    res.status(201).json({ ...app, target_bu_ids: validated.target_bu_ids });
  } catch (err) {
    console.error('Create application error:', err);
    res.status(500).json({ error: 'Failed to create application' });
  } finally {
    client.release();
  }
});

// PUT /api/applications/:id — Admin only
router.put('/:id', authMiddleware, requireAdmin, async (req, res) => {
  const validated = validateAppBody(req.body);
  if (validated.error) return res.status(400).json({ error: validated.error });
  // Validate each BU ID exists
  for (const buId of validated.target_bu_ids) {
    const bu = await businessUnitsDb.getById(pool, buId);
    if (!bu) return res.status(400).json({ error: `Department not found: ${buId}` });
  }
  const client = await pool.connect();
  try {
    const before = await applicationsDb.getByIdForUpdate(client, req.params.id);
    if (!before) {
      res.status(404).json({ error: 'Application not found' });
      return;
    }
    const app = await applicationsDb.update(client, req.params.id, validated);
    await applicationsDb.setApplicationBusinessUnits(client, req.params.id, validated.target_bu_ids);
    await auditLog(client, {
      actorId: req.user.id,
      actionType: 'UPDATE',
      targetEntity: app.name,
      payloadBefore: before,
      payloadAfter: { ...app, target_bu_ids: validated.target_bu_ids },
      ipAddress: getClientIp(req),
    });
    res.json({ ...app, target_bu_ids: validated.target_bu_ids });
  } catch (err) {
    console.error('Update application error:', err);
    res.status(500).json({ error: 'Failed to update application' });
  } finally {
    client.release();
  }
});

// DELETE /api/applications/:id — Admin only (soft delete)
router.delete('/:id', authMiddleware, requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const before = await applicationsDb.getByIdForUpdate(client, req.params.id);
    if (!before) {
      res.status(404).json({ error: 'Application not found' });
      return;
    }
    const ok = await applicationsDb.softDelete(client, req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Application not found' });
      return;
    }
    await auditLog(client, {
      actorId: req.user.id,
      actionType: 'DELETE',
      targetEntity: before.name,
      payloadBefore: before,
      payloadAfter: null,
      ipAddress: getClientIp(req),
    });
    res.status(204).send();
  } catch (err) {
    console.error('Delete application error:', err);
    res.status(500).json({ error: 'Failed to delete application' });
  } finally {
    client.release();
  }
});

module.exports = router;
