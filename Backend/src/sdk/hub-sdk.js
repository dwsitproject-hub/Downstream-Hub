/*!
 * Downstream Hub SDK v1 — usage analytics & bug reporting for internal web apps.
 *
 *   <script src="https://<hub>/api/sdk/v1/hub-sdk.js" data-app-key="dwsk_..." defer></script>
 *   DwsHub.identify({ id: '<Hub user id (OIDC sub)>', email: 'user@company.com' });
 *   DwsHub.track('report_exported', { format: 'xlsx' });
 *   DwsHub.reset();   // on sign-out
 *
 * Collects: page views (path only — query strings are never sent), time in app,
 * uncaught JS errors, and user bug reports from a floating "Report a bug" button.
 * Errors and reports carry breadcrumbs — the last few navigations, API calls (method,
 * path and status only), console errors and tracked actions — so Sentinel, the Hub's
 * support agent, can see what led up to the problem.
 */
(function (window, document) {
  'use strict';

  var existing = window.DwsHub;
  if (existing && existing.__loaded) return;

  var VERSION = '1.1.0';
  var HEARTBEAT_MS = 30 * 1000;
  var FLUSH_MS = 5 * 1000;
  var MAX_QUEUE = 100;
  var SESSION_IDLE_MS = 30 * 60 * 1000;
  var MAX_ERRORS_PER_PAGE = 20;
  var MAX_BREADCRUMBS = 30;

  var scriptEl = document.currentScript || (function () {
    var all = document.querySelectorAll('script[src*="hub-sdk"]');
    return all[all.length - 1];
  })();

  var cfg = {
    appKey: null,
    endpoint: null,
    bugButton: true,
    bugButtonPosition: 'bottom-right',
    autoPageViews: true,
    captureErrors: true,
    breadcrumbs: true,
    release: null,
    debug: false,
  };
  var state = {
    started: false,
    user: null,
    queue: [],
    lastPath: null,
    errorCount: 0,
    lastError: '',
    lastErrorAt: 0,
    flushTimer: null,
    heartbeatTimer: null,
    widget: null,
    crumbs: [],
  };

  /* ---------- small utilities ---------- */

  function log() {
    if (cfg.debug && window.console) console.log.apply(console, ['[DwsHub]'].concat([].slice.call(arguments)));
  }

  function store(key, value) {
    try {
      if (value === undefined) return JSON.parse(window.localStorage.getItem(key));
      if (value === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* storage blocked — run in memory */ }
    return null;
  }

  function randomId() {
    var bytes = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    var s = '';
    for (var j = 0; j < bytes.length; j++) s += ('0' + bytes[j].toString(16)).slice(-2);
    return s; // 32 hex chars
  }

  function bool(v, fallback) {
    if (v === undefined || v === null || v === '') return fallback;
    return !(v === false || v === 'false' || v === '0' || v === 'off');
  }

  /** Path only; hash routes kept ("/app#/orders"), all query strings dropped. */
  function currentPath() {
    var p = window.location.pathname || '/';
    var h = window.location.hash || '';
    if (h.indexOf('#/') === 0) p += '#' + h.slice(1).split('?')[0];
    return p;
  }

  /* ---------- identity & session ---------- */

  function anonymousId() {
    var id = store('dwshub.aid');
    if (!id) { id = randomId(); store('dwshub.aid', id); }
    return id;
  }

  function sessionStoreKey() { return 'dwshub.s.' + cfg.appKey; }

  function session(touch) {
    var now = Date.now();
    var s = store(sessionStoreKey());
    if (!s || !s.id || now - (s.last || 0) > SESSION_IDLE_MS) s = { id: randomId(), last: now };
    if (touch !== false) s.last = now;
    store(sessionStoreKey(), s);
    return s.id;
  }

  function rotateSession() {
    store(sessionStoreKey(), { id: randomId(), last: Date.now() });
  }

  /* ---------- transport ---------- */

  function endpoint(path) { return cfg.endpoint + path; }

  function post(path, payload, keepalive) {
    var body = JSON.stringify(payload);
    if (window.fetch) {
      return window.fetch(endpoint(path), {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        keepalive: !!keepalive && body.length < 60000,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: body,
      });
    }
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', endpoint(path), true);
      xhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
      xhr.onload = function () { resolve({ ok: xhr.status < 400, status: xhr.status, json: function () { return Promise.resolve(JSON.parse(xhr.responseText || '{}')); } }); };
      xhr.onerror = reject;
      xhr.send(body);
    });
  }

  function basePayload() {
    return {
      key: cfg.appKey,
      sdk: VERSION,
      session: { id: session(), anonymousId: anonymousId() },
      user: state.user,
      release: cfg.release || undefined,
    };
  }

  function enqueue(event, flushSoon) {
    if (!state.started) return;
    state.queue.push(event);
    if (state.queue.length > MAX_QUEUE) state.queue.splice(0, state.queue.length - MAX_QUEUE);
    if (flushSoon || state.queue.length >= 20) flush();
  }

  function flush(keepalive) {
    if (!state.started || state.queue.length === 0) return;
    var events = state.queue.splice(0, 50);
    var payload = basePayload();
    payload.events = events;
    post('/collect', payload, keepalive).then(function (res) {
      if (res && res.status >= 400 && res.status !== 429) log('collect rejected', res.status);
    }).catch(function () {
      // network failure: put events back for the next attempt (bounded)
      state.queue = events.concat(state.queue).slice(-MAX_QUEUE);
    });
  }

  /* ---------- breadcrumbs: what happened just before an error or report ---------- */

  function crumb(c) {
    if (!cfg.breadcrumbs) return;
    c.t = Date.now();
    state.crumbs.push(c);
    if (state.crumbs.length > MAX_BREADCRUMBS) state.crumbs.splice(0, state.crumbs.length - MAX_BREADCRUMBS);
  }

  function isOwnRequest(url) {
    return !!cfg.endpoint && String(url).indexOf(cfg.endpoint) === 0;
  }

  /** Method, path and status only: never the query string, headers or bodies. */
  function httpCrumb(method, url, status, start) {
    crumb({
      type: 'http',
      method: String(method || 'GET').toUpperCase(),
      url: String(url).split('#')[0].split('?')[0].slice(0, 300),
      status: status || 0,
      ms: Date.now() - start,
    });
  }

  function watchNetwork() {
    if (window.fetch && !window.fetch.__dwshub) {
      var originalFetch = window.fetch;
      var wrappedFetch = function (input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) || String(input);
        var method = (init && init.method) || (input && input.method) || 'GET';
        var start = Date.now();
        var request = originalFetch.apply(window, arguments);
        if (isOwnRequest(url)) return request;
        return request.then(function (res) {
          httpCrumb(method, url, res && res.status, start);
          return res;
        }, function (err) {
          httpCrumb(method, url, 0, start);
          throw err;
        });
      };
      wrappedFetch.__dwshub = true;
      window.fetch = wrappedFetch;
    }
    var XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype && !XHR.prototype.__dwshub) {
      var open = XHR.prototype.open;
      var send = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        this.__dwshubReq = { method: method, url: String(url) };
        return open.apply(this, arguments);
      };
      XHR.prototype.send = function () {
        var xhr = this;
        var req = xhr.__dwshubReq;
        if (req && !isOwnRequest(req.url)) {
          var start = Date.now();
          xhr.addEventListener('loadend', function () { httpCrumb(req.method, req.url, xhr.status, start); });
        }
        return send.apply(this, arguments);
      };
      XHR.prototype.__dwshub = true;
    }
  }

  function argText(a) {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.message;
    try { return JSON.stringify(a).slice(0, 200); } catch (e) { return String(a); }
  }

  function watchConsole() {
    var c = window.console;
    if (!c || typeof c.error !== 'function' || c.error.__dwshub) return;
    var originalError = c.error;
    var wrappedError = function () {
      try {
        crumb({ type: 'console', message: [].slice.call(arguments).map(argText).join(' ').slice(0, 300) });
      } catch (e) { /* never break the host's logging */ }
      return originalError.apply(c, arguments);
    };
    wrappedError.__dwshub = true;
    c.error = wrappedError;
  }

  function breadcrumbs() {
    return cfg.breadcrumbs && state.crumbs.length ? state.crumbs.slice() : undefined;
  }

  /* ---------- automatic collection ---------- */

  function pageView(path) {
    var p = path || currentPath();
    if (p === state.lastPath) return;
    state.lastPath = p;
    crumb({ type: 'nav', path: p });
    enqueue({ type: 'page_view', path: p, title: (document.title || '').slice(0, 200) });
  }

  function watchNavigation() {
    var wrap = function (method) {
      var original = window.history[method];
      if (typeof original !== 'function') return;
      window.history[method] = function () {
        var result = original.apply(this, arguments);
        setTimeout(function () { pageView(); }, 0);
        return result;
      };
    };
    wrap('pushState');
    wrap('replaceState');
    window.addEventListener('popstate', function () { pageView(); });
    window.addEventListener('hashchange', function () { pageView(); });
  }

  function reportError(message, stack) {
    var msg = String(message || '').slice(0, 1000);
    if (!msg || msg === 'Script error.' || msg === 'Script error') return; // opaque cross-origin noise
    var now = Date.now();
    if (msg === state.lastError && now - state.lastErrorAt < 10000) return;
    if (state.errorCount >= MAX_ERRORS_PER_PAGE) return;
    state.lastError = msg;
    state.lastErrorAt = now;
    state.errorCount += 1;
    enqueue({ type: 'error', message: msg, stack: stack ? String(stack).slice(0, 8000) : undefined, path: currentPath(), breadcrumbs: breadcrumbs() }, true);
  }

  function watchErrors() {
    window.addEventListener('error', function (e) {
      if (!e || (e.target && e.target !== window)) return; // resource load errors (img/script 404s) are not JS errors
      reportError(e.message || (e.error && e.error.message), e.error && e.error.stack);
    });
    window.addEventListener('unhandledrejection', function (e) {
      var r = e && e.reason;
      reportError((r && (r.message || String(r))) || 'Unhandled promise rejection', r && r.stack);
    });
  }

  function heartbeat() {
    if (document.visibilityState && document.visibilityState !== 'visible') return;
    enqueue({ type: 'heartbeat' }, true);
  }

  function watchVisibility() {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush(true);
      else heartbeat();
    });
    window.addEventListener('pagehide', function () { flush(true); });
  }

  /* ---------- bug report widget (Shadow DOM, isolated from the host page's CSS) ---------- */

  var WIDGET_CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}',
    '.fab{position:fixed;bottom:20px;z-index:2147483000;display:inline-flex;align-items:center;gap:8px;padding:10px 14px;border-radius:999px;border:1px solid #d9d9d9;background:#fff;color:#222;font-size:13px;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,.15);cursor:pointer}',
    '.fab:hover{box-shadow:0 6px 18px rgba(0,0,0,.2)}',
    '.fab:focus-visible,button:focus-visible,textarea:focus-visible{outline:2px solid #c43a31;outline-offset:2px}',
    '.right{right:20px}.left{left:20px}',
    '.overlay{position:fixed;inset:0;z-index:2147483001;background:rgba(17,24,39,.45);display:flex;align-items:center;justify-content:center;padding:16px}',
    '.overlay[hidden]{display:none}',
    '.modal{background:#fff;color:#222;border-radius:12px;box-shadow:0 20px 50px rgba(0,0,0,.3);width:100%;max-width:460px;padding:22px}',
    'h2{margin:0 0 6px;font-size:18px}',
    'p{margin:0 0 12px;font-size:13px;color:#595959;line-height:1.5}',
    'textarea{width:100%;min-height:120px;resize:vertical;padding:10px 12px;border:1px solid #c4c4c4;border-radius:8px;font-size:14px;color:#222}',
    '.row{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}',
    'button.btn{padding:8px 14px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid #d9d9d9;background:#fff;color:#222}',
    'button.primary{background:#c43a31;border-color:#c43a31;color:#fff}',
    'button[disabled]{opacity:.65;cursor:not-allowed}',
    '.msg{font-size:13px;margin-top:10px}.err{color:#b91c1c}.ok{color:#166534}',
    '.brand{font-size:11px;color:#8c8c8c;margin-top:12px}'
  ].join('');

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    if (text) node.textContent = text;
    return node;
  }

  function mountWidget() {
    if (state.widget || !document.body) return;
    var host = el('div', { 'data-dwshub-widget': '' });
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    root.appendChild(el('style', null, WIDGET_CSS));

    var fab = el('button', { type: 'button', class: 'fab ' + (cfg.bugButtonPosition === 'bottom-left' ? 'left' : 'right'), 'aria-label': 'Report a bug' });
    fab.appendChild(el('span', { 'aria-hidden': 'true' }, '🐞'));
    fab.appendChild(el('span', null, 'Report a bug'));

    var overlay = el('div', { class: 'overlay', hidden: '' });
    var modal = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dwshub-title' });
    var title = el('h2', { id: 'dwshub-title' }, 'Report a bug');
    var intro = el('p', null, 'Tell us what went wrong. The page you are on is included automatically.');
    var area = el('textarea', { maxlength: '5000', placeholder: 'What happened? What did you expect?', 'aria-label': 'Describe the problem' });
    var msg = el('div', { class: 'msg', role: 'status' });
    var cancel = el('button', { type: 'button', class: 'btn' }, 'Cancel');
    var send = el('button', { type: 'button', class: 'btn primary' }, 'Send report');
    var row = el('div', { class: 'row' });
    row.appendChild(cancel);
    row.appendChild(send);
    [title, intro, area, msg, row, el('div', { class: 'brand' }, 'Sent to the Downstream Hub team')].forEach(function (n) { modal.appendChild(n); });
    overlay.appendChild(modal);
    root.appendChild(fab);
    root.appendChild(overlay);
    document.body.appendChild(host);

    function close() {
      overlay.setAttribute('hidden', '');
      area.value = '';
      msg.textContent = '';
      msg.className = 'msg';
      send.disabled = false;
      send.textContent = 'Send report';
      area.style.display = '';
      send.style.display = '';
      cancel.textContent = 'Cancel';
      fab.focus();
    }
    function open() {
      overlay.removeAttribute('hidden');
      area.focus();
    }

    fab.addEventListener('click', open);
    cancel.addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    overlay.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    send.addEventListener('click', function () {
      var text = (area.value || '').trim();
      if (!text) { msg.className = 'msg err'; msg.textContent = 'Please describe the problem.'; return; }
      send.disabled = true;
      send.textContent = 'Sending…';
      var payload = basePayload();
      payload.message = text;
      payload.path = currentPath();
      payload.breadcrumbs = breadcrumbs();
      post('/bug-report', payload).then(function (res) {
        if (!res.ok) throw new Error('status ' + res.status);
        msg.className = 'msg ok';
        msg.textContent = 'Thanks — your report has been sent.';
        area.style.display = 'none';
        send.style.display = 'none';
        cancel.textContent = 'Close';
      }).catch(function () {
        msg.className = 'msg err';
        msg.textContent = 'Could not send the report. Please try again.';
        send.disabled = false;
        send.textContent = 'Send report';
      });
    });

    state.widget = { host: host, fab: fab, open: open };
    setBugButtonVisible(cfg.bugButton);
  }

  function setBugButtonVisible(visible) {
    cfg.bugButton = !!visible;
    if (state.widget) state.widget.fab.style.display = cfg.bugButton ? '' : 'none';
  }

  function whenBodyReady(fn) {
    if (document.body) fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  /* ---------- public API ---------- */

  function init(options) {
    if (state.started) return api;
    options = options || {};
    cfg.appKey = options.appKey || cfg.appKey;
    if (!cfg.appKey) { if (window.console) console.warn('[DwsHub] missing app key (data-app-key)'); return api; }
    var src = scriptEl && scriptEl.src ? scriptEl.src : '';
    var origin = src ? new URL(src, window.location.href).origin : window.location.origin;
    cfg.endpoint = (options.endpoint || (origin + '/api/sdk/v1')).replace(/\/$/, '');
    cfg.bugButton = bool(options.bugButton, cfg.bugButton);
    cfg.bugButtonPosition = options.bugButtonPosition || cfg.bugButtonPosition;
    cfg.autoPageViews = bool(options.autoPageViews, cfg.autoPageViews);
    cfg.captureErrors = bool(options.captureErrors, cfg.captureErrors);
    cfg.breadcrumbs = bool(options.breadcrumbs, cfg.breadcrumbs);
    cfg.release = options.release ? String(options.release).slice(0, 64) : null;
    cfg.debug = bool(options.debug, false);

    state.user = state.user || store('dwshub.u.' + cfg.appKey) || null;
    state.started = true;
    log('started', VERSION, cfg.endpoint);

    if (cfg.breadcrumbs) { watchNetwork(); watchConsole(); }
    if (cfg.captureErrors) watchErrors();
    if (cfg.autoPageViews) { watchNavigation(); pageView(); }
    watchVisibility();
    heartbeat();
    state.flushTimer = setInterval(function () { flush(); }, FLUSH_MS);
    state.heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
    whenBodyReady(mountWidget);
    return api;
  }

  var api = {
    __loaded: true,
    version: VERSION,
    init: init,
    /** Tell the SDK who is signed in: { id: Hub user id (OIDC "sub"), email } */
    identify: function (user) {
      if (!user || typeof user !== 'object') return api;
      var next = { id: user.id ? String(user.id) : undefined, email: user.email ? String(user.email) : undefined };
      var prev = state.user;
      state.user = next;
      if (cfg.appKey) store('dwshub.u.' + cfg.appKey, next);
      if (prev && (prev.id !== next.id || prev.email !== next.email)) rotateSession();
      enqueue({ type: 'heartbeat' }, true);
      return api;
    },
    /** Call on sign-out: forgets the user and starts a fresh session. */
    reset: function () {
      flush(true);
      state.user = null;
      state.crumbs = []; // the next person's reports must not carry this person's activity
      if (cfg.appKey) store('dwshub.u.' + cfg.appKey, null);
      rotateSession();
      return api;
    },
    track: function (name, properties) {
      if (!name) return api;
      crumb({ type: 'action', name: String(name).slice(0, 80) });
      enqueue({ type: 'custom', name: String(name).slice(0, 80), path: currentPath(), properties: properties || undefined });
      return api;
    },
    /** Manual page view (when autoPageViews is off, or for virtual pages). */
    page: function (path) {
      pageView(path ? String(path).split('?')[0] : undefined);
      return api;
    },
    openBugReport: function () {
      whenBodyReady(function () { mountWidget(); if (state.widget) state.widget.open(); });
      return api;
    },
    setBugButtonVisible: function (visible) { setBugButtonVisible(visible); return api; },
    flush: function () { flush(); return api; },
  };

  window.DwsHub = api;

  // Configure from the <script> tag's data-* attributes.
  if (scriptEl && scriptEl.getAttribute('data-app-key')) {
    init({
      appKey: scriptEl.getAttribute('data-app-key'),
      endpoint: scriptEl.getAttribute('data-endpoint') || undefined,
      bugButton: scriptEl.getAttribute('data-bug-button'),
      bugButtonPosition: scriptEl.getAttribute('data-bug-button-position') || undefined,
      autoPageViews: scriptEl.getAttribute('data-auto-page-views'),
      captureErrors: scriptEl.getAttribute('data-capture-errors'),
      breadcrumbs: scriptEl.getAttribute('data-breadcrumbs'),
      release: scriptEl.getAttribute('data-release') || undefined,
      debug: scriptEl.getAttribute('data-debug'),
    });
  }

  // Replay calls queued before the script loaded: window.DwsHub = [['identify', {...}], ...]
  if (Array.isArray(existing)) {
    existing.forEach(function (call) {
      if (call && typeof api[call[0]] === 'function') api[call[0]].apply(api, call.slice(1));
    });
  }
})(window, document);
