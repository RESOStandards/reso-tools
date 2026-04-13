/**
 * Type declarations for the Electron preload bridge exposed via
 * `contextBridge.exposeInMainWorld`. Defined in
 * reso-desktop-client/src/preload.ts. The web client may run inside
 * Electron (where these are present) or in a plain browser (where they
 * are not), so accessors should always check for existence before use.
 */

export interface ElectronStorageBridge {
  /** Get a value by key. Resolves to null if the key is unset. */
  get(key: string): Promise<string | null>;
  /** Set a value by key. */
  set(key: string, value: string): Promise<void>;
  /** Remove a value by key. */
  remove(key: string): Promise<void>;
}

export interface ElectronUpdatesBridge {
  onUpdateAvailable(
    callback: (release: { tagName: string; url: string; name: string }) => void
  ): void;
}

declare global {
  interface Window {
    /**
     * OS-encrypted key-value store (Keychain on macOS, DPAPI on Windows,
     * libsecret on Linux). Available only when running inside the
     * RESO Desktop Client; undefined in a plain browser.
     */
    electronStorage?: ElectronStorageBridge;

    /** Update notification bridge. */
    electronUpdates?: ElectronUpdatesBridge;
  }
}

export {};
