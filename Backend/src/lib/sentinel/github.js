/**
 * Read-only access to an application's source code on GitHub.
 *
 * One tarball download per commit gives Sentinel the whole repository in memory, so it can
 * list, search and read files without dozens of API calls (and without GitHub's code-search
 * index, which only covers default branches). Snapshots are cached briefly per commit.
 */
const { extractTextFiles } = require('./tar');

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9_./-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const CACHE_MS = 30 * 60 * 1000;
const CACHE_MAX = 4;
const MAX_TARBALL_BYTES = 150 * 1024 * 1024;
const cache = new Map(); // "repo@sha" -> { snapshot, expires }

class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

function headers(cfg, accept = 'application/vnd.github+json') {
  const h = { Accept: accept, 'User-Agent': 'downstream-hub-sentinel', 'X-GitHub-Api-Version': '2022-11-28' };
  if (cfg.githubToken) h.Authorization = `Bearer ${cfg.githubToken}`;
  return h;
}

async function gh(cfg, path) {
  let res;
  try {
    res = await fetch(`${cfg.githubApi}${path}`, { headers: headers(cfg), signal: AbortSignal.timeout(30000) });
  } catch (err) {
    throw new GitHubError(`Cannot reach GitHub (${err?.cause?.code || err.message}).`, 0);
  }
  const body = await res.json().catch(() => ({}));
  if (res.ok) return body;
  if (res.status === 401) throw new GitHubError('GitHub rejected the token (401). Check SENTINEL_GITHUB_TOKEN.', 401);
  if (res.status === 404) {
    throw new GitHubError(cfg.githubToken
      ? 'Repository or branch not found, or the token cannot read it (404).'
      : 'Repository not found (404). Private repositories need SENTINEL_GITHUB_TOKEN.', 404);
  }
  if (res.status === 403 || res.status === 429) throw new GitHubError(`GitHub refused the request (${res.status}): ${body.message || 'rate limit or permissions'}`, res.status);
  throw new GitHubError(`GitHub error ${res.status}: ${body.message || ''}`.trim(), res.status);
}

function validRepo(repo) { return REPO_RE.test(String(repo || '')); }
function validRef(ref) { return REF_RE.test(String(ref || '')) && !String(ref).includes('..'); }

/** Settings check for the admin screen. */
async function checkAccess(cfg, repo, branch) {
  if (!validRepo(repo)) throw new GitHubError('Repository must look like "owner/name".', 400);
  const meta = await gh(cfg, `/repos/${repo}`);
  const ref = branch || meta.default_branch;
  const commit = await gh(cfg, `/repos/${repo}/commits/${encodeURIComponent(ref)}`);
  return {
    ok: true,
    repo: meta.full_name,
    private: Boolean(meta.private),
    default_branch: meta.default_branch,
    branch: ref,
    commit: commit.sha,
    commit_message: String(commit.commit?.message || '').split('\n')[0].slice(0, 200),
    committed_at: commit.commit?.committer?.date || null,
  };
}

class RepoSnapshot {
  constructor({ repo, ref, commit, files, skipped, sourceRoot }) {
    this.repo = repo;
    this.ref = ref;
    this.commit = commit;
    this.files = files;
    this.skipped = skipped;
    this.sourceRoot = sourceRoot || '';
    this.paths = [...files.keys()].sort();
  }

  describe() {
    return { repo: this.repo, ref: this.ref, commit: this.commit, text_files: this.paths.length, source_root: this.sourceRoot || '(repository root)' };
  }

  /** Directory listing (path) or path filter (pattern). */
  list({ path = '', pattern = '' } = {}) {
    const pat = String(pattern || '').toLowerCase();
    if (pat) {
      const hits = this.paths.filter((p) => p.toLowerCase().includes(pat));
      return { pattern, total: hits.length, paths: hits.slice(0, 200) };
    }
    const dir = String(path || '').replace(/^\/+|\/+$/g, '');
    const prefix = dir ? `${dir}/` : '';
    const dirs = new Set();
    const files = [];
    for (const p of this.paths) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) files.push(rest);
      else dirs.add(`${rest.slice(0, slash)}/`);
    }
    return { path: dir || '/', directories: [...dirs].sort().slice(0, 200), files: files.slice(0, 300) };
  }

  /** Case-insensitive text search (or regex), source root first. */
  search({ query, regex = false, path = '', max = 40 }) {
    let test;
    if (regex) {
      let re;
      try { re = new RegExp(query, 'i'); } catch { return { error: 'Invalid regular expression' }; }
      test = (line) => re.test(line);
    } else {
      const q = String(query).toLowerCase();
      test = (line) => line.toLowerCase().includes(q);
    }
    const within = String(path || '').replace(/^\/+/, '');
    const ordered = this.sourceRoot
      ? [...this.paths.filter((p) => p.startsWith(this.sourceRoot)), ...this.paths.filter((p) => !p.startsWith(this.sourceRoot))]
      : this.paths;
    const matches = [];
    let total = 0;
    for (const p of ordered) {
      if (within && !p.startsWith(within)) continue;
      const lines = this.files.get(p).split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (!test(lines[i])) continue;
        total += 1;
        if (matches.length < max) matches.push(`${p}:${i + 1}: ${lines[i].trim().slice(0, 220)}`);
      }
    }
    return { query, total_matches: total, matches };
  }

  read({ path, start_line: start = 1, end_line: end }) {
    const p = String(path || '').replace(/^\/+/, '');
    const text = this.files.get(p);
    if (text === undefined) {
      const base = p.split('/').pop().toLowerCase();
      const similar = this.paths.filter((x) => x.toLowerCase().endsWith(`/${base}`) || x.toLowerCase() === base).slice(0, 10);
      return { error: `File not found: ${p}`, similar_paths: similar };
    }
    const lines = text.split('\n');
    const from = Math.max(1, parseInt(start, 10) || 1);
    const to = Math.min(lines.length, parseInt(end, 10) || from + 299, from + 399);
    const body = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)}  ${l}`).join('\n');
    return { path: p, total_lines: lines.length, start_line: from, end_line: to, content: body };
  }
}

/**
 * Snapshot of `repo` at `ref` (a release commit when the app reported one, else the branch).
 * Falls back to `fallbackRef` when `ref` cannot be found (e.g. an unpushed local build).
 */
async function getSnapshot(cfg, { repo, ref, fallbackRef, sourceRoot }) {
  if (!validRepo(repo)) throw new GitHubError('No valid repository configured.', 400);
  let resolvedRef = validRef(ref) ? ref : fallbackRef;
  let commit;
  try {
    commit = await gh(cfg, `/repos/${repo}/commits/${encodeURIComponent(resolvedRef)}`);
  } catch (err) {
    if (!fallbackRef || resolvedRef === fallbackRef || (err.status !== 404 && err.status !== 422)) throw err;
    resolvedRef = fallbackRef;
    commit = await gh(cfg, `/repos/${repo}/commits/${encodeURIComponent(resolvedRef)}`);
  }
  const sha = commit.sha;
  const key = `${repo}@${sha}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) {
    return new RepoSnapshot({ ...hit.data, ref: resolvedRef, sourceRoot });
  }

  let res;
  try {
    res = await fetch(`${cfg.githubApi}/repos/${repo}/tarball/${sha}`, { headers: headers(cfg), redirect: 'follow', signal: AbortSignal.timeout(120000) });
  } catch (err) {
    throw new GitHubError(`Could not download the repository (${err?.cause?.code || err.message}).`, 0);
  }
  if (!res.ok) throw new GitHubError(`Could not download the repository (${res.status}).`, res.status);
  const declared = parseInt(res.headers.get('content-length'), 10);
  if (declared > MAX_TARBALL_BYTES) throw new GitHubError('Repository is too large to analyse (over 150 MB compressed).', 413);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_TARBALL_BYTES) throw new GitHubError('Repository is too large to analyse (over 150 MB compressed).', 413);
  const { files, skipped } = extractTextFiles(buf);

  const data = { repo, commit: sha, files, skipped };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { data, expires: Date.now() + CACHE_MS });
  return new RepoSnapshot({ ...data, ref: resolvedRef, sourceRoot });
}

module.exports = { checkAccess, getSnapshot, RepoSnapshot, GitHubError, validRepo, validRef, SHA_RE };
