/**
 * Certification test worker — runs compliance tests in a Worker thread
 * so the main process event loop stays free for IPC message delivery.
 *
 * Communication:
 * - Main → Worker: { type: 'run', config, jobId }
 * - Worker → Main: { type: 'progress', jobId, progress }
 * - Worker → Main: { type: 'result', jobId, result }
 * - Worker → Main: { type: 'error', jobId, error }
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
        // Serialize progress to plain object to avoid structured clone errors
        parentPort?.postMessage({ type: 'progress', jobId: msg.jobId, progress: JSON.parse(JSON.stringify(progress)) });
      },
    );
    // Serialize result to plain JSON — the pipeline result may contain
    // non-cloneable objects (functions, service instances, etc.)
    parentPort?.postMessage({ type: 'result', jobId: msg.jobId, result: JSON.parse(JSON.stringify(result)) });
  } catch (err) {
    parentPort?.postMessage({
      type: 'error',
      jobId: msg.jobId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
