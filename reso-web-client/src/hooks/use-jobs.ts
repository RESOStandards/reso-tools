/**
 * React hook for the Job Manager service.
 *
 * Subscribes to job events and provides a reactive job list
 * that re-renders on every state change. On mount in Electron,
 * scans the local .reso-cert/ directory for completed runs and
 * starts a file watcher for new results.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  subscribe,
  getJobs,
  startBatch,
  cancelJob,
  clearCompleted,
  rerunJob,
  deleteJob,
  deleteAllLocal,
  initLocalResults,
} from '../services/job-manager';
import type { Job, JobEvent } from '../services/job-manager';
import type { BatchConfig } from '../components/cert/config-builder';

export interface UseJobsResult {
  readonly jobs: ReadonlyArray<Job>;
  readonly loading: boolean;
  readonly activeCount: number;
  readonly queuedCount: number;
  readonly start: (config: BatchConfig) => ReadonlyArray<Job>;
  readonly cancel: (jobId: string) => void;
  readonly clear: () => void;
  readonly rerun: (jobId: string) => Promise<string | undefined>;
  readonly remove: (jobId: string) => void;
  readonly removeAll: () => void;
}

export const useJobs = (): UseJobsResult => {
  const [jobs, setJobs] = useState<ReadonlyArray<Job>>(getJobs);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Subscribe to job events
    const unsubscribe = subscribe((_event: JobEvent) => {
      setJobs(getJobs());
    });

    // Hydrate from local results on disk (Electron only, no-op in browser)
    initLocalResults().then(() => {
      setJobs(getJobs());
      setLoading(false);
    });

    return unsubscribe;
  }, []);

  const start = useCallback((config: BatchConfig) => {
    const created = startBatch(config);
    setJobs(getJobs());
    return created;
  }, []);

  const cancel = useCallback((jobId: string) => {
    cancelJob(jobId);
    setJobs(getJobs());
  }, []);

  const clear = useCallback(() => {
    clearCompleted();
    setJobs(getJobs());
  }, []);

  const rerun = useCallback(async (jobId: string): Promise<string | undefined> => {
    const newJob = await rerunJob(jobId);
    setJobs(getJobs());
    return newJob?.id;
  }, []);

  const activeCount = jobs.filter(j => j.status === 'running').length;
  const queuedCount = jobs.filter(j => j.status === 'queued').length;

  const remove = useCallback((jobId: string) => {
    deleteJob(jobId).then(() => setJobs(getJobs()));
  }, []);

  const removeAll = useCallback(() => {
    deleteAllLocal().then(() => setJobs(getJobs()));
  }, []);

  return { jobs, loading, activeCount, queuedCount, start, cancel, clear, rerun, remove, removeAll };
};
