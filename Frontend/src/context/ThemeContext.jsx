import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Light / dark theme for the Hub.
 * - The chosen theme is stored in localStorage ('hub.theme'); with nothing stored we follow the
 *   device setting (prefers-color-scheme) and keep following it until the person picks one.
 * - The <html data-theme> attribute drives the CSS tokens in design-tokens.css. index.html sets
 *   it before first paint so there is no flash of the wrong theme.
 */
const STORAGE_KEY = 'hub.theme';
const ThemeContext = createContext({ theme: 'light', setTheme: () => {}, toggleTheme: () => {} });

function readStored() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function systemTheme() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function apply(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#08090C' : '#F4F3F0');
}

export function ThemeProvider({ children }) {
  const [stored, setStored] = useState(readStored);
  const [system, setSystem] = useState(systemTheme);
  const theme = stored || system;

  useEffect(() => {
    apply(theme);
  }, [theme]);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return undefined;
    const onChange = (e) => setSystem(e.matches ? 'dark' : 'light');
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  const setTheme = useCallback((next) => {
    setStored(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* storage unavailable — keep in memory only */
    }
  }, []);

  const toggleTheme = useCallback(() => setTheme(theme === 'dark' ? 'light' : 'dark'), [theme, setTheme]);

  const value = useMemo(() => ({ theme, setTheme, toggleTheme }), [theme, setTheme, toggleTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
