# Sentinel — AI Production Support for Downstream Hub

Sentinel is the Hub's production-support agent. It works on the data the **Hub SDK** collects from every
application (bug reports, JavaScript errors, sessions, page views) and on each application's **source code**
(read-only, from GitHub), and does three jobs:

| Job | When | What you get |
|---|---|---|
| **Bug analysis** | Automatically for every new bug report and every *new kind* of JS error; or on demand (**Analyse with Sentinel**) | Summary, severity, category, confidence, impact, **root cause with file:line evidence**, **proposed fix**, a **patch** (unified diff) when it is confident, a workaround, next steps |
| **Health report** | On demand, per application or for the Hub (**Health report** button) | Status (healthy / watch / degraded / critical), key metrics vs the previous period, findings, prioritised recommendations |
| **Ask Sentinel** | On demand | Answers in plain language to questions such as "Who stopped using KLIP this month?" or "Which page fails most?", with follow-up questions |

Everything appears in **Admin → Analytic**: open an application (or *Downstream Hub*), use the **Sentinel**
card, or open any bug report to see its analysis. Sentinel is **admin-only** and **read-only**: it proposes
fixes; engineers review and apply them.

---

## How it works

```
App (Hub SDK) ──► Hub API ──► bug_reports ──► Sentinel queue (sentinel_runs)
                                                  │
                                    Sentinel worker (inside the Hub backend)
                                                  │  tool calls, all read-only
            ┌─────────────────────────────────────┼───────────────────────────────┐
            ▼                                     ▼                               ▼
   Hub database: sessions, pages,       GitHub: application repo           Claude API
   errors, related reports              at the user's release/branch       (reasoning)
```

1. A report or error arrives. Errors are **fingerprinted** (same error + same code location = same
   fingerprint), so 500 occurrences of one crash trigger **one** analysis.
2. The worker (one run at a time) gives Claude the report and a set of read-only tools:
   the user's session timeline, how widespread the error is, usage analytics, and — when a repository is
   connected — `list_files`, `search_code` and `read_file` over a snapshot of the code.
3. Claude investigates (typically 5–15 tool calls, 1–3 minutes) and submits a structured result, which is
   stored and shown to admins.

---

## Setup (once per environment)

Staging and production are separate: each needs its own settings and its own keys.

### 1. Anthropic API key

Create an API key for the organisation in the Anthropic Console and put it in the backend `.env`
(`/opt/downstream-hub/backend/.env`):

```bash
ANTHROPIC_API_KEY=sk-ant-...
# optional:
# SENTINEL_MODEL=claude-opus-5-5        # default; claude-sonnet-5-5 is cheaper and faster
# SENTINEL_AUTO_DAILY_LIMIT=40           # automatic analyses per day
```

Check that the backend server can reach the API (expect `200`):

```bash
docker exec downstream-hub-api node -e "fetch('https://api.anthropic.com/v1/models',{headers:{'x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'}}).then(r=>console.log(r.status)).catch(e=>console.log('ERR',e.cause?.code||e.message))"
```

(Run it after step 3, once the container has the new `.env`.) `ERR ETIMEDOUT` / `ENOTFOUND` means outbound
HTTPS to `api.anthropic.com:443` is blocked — open it in the security group / firewall.

### 2. GitHub read-only token (for code-level analysis)

Without a token Sentinel still works, but only on runtime evidence (stack, breadcrumbs, analytics) — and
it can read public repositories only.

Create a **fine-grained personal access token** (or a GitHub App) owned by the `dwsitproject-hub` organisation:

- **Repository access:** *Only select repositories* — the applications you want analysed
- **Permissions:** *Contents: Read-only* and *Metadata: Read-only*. Nothing else.
- **Expiry:** per your policy (put a reminder in the calendar)

An organisation owner may need to approve the token. Then:

```bash
SENTINEL_GITHUB_TOKEN=github_pat_...
```

### 3. Rebuild the backend

```bash
cd /opt/downstream-hub && sudo bash deploy/rebuild-backend-staging.sh
docker logs downstream-hub-api 2>&1 | grep -E "Migration 021|Sentinel"
```

Expect `Migration 021_sentinel.sql applied` and `Sentinel: on — model claude-opus-5-5, code access token configured`.

### 4. Connect each application's repository

**Admin → Analytic → (application) → Sentinel settings**:

| Field | Example | Notes |
|---|---|---|
| GitHub repository | `dwsitproject-hub/klip-frontend` | `owner/name` or a github.com URL |
| Branch | `main` | Used unless the app reports its release (see *Better results*) |
| Application folder | `frontend/` | Monorepos only: where this app's code lives |
| Notes for Sentinel | "React 18 + Vite SPA, API is Express at /api, orders sync from SAP nightly" | Context Sentinel reads first |
| Analyse automatically | ✓ | Untick to analyse only on request |

Click **Test repository access** — it should show the branch and latest commit. The Hub itself is configured
the same way under **Analytic → Downstream Hub** (repository `dwsitproject-hub/Downstream-Hub`).

---

## Better results

1. **Tell Sentinel which release the user was running.** Add `data-release` to the SDK script tag, set at
   build time to the git commit or version tag. Sentinel then reads the code *as it was in that release*:
   ```html
   <script src=".../hub-sdk.js" data-app-key="dwsk_…" data-release="%VITE_GIT_SHA%" defer></script>
   ```
   (`VITE_GIT_SHA=$(git rev-parse --short HEAD)` in the build.)
2. **Keep function names in production builds.** Minified stacks (`index-3fa9c1.js:1:23456`) hide where the
   error happened. With Vite, `esbuild: { keepNames: true }` in `vite.config.js` keeps component and function
   names in stack traces at a small size cost.
3. **Write good notes.** Architecture, data sources, known quirks, and what "normal" looks like.
4. **Call `DwsHub.identify`.** Sentinel can see who is affected and correlate reports with errors in the
   same session only when users are identified.

---

## Cost control

| Control | Default |
|---|---|
| One analysis per distinct error (fingerprint) per 14 days | always on |
| Automatic analyses per day (`SENTINEL_AUTO_DAILY_LIMIT`) | 40 — beyond that, reports are marked *Not analysed* and can be analysed manually |
| Manual runs per admin per hour (`SENTINEL_MANUAL_RUNS_PER_HOUR`) | 60 |
| Tool rounds per run (`SENTINEL_MAX_STEPS`) | 24 |
| Turn automatic analysis off per application | Sentinel settings → *Analyse automatically* |
| Model (`SENTINEL_MODEL`) | `claude-opus-5-5` (most capable); `claude-sonnet-5-5` costs less |

Every run shows its token usage (*… in / … out tokens*); `GET /api/sentinel/status` returns today's and this
month's totals. Billing is visible in the Anthropic Console.

---

## Privacy and security

**What Sentinel sends to the Claude API:** the report text, error message and stack, breadcrumbs, page
paths, session timeline, aggregated analytics, the team's notes, and the source files it reads.

**What it never sends:**

- **Who users are.** Every email address is replaced with a pseudonym (`user-3@redacted.invalid`) before
  anything leaves the Hub; admins see the real addresses in the result because the Hub swaps them back
  locally.
- **Secrets.** JWTs, bearer tokens, API keys (`sk-…`, `ghp_…`, `dwsk_…`, AWS keys), `password=…`-style values
  and passwords in URLs are removed. IP addresses are masked.
- **Query strings.** The SDK never collects them; breadcrumbs keep method, path and status only.

**Other safeguards:**

- Sentinel is **read-only**: its tools can query the Hub database (`SELECT` only, through fixed queries) and
  read code. It cannot change data, code, settings or report status.
- Only **Admins** can see Sentinel's output or start runs. Settings changes are audited
  (`SENTINEL_CONFIG_UPDATE`).
- **Prompt injection:** bug reports are written by end users and may contain instructions ("ignore previous
  instructions…"). Sentinel is told to treat all report text, analytics and code as data, never as
  instructions — and since it has no write tools, a manipulated analysis can at worst be wrong, never act.
  Always review proposed patches before applying them.
- Results are stored in the Hub database (`sentinel_runs`) alongside the bug reports.
- Under Anthropic's commercial API terms, API inputs and outputs are not used to train models by default;
  confirm the terms in place with procurement/legal before production use.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Sentinel card says **Off** | `ANTHROPIC_API_KEY` missing (or `SENTINEL_ENABLED=0`). Add it to the backend `.env` and rebuild. |
| *Cannot reach the Anthropic API (ETIMEDOUT)* | Outbound HTTPS to `api.anthropic.com` is blocked from the backend server. |
| *The Anthropic API key was rejected (401)* | Wrong or revoked key. |
| *Model not available on this API key (404)* | Set `SENTINEL_MODEL` to a model your key can use. |
| Analyses say **No source code** | No repository connected in Sentinel settings, or the token cannot read it — use **Test repository access**. |
| *Repository or branch not found (404)* | Token lacks access to that repository (fine-grained tokens list repositories explicitly), or the branch name is wrong. |
| Reports show **Not analysed** | Daily automatic limit reached. Click **Analyse with Sentinel**, or raise `SENTINEL_AUTO_DAILY_LIMIT`. |
| Analysis stays **Queued** | Only one run executes at a time; check `docker logs downstream-hub-api | grep Sentinel`. Runs interrupted by a restart are re-queued automatically. |

---

## Reference

**Environment variables** (backend `.env`):

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required. Sentinel is off without it. |
| `SENTINEL_ENABLED` | `1` | `0` switches Sentinel off. |
| `SENTINEL_MODEL` | `claude-opus-5-5` | Claude model. |
| `SENTINEL_THINKING` | on | `off` disables extended thinking. |
| `SENTINEL_GITHUB_TOKEN` | — | Read-only GitHub token. |
| `SENTINEL_GITHUB_API_URL` | `https://api.github.com` | GitHub Enterprise: `https://<host>/api/v3`. |
| `SENTINEL_ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Only if traffic must go through an internal gateway. |
| `SENTINEL_AUTO_DAILY_LIMIT` | `40` | Automatic analyses per day. |
| `SENTINEL_MANUAL_RUNS_PER_HOUR` | `60` | Manual runs per admin per hour. |
| `SENTINEL_MAX_STEPS` | `24` | Tool rounds per run. |

**API** (Admin session required): `GET /api/sentinel/status`, `GET|PUT /api/sentinel/config/:scope`,
`POST /api/sentinel/config/:scope/test`, `GET /api/sentinel/runs`, `GET /api/sentinel/runs/:id`,
`GET /api/sentinel/bug-reports/:id/analysis`, `POST /api/sentinel/bug-reports/:id/analyze`,
`POST /api/sentinel/scopes/:scope/health`, `POST /api/sentinel/scopes/:scope/ask`.
`:scope` is `hub` or an application id.

**Database:** `sentinel_config` (per-scope settings), `sentinel_runs` (every analysis, report and answer),
and new `bug_reports` columns `fingerprint`, `release`, `context` (breadcrumbs) — migration `021_sentinel.sql`.
