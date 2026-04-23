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
    // Extract reports from the pipeline context for the UI
    const ctx = (result as Record<string, unknown>).context as Record<string, unknown> | undefined;
    const reports: Record<string, unknown> = {};
    if (ctx) {
      if (ctx.variationsReport) reports.variationsReport = ctx.variationsReport;
      if (ctx.metadataReportPath) reports.metadataReportPath = ctx.metadataReportPath;
      if (ctx.schemaErrors) reports.schemaErrors = ctx.schemaErrors;
    }

    parentPort?.postMessage({
      type: 'result',
      jobId: msg.jobId,
      result: JSON.stringify({
        status: result.status,
        steps: result.steps,
        duration: result.duration,
        reports: Object.keys(reports).length > 0 ? reports : undefined,
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
