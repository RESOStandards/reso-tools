import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, safeStorage, shell } from 'electron';
import { resolve, join, dirname, relative } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync, readdirSync, statSync } from 'node:fs';

// Suppress EPIPE errors from broken pipes (e.g., child process stdout closed on shutdown).
// These are harmless but surface as uncaught exceptions that crash the app.
process.on('uncaughtException', (err) => {
  if ('code' in err && err.code === 'EPIPE') return;
  throw err;
});

// In packaged apps, cwd defaults to / (macOS) or the system root. Change it
// to the resources directory so relative file lookups (schema-validation-settings.json,
// reference metadata, etc.) resolve against the bundled extraResources.
if (app.isPackaged) {
  process.chdir(process.resourcesPath);
}

/** Write diagnostic messages to a log file in the user data directory. */
const logFile = (): string => resolve(app.getPath('userData'), 'reso-desktop.log');
const log = (msg: string): void => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(logFile(), line); } catch { /* ignore */ }
  try { console.log(msg); } catch { /* EPIPE if child process pipe is closed */ }
};

// Override default "Electron" name shown in macOS menu bar and dock
app.setName('RESO Desktop Client (Beta)');

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

// ── Login credentials store (dedicated file, per-password encryption) ──
//
// Separate from the generic secure-storage.json above on purpose: that
// store reads + decrypts every key on every write, so a single corrupt
// value wipes the whole file. Login credentials live in their own JSON
// array file so a write here can never disturb other persisted state.
//
// File shape: [{ username: string, password: string /* base64 of encrypted */ }]

const loginCredsFilePath = (): string =>
  resolve(app.getPath('userData'), 'cert-login-credentials.json');

interface StoredLoginCredential {
  readonly username: string;
  /** base64 of safeStorage.encryptString(plain), or plain text if no encryption. */
  readonly password: string;
}

interface LoginCredential {
  readonly username: string;
  readonly password: string;
}

const readLoginCreds = (): ReadonlyArray<StoredLoginCredential> => {
  try {
    const raw = readFileSync(loginCredsFilePath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is StoredLoginCredential =>
        c && typeof c.username === 'string' && typeof c.password === 'string',
    );
  } catch {
    return [];
  }
};

const writeLoginCreds = (creds: ReadonlyArray<StoredLoginCredential>): void => {
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(loginCredsFilePath(), JSON.stringify(creds, null, 2), 'utf-8');
};

const encryptPassword = (plain: string): string =>
  safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(plain).toString('base64')
    : plain;

const decryptPassword = (stored: string): string => {
  if (!safeStorage.isEncryptionAvailable()) return stored;
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch {
    // Likely written under a different encryption mode. Drop the entry
    // rather than poisoning the rest of the list.
    return '';
  }
};

const registerLoginCredentialsHandlers = (): void => {
  ipcMain.handle('login-creds:list', (): ReadonlyArray<LoginCredential> => {
    return readLoginCreds()
      .map((c) => ({ username: c.username, password: decryptPassword(c.password) }))
      .filter((c) => c.password.length > 0);
  });

  ipcMain.handle('login-creds:upsert', (_event, username: string, password: string): void => {
    if (!username || !password) return;
    const existing = readLoginCreds();
    const others = existing.filter((c) => c.username !== username);
    const updated: ReadonlyArray<StoredLoginCredential> = [
      { username, password: encryptPassword(password) },
      ...others,
    ];
    writeLoginCreds(updated);
  });

  ipcMain.handle('login-creds:remove', (_event, username: string): void => {
    const existing = readLoginCreds();
    const updated = existing.filter((c) => c.username !== username);
    writeLoginCreds(updated);
  });
};

// ── Job store (SQLite in main process, accessed via IPC) ──

import { initJobsDb, createJobStore, type JobStore, type JobRecord, type StepRecord, type StatusPatch, type JobFilter } from './job-store.js';

let jobStore: JobStore | null = null;

const registerJobStoreHandlers = (): void => {
  const dbPath = resolve(app.getPath('userData'), 'reso-jobs.db');
  const db = initJobsDb(dbPath);
  jobStore = createJobStore(db);
  log(`Job store initialized: ${dbPath}`);

  ipcMain.handle('jobs:create', (_event, job: Omit<JobRecord, 'steps'>) =>
    jobStore!.createJob(job)
  );
  ipcMain.handle('jobs:update-status', (_event, id: string, patch: StatusPatch) =>
    jobStore!.updateJobStatus(id, patch)
  );
  ipcMain.handle('jobs:upsert-step', (_event, jobId: string, step: StepRecord) =>
    jobStore!.upsertStep(jobId, step)
  );
  ipcMain.handle('jobs:get', (_event, id: string) =>
    jobStore!.getJob(id)
  );
  ipcMain.handle('jobs:get-all', (_event, filter?: JobFilter) =>
    jobStore!.getJobs(filter)
  );
  ipcMain.handle('jobs:delete', (_event, id: string) =>
    jobStore!.deleteJob(id)
  );
  ipcMain.handle('jobs:clear-completed', () =>
    jobStore!.clearCompleted()
  );
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
    const resultsPath = outputDir ?? resolve(app.getPath('userData'), '.reso-cert');

    return resolve(resultsPath, `${slug}-${version}`, `${providerUoi}-${providerUsi}`, recipientUoi, 'current');
  } catch {
    return null;
  }
};

// ── Local results scanner + watcher ──────────────────────────────────

const CERT_RESULTS_DIR = '.reso-cert';

/** Get the root results directory. */
const certResultsRoot = (): string => resolve(app.getPath('userData'), CERT_RESULTS_DIR);

/**
 * Canonical filenames for each report type, in priority order.
 * First existing file wins — accommodates both new runs and legacy layouts.
 */
const REPORT_FILENAMES: Readonly<Record<string, ReadonlyArray<string>>> = {
  schemaErrors: ['data-availability-schema-validation-errors.json'],
  variations: ['variations-report.json', 'data-dictionary-variations.json'],
  metadata: ['metadata-report.processed.json'],
  ddReport: ['data-dictionary-2.0.json'],
  report: ['report.json'],
  reportDetailed: ['report-detailed.json'],
};

/** Build a map of `{ reportKey → absolute path }` for the files in `dir`, whether they exist yet or not. Callers filter by existence as needed. */
const KNOWN_REPORT_FILES = (dir: string): Readonly<Record<string, string>> => {
  const paths: Record<string, string> = {};
  for (const [key, filenames] of Object.entries(REPORT_FILENAMES)) {
    // Pick the first filename that exists; fall back to the first canonical name if none exists
    // (so callers who care about "what path would a file take" get a stable answer).
    const hit = filenames.find(f => existsSync(resolve(dir, f)));
    paths[key] = resolve(dir, hit ?? filenames[0]);
  }
  return paths;
};

/** Return a map of reportKey → absolute path for files that currently exist in the given dir. */
const listReportRefs = (dir: string): Record<string, string> => {
  const refs: Record<string, string> = {};
  for (const [key, path] of Object.entries(KNOWN_REPORT_FILES(dir))) {
    if (existsSync(path)) refs[key] = path;
  }
  return refs;
};

/**
 * Shape of a scanned local result — one per current/ or archived/ directory.
 * Returned to the renderer to hydrate the jobs list on startup.
 * `reports` values are absolute paths — renderer reads content via IPC on demand.
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
  readonly reports: Record<string, string>;
}

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
              reports: listReportRefs(currentPath),
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
                reports: listReportRefs(archivePath),
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

  /**
   * Read a report file's content by absolute path.
   * Safety: path must be inside the results root — rejects anything else.
   * Throws { code: 'MISSING' } if the file no longer exists so the renderer
   * can surface a "remove from history" prompt.
   */
  ipcMain.handle('reports:read-file', (_event, absPath: string): unknown => {
    const root = certResultsRoot();
    const normalized = resolve(absPath);
    if (!normalized.startsWith(root + '/') && normalized !== root) {
      throw new Error(`Refusing to read outside results root: ${normalized}`);
    }
    if (!existsSync(normalized)) {
      const err = new Error(`Report file not found: ${normalized}`) as Error & { code?: string };
      err.code = 'MISSING';
      throw err;
    }
    return JSON.parse(readFileSync(normalized, 'utf-8'));
  });

  /**
   * List which known report files currently exist in a given results directory.
   * Used for polling while a job is running to discover new reports as the pipeline writes them.
   * Returns the same { reportKey → absolute path } shape as the `reports` column in SQLite.
   */
  ipcMain.handle('reports:list-files', (_event, outputDir: string): Record<string, string> => {
    const root = certResultsRoot();
    const normalized = resolve(outputDir);
    if (!normalized.startsWith(root + '/') && normalized !== root) {
      throw new Error(`Refusing to list outside results root: ${normalized}`);
    }
    return listReportRefs(normalized);
  });

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
    const { Worker } = await import('node:worker_threads');

    // Resolve cert package path
    const certPath = app.isPackaged
      ? '@reso-standards/reso-certification'
      : resolve(__dirname, '..', '..', 'reso-certification', 'dist', 'index.js');

    // Resolve server URL and auth for local runs
    const isLocal = (config.server as Record<string, unknown>)?.url === 'LOCAL_SERVER';
    const serverAuth = (config.server as Record<string, unknown>)?.auth as Record<string, unknown> | undefined;
    // Ensure outputDir is an absolute path under userData (process.cwd() is / in packaged apps)
    const existingOptions = (config.options as Record<string, unknown>) ?? {};
    const outputDir = existingOptions.outputDir as string | undefined;
    const resolvedOutputDir = outputDir && resolve(outputDir) !== outputDir
      ? resolve(app.getPath('userData'), outputDir)
      : outputDir ?? resolve(app.getPath('userData'), '.reso-cert');

    const resolvedConfig = {
      ...config,
      options: {
        ...existingOptions,
        outputDir: resolvedOutputDir,
      },
      server: {
        ...(config.server as Record<string, unknown>),
        url: isLocal ? state.serverUrl : (config.server as Record<string, unknown>)?.url,
        auth: isLocal && (!serverAuth?.authToken && serverAuth?.mode === 'token')
          ? { mode: 'token', authToken: 'admin-token' }
          : serverAuth,
      },
    };

    // Run cert tests in a worker thread so the main process event loop
    // stays free for IPC message delivery (progress updates).
    // In the packaged app, use the pre-bundled worker that has all deps
    // statically included (asar can't resolve dynamic imports).
    // In dev mode, use the TypeScript-compiled worker with dynamic imports.
    const workerFile = app.isPackaged ? 'cert-worker-bundle.mjs' : 'cert-worker.js';
    const workerPath = resolve(__dirname, workerFile);
    const worker = new Worker(workerPath, { workerData: { certPath } });
    activeRuns.set(jobId, { abort: () => worker.terminate() } as unknown as AbortController);

    try {
      const result = await new Promise<{ status: string; steps: ReadonlyArray<Record<string, unknown>>; duration: number }>((resolveWorker, rejectWorker) => {
        worker.on('message', (msg: { type: string; jobId: string; progress?: Record<string, unknown>; result?: string; error?: string }) => {
          if (msg.jobId !== jobId) return;

          if (msg.type === 'progress' && msg.progress) {
            event.sender.send('cert:progress', jobId, {
              step: msg.progress.step,
              status: msg.progress.status,
              message: msg.progress.message,
              duration: msg.progress.duration,
            });
          } else if (msg.type === 'result' && msg.result) {
            worker.terminate();
            resolveWorker(JSON.parse(msg.result));
          } else if (msg.type === 'error') {
            worker.terminate();
            rejectWorker(new Error(msg.error ?? 'Worker error'));
          }
        });

        worker.on('error', rejectWorker);
        worker.on('exit', (code) => {
          if (code !== 0) rejectWorker(new Error(`Worker exited with code ${code}`));
        });

        worker.postMessage({ type: 'run', config: resolvedConfig, jobId });
      });

      activeRuns.delete(jobId);

    // List which report files exist on disk and return a map of refs (absolute paths).
    // The renderer reads content on demand via the reports:read-file IPC, matching the
    // cloud schema where refs are URLs to the cert API.
    const outputDir = resolveOutputPath(resolvedConfig);
    const reports = outputDir ? listReportRefs(outputDir) : undefined;
    if (reports && Object.keys(reports).length > 0) {
      log(`Cert run ${jobId}: found report refs: ${Object.keys(reports).join(', ')} in ${outputDir}`);
    }

    // Cross-check: if schema validation errors exist on disk but the pipeline
    // reported success, override to failed.
    const hasSchemaErrors = reports?.schemaErrors !== undefined;
    const actualStatus = hasSchemaErrors && result.status === 'passed' ? 'failed' as const : result.status;
    const error = hasSchemaErrors && result.status === 'passed'
      ? 'Schema validation errors found. See the failure report for details.'
      : (result as Record<string, unknown>).error as string | undefined;

    log(`Cert run ${jobId} complete: pipeline=${result.status}, actual=${actualStatus}, steps=${result.steps?.length ?? 0}${hasSchemaErrors ? ', schemaErrors=true' : ''}`);

    return { status: actualStatus, steps: result.steps ?? [], duration: result.duration ?? 0, reports, error };
    } catch (err) {
      activeRuns.delete(jobId);
      if (cancelledJobs.has(jobId)) {
        cancelledJobs.delete(jobId);
        log(`Cert run ${jobId} cancelled`);
        return { status: 'cancelled' as const, steps: [], duration: 0 };
      }
      const message = err instanceof Error ? err.message : String(err);
      log(`Cert run ${jobId} failed: ${message}`);
      return { status: 'failed' as const, error: message, steps: [], duration: 0 };
    }
  });

  /** Cancel a running cert job. */
  /** Track cancelled job IDs so we can distinguish cancellation from errors. */
  const cancelledJobs = new Set<string>();

  ipcMain.handle('cert:cancel', (_event, jobId: string) => {
    const controller = activeRuns.get(jobId);
    if (controller) {
      cancelledJobs.add(jobId);
      controller.abort();
      activeRuns.delete(jobId);
    }
  });

  /** Get the local server URL (for config builder auto-fill). */
  ipcMain.handle('cert:localServerUrl', () => state.serverUrl);

  /** Open a file in the system default application. */
  ipcMain.handle('cert:open-file', (_event, filePath: string) => {
    shell.openPath(resolve(filePath));
  });

  // ── Config manager IPC handlers ──

  const CONFIGS_DIR = resolve(certResultsRoot(), 'configs');

  const configPath = (config: Record<string, unknown>): string => {
    const providerUoi = (config.providerUoi as string) ?? '';
    const providerUsi = (config.providerUsi as string) ?? '';
    const recipientUoi = (config.recipientUoi as string) ?? '';
    if (providerUoi && recipientUoi) {
      return resolve(CONFIGS_DIR, `${providerUoi}-${providerUsi}`, recipientUoi);
    }
    // Non-cert connection — use slugified name
    const name = (config.name as string) ?? `connection-${Date.now()}`;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return resolve(CONFIGS_DIR, '_connections', slug);
  };

  /** List all saved configs by scanning the directory tree. */
  ipcMain.handle('config:list', async () => {
    try {
      if (!existsSync(CONFIGS_DIR)) return [];
      const configs: Array<Record<string, unknown>> = [];

      const scanDir = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            scanDir(resolve(dir, entry.name));
          } else if (entry.name === 'config.json') {
            try {
              const content = readFileSync(resolve(dir, entry.name), 'utf-8');
              const parsed = JSON.parse(content);
              // ID is the relative path from CONFIGS_DIR
              parsed.id = relative(CONFIGS_DIR, dir);
              configs.push(parsed);
            } catch { /* skip corrupt files */ }
          }
        }
      };

      scanDir(CONFIGS_DIR);
      return configs;
    } catch {
      return [];
    }
  });

  /** Save a config to its directory. */
  ipcMain.handle('config:save', async (_event, config: Record<string, unknown>) => {
    const dir = configPath(config);
    mkdirSync(dir, { recursive: true });
    // Strip credentials before writing to disk
    const onDisk = { ...config };
    delete onDisk.authToken;
    delete onDisk.clientSecret;
    delete onDisk.id;
    onDisk.updatedAt = new Date().toISOString();
    if (!onDisk.createdAt) onDisk.createdAt = onDisk.updatedAt;
    writeFileSync(resolve(dir, 'config.json'), JSON.stringify(onDisk, null, 2));
    // Return with ID
    return { ...onDisk, id: relative(CONFIGS_DIR, dir) };
  });

  /** Delete a config directory. */
  ipcMain.handle('config:delete', async (_event, id: string) => {
    const dir = resolve(CONFIGS_DIR, id);
    // Safety: must be inside CONFIGS_DIR
    if (!dir.startsWith(CONFIGS_DIR)) return false;
    try {
      const configFile = resolve(dir, 'config.json');
      if (existsSync(configFile)) unlinkSync(configFile);
      // Clean up empty parent directories
      const cleanEmpty = (d: string) => {
        if (d === CONFIGS_DIR || !d.startsWith(CONFIGS_DIR)) return;
        try {
          const entries = readdirSync(d);
          if (entries.length === 0) {
            readdirSync(d); // double-check
            const { rmdirSync } = require('fs');
            rmdirSync(d);
            cleanEmpty(dirname(d));
          }
        } catch { /* ignore */ }
      };
      cleanEmpty(dir);
      return true;
    } catch {
      return false;
    }
  });

  /** Import configs from a JSON array. */
  ipcMain.handle('config:import', async (_event, configs: ReadonlyArray<Record<string, unknown>>) => {
    let count = 0;
    for (const config of configs) {
      const dir = configPath(config);
      mkdirSync(dir, { recursive: true });
      const onDisk = { ...config };
      delete onDisk.authToken;
      delete onDisk.clientSecret;
      delete onDisk.id;
      onDisk.updatedAt = new Date().toISOString();
      if (!onDisk.createdAt) onDisk.createdAt = onDisk.updatedAt;
      writeFileSync(resolve(dir, 'config.json'), JSON.stringify(onDisk, null, 2));
      count++;
    }
    return count;
  });
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
            if (win?.webContents.navigationHistory.canGoBack()) win.webContents.navigationHistory.goBack();
          }
        },
        {
          label: 'Forward',
          accelerator: isMac ? 'Cmd+Right' : 'Alt+Right',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win?.webContents.navigationHistory.canGoForward()) win.webContents.navigationHistory.goForward();
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
  // Inline the logo as base64 data URI — file:// URLs are blocked inside data: pages
  let logoSrc = `file://${logoPath}`;
  try {
    const logoData = readFileSync(logoPath);
    logoSrc = `data:image/png;base64,${logoData.toString('base64')}`;
  } catch { /* fallback to file:// */ }

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
    title: `RESO Desktop Client (Beta) — DD ${getDDVersion()}`,
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

  // External schemes that should be handed off to the OS default handler
  // instead of being treated as in-app navigation. mailto: is the case the
  // Report Issue link relies on.
  const isExternalScheme = (url: string): boolean =>
    /^(https?|mailto|tel|sms):/i.test(url);

  // Prevent navigating away from the SPA (e.g., back to splash screen)
  win.webContents.on('will-navigate', (event, navUrl) => {
    // Allow navigation to the server URL (SPA root)
    if (state.serverUrl && navUrl.startsWith(state.serverUrl)) return;
    event.preventDefault();
    // Hand external links (mailto:, https:, etc.) to the OS so the user's
    // email client / browser opens. Without this, they fail silently.
    if (isExternalScheme(navUrl)) {
      shell.openExternal(navUrl);
    }
  });

  // Open external links in the system browser / email client
  win.webContents.setWindowOpenHandler(({ url: linkUrl }) => {
    if (isExternalScheme(linkUrl)) {
      shell.openExternal(linkUrl);
    }
    return { action: 'deny' };
  });

  // Safe SPA navigation helper — injected into renderer.
  // Prevents navigating back past the SPA entry point (which would show the splash screen).
  // Checks if a React Router blocker is active before navigating.
  const safeNavScript = (direction: 'back' | 'forward') => `
    (function() {
      if ('${direction}' === 'back') {
        if (window.history.length <= 1) return;
        if (window.location.pathname === '/') return;
      }
      window.history.${direction}();
    })()
  `;

  // Navigation: keyboard shortcuts (Cmd/Ctrl+[/] and Cmd/Ctrl+Arrow)
  // preventDefault stops Electron's native back/forward so only our safe script runs
  win.webContents.on('before-input-event', (event, input) => {
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    if (!mod || input.type !== 'keyDown') return;

    if (input.key === '[' || input.key === 'ArrowLeft') {
      event.preventDefault();
      win.webContents.executeJavaScript(safeNavScript('back')).catch(() => {});
    } else if (input.key === ']' || input.key === 'ArrowRight') {
      event.preventDefault();
      win.webContents.executeJavaScript(safeNavScript('forward')).catch(() => {});
    }
  });

  // Navigation: macOS swipe gestures (three-finger if configured)
  win.on('swipe', (_event, direction) => {
    if (direction === 'left') {
      win.webContents.executeJavaScript(safeNavScript('back')).catch(() => {});
    } else if (direction === 'right') {
      win.webContents.executeJavaScript(safeNavScript('forward')).catch(() => {});
    }
  });

  // Navigation: two-finger trackpad swipe (scroll-based)
  // For SPAs using React Router, we call window.history directly since
  // Electron's navigationHistory.canGoBack() doesn't track pushState navigation.
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
            if (window.history.length > 1 && window.location.pathname !== '/') window.history.back();
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
  if (jobStore) {
    jobStore.close();
    jobStore = null;
  }
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
      message: 'A new version of RESO Desktop Client (Beta) is available.',
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
      detail: `RESO Desktop Client (Beta) v${app.getVersion()}`
    });
  }
};

// App lifecycle
app.whenReady().then(async () => {
  const paths = resolvePaths();
  // Release name displayed in the About panel. Update this each release —
  // the version itself is read automatically from package.json via
  // app.getVersion() so it can never drift. See CLAUDE.md release checklist.
  const RELEASE_NAME = 'Elevenses';
  const appVersion = app.getVersion();
  app.setAboutPanelOptions({
    applicationName: 'RESO Desktop Client (Beta)',
    applicationVersion: appVersion,
    version: `v${appVersion} — ${RELEASE_NAME}`,
    copyright: '© 2026 Real Estate Standards Organization',
    credits: 'Browse, query, and manage real estate data using RESO standards.',
    website: 'https://reso.org',
    iconPath: paths.iconPath
  });

  registerStorageHandlers();
  registerLoginCredentialsHandlers();
  registerJobStoreHandlers();
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
