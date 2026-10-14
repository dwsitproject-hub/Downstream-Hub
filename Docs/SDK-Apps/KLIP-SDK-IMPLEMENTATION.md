# KLIP — Downstream Hub SDK Implementation Guide

**For:** the KLIP development team
**Application:** KLIP — KPN Logistics Intelligence Platform
**Effort:** about half a day including testing. Front-end: one `<script>` tag, two lines of code and one build variable (`data-release`). KLIP's back end needs, at most, a small change to the "current user" response (Step 2).

---

## 1. What this gives KLIP

Once the SDK is in KLIP, the Downstream Hub admins see, in **Hub → Admin → Analytic → KLIP**:

| Feature | What it shows |
|---|---|
| **Usage** | Who uses KLIP, how often, and for how long (active time only, while the tab is visible) |
| **Top pages** | Which KLIP pages people open most |
| **Top users** | The most active users, each with their sessions and page history |
| **Tracked actions** | Business actions KLIP chooses to record, e.g. "report exported" (optional) |
| **JS errors** | JavaScript errors users hit in KLIP, captured automatically with stack traces |
| **Bug reports** | Reports users send from a 🐞 **Report a bug** button inside KLIP |
| **Sentinel analysis** | For every bug report and new JS error, the Hub's AI support agent reads the error, what the user did before it, and KLIP's source code (read-only), then proposes the **root cause and a fix** — often as a ready-to-review patch |

**What it never collects:** keystrokes, form contents, clicks, cookies, request/response bodies, or query strings (`?code=`, `?token=` and the like are stripped before sending). Requests go out without cookies. Errors and reports carry *breadcrumbs* — the last few pages, API calls (method, path, status only) and `console.error` messages — so problems can be traced.

---

## 2. KLIP values

| Item | Staging | Production |
|---|---|---|
| KLIP address (allowed origin) | `http://test-klip.kpndomain.com` | *(KLIP production URL — the Hub admin adds it)* |
| Hub SDK script | `http://test-dwshub.kpndomain.com/api/sdk/v1/hub-sdk.js` | `https://dwshub.kpndomain.com/api/sdk/v1/hub-sdk.js` |
| KLIP SDK key (`data-app-key`) | `dwsk_…`, sent to you by the Hub admin | `dwsk_…`, a **different** key from the production Hub |
| OIDC client ID (for reference) | `logistic` | `logistic` |

> **Get the key from the Hub admin.** It comes from **Hub → Admin → Applications → KLIP → SDK**, and that same screen shows the ready-made snippet. Copy it from there rather than retyping it. One wrong character and you get `403 invalid_key`.
>
> The key is **publishable**: it can safely appear in page source. The Hub only accepts data from KLIP's registered addresses. Even so, don't reuse it in other applications.

> **Staging and production are separate systems.** Staging KLIP uses the staging Hub script and key; production KLIP uses the production ones. Load them from environment config (Step 1), never hard-code both.

---

## 3. Step 1 — Add the script

Add the script to KLIP's HTML `<head>`, **before KLIP's own application script**. The order matters: the SDK
must start first to record KLIP's API calls (fetch and axios/XHR) as breadcrumbs.

```html
<script src="http://test-dwshub.kpndomain.com/api/sdk/v1/hub-sdk.js"
        data-app-key="dwsk_KLIP_STAGING_KEY" defer></script>
```

**Where it goes:**

- **If KLIP is a single-page app (React / Vue / Angular, built with Vite or webpack):** put it in `index.html` once. Route changes are detected automatically, including hash routes.
- **If KLIP is server-rendered (EJS / Blade / Razor / JSP …):** put it in the shared layout template so it's on every page.

**Make it per-environment.** Vite example in `index.html`:

```html
<script src="%VITE_HUB_SDK_URL%" data-app-key="%VITE_HUB_SDK_KEY%" data-release="%VITE_GIT_SHA%" defer></script>
```

`data-release` tells the Hub which build the user was running, so Sentinel analyses errors against exactly that
code. It must be the **git commit SHA** (or a git **tag** that exists in KLIP's repository), set at build time:

- Local / CI build: `VITE_GIT_SHA=$(git rev-parse --short HEAD) npm run build` (in CI, use the pipeline's commit SHA variable).
- Docker build: `.git` is usually not inside the build context, so pass it in:
  `docker build --build-arg GIT_SHA=$(git rev-parse --short HEAD) …` and in the Dockerfile
  `ARG GIT_SHA` + `ENV VITE_GIT_SHA=$GIT_SHA` before `npm run build`.

If it isn't set, nothing breaks: Sentinel simply reads the branch configured in Step 6 instead.

Also recommended, so stack traces show real function names instead of `a`, `b`, `c`: add
`esbuild: { keepNames: true }` to `vite.config.js`.

```bash
# .env.staging
VITE_HUB_SDK_URL=http://test-dwshub.kpndomain.com/api/sdk/v1/hub-sdk.js
VITE_HUB_SDK_KEY=dwsk_KLIP_STAGING_KEY

# .env.production
VITE_HUB_SDK_URL=https://dwshub.kpndomain.com/api/sdk/v1/hub-sdk.js
VITE_HUB_SDK_KEY=dwsk_KLIP_PRODUCTION_KEY
```

(Other build tools have the same idea: CRA uses `%REACT_APP_…%`; for server-rendered pages, inject the values from the server config.)

With only Step 1 done, page views, time in app, JS errors and the bug button already work. Visitors show as **anonymous** until Step 2.

---

## 4. Step 2 — Tell the SDK who is signed in

KLIP signs users in through Downstream Hub (OIDC). The callback is `/auth/oidc/callback` on KLIP's **back end**. That is where KLIP validates the `id_token`, so the browser does not see the token claims directly.

What the SDK needs is the **Hub user id** (the `id_token` **`sub`** claim, a UUID) and the user's email.

### 4a. Back end — expose `hub_user_id` to the front end

KLIP already stores the Hub `sub` on its local user record during SSO sign-in. That's the silent-linking step in the SSO Integration Guide, usually a column such as `oidc_sub`. Return it from the endpoint the front end already calls to get the current user (`/api/me`, `/api/auth/session` or similar):

```js
// e.g. GET /api/me
res.json({
  id: user.id,                 // KLIP's own id: keep as-is
  name: user.name,
  email: user.email,
  hub_user_id: user.oidc_sub,  // ← add: Hub user id (id_token "sub"), or null
  // ...
});
```

> **Use the Hub `sub`, not KLIP's own user id.** The SDK only accepts the Hub UUID as `id` and silently ignores any other value. If a user has no Hub `sub` (for example a local, non-SSO login), send just the email. The Hub then matches by email, or shows the user as "Not a Hub account".

### 4b. Front end — call `identify` and `reset`

Call `identify` **once the current user is known, on every page load**. It is cheap and safe to repeat. Call `reset` on **sign-out**.

```js
// after the current user has been loaded
window.DwsHub && DwsHub.identify({ id: me.hub_user_id, email: me.email });

// on sign-out, before redirecting
window.DwsHub && DwsHub.reset();
```

**React example:**

```jsx
// wherever KLIP keeps the signed-in user (AuthContext, store, etc.)
useEffect(() => {
  if (user) window.DwsHub?.identify({ id: user.hub_user_id, email: user.email });
}, [user]);

async function signOut() {
  window.DwsHub?.reset();      // first, so the next person gets a fresh session
  await api.post('/auth/logout');
  window.location.href = '/login';
}
```

Pages viewed before `identify` in the same session, such as KLIP's `/login` page, are attributed to the user automatically once `identify` runs.

---

## 5. Step 3 (optional) — Record important KLIP actions

Page views come for free. For business actions the KLIP product owner cares about, add one line where the action succeeds:

```js
DwsHub.track('contract_viewed',   { contract_type: 'term' });
DwsHub.track('report_exported',   { report: 'shipment_status', format: 'xlsx' });
DwsHub.track('sap_import_started');
```

Rules:
- **Name:** up to 80 characters, letters/numbers/`_ . : / -`. Use `snake_case` verbs in past tense.
- **Properties:** a small JSON object (≤ 2 KB). **Never put personal data, contract values, prices or document contents in properties.** Use categories and counts only.

Suggested starter list for KLIP (agree on it with the product owner): `report_exported`, `contract_viewed`, `shipment_searched`, `sap_import_started`. These show under **Tracked actions** for KLIP.

---

## 6. Step 4 — Content-Security-Policy (only if KLIP sends one)

Check whether KLIP sends a CSP: browser DevTools → Network → the HTML document → Response Headers → `Content-Security-Policy`. Also check KLIP's nginx config for `add_header Content-Security-Policy`.

**If KLIP has no CSP:** skip this step.

**If it does,** add the Hub domain to `script-src` and `connect-src`.

helmet (Express):

```js
helmet({
  contentSecurityPolicy: {
    directives: {
      // ...existing directives
      scriptSrc:  ["'self'", process.env.HUB_SDK_ORIGIN],   // e.g. http://test-dwshub.kpndomain.com
      connectSrc: ["'self'", process.env.HUB_SDK_ORIGIN],
    },
  },
});
```

nginx:

```nginx
add_header Content-Security-Policy "... script-src 'self' http://test-dwshub.kpndomain.com; connect-src 'self' http://test-dwshub.kpndomain.com; ..." always;
```

(In production, use `https://dwshub.kpndomain.com`.)

No CORS configuration is needed in KLIP. The Hub handles CORS.

---

## 7. Step 5 — Test on staging

1. Deploy KLIP to staging (`http://test-klip.kpndomain.com`).
2. Open KLIP in a **fresh browser window**, sign in through the Hub, and browse 4–5 pages for a minute.
3. Check that the 🐞 **Report a bug** button is in the bottom-right corner. Send a test report, e.g. "SDK test, please ignore".
4. In DevTools → **Network**, filter for `collect`. You should see `POST …/api/sdk/v1/collect` → **204** every few seconds while you move around.
5. Ask the Hub admin to check:
   - **Admin → Applications → KLIP → SDK** shows **Receiving data**.
   - **Admin → Analytic → KLIP** shows your pages, your name under top users (not "anonymous"), and the test bug report.
6. Sign out, then sign in again as another user. They should appear as a separate user.
7. **Test error capture and Sentinel.** On any KLIP page, open DevTools → Console and run
   `setTimeout(() => { throw new Error('SDK test error — please ignore') })`. Then ask the Hub admin to open
   that error in **Analytic → KLIP → Bug reports & errors**. It should show **breadcrumbs** (your last pages and
   API calls) and, within a few minutes, a **Sentinel analysis**, which should correctly call it a deliberate
   test error.

**Debug mode:** add `data-debug="true"` to the script tag and watch the browser console for `[DwsHub]` lines. Remove it before production.

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Console: `blocked by CORS policy`, or `403 origin_not_allowed` | KLIP is running on an address the Hub doesn't know (another hostname, an IP address, or `http://localhost:5173` in development). Ask the Hub admin to add it under **SDK → Allowed origins**. |
| `403 invalid_key` | The key was mistyped or has been rotated. Copy the current snippet from the SDK screen. |
| `403 sdk_disabled` | The Hub admin has switched the SDK off for KLIP. |
| Console: `Refused to load the script` | KLIP's CSP is blocking the Hub domain. See Step 4. |
| Console: `Mixed Content` | An HTTPS KLIP page is loading the HTTP staging Hub. Use the matching environment's script and key. |
| Data arrives but every user is **anonymous** | `identify` isn't being called, or it's called with KLIP's own id instead of the Hub `sub` and no email. See Step 2. |
| The bug button covers a KLIP control | Add `data-bug-button-position="bottom-left"`, or `data-bug-button="false"` and call `DwsHub.openBugReport()` from KLIP's own Help menu. |
| Errors have no API calls in their breadcrumbs | The SDK script loads after KLIP's app script. Move it above. |
| Sentinel analysis says **No source code** | The repository isn't connected, or the Hub's GitHub token can't read it. See Step 6. |
| Stack traces show only `index-3fa9c1.js:1:23456` | Minified build. Add `esbuild: { keepNames: true }` (Step 1). |

---

## 8. Step 6 — Sentinel (Hub admin, 5 minutes)

So that Sentinel can read KLIP's code, the Hub admin opens **Analytic → KLIP → Sentinel settings** and enters:

| Field | Value |
|---|---|
| GitHub repository | KLIP's repository, e.g. `dwsitproject-hub/<klip-repo>` |
| Branch | the branch staging/production is built from |
| Application folder | only if KLIP's front end lives in a sub-folder (e.g. `frontend/`) |
| Notes for Sentinel | KLIP's stack and anything unusual: data sources (SAP imports), batch jobs, known slow pages |

The KLIP team only needs to confirm the repository/branch names and write the notes. Sentinel's access is
read-only; it proposes fixes, the KLIP team decides.

Things to check:

- **The repository must be on GitHub.** The Hub's read-only GitHub token must include it (fine-grained tokens list
  repositories explicitly). The Hub admin adds it and clicks **Test repository access**.
- **One repository per application.** If KLIP's front end and back end are in **separate repositories**, connect
  the **front-end** one: browser errors and bug reports start there. For causes on the API side, Sentinel works from
  the breadcrumbs (e.g. `GET /api/orders → 500`) and says so in its analysis.
- **Staging and production are configured separately.** Repeat this in the production Hub (Step 7).

---

## 9. Step 7 — Go to production

1. The Hub admin opens the **production** Hub → **Admin → Applications → KLIP → SDK**, adds KLIP's production URL to the allowed origins if it isn't already registered, and sends you the **production** key.
2. Set the production env values (`https://dwshub.kpndomain.com/...` and the production key).
3. If KLIP has a CSP, allow `https://dwshub.kpndomain.com`.
4. Make sure `data-debug` is gone and `data-release` is filled in by the production build.
5. The Hub admin repeats Step 6 (Sentinel settings) in the **production** Hub, with the production branch.
6. Deploy, then repeat the checks in Step 5 against production.

---

## 10. Reference

**Script tag options:**

| Attribute | Default | Effect |
|---|---|---|
| `data-app-key` | *(required)* | KLIP's key for this environment |
| `data-bug-button` | `true` | `false` hides the floating button |
| `data-bug-button-position` | `bottom-right` | `bottom-left` moves it |
| `data-auto-page-views` | `true` | `false`: KLIP calls `DwsHub.page()` itself |
| `data-capture-errors` | `true` | `false`: no automatic JS-error capture |
| `data-release` | — | Build version / git commit (recommended) |
| `data-breadcrumbs` | `true` | `false`: no breadcrumbs (less precise analyses) |
| `data-debug` | `false` | `true` logs SDK activity to the console |

**JavaScript API:**

| Call | Purpose |
|---|---|
| `DwsHub.identify({ id, email })` | Set the signed-in user (`id` = Hub `sub`) |
| `DwsHub.reset()` | Forget the user and start a new session (sign-out) |
| `DwsHub.track(name, props?)` | Record a business action |
| `DwsHub.page(path?)` | Record a page view manually |
| `DwsHub.openBugReport()` | Open the bug-report dialog from KLIP's own button |
| `DwsHub.setBugButtonVisible(bool)` | Show or hide the floating button |

Always guard calls with `window.DwsHub &&` (or `window.DwsHub?.`), so KLIP keeps working if the Hub is unreachable. The SDK never blocks or breaks the host page.

**Security notes for KLIP reviewers:**
- The identity KLIP reports is for analytics only. Nothing in the Hub grants access based on it.
- If the key leaks or is abused, the Hub admin issues a new key (the old one stops working immediately) and KLIP updates its env value.
- The Hub stores page paths (without query strings), error messages and stack traces, breadcrumbs (pages, API
  calls as method + path + status, `console.error` text), browser user agent and IP address.
- **Sentinel and KLIP's source code.** To analyse a problem, Sentinel reads KLIP's repository (read-only token,
  contents only) and sends the relevant source files, the error details and breadcrumbs to the **Claude API
  (Anthropic)**. User emails are replaced with pseudonyms and tokens/IPs are removed before sending; source files
  are sent as they are. If KLIP's code must not leave the company, don't connect the repository in Step 6.
  Sentinel then works from runtime evidence only.
- **Keep secrets and personal data out of URLs and error logs.** Breadcrumbs record API paths and
  `console.error` text. Query strings are dropped and tokens in console text are scrubbed, but a token or
  customer name **inside a path** (e.g. `/api/reset/8f3a…`, `/api/customers/john.doe`) or in a log message
  would be stored. Check that KLIP's API paths and `console.error` calls don't contain these. If they can't be
  changed, use `data-breadcrumbs="false"`.
- **Secrets in the repository.** Don't commit credentials to KLIP's repository: recognisable keys are scrubbed,
  but source files otherwise reach the Claude API unchanged.

Full generic guide: `Docs/SDK-INTEGRATION-GUIDE.md` in the Downstream Hub repository.

---

## 11. Checklist for the KLIP team

- [ ] Received the staging SDK key from the Hub admin
- [ ] Script tag added to `index.html` / layout, driven by env config, with `data-release` set at build time
- [ ] Back end returns `hub_user_id` (Hub `sub`) and `email` for the current user
- [ ] `DwsHub.identify(...)` called after the user loads; `DwsHub.reset()` on sign-out
- [ ] (Optional) `DwsHub.track(...)` for agreed business actions, with no personal data in properties
- [ ] CSP updated if KLIP sends one
- [ ] SDK script placed **before** KLIP's app script (API-call breadcrumbs)
- [ ] No tokens or personal data in API paths or `console.error` messages, or `data-breadcrumbs="false"`
- [ ] Security reviewer has agreed to KLIP's source code being read by Sentinel (Claude API)
- [ ] Repository (GitHub), branch and notes sent to the Hub admin for Sentinel
- [ ] Staging test passed: `collect` → 204, Hub shows **Receiving data**, user is named, test bug report visible,
      test error shows breadcrumbs and a Sentinel analysis
- [ ] Production key and URL configured, `data-debug` removed, production verified
