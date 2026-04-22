/**
 * SQLite-backed job storage for the Desktop Client.
 *
 * Provides a durable, queryable source of truth for certification jobs
 * and their steps. The schema mirrors the DynamoDB certificationRequests
 * table so the UI code is backend-agnostic. A future cloud adapter can
 * implement the same JobStore interface with AWS SDK calls.
 *
 * Runs in the Electron main process (better-sqlite3 is synchronous).
 * The renderer accesses it via IPC (see preload.ts / main.ts).
 */

import Database from 'better-sqlite3';

// ── Types ────────────────────────────────────────────────────────────

type JobStatus = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled';
type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

interface RequestDetail {
  readonly method: string;
  readonly url: string;
  readonly status?: number;
  readonly error?: string;
  readonly responseBody?: string;
}

interface Artifact {
  readonly label: string;
  readonly path: string;
}

export interface StepRecord {
  readonly name: string;
  readonly status: StepStatus;
  readonly sortOrder: number;
  readonly duration?: number;
  readonly detail?: string;
  readonly requestDetails?: ReadonlyArray<RequestDetail>;
  readonly artifacts?: ReadonlyArray<Artifact>;
}

export interface JobRecord {
  readonly id: string;
  readonly providerUoi: string;
  readonly providerUsi: string;
  readonly recipientUoi: string;
  readonly recipientName: string;
  readonly endorsement: string;
  readonly endorsementKey: string;
  readonly version: string;
  readonly status: JobStatus;
  readonly error?: string;
  readonly queuedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly local: boolean;
  readonly resultPath?: string;
  readonly sdkConfig?: Record<string, unknown>;
  readonly reports?: Record<string, unknown>;
  readonly steps: ReadonlyArray<StepRecord>;
}

export interface StatusPatch {
  readonly status?: JobStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: string;
  readonly reports?: Record<string, unknown>;
  readonly resultPath?: string;
}

export interface JobFilter {
  readonly status?: JobStatus;
  readonly providerUoi?: string;
  readonly recipientUoi?: string;
  readonly endorsementKey?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface JobStore {
  readonly createJob: (job: Omit<JobRecord, 'steps'>) => JobRecord;
  readonly updateJobStatus: (id: string, patch: StatusPatch) => JobRecord | undefined;
  readonly upsertStep: (jobId: string, step: StepRecord) => StepRecord;
  readonly getJob: (id: string) => JobRecord | undefined;
  readonly getJobs: (filter?: JobFilter) => ReadonlyArray<JobRecord>;
  readonly deleteJob: (id: string) => boolean;
  readonly clearCompleted: () => number;
  readonly close: () => void;
}

// ── Schema ───────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  provider_uoi     TEXT NOT NULL,
  provider_usi     TEXT NOT NULL DEFAULT '',
  recipient_uoi    TEXT NOT NULL,
  recipient_name   TEXT NOT NULL DEFAULT '',
  endorsement      TEXT NOT NULL,
  endorsement_key  TEXT NOT NULL,
  version          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'queued',
  error            TEXT,
  queued_at        TEXT NOT NULL,
  started_at       TEXT,
  completed_at     TEXT,
  local            INTEGER NOT NULL DEFAULT 1,
  result_path      TEXT,
  sdk_config       TEXT,
  reports          TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_queued_at   ON jobs (queued_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status      ON jobs (status, queued_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_recipient   ON jobs (recipient_uoi, queued_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_provider    ON jobs (provider_uoi, queued_at DESC);

CREATE TABLE IF NOT EXISTS job_steps (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id           TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  sort_order       INTEGER NOT NULL DEFAULT 0,
  duration         INTEGER,
  detail           TEXT,
  request_details  TEXT,
  artifacts        TEXT,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_steps_job ON job_steps (job_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS idx_steps_job_name ON job_steps (job_id, name);
`;

// ── Helpers ──────────────────────────────────────────────────────────

const toJSON = (value: unknown): string | null =>
  value != null ? JSON.stringify(value) : null;

const fromJSON = <T>(value: unknown): T | undefined => {
  if (typeof value !== 'string') return undefined;
  try { return JSON.parse(value) as T; }
  catch { return undefined; }
};

/** Map a raw SQLite row to a StepRecord. */
const rowToStep = (row: Record<string, unknown>): StepRecord => ({
  name: row.name as string,
  status: row.status as StepStatus,
  sortOrder: row.sort_order as number,
  duration: row.duration as number | undefined,
  detail: row.detail as string | undefined,
  requestDetails: fromJSON<ReadonlyArray<RequestDetail>>(row.request_details),
  artifacts: fromJSON<ReadonlyArray<Artifact>>(row.artifacts),
});

/** Map a raw SQLite row to a JobRecord (without steps). */
const rowToJob = (row: Record<string, unknown>, steps: ReadonlyArray<StepRecord>): JobRecord => ({
  id: row.id as string,
  providerUoi: row.provider_uoi as string,
  providerUsi: row.provider_usi as string,
  recipientUoi: row.recipient_uoi as string,
  recipientName: row.recipient_name as string,
  endorsement: row.endorsement as string,
  endorsementKey: row.endorsement_key as string,
  version: row.version as string,
  status: row.status as JobStatus,
  error: row.error as string | undefined,
  queuedAt: row.queued_at as string,
  startedAt: row.started_at as string | undefined,
  completedAt: row.completed_at as string | undefined,
  local: (row.local as number) === 1,
  resultPath: row.result_path as string | undefined,
  sdkConfig: fromJSON<Record<string, unknown>>(row.sdk_config),
  reports: fromJSON<Record<string, unknown>>(row.reports),
  steps,
});

// ── Database initialization ─────────────────────────────────────────

/** Open (or create) the jobs database and ensure the schema exists. */
export const initJobsDb = (dbPath: string): Database.Database => {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
};

// ── Store factory ───────────────────────────────────────────────────

/** Create a JobStore backed by the given SQLite database handle. */
export const createJobStore = (db: Database.Database): JobStore => {
  // Prepared statements (compiled once, reused per call)
  const insertJob = db.prepare(`
    INSERT INTO jobs (id, provider_uoi, provider_usi, recipient_uoi, recipient_name,
      endorsement, endorsement_key, version, status, error, queued_at, started_at,
      completed_at, local, result_path, sdk_config, reports)
    VALUES (@id, @provider_uoi, @provider_usi, @recipient_uoi, @recipient_name,
      @endorsement, @endorsement_key, @version, @status, @error, @queued_at, @started_at,
      @completed_at, @local, @result_path, @sdk_config, @reports)
  `);

  const selectJob = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const selectSteps = db.prepare('SELECT * FROM job_steps WHERE job_id = ? ORDER BY sort_order');

  const updateStatus = db.prepare(`
    UPDATE jobs SET
      status = COALESCE(@status, status),
      started_at = COALESCE(@started_at, started_at),
      completed_at = COALESCE(@completed_at, completed_at),
      error = COALESCE(@error, error),
      reports = COALESCE(@reports, reports),
      result_path = COALESCE(@result_path, result_path),
      updated_at = datetime('now')
    WHERE id = @id
  `);

  const upsertStepStmt = db.prepare(`
    INSERT INTO job_steps (job_id, name, status, sort_order, duration, detail, request_details, artifacts, updated_at)
    VALUES (@job_id, @name, @status, @sort_order, @duration, @detail, @request_details, @artifacts, datetime('now'))
    ON CONFLICT(job_id, name) DO UPDATE SET
      status = @status,
      sort_order = @sort_order,
      duration = COALESCE(@duration, duration),
      detail = COALESCE(@detail, detail),
      request_details = COALESCE(@request_details, request_details),
      artifacts = COALESCE(@artifacts, artifacts),
      updated_at = datetime('now')
  `);

  const deleteJobStmt = db.prepare('DELETE FROM jobs WHERE id = ?');
  const clearCompletedStmt = db.prepare("DELETE FROM jobs WHERE status IN ('passed', 'failed', 'cancelled')");

  /** Read a job with its steps from the database. */
  const readJob = (id: string): JobRecord | undefined => {
    const row = selectJob.get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const steps = (selectSteps.all(id) as ReadonlyArray<Record<string, unknown>>).map(rowToStep);
    return rowToJob(row, steps);
  };

  const createJob: JobStore['createJob'] = (job) => {
    insertJob.run({
      id: job.id,
      provider_uoi: job.providerUoi,
      provider_usi: job.providerUsi,
      recipient_uoi: job.recipientUoi,
      recipient_name: job.recipientName,
      endorsement: job.endorsement,
      endorsement_key: job.endorsementKey,
      version: job.version,
      status: job.status,
      error: job.error ?? null,
      queued_at: job.queuedAt,
      started_at: job.startedAt ?? null,
      completed_at: job.completedAt ?? null,
      local: job.local ? 1 : 0,
      result_path: job.resultPath ?? null,
      sdk_config: toJSON(job.sdkConfig),
      reports: toJSON(job.reports),
    });
    return readJob(job.id)!;
  };

  const updateJobStatus: JobStore['updateJobStatus'] = (id, patch) => {
    updateStatus.run({
      id,
      status: patch.status ?? null,
      started_at: patch.startedAt ?? null,
      completed_at: patch.completedAt ?? null,
      error: patch.error ?? null,
      reports: patch.reports != null ? toJSON(patch.reports) : null,
      result_path: patch.resultPath ?? null,
    });
    return readJob(id);
  };

  const upsertStep: JobStore['upsertStep'] = (jobId, step) => {
    upsertStepStmt.run({
      job_id: jobId,
      name: step.name,
      status: step.status,
      sort_order: step.sortOrder,
      duration: step.duration ?? null,
      detail: step.detail ?? null,
      request_details: toJSON(step.requestDetails),
      artifacts: toJSON(step.artifacts),
    });
    return step;
  };

  const getJob: JobStore['getJob'] = (id) => readJob(id);

  const getJobs: JobStore['getJobs'] = (filter) => {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filter?.status) {
      conditions.push('status = @status');
      params.status = filter.status;
    }
    if (filter?.providerUoi) {
      conditions.push('provider_uoi = @provider_uoi');
      params.provider_uoi = filter.providerUoi;
    }
    if (filter?.recipientUoi) {
      conditions.push('recipient_uoi = @recipient_uoi');
      params.recipient_uoi = filter.recipientUoi;
    }
    if (filter?.endorsementKey) {
      conditions.push('endorsement_key = @endorsement_key');
      params.endorsement_key = filter.endorsementKey;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter?.limit ? `LIMIT ${filter.limit}` : '';
    const offset = filter?.offset ? `OFFSET ${filter.offset}` : '';

    const sql = `SELECT * FROM jobs ${where} ORDER BY queued_at DESC ${limit} ${offset}`;
    const rows = db.prepare(sql).all(params) as ReadonlyArray<Record<string, unknown>>;

    return rows.map(row => {
      const steps = (selectSteps.all(row.id as string) as ReadonlyArray<Record<string, unknown>>).map(rowToStep);
      return rowToJob(row, steps);
    });
  };

  const deleteJob: JobStore['deleteJob'] = (id) => {
    const result = deleteJobStmt.run(id);
    return result.changes > 0;
  };

  const clearCompleted: JobStore['clearCompleted'] = () => {
    const result = clearCompletedStmt.run();
    return result.changes;
  };

  const close = (): void => { db.close(); };

  return { createJob, updateJobStatus, upsertStep, getJob, getJobs, deleteJob, clearCompleted, close };
};
