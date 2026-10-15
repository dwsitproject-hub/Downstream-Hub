/**
 * Sentinel's run-time model: the value set from Milo (sentinel_settings.model) when there is
 * one, else SENTINEL_MODEL from .env. Cached briefly; a change through the control API
 * updates the cache at once.
 */
const { sentinelConfig } = require('./config');
const models = require('./models');

const CACHE_MS = 30 * 1000;
let cached = null; // { value: { model, source, updated_at, from }, expires }

async function readRow(db) {
  const { rows } = await db.query("SELECT value, source, updated_at FROM sentinel_settings WHERE key = 'model'");
  return rows[0] || null;
}

/** { model, from: 'milo' | 'env', source, updated_at } */
async function currentModel(db) {
  if (cached && cached.expires > Date.now()) return cached.value;
  const envModel = sentinelConfig().model;
  let value = { model: envModel, from: 'env', source: null, updated_at: null };
  try {
    const row = await readRow(db);
    if (row && models.isSelectable(row.value)) {
      value = { model: row.value, from: 'milo', source: row.source, updated_at: row.updated_at };
    }
  } catch (err) {
    // Table missing (migration not run yet) or DB hiccup: fall back to .env, don't fail runs.
    console.error('Sentinel settings read failed, using SENTINEL_MODEL:', err.message);
  }
  cached = { value, expires: Date.now() + CACHE_MS };
  return value;
}

/** Store a new model. Returns { model, previous, changed, source, updated_at }. */
async function setModel(db, model, source) {
  if (!models.isSelectable(model)) {
    throw Object.assign(new Error(`Unsupported model. Allowed: ${models.MODELS.map((m) => m.id).join(', ')}`), { status: 400 });
  }
  const before = await currentModel(db);
  const { rows } = await db.query(
    `INSERT INTO sentinel_settings (key, value, source, updated_at) VALUES ('model', $1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source, updated_at = now()
     RETURNING value, source, updated_at`,
    [model, source ? String(source).slice(0, 200) : null]
  );
  const row = rows[0];
  cached = { value: { model: row.value, from: 'milo', source: row.source, updated_at: row.updated_at }, expires: Date.now() + CACHE_MS };
  return { model: row.value, previous: before.model, changed: before.model !== row.value, source: row.source, updated_at: row.updated_at };
}

function resetCache() { cached = null; }

module.exports = { currentModel, setModel, resetCache };
