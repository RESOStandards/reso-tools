/**
 * Certification test worker — runs compliance tests in a Worker thread
 * so the main process event loop stays free for IPC message delivery.
 *
 * Progress events are sent as plain objects (safe for structured clone).
 * The final result is sent as a JSON string to avoid clone errors from
 * non-serializable objects in the pipeline context (service instances, etc.).
 */

import { parentPort, workerData } from 'node:worker_threads';
import { resolve } from 'node:path';

const certPkg = workerData?.certPath
  ? resolve(workerData.certPath)
  : '@reso-standards/reso-certification';

const loadCertModule = async () => {
  const mod = await import(certPkg) as unknown as {
    runComplianceTests: (
      config: Record<string, unknown>,
      onProgress?: (progress: Record<string, unknown>) => void,
    ) => Promise<Record<string, unknown>>;
  };
  return mod;
};

parentPort?.on('message', async (msg: { type: string; config: Record<string, unknown>; jobId: string }) => {
  if (msg.type !== 'run') return;

  try {
    const certModule = await loadCertModule();
    const result = await certModule.runComplianceTests(
      msg.config,
      (progress) => {
        // Send progress as plain object — only include cloneable fields
        const progressMsg = {
          type: 'progress',
          jobId: msg.jobId,
          progress: {
            step: String(progress.step ?? ''),
            status: String(progress.status ?? ''),
            message: progress.message != null ? String(progress.message) : undefined,
            duration: typeof progress.duration === 'number' ? progress.duration : undefined,
          },
        };
        parentPort?.postMessage(progressMsg);
      },
    );
    // Reports are read from disk by the main process after the worker completes,
    // keyed by absolute path. Full report content stays on disk; the renderer
    // fetches it on demand via the reports:read-file IPC.
    parentPort?.postMessage({
      type: 'result',
      jobId: msg.jobId,
      result: JSON.stringify({
        status: result.status,
        steps: result.steps,
        duration: result.duration,
      }),
    });
  } catch (err) {
    parentPort?.postMessage({
      type: 'error',
      jobId: msg.jobId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
