/**
 * Bundled cert-worker entry point — statically imports reso-certification
 * so esbuild can include it in the bundle. Used in the packaged Electron app.
 */

import { parentPort } from 'node:worker_threads';
import { runComplianceTests } from '@reso-standards/reso-certification';

parentPort?.on('message', async (msg) => {
  if (msg.type !== 'run') return;

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
