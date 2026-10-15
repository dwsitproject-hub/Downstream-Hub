/**
 * Create a key for a machine client (e.g. the MCP Gateway).
 *
 *   node scripts/service-key.js mcp-gateway             read key    (hubsvc_…, HUB_SERVICE_READ_KEYS)
 *   node scripts/service-key.js mcp-gateway --control   control key (hubctl_…, HUB_SERVICE_CONTROL_KEYS):
 *                                                       may set Sentinel's model, nothing else
 *
 * Prints the key once — give it to the client — and the line to add to the backend .env,
 * which holds only the key's SHA-256 hash. To revoke, remove the entry and recreate the container.
 */
const { newKey } = require('../src/lib/serviceRead');

const args = process.argv.slice(2);
const control = args.includes('--control');
const name = (args.find((a) => !a.startsWith('--')) || '').trim();
if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(name)) {
  console.error('usage: node scripts/service-key.js <client-name> [--control]   (lowercase letters, digits, dashes)');
  process.exit(1);
}
const { key, hash } = newKey(control ? 'hubctl_' : 'hubsvc_');
const variable = control ? 'HUB_SERVICE_CONTROL_KEYS' : 'HUB_SERVICE_READ_KEYS';
const clientVar = control ? 'DWSHUB_CONTROL_KEY' : 'DWSHUB_SERVICE_KEY';
console.log(`\n${control ? 'Control' : 'Service'} key for "${name}" (shown once; store it with the client, e.g. the gateway's ${clientVar}):\n\n  ${key}\n`);
console.log('Add to the backend .env (append to any existing entries, comma-separated), then recreate the container:\n');
console.log(`  ${variable}=${name}:${hash}\n`);
