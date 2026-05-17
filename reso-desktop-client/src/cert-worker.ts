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

// The legacy cert-utils variations module reads RESO_SERVICES_URL at
// module-load time (via process.env) to build the Variations Service
// URLs. In the CLI use case that comes from `.env`; in the desktop
// worker process the parent shell rarely has it set, so the legacy
// module bails with "undefined/certification/variations/search".
// Default to the public services host — the variations service is a
// single, stable endpoint and no consumer of this worker wants to
// point elsewhere.
if (!process.env.RESO_SERVICES_URL) {
  process.env.RESO_SERVICES_URL = 'https://services.reso.org';
}

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

  // Dev override: when RESO_SERVICES_QA_BEARER_TOKEN is set in the
  // worker's env, use it as the services bearer instead of whatever
  // the renderer derived from the logged-in session. Lets you point
  // the cert step at a known-good token without re-logging-in.
  if (process.env.RESO_SERVICES_QA_BEARER_TOKEN) {
    msg.config = { ...msg.config, servicesAuthToken: process.env.RESO_SERVICES_QA_BEARER_TOKEN };
  }

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
