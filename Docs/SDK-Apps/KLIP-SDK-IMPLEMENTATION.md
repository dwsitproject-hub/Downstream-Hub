# KLIP — Downstream Hub SDK Implementation Guide

**For:** the KLIP development team
**Application:** KLIP — KPN Logistics Intelligence Platform (Next.js)
**Repository:** `dwsitproject-hub/Logistic`
**Effort:** staging is already integrated; production takes about 2 hours, including the CSP change and testing.

---

## 0. Current status (14 Oct 2026)

| | Staging | Production |
|---|---|---|
| Downstream Hub with SDK v1.1 + Sentinel | ✅ `http://test-dwshub.kpndomain.com` | ✅ `https://dwshub.kpndomain.com` (live since 14 Oct) |
| SDK script in KLIP | ✅ in the page, with `data-debug="true"` and `data-bug-button="false"` | ❌ not yet |
| KLIP CSP allows the Hub script | ✅ `http://test-dwshub.kpndomain.com` in `script-src` | ❌ **blocks it**: `https://dwshub.kpndomain.com` must be added to `script-src` (Step 4) |
| `data-release` (build commit) | ❌ not set | ❌ not set |
| Sentinel reads KLIP's code | Hub admin connects `dwsitproject-hub/Logistic` | Hub admin connects `dwsitproject-hub/Logistic` (Step 6) |

**To finish production, go to [Step 7](#9-step-7--go-to-production).** Steps 1–6 explain each part and are the reference.

---

## 1. What this gives KLIP

Once the SDK is in KLIP, the Downstream Hub admins see, in **Hub → Admin → Analytic → KLIP**:

| Feature | What it shows |
|---|---|
| **Usage** | Who uses KLIP, how often, and for how long (active time only, while the tab is visible) |
| **Top pages** | Which KLIP pages people open most |
| **Top users** | The most active users, each with their sessions and page history |
| **Tracked actions** | Business actions KLIP chooses to record, e.g. "report exported" (optional) |
| **JS errors** | JavaScript errors users hit in the browser, captured automatically with stack traces |
| **Bug reports** | Reports users send through the SDK's **Report a bug** dialog |
| **Sentinel analysis** | For every bug report and new JS error, the Hub's AI support agent reads the error, what the user did before it, and KLIP's source code (read-only), then proposes the **root cause and a fix** — often as a ready-to-review patch. Admins can copy the whole analysis into a ticket. |

**What it never collects:** keystrokes, form contents, clicks, cookies, request/response bodies, or query strings (`?code=`, `?token=` and the like are stripped before sending). Requests go out without cookies. Errors and reports carry *breadcrumbs* — the last few pages, API calls (method, path, status only) and `console.error` messages — so problems can be traced.

**Browser only.** The SDK sees what happens in the user's browser. Errors inside KLIP's server code (server components, route handlers, API) are not captured directly. They show up as failed API calls in the breadcrumbs (e.g. `GET /api/orders → 500`), which Sentinel follows into the code.

---

## 2. KLIP values

| Item | Staging | Production |
|---|---|---|
| KLIP address (allowed origin) | `http://test-klip.kpndomain.com` | `http://klip.kpndomain.com` |
| Hub | `http://test-dwshub.kpndomain.com` | `https://dwshub.kpndomain.com` |
| Hub SDK script | `http://test-dwshub.kpndomain.com/api/sdk/v1/hub-sdk.js` | `https://dwshub.kpndomain.com/api/sdk/v1/hub-sdk.js` |
| Add to KLIP's CSP `script-src` | `http://test-dwshub.kpndomain.com` ✅ done | `https://dwshub.kpndomain.com` |
| KLIP SDK key (`data-app-key`) | `dwsk_…` from the staging Hub (in use) | `dwsk_…`, a **different** key from the production Hub |
| Repository / branch for Sentinel | `dwsitproject-hub/Logistic` @ staging branch | `dwsitproject-hub/Logistic` @ *production branch — to be confirmed* |
| OIDC client ID (for reference) | `logistic` | *confirm in the production Hub (Applications → KLIP)* |

> **Get the key from the Hub admin.** It comes from **Hub → Admin → Applications → KLIP → SDK** (staging Hub for staging, production Hub for production), and that screen shows the ready-made snippet. Copy it rather than retyping it — one wrong character gives `403 invalid_key`.
>
> The key is **publishable**: it can safely appear in page source. The Hub only accepts data from KLIP's registered addresses. Don't reuse it in other applications.

> **KLIP production runs on HTTP, the production Hub on HTTPS — that's fine.** An HTTP page may load an HTTPS script and call an HTTPS API (only the reverse, HTTPS → HTTP, is blocked as "mixed content"). Two things to know:
> - The allowed origin is **exactly** `http://klip.kpndomain.com`. If KLIP later moves to HTTPS, tell the Hub admin first so `https://klip.kpndomain.com` is allowed too — otherwise data stops with `403 origin_not_allowed`.
> - Independently of the SDK, moving KLIP to HTTPS is recommended: sign-in sessions over plain HTTP can be intercepted on the network.

---

## 3. Step 1 — Add the script (Next.js)

Staging already has the tag. For production, drive it from environment variables and add `data-release`.

**App Router** — in the root layout, `app/layout.tsx` (a server component):

```tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {process.env.NEXT_PUBLIC_HUB_SDK_URL && (
          <script
            src={process.env.NEXT_PUBLIC_HUB_SDK_URL}
            data-app-key={process.env.NEXT_PUBLIC_HUB_SDK_KEY}
            data-release={process.env.NEXT_PUBLIC_GIT_SHA}
            data-bug-button="false"
            defer
          />
        )}
      </head>
      <body>{children}</body>
    </html>
  );
}
```

(Pages Router: the same `<script>` inside `<Head>` in `pages/_document.tsx`.)

- **Keep `defer`.** Never make the tag blocking: if the Hub were unreachable, a blocking script would freeze KLIP's page load. With `defer`, KLIP always loads normally and the SDK starts a moment later.
- **`data-bug-button="false"`** hides the floating button (as on staging). Users then need another way to report bugs — see [Step 2c](#4c-report-a-bug-entry-point). To show the floating button instead, remove the attribute.
- **No `data-debug` in production.** It logs to the console; it's on in staging today.
- If `NEXT_PUBLIC_GIT_SHA` is not set, React omits `data-release` and nothing breaks.

**Environment values:**

```bash
# staging
NEXT_PUBLIC_HUB_SDK_URL=http://test-dwshub.kpndomain.com/api/sdk/v1/hub-sdk.js
NEXT_PUBLIC_HUB_SDK_KEY=dwsk_KLIP_STAGING_KEY

# production
NEXT_PUBLIC_HUB_SDK_URL=https://dwshub.kpndomain.com/api/sdk/v1/hub-sdk.js
NEXT_PUBLIC_HUB_SDK_KEY=dwsk_KLIP_PRODUCTION_KEY
```

`NEXT_PUBLIC_*` values are baked in at **build time** (`next build`), so build staging and production images separately, each with its own values.

**`data-release` — which commit is running.** Sentinel uses it to read the code *exactly as deployed*. It must be the git commit SHA (or a tag that exists in the repository), set at build time:

- Local / CI: `NEXT_PUBLIC_GIT_SHA=$(git rev-parse --short HEAD) npm run build` (in CI, use the pipeline's commit SHA variable).
- Docker: `.git` is usually not in the build context, so pass it in:
  ```dockerfile
  ARG GIT_SHA
  ENV NEXT_PUBLIC_GIT_SHA=$GIT_SHA
  RUN npm run build
  ```
  and build with `docker build --build-arg GIT_SHA=$(git rev-parse --short HEAD) …`.

---

## 4. Step 2 — Tell the SDK who is signed in

KLIP signs users in through Downstream Hub (OIDC, callback `/auth/oidc/callback`) and validates the `id_token` on the server. The SDK needs the **Hub user id** — the `id_token` **`sub`** claim (a UUID) — and the email.

### 4a. Pass the user from the server to a small client component

KLIP stores the Hub `sub` on its user record at SSO sign-in (the silent-linking step, usually a column such as `oidc_sub`). In the root layout, read the session on the server and hand the two values to a client component — no new API endpoint needed:

```tsx
// app/hub-identify.tsx
'use client';
import { useEffect } from 'react';

declare global {
  interface Window { DwsHub?: any }
}

export default function HubIdentify({ hubUserId, email }: { hubUserId?: string | null; email?: string | null }) {
  useEffect(() => {
    if (!hubUserId && !email) return;
    const user = { id: hubUserId ?? undefined, email: email ?? undefined };
    // The SDK loads with `defer` and may not be ready yet: queue the call, the SDK replays it on load.
    const hub = (window.DwsHub = window.DwsHub || []);
    if (typeof hub.identify === 'function') hub.identify(user);
    else hub.push(['identify', user]);
  }, [hubUserId, email]);
  return null;
}
```

```tsx
// app/layout.tsx — make RootLayout `async`, then inside <body> next to {children}:
const user = await getCurrentUser();          // however KLIP reads its session today
<HubIdentify hubUserId={user?.oidc_sub} email={user?.email} />
```

> **Use the Hub `sub`, not KLIP's own user id.** The SDK only accepts the Hub UUID as `id` and silently ignores anything else. If a user has no Hub `sub` (a local, non-SSO login), send just the email — the Hub matches by email or shows "Not a Hub account".

### 4b. Sign-out

Call `reset` **before** redirecting to KLIP's logout, so the next person on the same browser starts clean:

```ts
window.DwsHub?.reset();
window.location.href = '/auth/logout';
```

Pages viewed before `identify` in the same session (e.g. the login screen) are attributed to the user automatically once `identify` runs.

### 4c. "Report a bug" entry point

Because KLIP hides the floating button (`data-bug-button="false"`), add a menu item — for example under the user menu or Help:

```tsx
<button type="button" onClick={() => window.DwsHub?.openBugReport()}>Report a bug</button>
```

Without it, users have no way to send reports (JS errors are still captured automatically).

---

## 5. Step 3 (optional) — Record important KLIP actions

Page views come for free. For business actions the KLIP product owner cares about, add one line where the action succeeds:

```js
window.DwsHub?.track('contract_viewed', { contract_type: 'term' });
window.DwsHub?.track('report_exported', { report: 'shipment_status', format: 'xlsx' });
window.DwsHub?.track('sap_import_started');
```

Rules:
- **Name:** up to 80 characters, letters/numbers/`_ . : / -`. Use `snake_case` verbs in past tense.
- **Properties:** a small JSON object (≤ 2 KB). **Never put personal data, contract values, prices or document contents in properties.** Use categories and counts only.

Suggested starter list (agree it with the product owner): `report_exported`, `contract_viewed`, `shipment_searched`, `sap_import_started`.

---

## 6. Step 4 — Content-Security-Policy

KLIP sends a CSP (from nginx or Next.js headers). Today:

- **Staging** `script-src` includes `http://test-dwshub.kpndomain.com` ✅
- **Production** `script-src` is `'self' 'unsafe-inline' 'unsafe-eval'` — the browser will **refuse to load the SDK** until `https://dwshub.kpndomain.com` is added.
- `connect-src` already allows `http: https:` in both, so the SDK's calls to the Hub need no change.

Make the same change in production that was made for staging — wherever the staging header was edited:

```
script-src 'self' 'unsafe-inline' 'unsafe-eval' https://dwshub.kpndomain.com;
```

Check after deploying (should print the header including `https://dwshub.kpndomain.com`):

```bash
curl -sI http://klip.kpndomain.com/ | grep -i content-security-policy
```

No CORS configuration is needed in KLIP — the Hub handles CORS.

---

## 7. Step 5 — Test

Run on staging first, then repeat on production (Step 7).

1. Open KLIP in a **fresh browser window**, sign in through the Hub, browse 4–5 pages for a minute.
2. DevTools → **Console**: no `Refused to load the script … hub-sdk.js` (CSP) errors.
3. DevTools → **Network**, filter `collect`: `POST …/api/sdk/v1/collect` → **204** every few seconds while you move around.
4. Open **Report a bug** from KLIP's menu (Step 2c) and send "SDK test, please ignore".
5. **Test error capture and Sentinel:** in the Console run
   `setTimeout(() => { throw new Error('SDK test error — please ignore') })`.
6. Ask the Hub admin to check:
   - **Admin → Applications → KLIP → SDK** shows **Receiving data**.
   - **Admin → Analytic → KLIP** shows your pages, **your name** under top users (not "anonymous"), the test report, and the test error with **breadcrumbs** — and within a few minutes a **Sentinel analysis** (which should identify it as a deliberate test).
   - Then mark both test items **resolved**.
7. Sign out, sign in as another user: they appear as a separate user.

**Debug mode:** `data-debug="true"` logs SDK activity as `[DwsHub]` lines in the console. Fine on staging, **remove for production**.

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Console: `Refused to load the script 'https://dwshub.kpndomain.com/…'` | Production CSP — add the Hub to `script-src` (Step 4). |
| Console: `blocked by CORS policy`, or `403 origin_not_allowed` | KLIP is on an address the Hub doesn't know (other hostname, IP, `https://` instead of `http://`, or `localhost` in development). Ask the Hub admin to add it under **SDK → Allowed origins**. |
| `403 invalid_key` | Wrong key for this environment, or the key was rotated. Copy the current snippet from that environment's Hub. |
| `403 sdk_disabled` | The Hub admin switched the SDK off for KLIP. |
| Data arrives but every user is **anonymous** | `identify` isn't called, or is called with KLIP's own id and no email (Step 2). |
| No way to report bugs | `data-bug-button="false"` without a menu item calling `DwsHub.openBugReport()` (Step 2c). |
| Sentinel analysis says **No source code** | The repository isn't connected in that Hub, or the token can't read it (Step 6). |
| Sentinel reads the wrong code version | `data-release` missing or not the deployed commit (Step 1). |

---

## 8. Step 6 — Sentinel (Hub admin, 5 minutes per environment)

The Hub admin opens **Analytic → KLIP → Sentinel settings** — in the staging Hub and again in the production Hub (they are configured separately):

| Field | Value |
|---|---|
| GitHub repository | `dwsitproject-hub/Logistic` |
| Branch | staging: the staging branch · production: *production branch — to be confirmed* |
| Application folder | leave empty — KLIP is one repository, and Sentinel can follow an error from the page into the API code |
| Notes for Sentinel | KLIP's stack (Next.js, App Router), data sources (SAP imports), scheduled jobs, known slow pages, anything unusual |

Click **Test repository access** (it should show the branch and latest commit), then **Save settings**. The KLIP team only supplies the branch names and the notes. Sentinel's access is read-only; it proposes fixes, the KLIP team decides.

---

## 9. Step 7 — Go to production

| # | Who | Action |
|---|---|---|
| 1 | Hub admin | Production Hub → **Applications → KLIP**: confirm the Target URL / redirect URIs use `http://klip.kpndomain.com`. Then **SDK**: check "Currently accepting" lists `http://klip.kpndomain.com`, and send the KLIP team the **production key** (copy from the snippet). |
| 2 | KLIP team | Production CSP: add `https://dwshub.kpndomain.com` to `script-src` (Step 4). |
| 3 | KLIP team | Production build env: `NEXT_PUBLIC_HUB_SDK_URL=https://dwshub.kpndomain.com/api/sdk/v1/hub-sdk.js`, `NEXT_PUBLIC_HUB_SDK_KEY=<production key>`, `NEXT_PUBLIC_GIT_SHA` from the build (Step 1). |
| 4 | KLIP team | Tag without `data-debug`; keep `defer`; keep `data-bug-button="false"` **and** add the Report a bug menu item (Step 2c) — or remove the attribute to show the floating button. |
| 5 | KLIP team | `identify` / `reset` in place (Step 2) — same code as staging. |
| 6 | Hub admin | Production Hub → **Analytic → KLIP → Sentinel settings**: `dwsitproject-hub/Logistic`, production branch, notes → Test → Save (Step 6). |
| 7 | KLIP team | Deploy, then run the Step 5 checks against `http://klip.kpndomain.com`. `collect` calls go to `https://dwshub.kpndomain.com/api/sdk/v1/collect`. |
| 8 | Hub admin | Production **Analytic → KLIP**: data arriving, users named, test report/error visible with a Sentinel analysis; resolve the test items. |

Quick check after the deploy (the tag should show the production URL, a `dwsk_` key, a release and no `data-debug`):

```bash
curl -s http://klip.kpndomain.com/ | grep -oE '<script[^>]*hub-sdk[^>]*>' | sed -E 's/dwsk_[A-Za-z0-9_-]+/dwsk_…/'
```

---

## 10. Reference

**Script tag options:**

| Attribute | Default | Effect |
|---|---|---|
| `data-app-key` | *(required)* | KLIP's key for this environment |
| `data-release` | — | Build commit SHA or tag (recommended) |
| `data-bug-button` | `true` | `false` hides the floating button (KLIP: `false` + menu item) |
| `data-bug-button-position` | `bottom-right` | `bottom-left` moves it |
| `data-auto-page-views` | `true` | `false`: KLIP calls `DwsHub.page()` itself |
| `data-capture-errors` | `true` | `false`: no automatic JS-error capture |
| `data-breadcrumbs` | `true` | `false`: no breadcrumbs (less precise analyses) |
| `data-debug` | `false` | `true` logs SDK activity to the console (staging only) |

**JavaScript API:**

| Call | Purpose |
|---|---|
| `DwsHub.identify({ id, email })` | Set the signed-in user (`id` = Hub `sub`) |
| `DwsHub.reset()` | Forget the user and start a new session (sign-out) |
| `DwsHub.track(name, props?)` | Record a business action |
| `DwsHub.page(path?)` | Record a page view manually |
| `DwsHub.openBugReport()` | Open the bug-report dialog from KLIP's own button |
| `DwsHub.setBugButtonVisible(bool)` | Show or hide the floating button |

Always guard calls with `window.DwsHub?.` so KLIP keeps working if the Hub is unreachable. The SDK never blocks or breaks the host page.

**Security notes for KLIP reviewers:**
- The identity KLIP reports is for analytics only. Nothing in the Hub grants access based on it.
- If the key leaks or is abused, the Hub admin issues a new key (the old one stops working immediately) and KLIP rebuilds with the new value.
- The Hub stores page paths (without query strings), error messages and stack traces, breadcrumbs (pages, API calls as method + path + status, `console.error` text), browser user agent and IP address.
- **Sentinel and KLIP's source code.** To analyse a problem, Sentinel reads `dwsitproject-hub/Logistic` (read-only token, contents only) and sends the relevant source files, the error details and breadcrumbs to the **Claude API (Anthropic)**. User emails are replaced with pseudonyms and tokens/IPs are removed before sending; source files are sent as they are. If KLIP's code must not leave the company, the Hub admin leaves the repository empty in Step 6 and Sentinel works from runtime evidence only.
- **Keep secrets and personal data out of URLs and error logs.** Breadcrumbs record API paths and `console.error` text. Query strings are dropped and tokens in console text are scrubbed, but a token or customer name **inside a path** (e.g. `/api/reset/8f3a…`, `/api/customers/john.doe`) or in a log message would be stored. Check KLIP's API paths and `console.error` calls; if they can't be changed, use `data-breadcrumbs="false"`.
- **Secrets in the repository.** Don't commit credentials: recognisable keys are scrubbed, but source files otherwise reach the Claude API unchanged.

Full generic guide: `Docs/SDK-INTEGRATION-GUIDE.md` in the Downstream Hub repository.

---

## 11. Checklist for production

- [ ] Production key received from the Hub admin (production Hub, not staging)
- [ ] Production CSP `script-src` includes `https://dwshub.kpndomain.com`
- [ ] `NEXT_PUBLIC_HUB_SDK_URL` / `NEXT_PUBLIC_HUB_SDK_KEY` set for the production build; `NEXT_PUBLIC_GIT_SHA` filled by the build
- [ ] Script tag keeps `defer`, has **no** `data-debug`
- [ ] Bug reporting reachable: Report a bug menu item (`DwsHub.openBugReport()`), or floating button enabled
- [ ] `identify` with the Hub `sub` + email after sign-in; `reset` on sign-out
- [ ] No tokens or personal data in API paths or `console.error` messages, or `data-breadcrumbs="false"`
- [ ] Security reviewer agreed to KLIP's source code being read by Sentinel (Claude API)
- [ ] Production branch name sent to the Hub admin; Sentinel connected in the production Hub
- [ ] Production test passed: no CSP errors, `collect` → 204, Hub shows **Receiving data**, user named, test report + test error with breadcrumbs and a Sentinel analysis, test items resolved
