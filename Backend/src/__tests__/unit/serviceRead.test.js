/**
 * Read-only service API (routes/service.js) and its key/redaction helpers.
 * The database is mocked: these tests are about who gets in and what comes out.
 */
jest.mock('../../db/pool', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));

const request = require('supertest');
const { pool } = require('../../db/pool');
const { configuredKeys, matchKey, newKey, alias, redactText, redactDeep } = require('../../lib/serviceRead');

const { key: KEY, hash: HASH } = newKey();
const app = require('../../app');

function withKeys(value, fn) {
  const before = process.env.HUB_SERVICE_READ_KEYS;
  process.env.HUB_SERVICE_READ_KEYS = value;
  return Promise.resolve(fn()).finally(() => {
    if (before === undefined) delete process.env.HUB_SERVICE_READ_KEYS;
    else process.env.HUB_SERVICE_READ_KEYS = before;
  });
}

describe('service keys', () => {
  it('parses name:hash pairs and ignores malformed entries', () => {
    const keys = configuredKeys({ HUB_SERVICE_READ_KEYS: `mcp-gateway:${HASH}, broken, other:xyz` });
    expect(keys).toEqual([{ name: 'mcp-gateway', hash: HASH }]);
  });

  it('matches only the exact key, and only hubsvc_ keys', () => {
    const keys = [{ name: 'mcp-gateway', hash: HASH }];
    expect(matchKey(KEY, keys)).toBe('mcp-gateway');
    expect(matchKey(`${KEY}x`, keys)).toBeNull();
    expect(matchKey(KEY.replace('hubsvc_', 'other_'), keys)).toBeNull();
    expect(matchKey('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig', keys)).toBeNull();
    expect(matchKey(undefined, keys)).toBeNull();
  });
});

describe('redaction', () => {
  it('gives the same person the same pseudonym, and different people different ones', () => {
    expect(alias('Jane.Doe@energi-up.com')).toBe(alias('jane.doe@energi-up.com'));
    expect(alias('jane.doe@energi-up.com')).not.toBe(alias('john@energi-up.com'));
    expect(alias('jane.doe@energi-up.com')).toMatch(/^user-[0-9a-f]{10}@redacted\.invalid$/);
  });

  it('removes emails, tokens and keys everywhere; IPs and key=value secrets in runtime data', () => {
    const runtime = redactText('jane@energi-up.com hit 10.1.2.3 with token=abcd1234 and sk-ant-api03-aaaaaaaaaaaaaaaa', { runtime: true });
    expect(runtime).not.toMatch(/jane@|10\.1\.2\.3|abcd1234|sk-ant-api03/);
    const analysis = redactText('`const password = req.body.password` at src/a.js:12; ask jane@energi-up.com');
    expect(analysis).toContain('const password = req.body.password');
    expect(analysis).not.toContain('jane@');
  });

  it('walks nested results and keeps non-strings', () => {
    const out = redactDeep({ a: ['x@y.co'], n: 3, d: null, nested: { e: 'Bearer abcdefghijklmnopqrstuvwx' } }, { runtime: true });
    expect(out.a[0]).toMatch(/redacted\.invalid/);
    expect(out.n).toBe(3);
    expect(out.d).toBeNull();
    expect(out.nested.e).not.toContain('abcdefghijklmnop');
  });
});

describe('GET /api/service/v1', () => {
  beforeEach(() => pool.query.mockReset());

  it('does not exist until a key is configured', () =>
    withKeys('', async () => {
      const r = await request(app).get('/api/service/v1/status').set('Authorization', `Bearer ${KEY}`);
      expect(r.status).toBe(404);
    }));

  it('is read-only: every other method is refused before authentication', () =>
    withKeys(`mcp-gateway:${HASH}`, async () => {
      for (const m of ['post', 'put', 'patch', 'delete']) {
        const r = await request(app)[m]('/api/service/v1/sentinel/runs').set('Authorization', `Bearer ${KEY}`);
        expect(r.status).toBe(405);
      }
      expect(pool.query).not.toHaveBeenCalled();
    }));

  it('accepts a service key and nothing else', () =>
    withKeys(`mcp-gateway:${HASH}`, async () => {
      expect((await request(app).get('/api/service/v1/status')).status).toBe(401);
      expect((await request(app).get('/api/service/v1/status').set('Authorization', 'Bearer hubsvc_wrong')).status).toBe(401);
      expect((await request(app).get('/api/service/v1/status').set('Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.x')).status).toBe(401);
      expect(pool.query).not.toHaveBeenCalled();
    }));

  it('does not open the admin Sentinel API to a service key', () =>
    withKeys(`mcp-gateway:${HASH}`, async () => {
      const r = await request(app).get('/api/sentinel/runs').set('Authorization', `Bearer ${KEY}`);
      expect(r.status).toBe(401);
    }));

  it('returns Sentinel runs with people pseudonymised and secrets removed', () =>
    withKeys(`mcp-gateway:${HASH}`, async () => {
      pool.query.mockResolvedValueOnce({ rows: [{
        id: '11111111-1111-1111-1111-111111111111', kind: 'bug', scope: 'hub', application_name: 'Downstream Hub',
        status: 'done', severity: 'high', summary: 'Login fails for jane.doe@energi-up.com: token sk-ant-api03-zzzzzzzzzzzzzzzz leaked in log',
        question: null, error: null, created_at: new Date('2026-10-14T01:00:00Z'),
      }] });
      const r = await request(app).get('/api/service/v1/sentinel/runs?kind=bug&days=7').set('Authorization', `Bearer ${KEY}`);
      expect(r.status).toBe(200);
      const body = JSON.stringify(r.body);
      expect(body).not.toContain('jane.doe@');
      expect(body).not.toContain('sk-ant-api03');
      expect(r.body.runs[0].summary).toMatch(/user-[0-9a-f]{10}@redacted\.invalid/);
      expect(r.body.runs[0].created_at).toBe('2026-10-14T01:00:00.000Z');
      const [sql, params] = pool.query.mock.calls[0];
      expect(sql).toMatch(/^\s*SELECT/);
      expect(params).toContain('bug');
    }));

  it('rejects bad filters with 400 instead of querying', () =>
    withKeys(`mcp-gateway:${HASH}`, async () => {
      const auth = { Authorization: `Bearer ${KEY}` };
      expect((await request(app).get('/api/service/v1/sentinel/runs?kind=drop').set(auth)).status).toBe(400);
      expect((await request(app).get('/api/service/v1/bug-reports?scope=1%3B--').set(auth)).status).toBe(400);
      expect((await request(app).get('/api/service/v1/errors').set(auth)).status).toBe(400);
      expect(pool.query).not.toHaveBeenCalled();
    }));
});
