/**
 * Job Store — unit tests for SQLite-backed job storage.
 *
 * Uses an in-memory SQLite database (:memory:) for speed and isolation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { initJobsDb, createJobStore, type JobStore, type JobRecord } from '../src/job-store.js';

let store: JobStore;

const makeJob = (overrides: Partial<JobRecord> = {}): Omit<JobRecord, 'steps'> => ({
  id: crypto.randomUUID(),
  providerUoi: 'P00001',
  providerUsi: 'S001',
  recipientUoi: 'R00001',
  recipientName: 'Test MLS',
  endorsement: 'Data Dictionary',
  endorsementKey: 'dd',
  version: '2.1',
  status: 'queued',
  queuedAt: new Date().toISOString(),
  local: true,
  ...overrides,
});

beforeEach(() => {
  const db = initJobsDb(':memory:');
  store = createJobStore(db);
});

// ── CRUD ─────────────────────────────────────────────────────────────

describe('CRUD', () => {
  it('creates and reads a job', () => {
    const input = makeJob();
    const created = store.createJob(input);
    expect(created.id).toBe(input.id);
    expect(created.providerUoi).toBe('P00001');
    expect(created.recipientName).toBe('Test MLS');
    expect(created.status).toBe('queued');
    expect(created.local).toBe(true);
    expect(created.steps).toEqual([]);

    const fetched = store.getJob(input.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(input.id);
  });

  it('returns undefined for non-existent job', () => {
    expect(store.getJob('nonexistent')).toBeUndefined();
  });

  it('updates job status', () => {
    const job = store.createJob(makeJob());
    const updated = store.updateJobStatus(job.id, {
      status: 'running',
      startedAt: new Date().toISOString(),
    });
    expect(updated).toBeDefined();
    expect(updated!.status).toBe('running');
    expect(updated!.startedAt).toBeDefined();
  });

  it('completes a job with error', () => {
    const job = store.createJob(makeJob({ status: 'running' }));
    const now = new Date().toISOString();
    const updated = store.updateJobStatus(job.id, {
      status: 'failed',
      completedAt: now,
      error: 'Schema validation errors found',
    });
    expect(updated!.status).toBe('failed');
    expect(updated!.completedAt).toBe(now);
    expect(updated!.error).toBe('Schema validation errors found');
  });

  it('deletes a job', () => {
    const job = store.createJob(makeJob());
    expect(store.deleteJob(job.id)).toBe(true);
    expect(store.getJob(job.id)).toBeUndefined();
    expect(store.deleteJob('nonexistent')).toBe(false);
  });
});

// ── Steps ────────────────────────────────────────────────────────────

describe('Steps', () => {
  it('upserts steps on a job', () => {
    const job = store.createJob(makeJob());
    store.upsertStep(job.id, { name: 'Metadata fetch', status: 'running', sortOrder: 0 });
    store.upsertStep(job.id, { name: 'Schema validation', status: 'pending', sortOrder: 1 });

    const fetched = store.getJob(job.id);
    expect(fetched!.steps).toHaveLength(2);
    expect(fetched!.steps[0].name).toBe('Metadata fetch');
    expect(fetched!.steps[0].status).toBe('running');
    expect(fetched!.steps[1].name).toBe('Schema validation');
  });

  it('updates an existing step', () => {
    const job = store.createJob(makeJob());
    store.upsertStep(job.id, { name: 'Metadata fetch', status: 'running', sortOrder: 0 });
    store.upsertStep(job.id, { name: 'Metadata fetch', status: 'passed', sortOrder: 0, duration: 1234 });

    const fetched = store.getJob(job.id);
    expect(fetched!.steps).toHaveLength(1);
    expect(fetched!.steps[0].status).toBe('passed');
    expect(fetched!.steps[0].duration).toBe(1234);
  });

  it('cascades step deletion when job is deleted', () => {
    const job = store.createJob(makeJob());
    store.upsertStep(job.id, { name: 'Step 1', status: 'passed', sortOrder: 0 });
    store.upsertStep(job.id, { name: 'Step 2', status: 'passed', sortOrder: 1 });
    store.deleteJob(job.id);
    expect(store.getJob(job.id)).toBeUndefined();
  });
});

// ── Filters ──────────────────────────────────────────────────────────

describe('Filters', () => {
  it('lists all jobs sorted by recency', () => {
    const older = makeJob({ queuedAt: '2026-01-01T00:00:00Z' });
    const newer = makeJob({ queuedAt: '2026-04-01T00:00:00Z' });
    store.createJob(older);
    store.createJob(newer);

    const all = store.getJobs();
    expect(all).toHaveLength(2);
    expect(all[0].id).toBe(newer.id);
    expect(all[1].id).toBe(older.id);
  });

  it('filters by status', () => {
    store.createJob(makeJob({ status: 'queued' }));
    store.createJob(makeJob({ status: 'passed' }));
    store.createJob(makeJob({ status: 'failed' }));

    expect(store.getJobs({ status: 'passed' })).toHaveLength(1);
    expect(store.getJobs({ status: 'queued' })).toHaveLength(1);
  });

  it('filters by provider', () => {
    store.createJob(makeJob({ providerUoi: 'P1' }));
    store.createJob(makeJob({ providerUoi: 'P2' }));

    expect(store.getJobs({ providerUoi: 'P1' })).toHaveLength(1);
  });

  it('filters by recipient', () => {
    store.createJob(makeJob({ recipientUoi: 'R1' }));
    store.createJob(makeJob({ recipientUoi: 'R2' }));

    expect(store.getJobs({ recipientUoi: 'R1' })).toHaveLength(1);
  });

  it('filters by endorsement key', () => {
    store.createJob(makeJob({ endorsementKey: 'dd' }));
    store.createJob(makeJob({ endorsementKey: 'core' }));

    expect(store.getJobs({ endorsementKey: 'dd' })).toHaveLength(1);
  });

  it('supports limit and offset', () => {
    for (let i = 0; i < 10; i++) {
      store.createJob(makeJob({ queuedAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z` }));
    }

    expect(store.getJobs({ limit: 3 })).toHaveLength(3);
    const offset = store.getJobs({ limit: 3, offset: 7 });
    expect(offset).toHaveLength(3);
  });
});

// ── JSON round-trip ──────────────────────────────────────────────────

describe('JSON round-trip', () => {
  it('persists and restores sdkConfig', () => {
    const sdkConfig = { server: { url: 'https://api.test.com' }, endorsement: 'dd', version: '2.1' };
    const job = store.createJob(makeJob({ sdkConfig }));
    const fetched = store.getJob(job.id);
    expect(fetched!.sdkConfig).toEqual(sdkConfig);
  });

  it('persists and restores reports', () => {
    const reports = { schemaErrors: { total: 5, errors: ['field1', 'field2'] } };
    const job = store.createJob(makeJob({ reports }));
    const fetched = store.getJob(job.id);
    expect(fetched!.reports).toEqual(reports);
  });

  it('persists and restores step requestDetails and artifacts', () => {
    const job = store.createJob(makeJob());
    store.upsertStep(job.id, {
      name: 'Test step',
      status: 'passed',
      sortOrder: 0,
      requestDetails: [{ method: 'GET', url: 'https://api.test.com/Property', status: 200 }],
      artifacts: [{ label: 'report.json', path: '/tmp/report.json' }],
    });

    const fetched = store.getJob(job.id);
    expect(fetched!.steps[0].requestDetails).toHaveLength(1);
    expect(fetched!.steps[0].requestDetails![0].method).toBe('GET');
    expect(fetched!.steps[0].artifacts).toHaveLength(1);
    expect(fetched!.steps[0].artifacts![0].label).toBe('report.json');
  });
});

// ── Bulk operations ──────────────────────────────────────────────────

describe('Bulk operations', () => {
  it('clears completed jobs', () => {
    store.createJob(makeJob({ status: 'queued' }));
    store.createJob(makeJob({ status: 'running' }));
    store.createJob(makeJob({ status: 'passed' }));
    store.createJob(makeJob({ status: 'failed' }));
    store.createJob(makeJob({ status: 'cancelled' }));

    const cleared = store.clearCompleted();
    expect(cleared).toBe(3); // passed + failed + cancelled
    expect(store.getJobs()).toHaveLength(2); // queued + running remain
  });
});

// ── Full lifecycle ───────────────────────────────────────────────────

describe('Full lifecycle', () => {
  it('creates → starts → progresses → completes a job', () => {
    const job = store.createJob(makeJob());
    expect(job.status).toBe('queued');

    store.updateJobStatus(job.id, { status: 'running', startedAt: new Date().toISOString() });
    expect(store.getJob(job.id)!.status).toBe('running');

    store.upsertStep(job.id, { name: 'Metadata fetch', status: 'running', sortOrder: 0 });
    store.upsertStep(job.id, { name: 'Schema validation', status: 'pending', sortOrder: 1 });
    store.upsertStep(job.id, { name: 'Lookup Resource', status: 'pending', sortOrder: 2 });

    store.upsertStep(job.id, { name: 'Metadata fetch', status: 'passed', sortOrder: 0, duration: 500 });
    store.upsertStep(job.id, { name: 'Schema validation', status: 'running', sortOrder: 1 });
    store.upsertStep(job.id, { name: 'Schema validation', status: 'passed', sortOrder: 1, duration: 3000 });
    store.upsertStep(job.id, { name: 'Lookup Resource', status: 'running', sortOrder: 2 });
    store.upsertStep(job.id, { name: 'Lookup Resource', status: 'passed', sortOrder: 2, duration: 8000 });

    const reports = { schemaErrors: null, summary: { fields: 1200, lookups: 800 } };
    store.updateJobStatus(job.id, {
      status: 'passed',
      completedAt: new Date().toISOString(),
      reports,
    });

    const final = store.getJob(job.id);
    expect(final!.status).toBe('passed');
    expect(final!.steps).toHaveLength(3);
    expect(final!.steps.every(s => s.status === 'passed')).toBe(true);
    expect(final!.reports).toEqual(reports);
  });
});
