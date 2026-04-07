/**
 * Secure key-value storage adapter.
 *
 * Uses the Electron preload bridge (`window.electronStorage`) when running
 * inside the RESO Desktop Client — values are encrypted by Electron's
 * `safeStorage` API, which delegates to the OS keychain (macOS Keychain,
 * Windows DPAPI, Linux libsecret).
 *
 * Falls back to `localStorage` when running in a plain browser. Values are
 * NOT encrypted in that case — anything that needs real encryption should
 * gate on `isSecure()` and refuse to persist sensitive data otherwise.
 *
 * The interface is async on both paths so call sites don't have to branch.
 */

/** True if the current environment provides OS-level encrypted storage. */
export const isSecure = (): boolean =>
  typeof window !== 'undefined' && window.electronStorage !== undefined;

/** Get a value by key. Returns null if unset or on error. */
export const secureGet = async (key: string): Promise<string | null> => {
  if (window.electronStorage) {
    try {
      return await window.electronStorage.get(key);
    } catch {
      return null;
    }
  }
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/** Set a value by key. Silently no-ops on error. */
export const secureSet = async (key: string, value: string): Promise<void> => {
  if (window.electronStorage) {
    try {
      await window.electronStorage.set(key, value);
    } catch {
      // Ignore — storage failures shouldn't block the app
    }
    return;
  }
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore quota / private mode errors
  }
};

/** Remove a value by key. Silently no-ops on error. */
export const secureRemove = async (key: string): Promise<void> => {
  if (window.electronStorage) {
    try {
      await window.electronStorage.remove(key);
    } catch {
      // Ignore
    }
    return;
  }
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore
  }
};

/** Convenience: JSON-serialized get/set. */
export const secureGetJson = async <T>(key: string): Promise<T | null> => {
  const raw = await secureGet(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export const secureSetJson = async <T>(key: string, value: T): Promise<void> => {
  await secureSet(key, JSON.stringify(value));
};
