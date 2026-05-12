/**
 * Pending Tasks — generic background-task queue for the desktop
 * client.
 *
 * The save handlers (variations review today, S3 uploads from Layer
 * 2B onward) used to block the UI on a network round-trip. This
 * module decouples the trigger from the await: callers `enqueue` a
 * task, the UI keeps running, the executor fires in the background,
 * and status flows back through a subscribe API.
 *
 * Architecture:
 *
 * - `PendingTaskQueue` interface describes the contract. Consumers
 *   depend on the interface, not on the implementation.
 * - `createSqliteQueue` is the v0.11 implementation — backed by a
 *   SQLite table in the Electron main process (see
 *   `pending-tasks-store.ts`). The renderer reaches it via the
 *   `pendingTasksStore` preload bridge.
 * - A module-level singleton (`queue`) is the default; named
 *   functions delegate to it for convenience. Tests can instantiate
 *   isolated queues against the interface.
 *
 * On app launch any unresolved tasks are loaded and re-fired.
 * Executors must be idempotent — a task may have completed
 * server-side without the client seeing the response.
 */

// ── Types ────────────────────────────────────────────────────────────

export type PendingTaskStatus = 'pending' | 'in-flight' | 'success' | 'failed';

export interface PendingTask {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
  readonly status: PendingTaskStatus;
  readonly retryCount: number;
  readonly createdAt: string;
  readonly lastAttemptAt?: string;
  readonly lastError?: string;
  /** Free-form context the UI can use to group tasks. */
  readonly scope?: string;
}

export type TaskExecutor = (payload: unknown) => Promise<void>;

export interface PendingTaskQueue {
  enqueue(input: { readonly type: string; readonly payload: unknown; readonly scope?: string }): Promise<PendingTask>;
  retry(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  registerExecutor(type: string, executor: TaskExecutor): void;
  subscribe(handler: (tasks: ReadonlyArray<PendingTask>) => void): () => void;
  getTasks(): ReadonlyArray<PendingTask>;
  init(): Promise<void>;
}

// ── SQLite IPC binding (Electron) ───────────────────────────────────

interface PendingTasksIPC {
  readonly insert: (task: PendingTask) => Promise<PendingTask>;
  readonly update: (id: string, patch: Partial<PendingTask>) => Promise<PendingTask | null>;
  readonly remove: (id: string) => Promise<boolean>;
  readonly get: (id: string) => Promise<PendingTask | null>;
  readonly list: () => Promise<ReadonlyArray<PendingTask>>;
}

const getIPC = (): PendingTasksIPC | undefined =>
  (window as unknown as Record<string, unknown>).pendingTasksStore as PendingTasksIPC | undefined;

// ── SQLite-backed queue ─────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 3;

export const createSqliteQueue = (): PendingTaskQueue => {
  let tasks: ReadonlyArray<PendingTask> = [];
  const executors = new Map<string, TaskExecutor>();
  const listeners = new Set<(tasks: ReadonlyArray<PendingTask>) => void>();
  let loaded = false;

  const notify = (): void => {
    for (const l of listeners) l(tasks);
  };

  /**
   * In-memory mirror update. SQLite is the durable record; we keep
   * an in-memory list so subscribers can re-render synchronously
   * without an IPC roundtrip on every read.
   */
  const replaceInMemory = (next: PendingTask | null, id: string): void => {
    if (next) {
      tasks = tasks.some(t => t.id === id)
        ? tasks.map(t => (t.id === id ? next : t))
        : [...tasks, next];
    } else {
      tasks = tasks.filter(t => t.id !== id);
    }
    notify();
  };

  const updateTask = async (id: string, patch: Partial<PendingTask>): Promise<void> => {
    const ipc = getIPC();
    if (!ipc) return;
    const updated = await ipc.update(id, patch);
    replaceInMemory(updated, id);
  };

  const removeInternal = async (id: string): Promise<void> => {
    const ipc = getIPC();
    if (!ipc) return;
    await ipc.remove(id);
    replaceInMemory(null, id);
  };

  const runTask = async (id: string): Promise<void> => {
    const task = tasks.find(t => t.id === id);
    if (!task) return;
    const executor = executors.get(task.type);
    if (!executor) {
      await updateTask(id, {
        status: 'failed',
        lastError: `No executor registered for type ${task.type}`,
        lastAttemptAt: new Date().toISOString(),
      });
      return;
    }
    await updateTask(id, {
      status: 'in-flight',
      lastAttemptAt: new Date().toISOString(),
    });
    try {
      await executor(task.payload);
      // Linger briefly so the UI can flash "Saved" before cleanup.
      await updateTask(id, { status: 'success' });
      setTimeout(() => { void removeInternal(id); }, 5_000);
    } catch (err) {
      const current = tasks.find(t => t.id === id);
      const nextRetryCount = (current?.retryCount ?? 0) + 1;
      await updateTask(id, {
        status: 'failed',
        retryCount: nextRetryCount,
        lastError: err instanceof Error ? err.message : String(err),
      });
      if (nextRetryCount < DEFAULT_MAX_RETRIES) {
        setTimeout(() => { void runTask(id); }, 1_000 * 2 ** nextRetryCount);
      }
    }
  };

  const ensureLoaded = async (): Promise<void> => {
    if (loaded) return;
    loaded = true;
    const ipc = getIPC();
    if (!ipc) return;
    try {
      const persisted = await ipc.list();
      // Reset any 'in-flight' tasks back to 'pending' — they may have
      // completed server-side, so the executor must be idempotent.
      const restored = await Promise.all(persisted.map(async t => {
        if (t.status !== 'in-flight') return t;
        const updated = await ipc.update(t.id, { status: 'pending' });
        return updated ?? t;
      }));
      tasks = restored;
      notify();
      for (const t of tasks) {
        if (t.status === 'pending') void runTask(t.id);
      }
    } catch (err) {
      console.error('pending-tasks: failed to load persisted state', err);
    }
  };

  return {
    async enqueue(input) {
      await ensureLoaded();
      const ipc = getIPC();
      const task: PendingTask = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        type: input.type,
        payload: input.payload,
        status: 'pending',
        retryCount: 0,
        createdAt: new Date().toISOString(),
        scope: input.scope,
      };
      if (ipc) {
        const inserted = await ipc.insert(task);
        replaceInMemory(inserted, inserted.id);
        void runTask(inserted.id);
        return inserted;
      }
      // No IPC means we're outside Electron — fall back to in-memory
      // only. The task won't survive a reload, but at least the
      // enqueue contract holds for the current session.
      replaceInMemory(task, task.id);
      void runTask(task.id);
      return task;
    },
    async retry(id) {
      await ensureLoaded();
      const task = tasks.find(t => t.id === id);
      if (!task || task.status !== 'failed') return;
      await updateTask(id, { status: 'pending', lastError: undefined });
      void runTask(id);
    },
    async remove(id) {
      await ensureLoaded();
      await removeInternal(id);
    },
    registerExecutor(type, executor) {
      executors.set(type, executor);
    },
    subscribe(handler) {
      listeners.add(handler);
      handler(tasks);
      return () => { listeners.delete(handler); };
    },
    getTasks() {
      return tasks;
    },
    async init() {
      await ensureLoaded();
    },
  };
};

// ── Default singleton + convenience exports ─────────────────────────

const queue: PendingTaskQueue = createSqliteQueue();

export const enqueueTask = (input: { readonly type: string; readonly payload: unknown; readonly scope?: string }): Promise<PendingTask> =>
  queue.enqueue(input);

export const retryTask = (id: string): Promise<void> => queue.retry(id);
export const removeTask = (id: string): Promise<void> => queue.remove(id);
export const registerExecutor = (type: string, executor: TaskExecutor): void => queue.registerExecutor(type, executor);
export const subscribeToTasks = (handler: (tasks: ReadonlyArray<PendingTask>) => void): (() => void) => queue.subscribe(handler);
export const getTasks = (): ReadonlyArray<PendingTask> => queue.getTasks();
export const initPendingTasks = (): Promise<void> => queue.init();
