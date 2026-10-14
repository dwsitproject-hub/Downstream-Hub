/**
 * Minimal reader for the .tar.gz snapshots GitHub serves (`/repos/{o}/{r}/tarball/{ref}`):
 * returns the text files in memory. Handles ustar prefixes and pax long names; skips
 * binaries, large files, and the top-level "<owner>-<repo>-<sha>/" folder.
 */
const zlib = require('zlib');

const BLOCK = 512;
const TEXT_EXT = /\.(m?[jt]sx?|cjs|vue|svelte|json|ya?ml|toml|ini|env\.example|sql|py|rb|go|java|kt|cs|php|html?|css|scss|less|md|txt|sh|bat|ps1|conf|xml|gradle|properties|dockerfile)$/i;
const TEXT_NAMES = /(^|\/)(Dockerfile|Makefile|Procfile|\.env\.example|nginx\.conf)$/i;
const SKIP_DIRS = /(^|\/)(node_modules|dist|build|coverage|vendor|\.git|\.next|\.nuxt|out|bin|obj)\//;
const SKIP_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.min\.(js|css)$|\.map$/i;

function readString(buf, start, len) {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? len : nul).toString('utf8');
}

function readOctal(buf, start, len) {
  const s = readString(buf, start, len).trim();
  return s ? parseInt(s, 8) : 0;
}

function parsePax(body) {
  const out = {};
  let rest = body.toString('utf8');
  while (rest.length) {
    const sp = rest.indexOf(' ');
    const len = parseInt(rest.slice(0, sp), 10);
    if (!len || sp < 0) break;
    const record = rest.slice(sp + 1, len - 1);
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    rest = rest.slice(len);
  }
  return out;
}

function isWanted(path, size, maxFileBytes) {
  if (size > maxFileBytes) return false;
  if (SKIP_DIRS.test(path) || SKIP_FILES.test(path)) return false;
  return TEXT_EXT.test(path) || TEXT_NAMES.test(path);
}

/**
 * @returns {{ files: Map<string,string>, skipped: number, commit: string|null }}
 */
function extractTextFiles(gzBuffer, { maxFileBytes = 400 * 1024, maxTotalBytes = 60 * 1024 * 1024 } = {}) {
  const tar = zlib.gunzipSync(gzBuffer, { maxOutputLength: 512 * 1024 * 1024 });
  const files = new Map();
  let skipped = 0;
  let total = 0;
  let commit = null;
  let paxPath = null;
  let offset = 0;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break;
    let name = readString(header, 0, 100);
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const magic = readString(header, 257, 6);
    if (magic.startsWith('ustar')) {
      const prefix = readString(header, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    const bodyStart = offset + BLOCK;
    const body = tar.subarray(bodyStart, bodyStart + size);
    offset = bodyStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'g') { // GitHub stores the commit sha in the global header comment
      const pax = parsePax(body);
      if (pax.comment && /^[0-9a-f]{40}$/.test(pax.comment)) commit = pax.comment;
      continue;
    }
    if (type === 'x') { paxPath = parsePax(body).path || null; continue; }
    if (paxPath) { name = paxPath; paxPath = null; }
    if (type !== '0' && type !== '\0') continue; // regular files only

    const rel = name.replace(/^[^/]+\//, ''); // drop "<owner>-<repo>-<sha>/"
    if (!rel || !isWanted(rel, size, maxFileBytes) || total + size > maxTotalBytes) {
      skipped += 1;
      continue;
    }
    if (body.includes(0)) { skipped += 1; continue; } // binary after all
    files.set(rel, body.toString('utf8'));
    total += size;
  }
  return { files, skipped, commit };
}

module.exports = { extractTextFiles };
