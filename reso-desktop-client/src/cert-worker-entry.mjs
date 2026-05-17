/**
 * Bundled cert-worker entry point — statically imports reso-certification
 * so esbuild can include it in the bundle. Used in the packaged Electron app.
 */

import { parentPort } from 'node:worker_threads';

// The legacy cert-utils variations module reads RESO_SERVICES_URL at
// module-load time to build the Variations Service URLs. Packaged
// app contexts don't carry that env var, so set the default before
// the cert module imports.
if (!process.env.RESO_SERVICES_URL) {
  process.env.RESO_SERVICES_URL = 'https://services.reso.org';
}

const { runComplianceTests } = await import('@reso-standards/reso-certification');

parentPort?.on('message', async (msg) => {
  if (msg.type !== 'run') return;

  // Dev override (same as cert-worker.ts) — see comment there.
  if (process.env.RESO_SERVICES_QA_BEARER_TOKEN) {
    msg.config = { ...msg.config, servicesAuthToken: process.env.RESO_SERVICES_QA_BEARER_TOKEN };
  }

  try {
    const result = await runComplianceTests(
      msg.config,
      (progress) => {
        parentPort?.postMessage({
          type: 'progress',
          jobId: msg.jobId,
          progress: {
            step: String(progress.step ?? ''),
            status: String(progress.status ?? ''),
            message: progress.message != null ? String(progress.message) : undefined,
            duration: typeof progress.duration === 'number' ? progress.duration : undefined,
          },
        });
      },
    );

    // Extract reports from the pipeline context for the UI
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
