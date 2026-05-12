/**
 * SQLite-backed pending-tasks store for the Desktop Client.
 *
 * Backs the renderer's pending-tasks queue with a durable table so
 * background tasks survive app restarts. The schema is intentionally
 * generic — the renderer registers executors keyed by `type` and
 * stores the per-type payload as opaque JSON.
 *
 * Runs in the Electron main process (better-sqlite3 is synchronous).
 * The renderer accesses it via IPC (see preload.ts / main.ts).
 */

import Database from 'better-sqlite3';

// ── Types ────────────────────────────────────────────────────────────

export type PendingTaskStatus = 'pending' | 'in-flight' | 'success' | 'failed';

export interface PendingTaskRecord {
  readonly id: string;
  readonly type: string;
  /** Opaque JSON payload — typed by the executor that consumes it. */
  readonly payload: unknown;
  readonly status: PendingTaskStatus;
  readonly retryCount: number;
  readonly createdAt: string;
  readonly lastAttemptAt?: string;
  readonly lastError?: string;
  readonly scope?: string;
}

export interface PendingTaskInsert {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
  readonly status: PendingTaskStatus;
  readonly retryCount: number;
  readonly createdAt: string;
  readonly scope?: string;
}

export interface PendingTaskPatch {
  readonly status?: PendingTaskStatus;
  readonly retryCount?: number;
  readonly lastAttemptAt?: string;
  /** Pass null to clear a previous error message on a successful retry. */
  readonly lastError?: string | null;
}

export interface PendingTasksStore {
  readonly insert: (task: PendingTaskInsert) => PendingTaskRecord;
  readonly update: (id: string, patch: PendingTaskPatch) => PendingTaskRecord | null;
  readonly remove: (id: string) => boolean;
  readonly get: (id: string) => PendingTaskRecord | null;
  readonly list: () => ReadonlyArray<PendingTaskRecord>;
  readonly close: () => void;
}

// ── Schema ───────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pending_tasks (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL,
  payload          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  retry_count      INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  last_attempt_at  TEXT,
  last_error       TEXT,
  scope            TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_tasks_status     ON pending_tasks (status, created_at);
CREATE INDEX IF NOT EXISTS idx_pending_tasks_type       ON pending_tasks (type, status);
CREATE INDEX IF NOT EXISTS idx_pending_tasks_scope      ON pending_tasks (scope);
`;

// ── Helpers ──────────────────────────────────────────────────────────

const rowToRecord = (row: Record<string, unknown>): PendingTaskRecord => {
  const payloadStr = row.payload as string;
  let payload: unknown;
  try { payload = JSON.parse(payloadStr); }
  catch { payload = null; }
  return {
    id: row.id as string,
    type: row.type as string,
    payload,
    status: row.status as PendingTaskStatus,
    retryCount: row.retry_count as number,
    createdAt: row.created_at as string,
    lastAttemptAt: (row.last_attempt_at as string | null) ?? undefined,
    lastError: (row.last_error as string | null) ?? undefined,
    scope: (row.scope as string | null) ?? undefined,
  };
};

// ── Initialization ──────────────────────────────────────────────────

/** Open (or create) the pending-tasks database and ensure the schema exists. */
export const initPendingTasksDb = (dbPath: string): Database.Database => {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
};

// ── Store factory ───────────────────────────────────────────────────

export const createPendingTasksStore = (db: Database.Database): PendingTasksStore => {
  const insertStmt = db.prepare(`
    INSERT INTO pending_tasks (id, type, payload, status, retry_count, created_at, scope)
    VALUES (@id, @type, @payload, @status, @retryCount, @createdAt, @scope)
  `);

  const getStmt = db.prepare(`SELECT * FROM pending_tasks WHERE id = ?`);
  const listStmt = db.prepare(`SELECT * FROM pending_tasks ORDER BY created_at ASC`);
  const removeStmt = db.prepare(`DELETE FROM pending_tasks WHERE id = ?`);

  const insert: PendingTasksStore['insert'] = (task) => {
    insertStmt.run({
      id: task.id,
      type: task.type,
      payload: JSON.stringify(task.payload ?? null),
      status: task.status,
      retryCount: task.retryCount,
      createdAt: task.createdAt,
      scope: task.scope ?? null,
    });
    const row = getStmt.get(task.id) as Record<string, unknown>;
    return rowToRecord(row);
  };

  const update: PendingTasksStore['update'] = (id, patch) => {
    // Build the SET clause dynamically so callers can patch any
    // subset of mutable columns. better-sqlite3 doesn't let us
    // bind column names, so we whitelist + assemble manually.
    const setFragments: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.status !== undefined) {
      setFragments.push('status = @status');
      params.status = patch.status;
    }
    if (patch.retryCount !== undefined) {
      setFragments.push('retry_count = @retryCount');
      params.retryCount = patch.retryCount;
    }
    if (patch.lastAttemptAt !== undefined) {
      setFragments.push('last_attempt_at = @lastAttemptAt');
      params.lastAttemptAt = patch.lastAttemptAt;
    }
    if (patch.lastError !== undefined) {
      setFragments.push('last_error = @lastError');
      params.lastError = patch.lastError;
    }
    if (setFragments.length === 0) {
      const row = getStmt.get(id) as Record<string, unknown> | undefined;
      return row ? rowToRecord(row) : null;
    }
    const stmt = db.prepare(`UPDATE pending_tasks SET ${setFragments.join(', ')} WHERE id = @id`);
    const result = stmt.run(params);
    if (result.changes === 0) return null;
    const row = getStmt.get(id) as Record<string, unknown>;
    return rowToRecord(row);
  };

  const remove: PendingTasksStore['remove'] = (id) => {
    const result = removeStmt.run(id);
    return result.changes > 0;
  };

  const get: PendingTasksStore['get'] = (id) => {
    const row = getStmt.get(id) as Record<string, unknown> | undefined;
    return row ? rowToRecord(row) : null;
  };

  const list: PendingTasksStore['list'] = () => {
    const rows = listStmt.all() as ReadonlyArray<Record<string, unknown>>;
    return rows.map(rowToRecord);
  };

  return { insert, update, remove, get, list, close: () => db.close() };
};
