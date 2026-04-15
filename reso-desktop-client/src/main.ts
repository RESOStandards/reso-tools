import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, safeStorage, shell } from 'electron';
import { resolve, join, basename, dirname, relative } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync, readdirSync, statSync } from 'node:fs';

// Suppress EPIPE errors from broken pipes (e.g., child process stdout closed on shutdown).
// These are harmless but surface as uncaught exceptions that crash the app.
process.on('uncaughtException', (err) => {
  if ('code' in err && err.code === 'EPIPE') return;
  throw err;
});

/** Write diagnostic messages to a log file in the user data directory. */
const logFile = (): string => resolve(app.getPath('userData'), 'reso-desktop.log');
const log = (msg: string): void => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(logFile(), line); } catch { /* ignore */ }
  try { console.log(msg); } catch { /* EPIPE if child process pipe is closed */ }
};

// Override default "Electron" name shown in macOS menu bar and dock
app.setName('RESO Desktop Client');

// ── Persistent storage (encrypted when safeStorage is available, plain JSON otherwise) ──

/** Path to the storage file in the user data directory. */
const storageFilePath = (): string => resolve(app.getPath('userData'), 'secure-storage.json');

/** Whether OS-level encryption (Keychain/DPAPI/libsecret) is available. */
const canEncrypt = (): boolean => safeStorage.isEncryptionAvailable();

/** Read the entire store as a Record<string, string>. */
const readStore = (): Record<string, string> => {
  try {
    const raw = readFileSync(storageFilePath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};

    const encrypted = canEncrypt();
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') {
        result[key] = encrypted
          ? safeStorage.decryptString(Buffer.from(value, 'base64'))
          : value;
      }
    }
    return result;
  } catch {
    return {};
  }
};

/** Write the store, encrypting values when safeStorage is available. */
const writeStore = (store: Record<string, string>): void => {
  const encrypted = canEncrypt();
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(store)) {
    output[key] = encrypted
      ? safeStorage.encryptString(value).toString('base64')
      : value;
  }
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(storageFilePath(), JSON.stringify(output, null, 2), 'utf-8');
};

/** Register IPC handlers for secure storage operations. */
const registerStorageHandlers = (): void => {
  ipcMain.handle('storage:get', (_event, key: string): string | null => {
    const store = readStore();
    return store[key] ?? null;
  });

  ipcMain.handle('storage:set', (_event, key: string, value: string): void => {
    const store = readStore();
    store[key] = value;
    writeStore(store);
  });

  ipcMain.handle('storage:remove', (_event, key: string): void => {
    const store = readStore();
    delete store[key];
    writeStore(store);
  });
};

// ── Certification runner (SDK in main process, progress via IPC) ──

/**
 * Active cert runs keyed by a client-provided jobId.
 * AbortControllers allow the renderer to cancel a running job.
 */
const activeRuns = new Map<string, AbortController>();

/** Mirror the SDK's buildOutputPath to find report files after a run. */
const resolveOutputPath = (config: Record<string, unknown>): string | null => {
  try {
    const endorsement = config.endorsement as string;
    const slugMap: Record<string, string> = {
      dd: 'data-dictionary',
      core: 'web-api-core',
      'add-edit': 'web-api-add-edit',
      'entity-event': 'entity-event',
    };
    const slug = slugMap[endorsement];
    if (!slug) return null;

    const versionMap: Record<string, string> = {
      dd: (config.version as string) ?? '2.0',
      core: (config.version as string) ?? '2.0.0',
      'add-edit': (config.specVersion as string) ?? '2.0.0',
      'entity-event': '1.0.0',
    };
    const version = versionMap[endorsement];

    const providerUoi = (config.providerUoi as string) ?? `LOCAL-${Date.now()}`;
    const providerUsi = (config.providerUsi as string) ?? 'LOCAL-SYSTEM';
    const recipientUoi = (config.recipientUoi as string) ?? 'LOCAL-RECIPIENT';
    const outputDir = (config.options as Record<string, unknown>)?.outputDir as string | undefined;
    const resultsPath = outputDir ?? resolve(process.cwd(), '.reso-cert');

    return resolve(resultsPath, `${slug}-${version}`, `${providerUoi}-${providerUsi}`, recipientUoi, 'current');
  } catch {
    return null;
  }
};

// ── Local results scanner + watcher ──────────────────────────────────

const CERT_RESULTS_DIR = '.reso-cert';

/** Get the root results directory. */
const certResultsRoot = (): string => resolve(process.cwd(), CERT_RESULTS_DIR);

/**
 * Shape of a scanned local result — one per current/ or archived/ directory.
 * Returned to the renderer to hydrate the jobs list on startup.
 */
interface LocalResult {
  readonly endorsement: string;
  readonly version: string;
  readonly providerUoi: string;
  readonly providerUsi: string;
  readonly recipientUoi: string;
  readonly path: string;
  readonly isCurrent: boolean;
  readonly timestamp: string;
  readonly reports: Record<string, unknown>;
}

/** Read report files from a results directory. */
const readReports = (dir: string): Record<string, unknown> => {
  const reports: Record<string, unknown> = {};
  const filesToRead: Readonly<Record<string, string>> = {
    schemaErrors: join(dir, 'data-availability-schema-validation-errors.json'),
    variations: join(dir, 'data-dictionary-variations.json'),
    metadata: join(dir, 'metadata-report.processed.json'),
    ddReport: join(dir, 'data-dictionary-2.0.json'),
    report: join(dir, 'report.json'),
    reportDetailed: join(dir, 'report-detailed.json'),
  };
  for (const [key, path] of Object.entries(filesToRead)) {
    try {
      const content = readFileSync(path, 'utf-8');
      reports[key] = JSON.parse(content);
    } catch { /* file doesn't exist — skip */ }
  }
  return reports;
};

/**
 * Scan the .reso-cert/ directory tree and return all local results.
 *
 * Structure:
 *   .reso-cert/data-dictionary-{version}/{providerUoi}-{providerUsi}/{recipientUoi}/current/
 *   .reso-cert/data-dictionary-{version}/{providerUoi}-{providerUsi}/{recipientUoi}/archived/{timestamp}/
 */
const scanLocalResults = (): ReadonlyArray<LocalResult> => {
  const root = certResultsRoot();
  if (!existsSync(root)) return [];

  const results: LocalResult[] = [];

  try {
    // Level 1: endorsement-version directories (e.g., data-dictionary-2.0)
    for (const endorsementDir of readdirSync(root)) {
      const endorsementPath = join(root, endorsementDir);
      if (!statSync(endorsementPath).isDirectory()) continue;

      // Parse endorsement and version from directory name
      // Supports: data-dictionary-2.0, web-api-core-2.0.0, web-api-add-edit-2.0.0, entity-event-1.0.0
      const match = endorsementDir.match(/^(.+)-(\d+\.\d+(?:\.\d+)?)$/);
      if (!match) continue;
      const endorsementSlug = match[1];
      const version = match[2];
      const endorsementLabels: Record<string, string> = {
        'data-dictionary': 'Data Dictionary',
        'web-api-core': 'Web API Core',
        'web-api-add-edit': 'Web API Add/Edit',
        'entity-event': 'EntityEvent',
      };
      const endorsement = endorsementLabels[endorsementSlug] ?? endorsementSlug;

      // Level 2: provider directories (e.g., T00000012-50055)
      for (const providerDir of readdirSync(endorsementPath)) {
        const providerPath = join(endorsementPath, providerDir);
        if (!statSync(providerPath).isDirectory()) continue;

        // Split on first dash to get providerUoi and providerUsi
        const dashIdx = providerDir.indexOf('-');
        const providerUoi = dashIdx > 0 ? providerDir.slice(0, dashIdx) : providerDir;
        const providerUsi = dashIdx > 0 ? providerDir.slice(dashIdx + 1) : '';

        // Level 3: recipient directories (e.g., M00000570)
        for (const recipientDir of readdirSync(providerPath)) {
          const recipientPath = join(providerPath, recipientDir);
          if (!statSync(recipientPath).isDirectory()) continue;
          const recipientUoi = recipientDir;

          // Check for current/ directory
          const currentPath = join(recipientPath, 'current');
          if (existsSync(currentPath) && statSync(currentPath).isDirectory()) {
            const mtime = statSync(currentPath).mtime.toISOString();
            results.push({
              endorsement, version, providerUoi, providerUsi, recipientUoi,
              path: currentPath, isCurrent: true, timestamp: mtime,
              reports: readReports(currentPath),
            });
          }

          // Check for archived/ directories
          const archivedPath = join(recipientPath, 'archived');
          if (existsSync(archivedPath) && statSync(archivedPath).isDirectory()) {
            for (const archiveDir of readdirSync(archivedPath)) {
              const archivePath = join(archivedPath, archiveDir);
              if (!statSync(archivePath).isDirectory()) continue;
              // Reconstruct ISO timestamp from file-safe directory name
              // e.g., 2026-04-14T034929041Z → 2026-04-14T03:49:29.041Z
              const ts = archiveDir.replace(
                /^(\d{4}-\d{2}-\d{2}T)(\d{2})(\d{2})(\d{2})(\d{3})Z$/,
                '$1$2:$3:$4.$5Z'
              );
              const timestamp = isNaN(new Date(ts).getTime())
                ? statSync(archivePath).mtime.toISOString()
                : ts;
              results.push({
                endorsement, version, providerUoi, providerUsi, recipientUoi,
                path: archivePath, isCurrent: false, timestamp,
                reports: readReports(archivePath),
              });
            }
          }
        }
      }
    }
  } catch (err) {
    log(`Error scanning cert results: ${err}`);
  }

  return results;
};

const registerCertRunnerHandlers = (): void => {

  /** Scan local results directory and return all found results. */
  ipcMain.handle('cert:scan-results', () => scanLocalResults());

  /** Delete a local result directory, or all results if '__ALL__' is passed. */
  ipcMain.handle('cert:delete-result', async (_event, resultPath: string) => {
    const root = certResultsRoot();

    // Special sentinel: delete the entire .reso-cert directory
    if (resultPath === '__ALL__') {
      try {
        const { rm } = await import('node:fs/promises');
        if (existsSync(root)) {
          await rm(root, { recursive: true, force: true });
          log(`Deleted all local results: ${root}`);
        }
        return true;
      } catch (err) {
        log(`Failed to delete all results: ${err}`);
        return false;
      }
    }

    // Safety: only allow deleting paths inside .reso-cert/
    const resolved = resolve(resultPath);
    if (!resolved.startsWith(root)) {
      log(`Refused to delete path outside .reso-cert: ${resolved}`);
      return false;
    }
    try {
      const { rm, readdir, rmdir } = await import('node:fs/promises');
      await rm(resolved, { recursive: true, force: true });
      log(`Deleted local result: ${resolved}`);

      // Clean up empty parent directories up to .reso-cert/
      let parent = dirname(resolved);
      while (parent.startsWith(root) && parent !== root) {
        try {
          const entries = await readdir(parent);
          if (entries.length === 0) {
            await rmdir(parent);
            log(`Cleaned up empty parent: ${parent}`);
            parent = dirname(parent);
          } else {
            break;
          }
        } catch { break; }
      }

      return true;
    } catch (err) {
      log(`Failed to delete ${resolved}: ${err}`);
      return false;
    }
  });

  /**
   * Start a compliance test run.
   * The renderer sends a ComplianceConfig-shaped object plus a jobId.
   * Progress events are pushed to the renderer via 'cert:progress'.
   * Resolves with the PipelineResult when the run completes.
   */
  ipcMain.handle('cert:run', async (event, jobId: string, config: Record<string, unknown>) => {
    const controller = new AbortController();
    activeRuns.set(jobId, controller);

    try {
      // Dynamic import — use a variable to prevent TypeScript from resolving
      // the module at compile time. The package is available at runtime from
      // the monorepo but not declared as a dependency.
      const certPkg = '@reso-standards/reso-certification';
      const certModule = await import(/* webpackIgnore: true */ certPkg) as unknown as {
        runComplianceTests: (config: Record<string, unknown>, onProgress?: (progress: Record<string, unknown>) => void) => Promise<{ status: string; steps: ReadonlyArray<Record<string, unknown>>; duration: number }>;
      };
      const { runComplianceTests } = certModule;

      // If the config targets the local server, inject the actual server URL
      const resolvedConfig = {
        ...config,
        server: {
          ...(config.server as Record<string, unknown>),
          url: (config.server as Record<string, unknown>)?.url === 'LOCAL_SERVER'
            ? state.serverUrl
            : (config.server as Record<string, unknown>)?.url,
        },
      };

      const result = await runComplianceTests(
        resolvedConfig,
        (progress: Record<string, unknown>) => {
          if (controller.signal.aborted) return;
          // Send progress to the renderer
          event.sender.send('cert:progress', jobId, {
            step: progress.step,
            status: progress.status,
            message: progress.message,
            duration: progress.duration,
          });
        },
      );

      activeRuns.delete(jobId);

      // Read any generated reports (available on both pass and fail)
      let reports: Record<string, unknown> | undefined;
      try {
        const outputDir = resolveOutputPath(resolvedConfig);
        if (outputDir) {
          const reportFiles: Record<string, unknown> = {};
          const filesToRead: Readonly<Record<string, string>> = {
            schemaErrors: resolve(outputDir, 'data-availability-schema-validation-errors.json'),
            variations: resolve(outputDir, 'data-dictionary-variations.json'),
            metadata: resolve(outputDir, 'metadata-report.processed.json'),
            report: resolve(outputDir, 'report.json'),
            reportDetailed: resolve(outputDir, 'report-detailed.json'),
          };
          for (const [key, path] of Object.entries(filesToRead)) {
            try {
              const content = readFileSync(path, 'utf-8');
              reportFiles[key] = JSON.parse(content);
            } catch { /* file doesn't exist — skip */ }
          }
          if (Object.keys(reportFiles).length > 0) reports = reportFiles;
          log(`Cert run ${jobId}: found reports: ${Object.keys(reportFiles).join(', ')} in ${outputDir}`);
        }
      } catch (reportErr) {
        log(`Cert run ${jobId}: error reading reports: ${reportErr}`);
      }

      // Cross-check: if schema validation errors exist on disk but the pipeline
      // reported success, override to failed. This catches cases where throwOnError
      // propagates through the pipeline but the overall status isn't set correctly
      // (e.g., failFast=false or the error is caught within a sub-step).
      const hasSchemaErrors = reports?.schemaErrors !== undefined;
      const actualStatus = hasSchemaErrors && result.status === 'passed' ? 'failed' as const : result.status;
      const error = hasSchemaErrors && result.status === 'passed'
        ? 'Schema validation errors found. See the failure report for details.'
        : undefined;

      log(`Cert run ${jobId} complete: pipeline=${result.status}, actual=${actualStatus}, steps=${result.steps.length}${hasSchemaErrors ? ', schemaErrors=true' : ''}`);

      return { status: actualStatus, steps: result.steps, duration: result.duration, reports, error };
    } catch (err) {
      activeRuns.delete(jobId);
      const message = err instanceof Error ? err.message : String(err);
      log(`Cert run ${jobId} failed: ${message}`);

      // If exit was intercepted, the run produced reports before dying.
      // Return failed status so the UI can show the error report.
      // Try to read any generated reports from the output directory
      let reports: Record<string, unknown> | undefined;
      try {
        const outputDir = resolveOutputPath(config);
        if (outputDir) {
          const reportFiles: Record<string, unknown> = {};
          const errorFilesToRead: Readonly<Record<string, string>> = {
            schemaErrors: resolve(outputDir, 'data-availability-schema-validation-errors.json'),
            variations: resolve(outputDir, 'data-dictionary-variations.json'),
            metadata: resolve(outputDir, 'metadata-report.processed.json'),
            report: resolve(outputDir, 'report.json'),
            reportDetailed: resolve(outputDir, 'report-detailed.json'),
          };

          for (const [key, path] of Object.entries(errorFilesToRead)) {
            try {
              const content = readFileSync(path, 'utf-8');
              reportFiles[key] = JSON.parse(content);
            } catch { /* file doesn't exist yet — skip */ }
          }
          if (Object.keys(reportFiles).length > 0) reports = reportFiles;
        }
      } catch { /* ignore report reading errors */ }

      return {
        status: 'failed' as const,
        error: message,
        steps: [],
        duration: 0,
        reports,
      };
    }
  });

  /** Cancel a running cert job. */
  ipcMain.handle('cert:cancel', (_event, jobId: string) => {
    const controller = activeRuns.get(jobId);
    if (controller) {
      controller.abort();
      activeRuns.delete(jobId);
    }
  });

  /** Get the local server URL (for config builder auto-fill). */
  ipcMain.handle('cert:localServerUrl', () => state.serverUrl);
};

// ── DD version management ──

const DD_VERSIONS = ['2.0', '2.1'] as const;
type DDVersion = typeof DD_VERSIONS[number];
const DD_VERSION_KEY = 'ddVersion';
const DEFAULT_DD_VERSION: DDVersion = '2.0';

/** Get the currently selected DD version. */
const getDDVersion = (): DDVersion => {
  const store = readStore();
  const version = store[DD_VERSION_KEY];
  return DD_VERSIONS.includes(version as DDVersion) ? (version as DDVersion) : DEFAULT_DD_VERSION;
};

/** Set the DD version and return it. */
const setDDVersion = (version: DDVersion): DDVersion => {
  const store = readStore();
  store[DD_VERSION_KEY] = version;
  writeStore(store);
  return version;
};

/** Resolve the metadata file path for a DD version. */
const resolveMetadataForVersion = (version: DDVersion): string => {
  if (app.isPackaged) {
    return resolve(process.resourcesPath, `dd-${version}.json`);
  }
  // Dev mode: reference metadata from reso-certification package
  return resolve(__dirname, '..', '..', 'reso-certification', 'reference-metadata', `dd-${version}.json`);
};

/** State for the running server instance. */
interface AppState {
  serverProcess: ChildProcess | null;
  mainWindow: BrowserWindow | null;
  serverUrl: string | null;
}

const state: AppState = {
  serverProcess: null,
  mainWindow: null,
  serverUrl: null
};

/** Resolve paths for dev vs packaged. */
const resolvePaths = (): {
  readonly serverEntry: string;
  readonly sqliteDbPath: string;
  readonly metadataPath: string;
  readonly serverRoot: string;
  readonly uiDistPath: string;
  readonly iconPath: string;
  readonly logoPath: string;
} => {
  const ddVersion = getDDVersion();
  const sqliteDbPath = resolve(app.getPath('userData'), `reso_reference_${ddVersion}.db`);

  const metadataPath = resolveMetadataForVersion(ddVersion);

  if (app.isPackaged) {
    return {
      serverEntry: resolve(process.resourcesPath, 'server-bundle', 'server-entry.mjs'),
      sqliteDbPath,
      metadataPath,
      serverRoot: process.resourcesPath,
      uiDistPath: resolve(process.resourcesPath, 'ui'),
      iconPath: resolve(process.resourcesPath, '..', 'Resources', 'icon.icns'),
      logoPath: resolve(process.resourcesPath, 'reso-logo.png')
    };
  }

  return {
    serverEntry: resolve(__dirname, 'server-entry.mjs'),
    sqliteDbPath,
    metadataPath,
    serverRoot: resolve(__dirname, '..', '..', 'reso-reference-server', 'src'),
    uiDistPath: resolve(__dirname, '..', '..', 'reso-web-client', 'dist'),
    iconPath: resolve(__dirname, '..', 'build', 'icon.png'),
    logoPath: resolve(__dirname, '..', 'build', 'reso-logo.png')
  };
};

/** Navigate the SPA to a path by executing pushState + popstate in the renderer. */
const navigateTo = (path: string): void => {
  const win = BrowserWindow.getFocusedWindow();
  if (win) {
    win.webContents.executeJavaScript(
      `(function() { const p = ${JSON.stringify(path)}; window.history.pushState({}, '', p); window.dispatchEvent(new PopStateEvent('popstate')); })()`
    ).catch(() => {});
  }
};

/** Build the native application menu. */
const buildMenu = (): void => {
  const isMac = process.platform === 'darwin';

  const template: Electron.MenuItemConstructorOptions[] = [
    // App menu (macOS only)
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    // File
    {
      label: 'File',
      submenu: isMac ? [{ role: 'close' }] : [{ role: 'quit' }]
    },
    // Edit
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    // View
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    // Navigate
    {
      label: 'Navigate',
      submenu: [
        {
          label: 'Back',
          accelerator: isMac ? 'Cmd+Left' : 'Alt+Left',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win?.webContents.canGoBack()) win.webContents.goBack();
          }
        },
        {
          label: 'Forward',
          accelerator: isMac ? 'Cmd+Right' : 'Alt+Right',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win?.webContents.canGoForward()) win.webContents.goForward();
          }
        },
        { type: 'separator' },
        {
          label: 'Dashboard',
          accelerator: isMac ? 'Cmd+Shift+H' : 'Ctrl+Shift+H',
          click: () => navigateTo('/')
        },
        { type: 'separator' },
        {
          label: 'Organizations',
          accelerator: isMac ? 'Cmd+Shift+O' : 'Ctrl+Shift+O',
          click: () => navigateTo('/organizations')
        },
        {
          label: 'Resources',
          accelerator: isMac ? 'Cmd+Shift+R' : 'Ctrl+Shift+R',
          click: () => navigateTo('/Property')
        },
        {
          label: 'Metadata',
          accelerator: isMac ? 'Cmd+Shift+M' : 'Ctrl+Shift+M',
          click: () => navigateTo('/metadata')
        },
        { type: 'separator' },
        {
          label: 'Data Generator',
          click: () => navigateTo('/admin/data-generator')
        }
      ]
    },
    // Server
    {
      label: 'Server',
      submenu: [
        {
          label: 'Data Dictionary Version',
          submenu: DD_VERSIONS.map(version => ({
            label: `DD ${version}${version === '2.1' ? ' (Draft)' : ''}`,
            type: 'radio' as const,
            checked: getDDVersion() === version,
            click: async () => {
              const current = getDDVersion();
              if (current === version) return;
              setDDVersion(version);
              const result = await dialog.showMessageBox({
                type: 'question',
                buttons: ['Restart Now', 'Later'],
                defaultId: 0,
                title: 'Restart Required',
                message: `Switched to DD ${version}. The reference server needs to restart to use the new metadata.`,
              });
              if (result.response === 0) {
                app.relaunch();
                app.exit(0);
              }
            },
          })),
        },
        { type: 'separator' },
        {
          label: 'Restart Server',
          click: () => {
            app.relaunch();
            app.exit(0);
          },
        },
      ]
    },
    // Window
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : [{ role: 'close' as const }])
      ]
    },
    // Help
    {
      label: 'Help',
      submenu: [
        {
          label: 'Check for Updates...',
          click: () => checkForUpdatesInteractive()
        },
        { type: 'separator' },
        {
          label: 'Releases',
          click: () => shell.openExternal('https://tools.reso.org/releases/')
        },
        {
          label: 'Announcements',
          click: () => shell.openExternal('https://tools.reso.org/announcements/')
        },
        {
          label: 'Security Audit',
          click: () => shell.openExternal('https://tools.reso.org/security/')
        },
        { type: 'separator' },
        {
          label: 'RESO Website',
          click: () => shell.openExternal('https://www.reso.org')
        },
        {
          label: 'RESO Data Dictionary',
          click: () => shell.openExternal('https://ddwiki.reso.org')
        },
        { type: 'separator' },
        {
          label: 'Report an Issue',
          click: () => shell.openExternal('https://github.com/RESOStandards/reso-tools/issues')
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

/** Start the server in a child process and return the URL. */
const startReferenceServer = (): Promise<string> => {
  const paths = resolvePaths();

  log('Launching server child process...');
  log(`  Entry:  ${paths.serverEntry}`);
  log(`  SQLite: ${paths.sqliteDbPath}`);
  log(`  isPackaged: ${app.isPackaged}`);
  log(`  resourcesPath: ${process.resourcesPath}`);

  return new Promise((resolvePromise, reject) => {
    // Fork Electron as a plain Node.js process via ELECTRON_RUN_AS_NODE.
    // This uses Electron's bundled Node (same ABI as the compiled native
    // addons), so it works in packaged apps without requiring system Node.
    log(`  execPath: ${process.execPath}`);
    const child = fork(
      paths.serverEntry,
      [paths.sqliteDbPath, paths.metadataPath, paths.serverRoot, paths.uiDistPath],
      {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ENTITY_EVENT: 'true' }
      }
    );

    // Capture child stdout/stderr for diagnostics
    child.stdout?.on('data', (data: Buffer) => log(`[server] ${data.toString().trimEnd()}`));
    child.stderr?.on('data', (data: Buffer) => log(`[server:err] ${data.toString().trimEnd()}`));

    state.serverProcess = child;

    child.on('message', (msg: unknown) => {
      const message = msg as { type: string; port?: number; message?: string };
      if (message.type === 'ready' && message.port) {
        const url = `http://localhost:${message.port}`;
        state.serverUrl = url;
        resolvePromise(url);
      } else if (message.type === 'error') {
        reject(new Error(message.message ?? 'Server failed to start'));
      }
    });

    child.on('error', (err) => {
      log(`Fork error: ${err.message}`);
      reject(new Error(`Failed to spawn server process: ${err.message}`));
    });

    child.on('exit', (code) => {
      log(`Server child exited with code ${code}`);
      if (!state.serverUrl) {
        reject(new Error(`Server process exited with code ${code} before becoming ready`));
      }
    });
  });
};

/** Check the persisted theme preference, falling back to system setting. */
const isDarkMode = (): boolean => {
  const store = readStore();
  const saved = store['reso-theme'];
  if (saved === 'dark') return true;
  if (saved === 'light') return false;
  return nativeTheme.shouldUseDarkColors;
};

/** Build an inline HTML splash screen with the RESO logo. */
const buildSplashHtml = (logoPath: string): string => {
  const isDark = isDarkMode();
  const bg = isDark ? '#1a202c' : '#f9fafb';
  const spinnerColor = isDark ? '#63b3ed' : '#007e9e';
  const logoSrc = `file://${logoPath}`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { margin:0; height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; background:${bg}; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  img { width:200px; margin-bottom:24px; }
  .spinner { width:24px; height:24px; border:3px solid transparent; border-top-color:${spinnerColor}; border-radius:50%; animation:spin 0.8s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
</style></head><body><img src="${logoSrc}" alt="RESO" /><div class="spinner"></div></body></html>`)}`;
};

/** Create the main application window. Shows a splash screen, then navigates to the server URL. */
const createWindow = (paths: ReturnType<typeof resolvePaths>): BrowserWindow => {
  const isDark = isDarkMode();
  const icon = nativeImage.createFromPath(paths.iconPath);

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: isDark ? '#1a202c' : '#f9fafb',
    title: `RESO Desktop Client — DD ${getDDVersion()}`,
    icon,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: resolve(__dirname, 'preload.js')
    }
  });

  // Set dock icon on macOS
  if (process.platform === 'darwin' && !icon.isEmpty() && app.dock) {
    app.dock.setIcon(icon);
  }

  // Show the splash screen immediately
  win.once('ready-to-show', () => win.show());
  win.loadURL(buildSplashHtml(paths.logoPath));

  // Open external links in the system browser
  win.webContents.setWindowOpenHandler(({ url: linkUrl }) => {
    if (linkUrl.startsWith('http')) {
      shell.openExternal(linkUrl);
    }
    return { action: 'deny' };
  });

  // Navigation: keyboard shortcuts (Cmd/Ctrl+[/] and Cmd/Ctrl+Arrow)
  // Uses window.history for SPA (React Router) compatibility.
  win.webContents.on('before-input-event', (_event, input) => {
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    if (!mod || input.type !== 'keyDown') return;

    if (input.key === '[' || input.key === 'ArrowLeft') {
      win.webContents.executeJavaScript('window.history.back()').catch(() => {});
    } else if (input.key === ']' || input.key === 'ArrowRight') {
      win.webContents.executeJavaScript('window.history.forward()').catch(() => {});
    }
  });

  // Navigation: macOS swipe gestures (three-finger if configured)
  win.on('swipe', (_event, direction) => {
    if (direction === 'left') {
      win.webContents.executeJavaScript('window.history.back()').catch(() => {});
    } else if (direction === 'right') {
      win.webContents.executeJavaScript('window.history.forward()').catch(() => {});
    }
  });

  // Navigation: two-finger trackpad swipe (scroll-based)
  // For SPAs using React Router, we call window.history directly since
  // Electron's webContents.canGoBack() doesn't track pushState navigation.
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`
      (() => {
        let deltaX = 0;
        let tracking = false;
        let resetTimer;
        document.addEventListener('wheel', (e) => {
          if (Math.abs(e.deltaX) < Math.abs(e.deltaY)) return;
          if (!tracking) {
            deltaX = 0;
            tracking = true;
          }
          deltaX += e.deltaX;
          if (deltaX > 150) {
            tracking = false;
            deltaX = 0;
            window.history.back();
          } else if (deltaX < -150) {
            tracking = false;
            deltaX = 0;
            window.history.forward();
          }
          clearTimeout(resetTimer);
          resetTimer = setTimeout(() => { tracking = false; deltaX = 0; }, 200);
        });
      })();
    `).catch(() => {});
  });

  state.mainWindow = win;

  win.on('close', () => win.hide());
  win.on('closed', () => {
    state.mainWindow = null;
  });

  return win;
};

/** Graceful shutdown — kill server child process. */
const shutdown = (): void => {
  log('Shutting down...');
  if (state.serverProcess) {
    state.serverProcess.kill('SIGTERM');
    state.serverProcess = null;
  }
};

// ── Update checker ──

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/RESOStandards/reso-tools/releases/latest';

/** Compare two semver strings. Returns true if remote is newer than local. */
const isNewerVersion = (local: string, remote: string): boolean => {
  const parse = (v: string): readonly number[] => v.replace(/^v/, '').split('.').map(Number);
  const [lMajor = 0, lMinor = 0, lPatch = 0] = parse(local);
  const [rMajor = 0, rMinor = 0, rPatch = 0] = parse(remote);
  if (rMajor !== lMajor) return rMajor > lMajor;
  if (rMinor !== lMinor) return rMinor > lMinor;
  return rPatch > lPatch;
};

interface ReleaseInfo {
  readonly tagName: string;
  readonly url: string;
  readonly name: string;
}

/** Validate that a release URL points to the expected GitHub repository. */
const isValidReleaseUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' &&
      parsed.hostname === 'github.com' &&
      parsed.pathname.startsWith('/RESOStandards/reso-tools/releases/');
  } catch {
    return false;
  }
};

/** Fetch the latest release info from GitHub. Returns null if up to date or on error. */
const fetchLatestRelease = async (): Promise<ReleaseInfo | null> => {
  try {
    const response = await fetch(GITHUB_RELEASES_URL, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'RESO-Desktop-Client' }
    });
    if (!response.ok) return null;

    const release = await response.json() as { tag_name: string; html_url: string; name: string };
    if (!isValidReleaseUrl(release.html_url)) {
      log(`Update check: unexpected release URL ${release.html_url}`);
      return null;
    }
    const currentVersion = app.getVersion();

    if (isNewerVersion(currentVersion, release.tag_name)) {
      log(`Update available: ${release.tag_name} (current: v${currentVersion})`);
      return { tagName: release.tag_name, url: release.html_url, name: release.name };
    }
    log(`Up to date (v${currentVersion})`);
    return null;
  } catch (err) {
    log(`Update check failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
};

/** Silent check — notifies the renderer to show an update badge. */
const checkForUpdatesSilent = async (): Promise<void> => {
  const release = await fetchLatestRelease();
  if (release && state.mainWindow) {
    state.mainWindow.webContents.send('update:available', release);
  }
};

/** Interactive check — shows a native dialog (from Help menu). */
const checkForUpdatesInteractive = async (): Promise<void> => {
  const release = await fetchLatestRelease();
  if (release) {
    const { response: button } = await dialog.showMessageBox({
      type: 'info',
      title: 'Update Available',
      message: 'A new version of RESO Desktop Client is available.',
      detail: `${release.name}\n\nYou are running v${app.getVersion()}. Would you like to download the latest version?`,
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1
    });
    if (button === 0) {
      shell.openExternal(release.url);
    }
  } else {
    dialog.showMessageBox({
      type: 'info',
      title: 'No Updates',
      message: 'You are running the latest version.',
      detail: `RESO Desktop Client v${app.getVersion()}`
    });
  }
};

// App lifecycle
app.whenReady().then(async () => {
  const paths = resolvePaths();
  // Release name displayed in the About panel. Update this each release —
  // the version itself is read automatically from package.json via
  // app.getVersion() so it can never drift. See CLAUDE.md release checklist.
  const RELEASE_NAME = 'Eight Days a Week';
  const appVersion = app.getVersion();
  app.setAboutPanelOptions({
    applicationName: 'RESO Desktop Client',
    applicationVersion: appVersion,
    version: `v${appVersion} — ${RELEASE_NAME}`,
    copyright: '© 2026 Real Estate Standards Organization',
    credits: 'Browse, query, and manage real estate data using RESO standards.',
    website: 'https://reso.org',
    iconPath: paths.iconPath
  });

  registerStorageHandlers();
  registerCertRunnerHandlers();
  buildMenu();

  // Show splash screen immediately while server starts
  const win = createWindow(paths);

  try {
    const url = await startReferenceServer();
    // Navigate from splash to the real server UI
    win.loadURL(url);
    checkForUpdatesSilent();
  } catch (err) {
    log(`Failed to start server: ${err instanceof Error ? err.message : String(err)}`);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  shutdown();
  app.quit();
});

app.on('before-quit', shutdown);

// macOS: re-create window when dock icon is clicked
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && state.serverUrl) {
    const win = createWindow(resolvePaths());
    win.loadURL(state.serverUrl);
  }
});
