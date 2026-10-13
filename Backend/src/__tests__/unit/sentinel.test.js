const zlib = require('zlib');
const { fingerprint, topFrame } = require('../../lib/sentinel/fingerprint');
const { Pseudonymizer, scrubSecrets } = require('../../lib/sentinel/privacy');
const { extractTextFiles } = require('../../lib/sentinel/tar');
const { RepoSnapshot } = require('../../lib/sentinel/github');
const { sanitizeBreadcrumbs, sanitizeRelease, sanitizeRequestUrl } = require('../../lib/sdkPolicy');

jest.mock('../../lib/sentinel/llm', () => ({ createMessage: jest.fn() }));
const { createMessage } = require('../../lib/sentinel/llm');
const { runAgent } = require('../../lib/sentinel/agent');

/* ---------- a tiny tar.gz builder (ustar + pax), enough to exercise the reader ---------- */
function header(name, size, type = '0', prefix = '') {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  if (prefix) h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}
function pad(buf) {
  const rest = buf.length % 512;
  return rest ? Buffer.concat([buf, Buffer.alloc(512 - rest)]) : buf;
}
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  while (String(len).length + body.length !== len) len = String(len).length + body.length;
  return `${len}${body}`;
}
function tarGz(entries, commit) {
  const parts = [];
  if (commit) {
    const g = Buffer.from(paxRecord('comment', commit));
    parts.push(header('pax_global_header', g.length, 'g'), pad(g));
  }
  for (const e of entries) {
    const body = Buffer.from(e.content);
    if (e.pax) {
      const x = Buffer.from(paxRecord('path', e.pax));
      parts.push(header('PaxHeader', x.length, 'x'), pad(x));
    }
    parts.push(header(e.name, body.length, e.type || '0', e.prefix), pad(body));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts));
}

describe('Sentinel fingerprint', () => {
  const stack = 'TypeError: x\n    at saveOrder (https://klip.example.com/assets/index-3fa9c1d2.js:1:23456)';
  test('same error with different ids/numbers/hosts/bundle hashes groups together', () => {
    const a = fingerprint({ scope: 'app1', kind: 'client_error', message: 'Cannot read properties of undefined (reading \'id\') for order 123', stack });
    const b = fingerprint({
      scope: 'app1',
      kind: 'client_error',
      message: 'Cannot read properties of undefined (reading \'id\') for order 98765',
      stack: stack.replace('3fa9c1d2', 'b8e01f77').replace(':1:23456', ':1:99999').replace('klip.example.com', 'test-klip.example.com'),
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });
  test('different apps or different frames do not group', () => {
    const base = { kind: 'client_error', message: 'boom', stack };
    expect(fingerprint({ ...base, scope: 'app1' })).not.toBe(fingerprint({ ...base, scope: 'app2' }));
    expect(fingerprint({ ...base, scope: 'app1' })).not.toBe(fingerprint({ ...base, scope: 'app1', stack: '    at other (/x.js:1:1)' }));
  });
  test('user reports are not fingerprinted', () => {
    expect(fingerprint({ scope: 'app1', kind: 'user_report', message: 'save does not work' })).toBeNull();
  });
  test('topFrame strips location noise', () => {
    expect(topFrame(stack)).toBe('at saveOrder (/assets/index.js)');
  });
});

describe('Sentinel privacy', () => {
  test('emails become stable pseudonyms and come back on the way in', () => {
    const p = new Pseudonymizer();
    const out = p.outbound('Alice.Doe@corp.com failed, then alice.doe@corp.com again; bob@corp.com too');
    expect(out).toBe('user-1@redacted.invalid failed, then user-1@redacted.invalid again; user-2@redacted.invalid too');
    expect(p.inbound('Only user-2@redacted.invalid is affected')).toBe('Only bob@corp.com is affected');
    expect(p.inboundDeep({ a: ['user-1@redacted.invalid'], n: 3 })).toEqual({ a: ['Alice.Doe@corp.com'], n: 3 });
  });
  test('secrets, tokens and IPs are scrubbed from data', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const text = `Authorization: Bearer abcdefghijklmnop12345 token=${jwt} password: hunter2pass from 172.28.92.57 key sk-ant-api03-abcdefghijklmnop`;
    const out = scrubSecrets(text);
    expect(out).not.toMatch(/abcdefghijklmnop12345|hunter2pass|172\.28|sk-ant-api03|eyJhbGci/);
  });
  test('code mode keeps assignments but still removes real credentials', () => {
    const code = "const password = req.body.password;\nconst key = 'ghp_abcdefghijklmnopqrstuvwxyz0123';";
    const out = scrubSecrets(code, { code: true });
    expect(out).toContain('const password = req.body.password;');
    expect(out).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
  });
});

describe('Sentinel tar reader', () => {
  test('reads text files, honours prefix and pax paths, skips binaries/deps/lockfiles', () => {
    const longName = `repo-abc/src/${'deep/'.repeat(30)}Component.jsx`;
    const gz = tarGz([
      { name: 'repo-abc/', content: '', type: '5' },
      { name: 'repo-abc/src/app.js', content: 'console.log(1);\n' },
      { name: 'orders.js', prefix: 'repo-abc/src/api', content: 'export const x = 1;\n' },
      { name: 'repo-abc/x', pax: longName, content: 'export default 1;\n' },
      { name: 'repo-abc/node_modules/a/index.js', content: 'nope' },
      { name: 'repo-abc/package-lock.json', content: '{}' },
      { name: 'repo-abc/logo.png', content: 'PNG' },
      { name: 'repo-abc/bin.js', content: 'a\u0000b' },
    ], 'a'.repeat(40));
    const { files, commit } = extractTextFiles(gz);
    expect(commit).toBe('a'.repeat(40));
    expect([...files.keys()].sort()).toEqual([`src/${'deep/'.repeat(30)}Component.jsx`, 'src/api/orders.js', 'src/app.js'].sort());
  });
});

describe('Sentinel repo snapshot', () => {
  const files = new Map([
    ['frontend/src/OrderForm.jsx', 'import x from "y";\nfunction save(order) {\n  return order.items.map((i) => i.id);\n}\n'],
    ['backend/routes/orders.js', "router.post('/api/orders', save);\n"],
    ['README.md', '# Orders'],
  ]);
  const snap = new RepoSnapshot({ repo: 'o/r', ref: 'main', commit: 'abc', files, sourceRoot: 'frontend/' });

  test('lists directories and filters by pattern', () => {
    expect(snap.list({})).toEqual({ path: '/', directories: ['backend/', 'frontend/'], files: ['README.md'] });
    expect(snap.list({ pattern: 'order' }).paths).toEqual(['backend/routes/orders.js', 'frontend/src/OrderForm.jsx']);
  });
  test('searches with the source root first, text or regex', () => {
    expect(snap.search({ query: 'save' }).matches[0]).toBe('frontend/src/OrderForm.jsx:2: function save(order) {');
    expect(snap.search({ query: 'items\\.map', regex: true }).total_matches).toBe(1);
    expect(snap.search({ query: '(', regex: true }).error).toBeTruthy();
  });
  test('reads numbered ranges and suggests similar paths', () => {
    const r = snap.read({ path: '/frontend/src/OrderForm.jsx', start_line: 2, end_line: 3 });
    expect(r.content).toBe('    2  function save(order) {\n    3    return order.items.map((i) => i.id);');
    expect(snap.read({ path: 'src/OrderForm.jsx' }).similar_paths).toEqual(['frontend/src/OrderForm.jsx']);
  });
});

describe('SDK breadcrumbs and release', () => {
  test('keeps known breadcrumb shapes and drops queries and junk', () => {
    const out = sanitizeBreadcrumbs([
      { t: 1700000000000, type: 'nav', path: '/orders?id=5' },
      { t: 1700000000001, type: 'http', method: 'post', url: 'https://api.example.com/v1/orders?token=abc', status: 500, ms: 120.4 },
      { t: 1700000000002, type: 'http', method: 'HACK', url: '/api/x?y=1', status: 'x' },
      { type: 'console', message: '  Warning: something  ' },
      { type: 'action', name: 'order_submitted!!' },
      { type: 'evil', payload: 1 },
      null,
    ]);
    expect(out).toEqual([
      { t: 1700000000000, type: 'nav', path: '/orders' },
      { t: 1700000000001, type: 'http', method: 'POST', url: 'https://api.example.com/v1/orders', status: 500, ms: 120 },
      { t: 1700000000002, type: 'http', method: 'GET', url: '/api/x', status: 0, ms: null },
      { t: null, type: 'console', message: 'Warning: something' },
      { t: null, type: 'action', name: 'order_submitted' },
    ]);
    expect(sanitizeBreadcrumbs(Array.from({ length: 50 }, (_, i) => ({ type: 'nav', path: `/p${i}` })))).toHaveLength(30);
    expect(sanitizeBreadcrumbs('x')).toBeNull();
  });
  test('console breadcrumbs never store tokens', () => {
    const [c] = sanitizeBreadcrumbs([{ type: 'console', message: 'auth failed: Bearer abcdefghijklmnopqrstu' }]);
    expect(c.message).toBe('auth failed: Bearer <redacted>');
  });
  test('release accepts versions and shas only', () => {
    expect(sanitizeRelease('1.4.2')).toBe('1.4.2');
    expect(sanitizeRelease(' 3fa9c1d ')).toBe('3fa9c1d');
    expect(sanitizeRelease('../etc')).toBeNull();
    expect(sanitizeRelease('a b')).toBeNull();
    expect(sanitizeRequestUrl('javascript:alert(1)')).toBe('/javascript:alert(1)');
  });
});

describe('Sentinel agent loop', () => {
  const cfg = { model: 'test-model', maxTokens: 1000, thinking: false, maxSteps: 6 };
  beforeEach(() => createMessage.mockReset());

  test('runs tools, pseudonymises their output, and returns the submitted result', async () => {
    createMessage
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 't1', name: 'lookup', input: { q: 1 } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'done' }, { type: 'tool_use', id: 't2', name: 'submit_analysis', input: { summary: 'user-1@redacted.invalid hit it' } }],
        usage: { input_tokens: 20, cache_read_input_tokens: 7, output_tokens: 9 },
      });
    const privacy = new Pseudonymizer();
    const handlers = { lookup: jest.fn(async () => ({ data: { who: 'jane@corp.com', ip: '10.1.2.3' } })) };
    const out = await runAgent({ cfg, privacy, task: 'Investigate jane@corp.com', tools: [], handlers, finalTool: 'submit_analysis' });

    expect(handlers.lookup).toHaveBeenCalledWith({ q: 1 });
    const firstCall = createMessage.mock.calls[0][1];
    expect(firstCall.messages[0].content).toBe('Investigate user-1@redacted.invalid');
    const secondCall = createMessage.mock.calls[1][1];
    const toolResult = secondCall.messages[2].content[0];
    expect(toolResult).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
    expect(toolResult.content).toBe('{"who":"user-1@redacted.invalid","ip":"<ip>"}');
    expect(out.result).toEqual({ summary: 'user-1@redacted.invalid hit it' });
    expect(privacy.inboundDeep(out.result)).toEqual({ summary: 'jane@corp.com hit it' });
    expect(out.usage).toEqual({ input: 37, output: 14 });
    expect(out.toolCalls).toBe(1);
  });

  test('nudges for the final tool, and answers in text when there is none', async () => {
    createMessage
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'I think it is X' }], usage: {} })
      .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 'f', name: 'submit_analysis', input: { summary: 'X' } }], usage: {} });
    const res = await runAgent({ cfg, privacy: new Pseudonymizer(), task: 't', tools: [], handlers: {}, finalTool: 'submit_analysis' });
    expect(res.result).toEqual({ summary: 'X' });
    expect(createMessage.mock.calls[1][1].messages[2]).toEqual({ role: 'user', content: 'Please call submit_analysis now with your findings.' });

    createMessage.mockReset();
    createMessage.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Answer: 42' }], usage: {} });
    const ask = await runAgent({ cfg, privacy: new Pseudonymizer(), task: 'q', tools: [], handlers: {}, finalTool: null });
    expect(ask.text).toBe('Answer: 42');
  });

  test('tool errors are reported to the model, and the loop is bounded', async () => {
    createMessage.mockResolvedValue({ content: [{ type: 'tool_use', id: 'x', name: 'boom', input: {} }], usage: {} });
    const handlers = { boom: async () => { throw new Error('db down'); } };
    await expect(runAgent({ cfg, privacy: new Pseudonymizer(), task: 't', tools: [], handlers, finalTool: 'submit_analysis' }))
      .rejects.toThrow(/did not finish/);
    const second = createMessage.mock.calls[1][1].messages[2].content[0];
    expect(second).toMatchObject({ is_error: true, content: '{"error":"Tool failed: db down"}' });
    expect(createMessage.mock.calls.length).toBe(cfg.maxSteps + 2);
  });
});
