/**
 * Create a read-only service key for a machine client (e.g. the MCP Gateway).
 *
 *   node scripts/service-key.js mcp-gateway
 *
 * Prints the key once — give it to the client — and the line to add to the backend .env,
 * which holds only the key's SHA-256 hash. To revoke, remove the entry and rebuild.
 */
const { newKey } = require('../src/lib/serviceRead');

const name = (process.argv[2] || '').trim();
if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(name)) {
  console.error('usage: node scripts/service-key.js <client-name>   (lowercase letters, digits, dashes)');
  process.exit(1);
}
const { key, hash } = newKey();
console.log(`\nService key for "${name}" (shown once; store it with the client, e.g. the gateway's HUB_SERVICE_KEY):\n\n  ${key}\n`);
console.log('Add to the backend .env (append to any existing entries, comma-separated), then rebuild:\n');
console.log(`  HUB_SERVICE_READ_KEYS=${name}:${hash}\n`);
