import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'reso-theme';

interface ElectronStorageApi {
  readonly get: (key: string) => Promise<string | null>;
  readonly set: (key: string, value: string) => Promise<void>;
}

const electronStorage = (): ElectronStorageApi | null =>
  (window as unknown as { electronStorage?: ElectronStorageApi }).electronStorage ?? null;

/**
 * Manages dark mode state. Priority order:
 * 1. URL query param `?theme=dark|light` (one-time override, not required on every page)
 * 2. Persisted preference (Electron secure storage or localStorage)
 * 3. System preference (prefers-color-scheme)
 */
export const useDarkMode = () => {
  const getInitial = (): boolean => {
    // Check URL param first (one-time override)
    const url = new URL(window.location.href);
    const themeParam = url.searchParams.get('theme');
    if (themeParam === 'dark') return true;
    if (themeParam === 'light') return false;

    // Must match the anti-flash script in index.html exactly:
    // the script reads localStorage then system pref, and only
    // adds the dark class — never removes it. So our initial
    // state must agree with what the DOM currently shows.
    return document.documentElement.classList.contains('dark');
  };

  const [isDark, setIsDark] = useState(getInitial);

  // Apply dark class to <html> element and persist preference
  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    const value = isDark ? 'dark' : 'light';
    localStorage.setItem(STORAGE_KEY, value);
    // Cookie survives Electron's random-port localStorage partitioning
    document.cookie = `${STORAGE_KEY}=${value};path=/;max-age=31536000;SameSite=Lax`;
    electronStorage()?.set(STORAGE_KEY, value);
  }, [isDark]);

  const toggle = useCallback(() => {
    setIsDark(prev => !prev);
  }, []);

  return { isDark, toggle };
};
