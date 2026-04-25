/**
 * Job Manager — orchestrates certification test runs locally.
 *
 * Converts BatchConfig from the Config Builder into ComplianceConfig
 * objects, manages a job queue with configurable concurrency, and
 * emits progress events that the UI can subscribe to.
 *
 * For local runs, the SDK's ProgressCallback maps directly to UI
 * step updates. For cloud runs, a polling mechanism will be added
 * later (post-conference).
 *
 * This module uses a simple event-bus pattern (subscribe/emit) rather
 * than React context so it can be used from both components and
 * non-React code.
 */

import type { BatchConfig, RecipientConfig, AuthConfig } from '../components/cert/config-builder';
import {
  saveConnection,
  storeCredentials,
  getCredentials,
  findConnectionByKey,
  type StoredCredentials,
} from './connection-manager';
import {
  CERT_ENDORSEMENT_LABELS,
  ENDORSEMENT_DEFAULT_VERSIONS,
  stepsForEndorsement,
} from '../constants/cert';
import type { CertEndorsement, JobStatus, StepStatus } from '../constants/cert';
import { resolveReportRef } from './report-ref';

// ── Re-export status types from shared constants ─────────────────────

export type { JobStatus, StepStatus };

// ── Electron IPC bridge (available only in the desktop client) ───────

interface LocalResult {
  readonly endorsement: string;
  readonly version: string;
  readonly providerUoi: string;
  readonly providerUsi: string;
  readonly recipientUoi: string;
  readonly path: string;
  readonly isCurrent: boolean;
  readonly timestamp: string;
  /** Map of reportKey → absolute path (local) or URL (cloud). Renderer resolves on demand via report-ref service. */
  readonly reports: Record<string, string>;
}

interface CertRunnerAPI {
  readonly run: (jobId: string, config: Record<string, unknown>) => Promise<{
    status: 'passed' | 'failed';
    steps?: ReadonlyArray<{ name: string; status: string; duration?: number; summary?: string; errors?: ReadonlyArray<string>; requestDetails?: ReadonlyArray<{ method: string; url: string; status?: number; error?: string; responseBody?: string }>; artifacts?: ReadonlyArray<{ label: string; path: string }> }>;
    duration: number;
    error?: string;
    reports?: Record<string, string>;
  }>;
  readonly cancel: (jobId: string) => Promise<void>;
  readonly onProgress: (callback: (jobId: string, progress: { step: string; status: string; message?: string; duration?: number }) => void) => () => void;
  readonly localServerUrl: () => Promise<string | null>;
  readonly scanResults: () => Promise<ReadonlyArray<LocalResult>>;
  readonly deleteResult: (resultPath: string) => Promise<boolean>;
}

const getCertRunner = (): CertRunnerAPI | undefined =>
  (window as unknown as Record<string, unknown>).certRunner as CertRunnerAPI | undefined;

const isElectron = (): boolean => getCertRunner() !== undefined;

// ── Secure storage for configs (Electron only) ──────────────────────

interface ElectronStorage {
  readonly get: (key: string) => Promise<string | null>;
  readonly set: (key: string, value: string) => Promise<void>;
  readonly remove: (key: string) => Promise<void>;
}

const getElectronStorage = (): ElectronStorage | undefined =>
  (window as unknown as Record<string, unknown>).electronStorage as ElectronStorage | undefined;

// ── SQLite job store (Electron only, exposed via IPC) ─────────────

interface JobStoreAPI {
  readonly createJob: (job: Omit<Job, 'steps'>) => Promise<Job>;
  readonly updateJobStatus: (id: string, patch: {
    readonly status?: JobStatus;
    readonly startedAt?: string;
    readonly completedAt?: string;
    readonly error?: string;
    readonly reports?: Record<string, string>;
    readonly resultPath?: string;
    readonly variationsReviewSubmittedAt?: string;
  }) => Promise<Job | undefined>;
  readonly upsertStep: (jobId: string, step: JobStep & { readonly sortOrder: number }) => Promise<unknown>;
  readonly getJob: (id: string) => Promise<Job | undefined>;
  readonly getJobs: (filter?: Record<string, unknown>) => Promise<ReadonlyArray<Job>>;
  readonly deleteJob: (id: string) => Promise<boolean>;
  readonly clearCompleted: () => Promise<number>;
}

const getJobStore = (): JobStoreAPI | undefined =>
  (window as unknown as Record<string, unknown>).jobStore as JobStoreAPI | undefined;

/** Load an individual job's SDK config from secure storage. */
const loadJobConfigFromStorage = async (job: Job): Promise<Record<string, unknown> | null> => {
  const storage = getElectronStorage();
  if (!storage) return null;
  const key = `cert:jobConfig:${job.providerUoi}:${job.recipientUoi}:${job.endorsementKey}`;
  const raw = await storage.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw) as Record<string, unknown>; }
  catch { return null; }
};

export interface JobStep {
  readonly name: string;
  readonly status: StepStatus;
  readonly duration?: number;
  /** Epoch ms when this step first transitioned to "running". Monotonic source of truth for the live timer. */
  readonly startedAt?: number;
  readonly detail?: string;
  readonly requestDetails?: ReadonlyArray<{
    readonly method: string;
    readonly url: string;
    readonly status?: number;
    readonly error?: string;
    readonly responseBody?: string;
  }>;
  readonly artifacts?: ReadonlyArray<{ readonly label: string; readonly path: string }>;
}

export interface Job {
  readonly id: string;
  readonly endorsement: string;
  readonly endorsementKey: string;
  readonly version: string;
  readonly recipientUoi: string;
  readonly recipientName: string;
  readonly providerUoi: string;
  readonly providerUsi: string;
  readonly status: JobStatus;
  readonly steps: ReadonlyArray<JobStep>;
  readonly queuedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly local: boolean;
  readonly error?: string;
  /** SDK config for this job — used by the Electron cert runner. */
  readonly sdkConfig?: Record<string, unknown>;
  /** Report data returned from a completed run (schema errors, variations, metadata). */
  readonly reports?: Record<string, string>;
  /** Local filesystem path for disk-hydrated jobs. Used for deletion. */
  readonly resultPath?: string;
  /**
   * ISO timestamp when the provider explicitly submitted variations from
   * this job for review. Undefined while variations are still local-only.
   * Drives the "Start Variations Review" vs "Review Variations" button
   * label so the provider can iterate before going public.
   */
  readonly variationsReviewSubmittedAt?: string;
}

export type JobEvent =
  | { readonly type: 'job-queued'; readonly job: Job }
  | { readonly type: 'job-started'; readonly jobId: string }
  | { readonly type: 'step-progress'; readonly jobId: string; readonly step: string; readonly status: StepStatus; readonly detail?: string; readonly duration?: number }
  | { readonly type: 'job-completed'; readonly jobId: string; readonly status: 'passed' | 'failed'; readonly error?: string }
  | { readonly type: 'job-cancelled'; readonly jobId: string }
  | { readonly type: 'queue-complete' };

type JobEventListener = (event: JobEvent) => void;

// ── Endorsement labels and versions from shared constants ────────────

// ── Job Manager ──────────────────────────────────────────────────────

// ── Job persistence ──────────────────────────────────────────────────

const JOBS_STORAGE_KEY = 'cert-jobs';

/** Load jobs from localStorage (fallback when SQLite is unavailable). */
const loadPersistedJobsFromLocalStorage = (): Map<string, Job> => {
  try {
    const raw = localStorage.getItem(JOBS_STORAGE_KEY);
    if (!raw) return new Map();
    const entries = JSON.parse(raw) as ReadonlyArray<[string, Job]>;
    return new Map(entries);
  } catch {
    return new Map();
  }
};

/** Persist to localStorage (fallback when SQLite is unavailable). */
const persistJobsToLocalStorage = (jobs: Map<string, Job>): void => {
  try {
    const durable = [...jobs.entries()].filter(([, j]) =>
      j.status === 'passed' || j.status === 'failed' || j.status === 'cancelled'
    );
    localStorage.setItem(JOBS_STORAGE_KEY, JSON.stringify(durable));
  } catch { /* localStorage may be full or unavailable */ }
};

/** In-memory job store and event bus for the current session. */
const state = {
  jobs: loadPersistedJobsFromLocalStorage(),
  listeners: new Set<JobEventListener>(),
  running: false,
};

/** Ephemeral state for sub-step debouncing and elapsed time tracking. */
const subStepState: Record<string, unknown> = {};

/** Subscribe to job events. Returns an unsubscribe function. */
export const subscribe = (listener: JobEventListener): (() => void) => {
  state.listeners.add(listener);
  return () => { state.listeners.delete(listener); };
};

const emit = (event: JobEvent): void => {
  for (const listener of state.listeners) {
    try { listener(event); } catch { /* listeners should not throw */ }
  }
};

const updateJob = (id: string, patch: Partial<Job>): void => {
  const existing = state.jobs.get(id);
  if (!existing) return;
  const updated = { ...existing, ...patch } as Job;
  state.jobs.set(id, updated);

  // Write through to SQLite when available, localStorage as fallback
  const store = getJobStore();
  if (store) {
    // Persist status changes to SQLite
    if (patch.status || patch.startedAt || patch.completedAt || patch.error || patch.reports || patch.resultPath || patch.variationsReviewSubmittedAt) {
      store.updateJobStatus(id, {
        status: patch.status,
        startedAt: patch.startedAt,
        completedAt: patch.completedAt,
        error: patch.error,
        reports: patch.reports,
        resultPath: patch.resultPath,
        variationsReviewSubmittedAt: patch.variationsReviewSubmittedAt,
      }).catch(() => {});
    }
    // Persist step updates to SQLite
    if (patch.steps) {
      for (let i = 0; i < patch.steps.length; i++) {
        const step = patch.steps[i];
        store.upsertStep(id, { ...step, sortOrder: i }).catch(() => {});
      }
    }
  } else if (updated.status === 'passed' || updated.status === 'failed' || updated.status === 'cancelled') {
    persistJobsToLocalStorage(state.jobs);
  }
};

/** Get a snapshot of all jobs (most recent first). */
export const getJobs = (): ReadonlyArray<Job> =>
  Array.from(state.jobs.values()).sort((a, b) =>
    new Date(b.queuedAt).getTime() - new Date(a.queuedAt).getTime()
  );

/** Get a single job by ID. */
export const getJob = (id: string): Job | undefined => state.jobs.get(id);

/**
 * Mark a job's variations as submitted for review. Called after a
 * successful saveVariationsReview() so the "Start Variations Review"
 * button on the job card flips to "Review Variations" and the
 * provider knows the submission landed. Stores an ISO timestamp; the
 * presence of the field is the gate, the timestamp is for audit.
 *
 * Idempotent — calling twice keeps the original timestamp (we record
 * the FIRST submission, not the most recent re-save). Subsequent
 * saves are edits, not new submissions.
 */
export const markVariationsReviewSubmitted = (id: string): void => {
  const job = state.jobs.get(id);
  if (!job) return;
  if (job.variationsReviewSubmittedAt) return;
  updateJob(id, { variationsReviewSubmittedAt: new Date().toISOString() });
};

/** Cancel a queued or running job. */
export const cancelJob = (id: string): void => {
  const job = state.jobs.get(id);
  if (!job || job.status === 'passed' || job.status === 'failed') return;
  updateJob(id, { status: 'cancelled', completedAt: new Date().toISOString() });
  emit({ type: 'job-cancelled', jobId: id });
  // Also cancel in the main process if running in Electron
  const runner = getCertRunner();
  if (runner) runner.cancel(id);
};

// ── Build SDK ComplianceConfig from UI config ────────────────────────

/** Normalize a URL — removes trailing slashes, resolves path segments. */
const normalizeUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString();
  } catch {
    return url;
  }
};

const buildAuthConfig = (auth: AuthConfig): Record<string, unknown> =>
  auth.mode === 'token'
    ? { mode: 'token', authToken: auth.authToken }
    : { mode: 'client_credentials', clientId: auth.clientId, clientSecret: auth.clientSecret, tokenUrl: normalizeUrl(auth.tokenUrl), scope: auth.scope };

const buildSDKConfig = (recipient: RecipientConfig, endorsement: CertEndorsement, providerUoi: string): Record<string, unknown> => {
  const base = {
    server: {
      // 'LOCAL_SERVER' is a sentinel value — the Electron main process
      // will replace it with the actual local server URL at runtime.
      url: normalizeUrl(recipient.serviceRootUri || 'LOCAL_SERVER'),
      auth: buildAuthConfig(recipient.auth),
    },
    options: { verbose: false },
    providerUoi,
    providerUsi: recipient.providerUsi,
    recipientUoi: recipient.recipientUoi,
  };

  switch (endorsement) {
    case 'dd':
      return {
        ...base,
        options: { ...base.options },
        endorsement: 'dd',
        version: recipient.ddOptions.version,
        limit: recipient.ddOptions.limit,
        strictMode: recipient.ddOptions.strictMode,
        batchExpand: recipient.ddOptions.batchExpand,
        requestDelay: recipient.ddOptions.requestDelay,
        rateLimitWait: recipient.ddOptions.rateLimitWait,
        providerUoi,
        providerUsi: recipient.providerUsi,
        recipientUoi: recipient.recipientUoi,
      };
    case 'core':
      return {
        ...base,
        endorsement: 'core',
        version: recipient.coreOptions.version,
        resources: recipient.coreOptions.resources?.split(',').map(r => r.trim()).filter(Boolean),
        enumMode: recipient.coreOptions.enumMode,
        fullCoverage: recipient.coreOptions.fullCoverage,
      };
    case 'add-edit':
      return {
        ...base,
        endorsement: 'add-edit',
        resource: recipient.addEditOptions.resource,
        payloadsDir: recipient.addEditOptions.payloadsDir,
        specVersion: recipient.addEditOptions.specVersion,
      };
    case 'entity-event':
      return {
        ...base,
        endorsement: 'entity-event',
        mode: recipient.entityEventOptions.mode,
        writableResource: recipient.entityEventOptions.writableResource,
        maxEvents: recipient.entityEventOptions.maxEvents,
        pollInterval: recipient.entityEventOptions.pollInterval,
        pollTimeout: recipient.entityEventOptions.pollTimeout,
      };
  }
};

// ── Expand BatchConfig into individual jobs ──────────────────────────

const expandBatchConfig = (config: BatchConfig): ReadonlyArray<Job> =>
  config.recipients.flatMap(recipient =>
    recipient.endorsements.map(endorsement => ({
      id: crypto.randomUUID(),
      endorsement: CERT_ENDORSEMENT_LABELS[endorsement as keyof typeof CERT_ENDORSEMENT_LABELS] ?? endorsement,
      endorsementKey: endorsement,
      version: endorsement === 'dd'
        ? recipient.ddOptions.version
        : endorsement === 'core'
        ? (recipient.coreOptions.version ?? ENDORSEMENT_DEFAULT_VERSIONS[endorsement as keyof typeof ENDORSEMENT_DEFAULT_VERSIONS])
        : ENDORSEMENT_DEFAULT_VERSIONS[endorsement as keyof typeof ENDORSEMENT_DEFAULT_VERSIONS],
      recipientUoi: recipient.recipientUoi,
      recipientName: recipient.description || recipient.recipientUoi,
      providerUoi: config.providerUoi,
      providerUsi: recipient.providerUsi,
      status: 'queued' as const,
      steps: [],
      queuedAt: new Date().toISOString(),
      local: true,
      sdkConfig: buildSDKConfig(recipient, endorsement, config.providerUoi),
    }))
  );

// ── Run a single job ─────────────────────────────────────────────────

/**
 * Run via Electron IPC — the main process imports the SDK and streams
 * progress events back through the preload bridge.
 */
const runJobElectron = async (job: Job): Promise<void> => {
  const runner = getCertRunner()!;
  const steps = stepsForEndorsement(job.endorsement);
  const initialSteps: ReadonlyArray<JobStep> = steps.map(name => ({ name, status: 'pending' }));
  updateJob(job.id, {
    status: 'running',
    startedAt: new Date().toISOString(),
    steps: initialSteps,
  });
  emit({ type: 'job-started', jobId: job.id });

  // Subscribe to progress events from the main process
  const unsubscribe = runner.onProgress((jobId, progress) => {
    if (jobId !== job.id) return;

    const stepStatus = progress.status as StepStatus;

    // Sub-step events update the currently running parent step's detail text.
    // Duration is not derived here — the UI's live timer reads step.startedAt directly.
    if (progress.step.startsWith('sub:')) {
      const current = state.jobs.get(jobId);
      if (!current) return;
      const runningParent = current.steps.find(s => s.status === 'running');
      if (runningParent && progress.message) {
        const updatedSteps = current.steps.map(s =>
          s.name === runningParent.name ? { ...s, detail: progress.message } : s
        );
        updateJob(jobId, { steps: updatedSteps });

        // Debounce UI updates at 50ms
        const debounceKey = `${jobId}:${runningParent.name}`;
        if (!subStepState[debounceKey]) {
          subStepState[debounceKey] = true;
          setTimeout(() => {
            subStepState[debounceKey] = false;
            emit({ type: 'step-progress', jobId, step: runningParent.name, status: 'running', detail: progress.message });
          }, 50);
        }
      }
      return;
    }

    emit({ type: 'step-progress', jobId, step: progress.step, status: stepStatus, detail: progress.message, duration: progress.duration });

    // Update the step in our local state — add dynamically if not in the predefined list.
    const current = state.jobs.get(jobId);
    if (!current) return;
    const now = Date.now();
    const exists = current.steps.some(s => s.name === progress.step);
    const baseSteps = exists
      ? current.steps.map(s => {
          if (s.name !== progress.step) return s;
          // Capture startedAt the first time a step enters "running" — authoritative for live timer.
          const startedAt = stepStatus === 'running' && s.startedAt == null ? now : s.startedAt;
          // On terminal transitions, prefer the pipeline's reported duration, otherwise derive from startedAt.
          const resolvedDuration = stepStatus === 'running'
            ? s.duration
            : (progress.duration ?? (startedAt != null ? now - startedAt : undefined));
          return { ...s, status: stepStatus, duration: resolvedDuration, startedAt, detail: progress.message };
        })
      : [...current.steps, {
          name: progress.step,
          status: stepStatus,
          duration: progress.duration,
          startedAt: stepStatus === 'running' ? now : undefined,
          detail: progress.message,
        }];

    // Auto-close straggling "running" steps when a new one starts (IPC reordering guard).
    // Duration is derived from each step's own startedAt so it stays monotonic — no bounce.
    const updatedSteps = stepStatus === 'running'
      ? baseSteps.map(s => {
          if (s.name === progress.step || s.status !== 'running') return s;
          const derivedDuration = s.startedAt != null ? now - s.startedAt : s.duration;
          return { ...s, status: 'passed' as StepStatus, duration: derivedDuration };
        })
      : baseSteps;

    updateJob(jobId, { steps: updatedSteps });
  });

  try {
    const result = await runner.run(job.id, job.sdkConfig ?? {});

    // Map SDK step results to our format
    const finalSteps: ReadonlyArray<JobStep> = result.steps
      ? result.steps.map(s => ({
          name: s.name,
          status: s.status as StepStatus,
          duration: s.duration,
          detail: [s.summary, s.errors?.join('; ')].filter(Boolean).join(' \u2014 '),
          requestDetails: s.requestDetails as JobStep['requestDetails'],
          artifacts: s.artifacts as JobStep['artifacts'],
        }))
      : initialSteps.map(s => ({ ...s, status: result.status === 'passed' ? 'passed' as const : 'skipped' as const }));

    // Cross-check: if any step failed, the job failed — don't trust the SDK status alone
    const hasFailedStep = finalSteps.some(s => s.status === 'failed');
    const finalStatus = hasFailedStep ? 'failed' : result.status;
    const finalError = hasFailedStep && !result.error
      ? `Failed at: ${finalSteps.find(s => s.status === 'failed')?.name}`
      : result.error;

    updateJob(job.id, {
      status: finalStatus,
      completedAt: new Date().toISOString(),
      steps: finalSteps,
      error: finalError,
      reports: result.reports,
    });
    emit({ type: 'job-completed', jobId: job.id, status: finalStatus, error: finalError });
  } catch (err) {
    updateJob(job.id, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    });
    emit({ type: 'job-completed', jobId: job.id, status: 'failed', error: String(err) });
  } finally {
    unsubscribe();
  }
};

/**
 * Simulated run — used in the browser (non-Electron) for demo/testing.
 */
const runJobSimulated = async (job: Job): Promise<void> => {
  const steps = stepsForEndorsement(job.endorsement);
  const initialSteps: ReadonlyArray<JobStep> = steps.map(name => ({ name, status: 'pending' }));

  updateJob(job.id, {
    status: 'running',
    startedAt: new Date().toISOString(),
    steps: initialSteps,
  });
  emit({ type: 'job-started', jobId: job.id });

  let failedStep: string | undefined;

  for (let i = 0; i < steps.length; i++) {
    const current = state.jobs.get(job.id);
    if (!current || current.status === 'cancelled') return;

    const runningSteps = initialSteps.map((s, si) =>
      si === i ? { ...s, status: 'running' as const } :
      si < i ? { ...s, status: (failedStep ? 'skipped' : 'passed') as StepStatus } :
      s
    );
    updateJob(job.id, { steps: runningSteps });
    emit({ type: 'step-progress', jobId: job.id, step: steps[i], status: 'running' });

    const duration = 200 + Math.floor(Math.random() * 1300);
    await new Promise(resolve => setTimeout(resolve, Math.min(duration, 500)));

    const failed = !failedStep && i > 1 && Math.random() < 0.1;
    if (failed) failedStep = steps[i];

    const stepStatus: StepStatus = failedStep === steps[i] ? 'failed' : failedStep ? 'skipped' : 'passed';
    emit({ type: 'step-progress', jobId: job.id, step: steps[i], status: stepStatus, duration });
  }

  const finalSteps = initialSteps.map(s => {
    if (failedStep && s.name === failedStep) return { ...s, status: 'failed' as const };
    if (failedStep && steps.indexOf(s.name) > steps.indexOf(failedStep)) return { ...s, status: 'skipped' as const };
    return { ...s, status: 'passed' as const };
  });

  const finalStatus = failedStep ? 'failed' : 'passed';
  updateJob(job.id, {
    status: finalStatus,
    completedAt: new Date().toISOString(),
    steps: finalSteps,
    error: failedStep ? `Failed at: ${failedStep}` : undefined,
  });
  emit({ type: 'job-completed', jobId: job.id, status: finalStatus, error: failedStep });
};

/** Route to real SDK (Electron) or simulation (browser). */
const runJob = (job: Job): Promise<void> =>
  isElectron() ? runJobElectron(job) : runJobSimulated(job);

// ── Queue runner ─────────────────────────────────────────────────────

const runQueue = async (concurrency: number): Promise<void> => {
  if (state.running) return;
  state.running = true;

  const queued = Array.from(state.jobs.values()).filter(j => j.status === 'queued');
  const active = new Set<Promise<void>>();

  for (const job of queued) {
    if (active.size >= concurrency) {
      await Promise.race(active);
    }

    const current = state.jobs.get(job.id);
    if (!current || current.status === 'cancelled') continue;

    const promise = runJob(job).then(() => { active.delete(promise); });
    active.add(promise);
  }

  await Promise.all(active);
  state.running = false;
  emit({ type: 'queue-complete' });
};

// ── Credential auto-save ─────────────────────────────────────────────

/** Save connection + credentials from a batch config's recipients. */
const autoSaveConnections = async (config: BatchConfig): Promise<void> => {
  for (const recipient of config.recipients) {
    if (!recipient.serviceRootUri) continue;

    const url = normalizeUrl(recipient.serviceRootUri);
    const authMode = recipient.auth.mode;
    const clientId = authMode === 'client_credentials' ? recipient.auth.clientId : undefined;
    const originatingSystemName = authMode === 'token' ? (recipient.description || undefined) : undefined;

    const conn = await saveConnection({
      name: recipient.description || url,
      url,
      authMode,
      clientId,
      tokenUrl: authMode === 'client_credentials' ? normalizeUrl(recipient.auth.tokenUrl) : undefined,
      scope: authMode === 'client_credentials' ? recipient.auth.scope : undefined,
      originatingSystemName,
    });

    const creds: StoredCredentials = authMode === 'token'
      ? { authToken: recipient.auth.authToken }
      : { clientSecret: recipient.auth.clientSecret };
    if (creds.authToken || creds.clientSecret) {
      await storeCredentials(conn.id, creds);
    }
  }
};

/** Check if credentials differ from what's saved for a recipient. */
export const detectCredentialChanges = async (recipients: ReadonlyArray<RecipientConfig>): Promise<ReadonlyArray<{ recipientIndex: number; url: string }>> => {
  const changes: { recipientIndex: number; url: string }[] = [];

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    if (!r.serviceRootUri) continue;

    const url = normalizeUrl(r.serviceRootUri);
    const existing = await findConnectionByKey(
      url,
      r.auth.mode,
      r.auth.mode === 'client_credentials' ? r.auth.clientId : undefined,
      r.auth.mode === 'token' ? r.description : undefined
    );
    if (!existing) continue;

    const creds = await getCredentials(existing.id);
    if (!creds) continue;

    const changed = r.auth.mode === 'token'
      ? creds.authToken !== r.auth.authToken
      : creds.clientSecret !== r.auth.clientSecret;

    if (changed) changes.push({ recipientIndex: i, url });
  }

  return changes;
};

// ── Public API ───────────────────────────────────────────────────────

/** Enqueue jobs from a BatchConfig and start processing. */
export const startBatch = (config: BatchConfig, skipAutoSave = false): ReadonlyArray<Job> => {
  const jobs = expandBatchConfig(config);
  const store = getJobStore();
  for (const job of jobs) {
    state.jobs.set(job.id, job);
    // Persist to SQLite immediately so the job survives crashes/restarts
    if (store) store.createJob(job).catch(() => {});
    emit({ type: 'job-queued', job });
  }

  // Auto-save connections (fire-and-forget, don't block job start)
  if (!skipAutoSave) {
    autoSaveConnections(config).catch(() => {});
  }

  // Start the queue (non-blocking)
  runQueue(config.concurrency);

  return jobs;
};

/** Rebuild an SDK config from job metadata when the original wasn't stored. */
const rebuildSDKConfig = async (job: Job): Promise<Record<string, unknown>> => {
  // Try loading from secure storage first (saved on previous run)
  const stored = await loadJobConfigFromStorage(job);
  if (stored) return stored;

  // Cannot rebuild without the original config — the server URL, auth, and
  // test parameters are lost. Return a config that will fail clearly rather
  // than silently running against the wrong server.
  throw new Error(
    'Cannot re-run this job — the original configuration was not saved. ' +
    'Please create a new test run with the correct server URL and credentials.'
  );
};

/** Re-run a completed job by creating a new job with the same config. */
export const rerunJob = async (id: string): Promise<Job | undefined> => {
  const original = state.jobs.get(id);
  if (!original) return undefined;

  const sdkConfig = original.sdkConfig ?? await rebuildSDKConfig(original);

  const newJob: Job = {
    ...original,
    id: crypto.randomUUID(),
    status: 'queued',
    steps: [],
    queuedAt: new Date().toISOString(),
    startedAt: undefined,
    completedAt: undefined,
    error: undefined,
    reports: undefined,
    sdkConfig,
  };

  state.jobs.set(newJob.id, newJob);
  const store = getJobStore();
  if (store) store.createJob(newJob).catch(() => {});
  emit({ type: 'job-queued', job: newJob });

  // Run immediately
  runJob(newJob);

  return newJob;
};

/** Delete a local result from disk and remove from the job store. */
export const deleteJob = async (id: string): Promise<boolean> => {
  const job = state.jobs.get(id);
  if (!job) return false;

  // If it has a result path, delete the directory on disk
  if (job.resultPath) {
    const runner = getCertRunner();
    if (runner) {
      const success = await runner.deleteResult(job.resultPath);
      if (!success) return false;
    }
  }

  state.jobs.delete(id);
  const store = getJobStore();
  if (store) store.deleteJob(id).catch(() => {});
  else persistJobsToLocalStorage(state.jobs);
  emit({ type: 'job-cancelled', jobId: id });
  return true;
};

/** Delete ALL local results from disk and clear the job store. */
export const deleteAllLocal = async (): Promise<void> => {
  const runner = getCertRunner();

  if (runner) {
    // Delete all individual result directories
    const localJobs = Array.from(state.jobs.values()).filter(j => j.resultPath);
    for (const job of localJobs) {
      if (job.resultPath) await runner.deleteResult(job.resultPath);
    }
    // Also delete the root .reso-cert directory to clean up empty parent dirs
    await runner.deleteResult('__ALL__');
  }

  // Clear all local jobs from memory and SQLite
  const store = getJobStore();
  for (const [id, job] of state.jobs) {
    if (job.local) {
      state.jobs.delete(id);
      if (store) store.deleteJob(id).catch(() => {});
    }
  }

  emit({ type: 'queue-complete' });
};

/** Clear all completed/cancelled jobs from the store. */
export const clearCompleted = (): void => {
  const store = getJobStore();
  for (const [id, job] of state.jobs) {
    if (job.status === 'passed' || job.status === 'failed' || job.status === 'cancelled') {
      state.jobs.delete(id);
      if (store) store.deleteJob(id).catch(() => {});
    }
  }
};

// ── Local results hydration (Electron only) ──────────────────────────

/** Convert a scanned LocalResult into a Job for the UI. Resolves reportDetailed ref to hydrate steps. */
const localResultToJob = async (result: LocalResult): Promise<Job> => {
  const hasSchemaErrors = result.reports.schemaErrors !== undefined;
  // Check detailed report outcome for non-DD endorsements (Core, Add/Edit, EntityEvent)
  let detailedReport: Record<string, unknown> | undefined;
  if (result.reports.reportDetailed) {
    try {
      detailedReport = await resolveReportRef(result.reports.reportDetailed) as Record<string, unknown>;
    } catch {
      // File missing or unreadable — proceed without detailed info.
    }
  }
  const detailedOutcome = detailedReport?.outcome as string | undefined;
  const failed = hasSchemaErrors || detailedOutcome === 'failed';

  // Hydrate steps from the detailed report when available
  const detailedSteps = (detailedReport?.steps ?? []) as ReadonlyArray<Record<string, unknown>>;
  const hydratedSteps: ReadonlyArray<JobStep> = detailedSteps.map(s => {
    const summary = s.summary as string | undefined;
    const counts = s.counts as Record<string, number> | undefined;

    // Enrich summary with counts when present
    const countParts: ReadonlyArray<string> = counts
      ? Object.entries(counts)
          .filter(([key]) => !['total'].includes(key))
          .map(([key, val]) => `${val.toLocaleString()} ${key}`)
      : [];
    const detail = countParts.length > 0 && !summary?.includes(String(countParts[0]))
      ? [summary, countParts.join(', ')].filter(Boolean).join(' · ')
      : summary;

    return {
      name: (s.name as string) ?? 'Unknown',
      status: (s.status as StepStatus) ?? 'passed',
      duration: s.duration as number | undefined,
      detail,
    };
  });

  return {
    id: `local-${result.path.replace(/[^a-zA-Z0-9]/g, '-')}`,
    endorsement: result.endorsement,
    endorsementKey: Object.entries(CERT_ENDORSEMENT_LABELS).find(([, label]) => label === result.endorsement)?.[0] ?? 'dd',
    version: result.version,
    recipientUoi: result.recipientUoi,
    recipientName: `${result.recipientUoi}${result.isCurrent ? '' : ' (archived)'}`,
    providerUoi: result.providerUoi,
    providerUsi: result.providerUsi,
    status: failed ? 'failed' : 'passed',
    steps: hydratedSteps,
    queuedAt: result.timestamp,
    completedAt: result.timestamp,
    local: true,
    error: hasSchemaErrors ? 'Schema validation errors found'
      : detailedOutcome === 'failed' ? 'Test scenarios failed. See the failure report for details.'
      : undefined,
    reports: result.reports,
    resultPath: result.path,
  };
};

const MAX_ARCHIVED_PER_RECIPIENT = 5;

/** Hydrate the job list from local results on disk. */
const hydrateFromLocal = async (results: ReadonlyArray<LocalResult>): Promise<void> => {
  // Sort: current first, then archived by most recent
  const sorted = [...results].sort((a, b) => {
    if (a.isCurrent && !b.isCurrent) return -1;
    if (!a.isCurrent && b.isCurrent) return 1;
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  const archivedCounts = new Map<string, number>();

  for (const result of sorted) {
    if (!result.isCurrent) {
      const archiveKey = `${result.providerUoi}:${result.providerUsi}:${result.recipientUoi}`;
      const count = archivedCounts.get(archiveKey) ?? 0;
      if (count >= MAX_ARCHIVED_PER_RECIPIENT) continue;
      archivedCounts.set(archiveKey, count + 1);
    }

    const job = await localResultToJob(result);
    if (!state.jobs.has(job.id)) {
      state.jobs.set(job.id, job);
    }
  }
};

/**
 * Initialize local results — loads from SQLite when available,
 * with a one-time migration from localStorage and .reso-cert/ filesystem.
 * Called once on app startup from the useJobs hook.
 */
let initialized = false;

export const initLocalResults = async (): Promise<void> => {
  if (initialized) return;
  initialized = true;

  const store = getJobStore();

  if (store) {
    // ── SQLite path (Electron) ────────────────────────────────────
    const existing = await store.getJobs();

    // One-time migration from localStorage → SQLite
    const localStorageData = localStorage.getItem(JOBS_STORAGE_KEY);
    if (localStorageData) {
      try {
        const entries = JSON.parse(localStorageData) as ReadonlyArray<[string, Job]>;
        for (const [, job] of entries) {
          // Skip if already in SQLite (by ID)
          if (!existing.some(e => e.id === job.id)) {
            await store.createJob(job);
          }
        }
      } catch { /* corrupt localStorage data */ }
      localStorage.removeItem(JOBS_STORAGE_KEY);
    }

    // One-time migration from .reso-cert/ filesystem → SQLite
    if (existing.length === 0) {
      const runner = getCertRunner();
      if (runner) {
        const results = await runner.scanResults();
        for (const result of results) {
          const job = await localResultToJob(result);
          await store.createJob(job);
        }
      }
    }

    // Normalize legacy blob-shaped reports to refs. Pre-refactor rows stored parsed JSON
    // in the `reports` column; the new schema stores absolute paths (or URLs). Convert
    // in place so the rest of the app sees a single shape.
    const allJobsPreMigration = await store.getJobs();
    const runner = getCertRunner();
    for (const job of allJobsPreMigration) {
      if (!job.reports) continue;
      const hasBlobs = Object.values(job.reports).some(v => typeof v !== 'string');
      if (!hasBlobs) continue;

      // Try to rebuild refs from the on-disk result directory. If the directory exists,
      // listReportFiles returns the canonical refs. If not, clear reports.
      let rebuilt: Record<string, string> | null = null;
      if (runner && job.resultPath) {
        try {
          rebuilt = await (runner as unknown as { listReportFiles?: (dir: string) => Promise<Record<string, string>> })
            .listReportFiles?.(job.resultPath) ?? null;
        } catch { rebuilt = null; }
      }
      await store.updateJobStatus(job.id, { reports: rebuilt ?? {} });
    }

    // Load all jobs from SQLite into the in-memory cache
    const allJobs = await store.getJobs();
    for (const job of allJobs) {
      state.jobs.set(job.id, job);
    }
  } else {
    // ── localStorage fallback (browser mode) ──────────────────────
    const runner = getCertRunner();
    if (runner) {
      const results = await runner.scanResults();
      await hydrateFromLocal(results);
    }
  }

  emit({ type: 'queue-complete' });
};
