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

/**
 * Dedicated login-credentials bridge — backed by its own JSON file
 * (cert-login-credentials.json) so writes here can't disturb other
 * persisted state. Each password is individually encrypted via
 * Electron's safeStorage on the main process side.
 */
contextBridge.exposeInMainWorld('loginCredentials', {
  list: (): Promise<ReadonlyArray<{ username: string; password: string }>> =>
    ipcRenderer.invoke('login-creds:list'),
  upsert: (username: string, password: string): Promise<void> =>
    ipcRenderer.invoke('login-creds:upsert', username, password),
  remove: (username: string): Promise<void> =>
    ipcRenderer.invoke('login-creds:remove', username)
});

contextBridge.exposeInMainWorld('electronUpdates', {
  onUpdateAvailable: (callback: (release: { tagName: string; url: string; name: string }) => void): void => {
    ipcRenderer.on('update:available', (_event, release) => callback(release));
  }
});

contextBridge.exposeInMainWorld('configManager', {
  /** List all saved configs. */
  list: (): Promise<ReadonlyArray<unknown>> =>
    ipcRenderer.invoke('config:list'),
  /** Save a config (creates or updates). */
  save: (config: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('config:save', config),
  /** Delete a config by ID. */
  remove: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('config:delete', id),
  /** Import configs from a JSON array. Returns count imported. */
  importConfigs: (configs: ReadonlyArray<Record<string, unknown>>): Promise<number> =>
    ipcRenderer.invoke('config:import', configs),
});

contextBridge.exposeInMainWorld('jobStore', {
  createJob: (job: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('jobs:create', job),
  updateJobStatus: (id: string, patch: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('jobs:update-status', id, patch),
  upsertStep: (jobId: string, step: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('jobs:upsert-step', jobId, step),
  getJob: (id: string): Promise<unknown> =>
    ipcRenderer.invoke('jobs:get', id),
  getJobs: (filter?: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('jobs:get-all', filter),
  deleteJob: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('jobs:delete', id),
  clearCompleted: (): Promise<number> =>
    ipcRenderer.invoke('jobs:clear-completed'),
});

contextBridge.exposeInMainWorld('pendingTasksStore', {
  insert: (task: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('pending-tasks:insert', task),
  update: (id: string, patch: Record<string, unknown>): Promise<unknown> =>
    ipcRenderer.invoke('pending-tasks:update', id, patch),
  remove: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('pending-tasks:remove', id),
  get: (id: string): Promise<unknown> =>
    ipcRenderer.invoke('pending-tasks:get', id),
  list: (): Promise<unknown> =>
    ipcRenderer.invoke('pending-tasks:list'),
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

  /** Open a file in the system's default application or show in Finder/Explorer. */
  openFile: (filePath: string): Promise<void> =>
    ipcRenderer.invoke('cert:open-file', filePath),

  /**
   * Read a report file's parsed JSON by absolute path.
   * Rejects with an Error whose `code` is `'MISSING'` if the file no longer exists.
   */
  readReportFile: (absolutePath: string): Promise<unknown> =>
    ipcRenderer.invoke('reports:read-file', absolutePath),

  /**
   * Read a report file as raw UTF-8 text (no JSON parsing).
   * Use for non-JSON artifacts like metadata.xml.
   */
  readReportFileText: (absolutePath: string): Promise<string> =>
    ipcRenderer.invoke('reports:read-text', absolutePath),

  /** List known report files present in a results directory as `{ reportKey → absolute path }`. */
  listReportFiles: (outputDir: string): Promise<Record<string, string>> =>
    ipcRenderer.invoke('reports:list-files', outputDir),

});
