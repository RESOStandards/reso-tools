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

    // Check localStorage (may have been hydrated from Electron storage)
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark') return true;
    if (stored === 'light') return false;

    // Fall back to system preference
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  };

  const [isDark, setIsDark] = useState(getInitial);

  // On mount, hydrate from Electron storage if available (async)
  useEffect(() => {
    const storage = electronStorage();
    if (storage) {
      storage.get(STORAGE_KEY).then(value => {
        if (value === 'dark') setIsDark(true);
        else if (value === 'light') setIsDark(false);
      });
    }
  }, []);

  // Apply dark class to <html> element and persist preference
  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    const value = isDark ? 'dark' : 'light';
    localStorage.setItem(STORAGE_KEY, value);
    electronStorage()?.set(STORAGE_KEY, value);
  }, [isDark]);

  const toggle = useCallback(() => {
    setIsDark(prev => !prev);
  }, []);

  return { isDark, toggle };
};
