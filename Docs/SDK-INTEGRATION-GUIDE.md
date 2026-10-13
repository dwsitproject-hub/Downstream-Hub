# Downstream Hub SDK — Integration Guide for Application Teams

The Hub SDK is a small script you add to your web application. Once added, Downstream Hub shows —
per application, in **Admin → Analytic** — who uses your app, which pages they visit, how long they
stay, which JavaScript errors they hit, and the bug reports they send.

It takes about 10 minutes and needs no backend changes in your app.

---

## What it collects

| Collected automatically | How |
|---|---|
| **Page views** | Every route change (works with React/Vue/Angular routers and hash routes). **Path only** — query strings and fragment queries are never sent, so tokens such as `?code=` or `?token=` are never stored. |
| **Time in app** | A heartbeat every 30 s while the page is **visible** on screen. A session ends after 30 minutes without activity. |
| **JavaScript errors** | Uncaught errors and unhandled promise rejections, with stack traces (opaque cross-origin "Script error." noise is ignored). |
| **Bug reports** | A floating **🐞 Report a bug** button. Users type what went wrong; the current page is attached automatically. |
| **Breadcrumbs** | Attached to errors and bug reports only: the last ~30 navigations, API calls (**method, path and status only**), `console.error` messages and tracked actions. They show what led up to a problem — and are what **Sentinel**, the Hub's AI support agent, uses to find the root cause. |

**Not collected:** keystrokes, form contents, clicks, cookies, request/response bodies or headers, query
strings, or anything from other sites. Requests are sent without cookies (`credentials: 'omit'`). Tokens that
appear in console messages are removed before storage.

---

## Before you start

1. A Hub **Admin** opens **Admin → Applications**, finds your application and clicks **SDK**.
2. That screen shows your ready-made snippet (with your application's key) and whether data is arriving.

> **Each environment has its own key.** The staging Hub and the production Hub are separate systems —
> use the snippet from the staging Hub in your staging build and from the production Hub in production.

---

## Step 1 — Add the script

Paste the snippet into the `<head>` of every page, **before your application's own script**:

```html
<script src="https://dwshub.kpndomain.com/api/sdk/v1/hub-sdk.js"
        data-app-key="dwsk_your_key_here" defer></script>
```

That's enough for page views, time in app, JS errors and the bug button. In a single-page app you add it
once, in `index.html`.

## Step 2 — Tell the SDK who is signed in

Your app signs users in through Downstream Hub (OIDC). After you have validated the `id_token`, pass the
Hub user id (the **`sub`** claim) and email:

```js
window.DwsHub && DwsHub.identify({ id: claims.sub, email: claims.email });
```

On sign-out:

```js
window.DwsHub && DwsHub.reset();
```

Call `identify` on every page load once you know the user (it is cheap and idempotent). Pages viewed
earlier in the same session — e.g. the login screen — are attributed to the user automatically.

**React example**

```jsx
useEffect(() => {
  if (user) window.DwsHub?.identify({ id: user.sub, email: user.email });
}, [user]);

function signOut() {
  window.DwsHub?.reset();
  // ...your existing sign-out
}
```

If you only know the user's email (no Hub `sub`), `identify({ email })` still works; such users show as
"Not a Hub account" in the dashboard.

## Step 3 (optional) — Record business actions

```js
DwsHub.track('report_exported', { format: 'xlsx' });
DwsHub.track('order_submitted', { items: 3 });
```

Names: up to 80 characters (letters, numbers, `_ . : / -`). Properties: a small JSON object (≤ 2 KB).
These appear under **Tracked actions** for your application.

---

## Script options

Add these attributes to the `<script>` tag:

| Attribute | Default | Effect |
|---|---|---|
| `data-app-key` | — (required) | Your application's key from the SDK screen. |
| `data-bug-button` | `true` | `false` hides the floating button (use `DwsHub.openBugReport()` from your own button instead). |
| `data-bug-button-position` | `bottom-right` | `bottom-left` moves the button. |
| `data-auto-page-views` | `true` | `false` stops automatic page views; call `DwsHub.page()` yourself. |
| `data-capture-errors` | `true` | `false` stops automatic JS-error capture. |
| `data-release` | — | Your build's version or git commit (e.g. `1.4.2` or `3fa9c1d`). Sentinel then reads the code of exactly that release. Recommended. |
| `data-breadcrumbs` | `true` | `false` stops recording breadcrumbs (Sentinel's analyses get less precise). |
| `data-debug` | `false` | `true` logs SDK activity to the browser console. |

## JavaScript API

| Call | Purpose |
|---|---|
| `DwsHub.identify({ id, email })` | Set the signed-in user (`id` = Hub user id / OIDC `sub`). |
| `DwsHub.reset()` | Forget the user and start a new session (call on sign-out). |
| `DwsHub.track(name, properties?)` | Record a business action. |
| `DwsHub.page(path?)` | Record a page view manually. |
| `DwsHub.openBugReport()` | Open the bug-report dialog from your own button. |
| `DwsHub.setBugButtonVisible(true \| false)` | Show or hide the floating button at runtime. |

Calling the SDK before the script has loaded? Queue calls instead:

```html
<script>window.DwsHub = window.DwsHub || []; DwsHub.push(['identify', { id: '…', email: '…' }]);</script>
```

---

## Requirements on your side

- **Content-Security-Policy.** If your app sends a CSP header, allow the Hub domain for scripts and requests:
  `script-src … https://dwshub.kpndomain.com; connect-src … https://dwshub.kpndomain.com`
  (helmet: add the domain to `scriptSrc` and `connectSrc`).
- **HTTPS ↔ HTTPS.** An HTTPS app must use the HTTPS Hub (production). Browsers block an HTTPS page from
  loading the HTTP staging Hub ("mixed content") — use the matching environment.
- **Allowed origins.** The Hub only accepts data from your application's registered web addresses (its Target
  URL and OIDC redirect URIs). If your app is served from another address (another hostname, a test server,
  `http://localhost:5173` during development), an Admin adds it under **SDK → Allowed origins**.
- **No CORS setup needed** in your app — the Hub handles it.

---

## Recommended: report your release

Set `data-release` at build time so that error analyses look at the code users actually ran. Vite example:

```html
<script src="https://dwshub.kpndomain.com/api/sdk/v1/hub-sdk.js"
        data-app-key="%VITE_HUB_SDK_KEY%" data-release="%VITE_GIT_SHA%" defer></script>
```

```bash
VITE_GIT_SHA=$(git rev-parse --short HEAD) npm run build
```

Keeping function names in production bundles makes stack traces readable for people and for Sentinel
(Vite: `esbuild: { keepNames: true }` in `vite.config.js`).

---

## Check that it works

1. Open your app and click around.
2. In the Hub, **Admin → Applications → SDK** should say **Receiving data** within a minute.
3. **Admin → Analytic → (your application)** shows users, pages, time, errors and bug reports.

Still nothing? Add `data-debug="true"` to the script tag and open the browser console.

| Symptom | Cause / fix |
|---|---|
| Console: `blocked by CORS policy` / `403 origin_not_allowed` | Your page's address is not in the allowed origins — add it on the SDK screen. |
| `403 invalid_key` | Wrong key, or the key was rotated — copy the current snippet. |
| `403 sdk_disabled` | An Admin switched the SDK off for this application. |
| Console: `Refused to load the script` | Your CSP blocks the Hub domain — see *Requirements*. |
| Console: `Mixed Content` | HTTPS app loading the HTTP staging Hub — use the matching environment. |
| Data arrives but users show as anonymous | `DwsHub.identify(...)` is not being called after sign-in. |

---

## Security model (for reviewers)

- The key is a **publishable** key, like an analytics write key: it is visible in your page source by design.
  Data is accepted only when the key is valid **and** the request comes from one of the application's
  allowed origins; requests without an `Origin` header are rejected.
- The user identity is **reported by your app**, so it is analytics-grade, not an authentication signal.
  Never use Hub analytics data to grant access.
- If a key leaks or is abused, an Admin clicks **Issue a new key** on the SDK screen — the old key stops
  working immediately — and you update the snippet.
- The Hub stores page paths without query strings, error messages/stack traces, breadcrumbs, user agent and IP address.
- When **Sentinel** analyses a report it sends the technical details to the Claude API with every email address
  pseudonymised and secrets/IPs removed; see `Docs/SENTINEL-GUIDE.md`.
