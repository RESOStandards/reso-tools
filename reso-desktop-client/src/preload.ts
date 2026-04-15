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

contextBridge.exposeInMainWorld('electronUpdates', {
  onUpdateAvailable: (callback: (release: { tagName: string; url: string; name: string }) => void): void => {
    ipcRenderer.on('update:available', (_event, release) => callback(release));
  }
});

contextBridge.exposeInMainWorld('certRunner', {
  /** Start a compliance test run. Returns the PipelineResult when done. */
  run: (jobId: string, config: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('cert:run', jobId, config),

  /** Cancel a running cert job. */
  cancel: (jobId: string): Promise<void> =>
    ipcRenderer.invoke('cert:cancel', jobId),

  /** Subscribe to step-level progress events for a job. Returns an unsubscribe function. */
  onProgress: (callback: (jobId: string, progress: { step: string; status: string; message?: string; duration?: number }) => void): (() => void) => {
    const handler = (_event: unknown, jobId: string, progress: { step: string; status: string; message?: string; duration?: number }) =>
      callback(jobId, progress);
    ipcRenderer.on('cert:progress', handler);
    return () => { ipcRenderer.removeListener('cert:progress', handler); };
  },

  /** Get the local reference server URL. */
  localServerUrl: (): Promise<string | null> =>
    ipcRenderer.invoke('cert:localServerUrl'),

  /** Scan local results directory for completed runs. */
  scanResults: (): Promise<ReadonlyArray<unknown>> =>
    ipcRenderer.invoke('cert:scan-results'),

  /** Delete a local result directory. Returns true on success. */
  deleteResult: (resultPath: string): Promise<boolean> =>
    ipcRenderer.invoke('cert:delete-result', resultPath),

});
