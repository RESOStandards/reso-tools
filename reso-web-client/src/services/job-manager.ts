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
  CERT_ENDORSEMENT_LABELS,
  ENDORSEMENT_DEFAULT_VERSIONS,
  stepsForEndorsement,
} from '../constants/cert';
import type { CertEndorsement, JobStatus, StepStatus } from '../constants/cert';

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
  readonly reports: Record<string, unknown>;
}

interface CertRunnerAPI {
  readonly run: (jobId: string, config: Record<string, unknown>) => Promise<{
    status: 'passed' | 'failed';
    steps?: ReadonlyArray<{ name: string; status: string; duration?: number; summary?: string; errors?: ReadonlyArray<string> }>;
    duration: number;
    error?: string;
    reports?: Record<string, unknown>;
  }>;
  readonly cancel: (jobId: string) => Promise<void>;
  readonly onProgress: (callback: (jobId: string, progress: { step: string; status: string; message?: string; duration?: number }) => void) => () => void;
  readonly localServerUrl: () => Promise<string | null>;
  readonly scanResults: () => Promise<ReadonlyArray<LocalResult>>;
  readonly startWatcher: () => Promise<void>;
  readonly onResultsChanged: (callback: (results: ReadonlyArray<LocalResult>) => void) => () => void;
}

const getCertRunner = (): CertRunnerAPI | undefined =>
  (window as unknown as Record<string, unknown>).certRunner as CertRunnerAPI | undefined;

const isElectron = (): boolean => getCertRunner() !== undefined;

export interface JobStep {
  readonly name: string;
  readonly status: StepStatus;
  readonly duration?: number;
  readonly detail?: string;
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
  readonly reports?: Record<string, unknown>;
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

/** In-memory job store and event bus for the current session. */
const state = {
  jobs: new Map<string, Job>(),
  listeners: new Set<JobEventListener>(),
  running: false,
};

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
};

/** Get a snapshot of all jobs (most recent first). */
export const getJobs = (): ReadonlyArray<Job> =>
  Array.from(state.jobs.values()).sort((a, b) =>
    new Date(b.queuedAt).getTime() - new Date(a.queuedAt).getTime()
  );

/** Get a single job by ID. */
export const getJob = (id: string): Job | undefined => state.jobs.get(id);

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

const buildAuthConfig = (auth: AuthConfig): Record<string, unknown> =>
  auth.mode === 'token'
    ? { mode: 'token', authToken: auth.authToken }
    : { mode: 'client_credentials', clientId: auth.clientId, clientSecret: auth.clientSecret, tokenUrl: auth.tokenUrl };

const buildSDKConfig = (recipient: RecipientConfig, endorsement: CertEndorsement, providerUoi: string): Record<string, unknown> => {
  const base = {
    server: {
      // 'LOCAL_SERVER' is a sentinel value — the Electron main process
      // will replace it with the actual local server URL at runtime.
      url: recipient.serviceRootUri || 'LOCAL_SERVER',
      auth: buildAuthConfig(recipient.auth),
    },
    options: { verbose: false },
  };

  switch (endorsement) {
    case 'dd':
      return {
        ...base,
        endorsement: 'dd',
        version: recipient.ddOptions.version,
        limit: recipient.ddOptions.limit,
        strictMode: recipient.ddOptions.strictMode,
        batchExpand: recipient.ddOptions.batchExpand,
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
    emit({ type: 'step-progress', jobId, step: progress.step, status: stepStatus, detail: progress.message, duration: progress.duration });

    // Update the step in our local state
    const current = state.jobs.get(jobId);
    if (!current) return;
    const updatedSteps = current.steps.map(s =>
      s.name === progress.step ? { ...s, status: stepStatus, duration: progress.duration, detail: progress.message } : s
    );
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
          detail: s.summary ?? s.errors?.join('; '),
        }))
      : initialSteps.map(s => ({ ...s, status: result.status === 'passed' ? 'passed' as const : 'skipped' as const }));

    updateJob(job.id, {
      status: result.status,
      completedAt: new Date().toISOString(),
      steps: finalSteps,
      error: result.error,
      reports: result.reports,
    });
    emit({ type: 'job-completed', jobId: job.id, status: result.status, error: result.error });
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

// ── Public API ───────────────────────────────────────────────────────

/** Enqueue jobs from a BatchConfig and start processing. */
export const startBatch = (config: BatchConfig): ReadonlyArray<Job> => {
  const jobs = expandBatchConfig(config);
  for (const job of jobs) {
    state.jobs.set(job.id, job);
    emit({ type: 'job-queued', job });
  }

  // Start the queue (non-blocking)
  runQueue(config.concurrency);

  return jobs;
};

/** Clear all completed/cancelled jobs from the store. */
export const clearCompleted = (): void => {
  for (const [id, job] of state.jobs) {
    if (job.status === 'passed' || job.status === 'failed' || job.status === 'cancelled') {
      state.jobs.delete(id);
    }
  }
};

// ── Local results hydration (Electron only) ──────────────────────────

/** Convert a scanned LocalResult into a Job for the UI. */
const localResultToJob = (result: LocalResult): Job => {
  const hasSchemaErrors = result.reports.schemaErrors !== undefined;
  const hasVariations = result.reports.variations !== undefined;
  const failed = hasSchemaErrors;

  return {
    id: `local-${result.path.replace(/[^a-zA-Z0-9]/g, '-')}`,
    endorsement: result.endorsement,
    endorsementKey: 'dd',
    version: result.version,
    recipientUoi: result.recipientUoi,
    recipientName: result.recipientUoi,
    providerUoi: result.providerUoi,
    providerUsi: result.providerUsi,
    status: failed ? 'failed' : 'passed',
    steps: [],
    queuedAt: result.timestamp,
    completedAt: result.timestamp,
    local: true,
    error: hasSchemaErrors ? 'Schema validation errors found' : undefined,
    reports: result.reports,
  };
};

/** Hydrate the job list from local results on disk. */
const hydrateFromLocal = (results: ReadonlyArray<LocalResult>): void => {
  // Only add results we don't already have (by path-based ID)
  for (const result of results) {
    // Only show current results — archived ones are for Compare
    if (!result.isCurrent) continue;
    const job = localResultToJob(result);
    if (!state.jobs.has(job.id)) {
      state.jobs.set(job.id, job);
    }
  }
};

/**
 * Initialize local results scanning and file watching.
 * Called once on app startup from the useJobs hook.
 */
let initialized = false;

export const initLocalResults = async (): Promise<void> => {
  if (initialized) return;
  initialized = true;

  const runner = getCertRunner();
  if (!runner) return;

  // Scan existing results
  const results = await runner.scanResults();
  hydrateFromLocal(results);
  emit({ type: 'queue-complete' }); // trigger UI refresh

  // Start file watcher
  await runner.startWatcher();
  runner.onResultsChanged((updatedResults) => {
    hydrateFromLocal(updatedResults as ReadonlyArray<LocalResult>);
    emit({ type: 'queue-complete' }); // trigger UI refresh
  });
};
