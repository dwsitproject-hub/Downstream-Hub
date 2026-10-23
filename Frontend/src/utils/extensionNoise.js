/**
 * True when every script URL in a stack belongs to a browser extension (MetaMask, password
 * managers, ad blockers...). Their injected scripts throw into the page's global handlers,
 * but they are not Hub errors. A stack with no URL is not treated as noise.
 * Same rule as the backend's sdkPolicy.isExtensionOnlyStack.
 */
const STACK_URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s)]+/gi;
const EXTENSION_URL_RE = /^(chrome|moz|safari|safari-web|ms-browser)-extension:/i;

export function isExtensionOnlyStack(stack) {
  const urls = String(stack || '').match(STACK_URL_RE);
  return !!urls && urls.every((u) => EXTENSION_URL_RE.test(u));
}
