/**
 * Sentinel's run-time model: the control API Milo uses (through the MCP Gateway) to set it,
 * the per-model request shape, and the refusal-fallback retry.
 */
jest.mock('../../db/pool', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));

const request = require('supertest');
const { pool } = require('../../db/pool');
const { newKey } = require('../../lib/serviceRead');
const settings = require('../../lib/sentinel/settings');
const models = require('../../lib/sentinel/models');

const { key: CONTROL_KEY, hash: CONTROL_HASH } = newKey('hubctl_');
const { key: READ_KEY, hash: READ_HASH } = newKey('hubsvc_');
const app = require('../../app');

function withEnv(vars, fn) {
  const before = {};
  for (const k of Object.keys(vars)) { before[k] = process.env[k]; process.env[k] = vars[k]; }
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(vars)) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  });
}

/** A tiny in-memory sentinel_settings + audit_logs behind pool.query. */
function fakeDb() {
  const state = { row: null, audits: [] };
  pool.query.mockImplementation(async (sql, params = []) => {
    if (/FROM sentinel_settings/.test(sql)) return { rows: state.row ? [state.row] : [] };
    if (/INSERT INTO sentinel_settings/.test(sql)) {
      state.row = { value: params[0], source: params[1], updated_at: new Date('2026-10-14T10:00:00Z') };
      return { rows: [state.row] };
    }
    if (/INSERT INTO audit_logs/.test(sql)) { state.audits.push(params); return { rows: [] }; }
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  });
  return state;
}

const CONTROL = { HUB_SERVICE_CONTROL_KEYS: `mcp-gateway:${CONTROL_HASH}`, HUB_SERVICE_READ_KEYS: `mcp-gateway:${READ_HASH}` };

describe('PUT/GET /api/service/control/v1/sentinel/model', () => {
  beforeEach(() => { pool.query.mockReset(); settings.resetCache(); });

  it('does not exist until a control key is configured', () =>
    withEnv({ HUB_SERVICE_CONTROL_KEYS: '' }, async () => {
      const r = await request(app).put('/api/service/control/v1/sentinel/model').set('Authorization', `Bearer ${CONTROL_KEY}`).send({ model: 'claude-opus-5-5' });
      expect(r.status).toBe(404);
      expect(pool.query).not.toHaveBeenCalled();
    }));

  it('accepts only a control key: not a read key, not a user token, not nothing', () =>
    withEnv(CONTROL, async () => {
      const put = (auth) => request(app).put('/api/service/control/v1/sentinel/model').set(auth ? { Authorization: auth } : {}).send({ model: 'claude-opus-5-5' });
      expect((await put(null)).status).toBe(401);
      expect((await put(`Bearer ${READ_KEY}`)).status).toBe(401);
      expect((await put('Bearer eyJhbGciOiJIUzI1NiJ9.e30.x')).status).toBe(401);
      expect(pool.query).not.toHaveBeenCalled();
    }));

  it('does not let a control key into the read API or the admin API', () =>
    withEnv(CONTROL, async () => {
      expect((await request(app).get('/api/service/v1/status').set('Authorization', `Bearer ${CONTROL_KEY}`)).status).toBe(401);
      expect((await request(app).get('/api/sentinel/status').set('Authorization', `Bearer ${CONTROL_KEY}`)).status).toBe(401);
    }));

  it('sets an allowed model, audits the change, and reports it', () =>
    withEnv(CONTROL, async () => {
      const db = fakeDb();
      const r = await request(app).put('/api/service/control/v1/sentinel/model')
        .set('Authorization', `Bearer ${CONTROL_KEY}`)
        .send({ model: 'claude-sonnet-5-5', requested_by: 'jerry.hakim@energi-up.com' });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ model: 'claude-sonnet-5-5', previous: 'claude-opus-5-5', changed: true, source: 'mcp-gateway (jerry.hakim@energi-up.com)' });
      expect(db.audits).toHaveLength(1);
      expect(db.audits[0][1]).toBe('SENTINEL_MODEL_SET');

      const g = await request(app).get('/api/service/control/v1/sentinel/model').set('Authorization', `Bearer ${CONTROL_KEY}`);
      expect(g.body).toMatchObject({ model: 'claude-sonnet-5-5', set_from: 'milo' });
      expect(g.body.allowed.map((m) => m.id)).toContain('claude-opus-5-5');

      // the same value again: no change, no second audit row
      const again = await request(app).put('/api/service/control/v1/sentinel/model').set('Authorization', `Bearer ${CONTROL_KEY}`).send({ model: 'claude-sonnet-5-5' });
      expect(again.body.changed).toBe(false);
      expect(db.audits).toHaveLength(1);
    }));

  it('refuses models outside the list, and other methods/paths', () =>
    withEnv(CONTROL, async () => {
      fakeDb();
      const auth = { Authorization: `Bearer ${CONTROL_KEY}` };
      const bad = await request(app).put('/api/service/control/v1/sentinel/model').set(auth).send({ model: 'gpt-5' });
      expect(bad.status).toBe(400);
      expect(bad.body.allowed.length).toBe(models.MODELS.length);
      expect((await request(app).post('/api/service/control/v1/sentinel/model').set(auth).send({ model: 'claude-opus-5-5' })).status).toBe(405);
      expect((await request(app).delete('/api/service/control/v1/sentinel/model').set(auth)).status).toBe(405);
      expect((await request(app).put('/api/service/control/v1/sentinel/enabled').set(auth).send({})).status).toBe(404);
    }));
});

describe('model capabilities and request shape', () => {
  /** runAgent with the LLM module replaced before agent.js loads it. */
  function agentWith(createMessage) {
    let runAgent;
    let Pseudonymizer;
    jest.isolateModules(() => {
      jest.doMock('../../lib/sentinel/llm', () => ({ createMessage }));
      ({ runAgent } = require('../../lib/sentinel/agent'));
      ({ Pseudonymizer } = require('../../lib/sentinel/privacy'));
    });
    jest.dontMock('../../lib/sentinel/llm'); // doMock outlives isolateModules
    return (cfg, finalTool = null) => runAgent({ cfg, privacy: new Pseudonymizer(), task: 't', tools: [], handlers: {}, finalTool });
  }

  it('knows which models take thinking, effort and fallbacks', () => {
    expect(models.info('claude-opus-5-5')).toMatchObject({ thinking: 'adaptive', effort: true, fallbacks: true });
    expect(models.info('claude-haiku-4-5')).toMatchObject({ thinking: null, effort: false, fallbacks: false });
    expect(models.isSelectable('claude-haiku-5-5')).toBe(true);
    expect(models.isSelectable('claude-3-opus')).toBe(false);
  });

  it('sends adaptive thinking + effort to Opus 5.5 and neither to Haiku 4.5', async () => {
    const seen = [];
    const run = agentWith(async (cfg, body, opts) => {
      seen.push({ body, opts });
      return { model: body.model, content: [{ type: 'text', text: 'ok' }], usage: {} };
    });
    const base = { maxTokens: 1000, thinking: true, effort: 'high', fallbacks: true, maxSteps: 4 };
    await run({ ...base, model: 'claude-opus-5-5' });
    await run({ ...base, model: 'claude-haiku-4-5' });
    expect(seen[0].body).toMatchObject({ model: 'claude-opus-5-5', thinking: { type: 'adaptive' }, output_config: { effort: 'high' } });
    expect(seen[0].opts).toEqual({ fallbacks: true });
    expect(seen[1].body.model).toBe('claude-haiku-4-5');
    expect(seen[1].body.thinking).toBeUndefined();
    expect(seen[1].body.output_config).toBeUndefined();
    expect(seen[1].opts).toEqual({ fallbacks: false });
  });

  it('notes the model that took over after a refusal fallback (from the fallback block)', async () => {
    const run = agentWith(async () => ({
      model: 'claude-opus-5-5',
      content: [{ type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } }, { type: 'text', text: 'answer' }],
      usage: {},
    }));
    const out = await run({ model: 'claude-opus-5-5', maxTokens: 10, maxSteps: 4 });
    expect(out.servedBy).toEqual(['claude-opus-4-8']);
    const plain = agentWith(async () => ({ model: 'whatever-the-api-echoes', content: [{ type: 'text', text: 'ok' }], usage: {} }));
    expect((await plain({ model: 'claude-opus-5-5', maxTokens: 10, maxSteps: 4 })).servedBy).toEqual([]);
  });

  it('turns a refusal into a clear failure instead of looping', async () => {
    const fn = jest.fn().mockResolvedValue({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [], usage: { input_tokens: 5, output_tokens: 1 } });
    const run = agentWith(fn);
    await expect(run({ model: 'claude-opus-5-5', maxTokens: 10, maxSteps: 4 }, 'submit_analysis')).rejects.toThrow(/declined.*\(cyber\)/);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('refusal fallbacks over the wire', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('sends fallbacks: "default" with the beta header, and drops them once if the API rejects the beta', async () => {
    const { createMessage, llmInternals } = jest.requireActual('../../lib/sentinel/llm');
    llmInternals.reset();
    const calls = [];
    global.fetch = jest.fn(async (url, init) => {
      calls.push({ headers: init.headers, body: JSON.parse(init.body) });
      if (calls.length === 1) {
        return { ok: false, status: 400, json: async () => ({ error: { message: 'Unknown beta: server-side-fallback-2026-07-01' } }), headers: { get: () => null } };
      }
      return { ok: true, status: 200, json: async () => ({ content: [], usage: {} }) };
    });
    await createMessage({ baseUrl: 'https://x', apiKey: 'k' }, { model: 'claude-opus-5-5' }, { fallbacks: true });
    expect(calls[0].headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    expect(calls[0].body.fallbacks).toBe('default');
    expect(calls[1].headers['anthropic-beta']).toBeUndefined();
    expect(calls[1].body.fallbacks).toBeUndefined();
    // stays off afterwards
    await createMessage({ baseUrl: 'https://x', apiKey: 'k' }, { model: 'claude-opus-5-5' }, { fallbacks: true });
    expect(calls[2].body.fallbacks).toBeUndefined();
    llmInternals.reset();
  });
});
