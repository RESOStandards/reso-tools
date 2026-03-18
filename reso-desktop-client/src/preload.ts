import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload script — exposes a secure storage API to the renderer process
 * via contextBridge. The main process handles encryption/decryption using
 * Electron's safeStorage (OS-level keychain/credential store).
 */

contextBridge.exposeInMainWorld('electronStorage', {
  get: (key: string): Promise<string | null> => ipcRenderer.invoke('storage:get', key),
  set: (key: string, value: string): Promise<void> => ipcRenderer.invoke('storage:set', key, value),
  remove: (key: string): Promise<void> => ipcRenderer.invoke('storage:remove', key)
});
