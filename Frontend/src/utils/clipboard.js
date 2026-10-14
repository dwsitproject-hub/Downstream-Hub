/**
 * Copy text to the clipboard. The async Clipboard API only exists on secure origins
 * (HTTPS or localhost), so plain-HTTP deployments such as staging fall back to a hidden
 * textarea + execCommand('copy'). Resolves true when the copy succeeded.
 */
export async function copyText(text) {
  const value = String(text ?? '');
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // permission denied or document not focused — try the fallback
    }
  }
  const previousFocus = document.activeElement;
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
  return ok;
}
