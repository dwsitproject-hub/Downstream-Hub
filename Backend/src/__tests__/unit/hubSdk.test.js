/**
 * The browser SDK (src/sdk/hub-sdk.js), run in a sandbox with a fake window, document and
 * fetch. Pins what integrators rely on (TAS, 5 Nov 2026):
 *   - calls queued before load are replayed in order, and a push AFTER load - on the early
 *     array or on DwsHub - still runs;
 *   - identify() is idempotent: the same identity again sends nothing;
 *   - reset() forgets the user and gives the browser a new anonymous id;
 *   - with localStorage blocked, the session and anonymous id stay stable for the page;
 *   - a rejected key or origin is reported in the console, once, without debug mode.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');

const SDK = fs.readFileSync(path.join(__dirname, '../../sdk/hub-sdk.js'), 'utf8');

function makeStorage(blocked) {
  const m = new Map();
  const guard = () => { if (blocked) throw new Error('SecurityError'); };
  return {
    getItem: (k) => { guard(); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { guard(); m.set(k, String(v)); },
    removeItem: (k) => { guard(); m.delete(k); },
    _map: m,
  };
}

/** Load the SDK into a fresh fake page. Returns the window and every POST it made. */
function loadSdk({ preset, storageBlocked = false, status = 204, errorBody = null, storage } = {}) {
  const posts = [];
  const warnings = [];
  const fakeConsole = { log() {}, error() {}, warn: (...a) => warnings.push(a.join(' ')) };
  const window = {
    localStorage: storage || makeStorage(storageBlocked),
    location: { pathname: '/positions', hash: '', href: 'https://tas.example.com/positions', origin: 'https://tas.example.com' },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    crypto: webcrypto,
    console: fakeConsole,
    fetch: (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(errorBody || {}) });
    },
  };
  if (preset !== undefined) window.DwsHub = preset;
  const attrs = { 'data-app-key': 'dwsk_test' };
  const document = {
    currentScript: { src: 'https://hub.example.com/api/sdk/v1/hub-sdk.js', getAttribute: (n) => (n in attrs ? attrs[n] : null) },
    querySelectorAll: () => [],
    addEventListener() {},
    visibilityState: 'visible',
    body: null,
    title: 'Positions',
  };
  const context = vm.createContext({
    window, document, console: fakeConsole, URL, JSON, Promise, Date, Math, Object, Array, String, Number,
    Uint8Array, setInterval: () => 0, setTimeout: () => 0, clearInterval() {}, clearTimeout() {},
  });
  vm.runInContext(SDK, context);
  return { window, posts, warnings };
}

const settle = () => new Promise((r) => setImmediate(r));
const users = (posts) => posts.map((p) => p.body.user && p.body.user.email);

describe('hub-sdk.js', () => {
  it('replays calls queued before load, in order', () => {
    const { window, posts } = loadSdk({ preset: [['identify', { id: 'x', email: 'Rio@Example.com' }], ['track', 'position_deleted']] });
    expect(window.DwsHub.__loaded).toBe(true);
    window.DwsHub.flush();
    const events = posts.flatMap((p) => p.body.events.map((e) => e.type + (e.name ? `:${e.name}` : '')));
    expect(events).toContain('custom:position_deleted');
    expect(posts[posts.length - 1].body.user).toEqual({ id: 'x', email: 'rio@example.com' });
  });

  it('runs a push made AFTER load, on the early array or on DwsHub itself', () => {
    const early = [];
    const { window, posts } = loadSdk({ preset: early });
    early.push(['identify', { email: 'late@example.com' }]); // code that kept the array
    expect(users(posts)).toContain('late@example.com');
    window.DwsHub.push(['identify', { email: 'later@example.com' }]);
    expect(users(posts)).toContain('later@example.com');
  });

  it('identify() with the same identity again sends nothing', () => {
    const { window, posts } = loadSdk();
    window.DwsHub.identify({ id: 'u1', email: 'rio@example.com' });
    const after = posts.length;
    window.DwsHub.identify({ id: 'u1', email: 'rio@example.com' });
    window.DwsHub.identify({ id: 'u1', email: 'RIO@example.com ' });
    expect(posts.length).toBe(after);
  });

  it('keeps the session when an anonymous visitor identifies, starts a new one for a different person', () => {
    const { window, posts } = loadSdk();
    const anonSession = posts[0].body.session.id;
    window.DwsHub.identify({ email: 'rio@example.com' });
    expect(posts[posts.length - 1].body.session.id).toBe(anonSession);
    window.DwsHub.identify({ email: 'someone.else@example.com' });
    expect(posts[posts.length - 1].body.session.id).not.toBe(anonSession);
  });

  it('reset() forgets the user and gives the browser a new anonymous id', () => {
    const { window, posts } = loadSdk();
    window.DwsHub.identify({ email: 'rio@example.com' });
    const before = posts[posts.length - 1].body.session;
    window.DwsHub.reset();
    window.DwsHub.track('opened_login');
    window.DwsHub.flush();
    const after = posts[posts.length - 1].body;
    expect(after.user).toBeNull();
    expect(after.session.anonymousId).not.toBe(before.anonymousId);
    expect(after.session.id).not.toBe(before.id);
  });

  it('with localStorage blocked, keeps one session and anonymous id for the page', () => {
    const { window, posts } = loadSdk({ storageBlocked: true });
    window.DwsHub.track('a');
    window.DwsHub.flush();
    window.DwsHub.track('b');
    window.DwsHub.flush();
    expect(new Set(posts.map((p) => p.body.session.id)).size).toBe(1);
    expect(new Set(posts.map((p) => p.body.session.anonymousId)).size).toBe(1);
  });

  it('warns once, without debug mode, when the Hub refuses the app key or origin', async () => {
    const { window, warnings } = loadSdk({ status: 403, errorBody: { error: 'origin_not_allowed' } });
    await settle();
    window.DwsHub.track('x');
    window.DwsHub.flush();
    await settle();
    const refused = warnings.filter((w) => w.includes('refused'));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain('origin_not_allowed');
  });

  it('warns about an unknown command and an identify() with no identity', () => {
    const { window, warnings } = loadSdk();
    window.DwsHub.push(['identfy', { email: 'typo@example.com' }]);
    window.DwsHub.identify({});
    expect(warnings.some((w) => w.includes('unknown command identfy'))).toBe(true);
    expect(warnings.some((w) => w.includes('identify() needs'))).toBe(true);
  });
});
