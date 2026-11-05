// Set the Hub's light/dark theme before first paint, so the page never flashes the wrong one.
// Kept as a same-origin file (not inline) so it works under a `script-src 'self'` CSP.
// Must agree with src/context/ThemeContext.jsx ('hub.theme' in localStorage, else the device setting).
(function () {
  var t = null;
  try { t = localStorage.getItem('hub.theme'); } catch (e) { /* storage blocked */ }
  if (t !== 'light' && t !== 'dark') {
    t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', t);
})();
