/**
 * Report reference resolver.
 *
 * A report "ref" is either:
 *   - Local: absolute filesystem path (desktop, read via IPC)
 *   - Cloud: HTTPS URL (fetched, auth headers attached)
 *
 * SQLite / cert API stores refs in the same schema slot. This resolver
 * dispatches on shape so the same UI code works against either source.
 */

type CertRunner = {
  readonly readReportFile: (absolutePath: string) => Promise<unknown>;
  readonly listReportFiles: (outputDir: string) => Promise<Record<string, string>>;
};

const getCertRunner = (): CertRunner | null =>
  (window as unknown as { certRunner?: CertRunner }).certRunner ?? null;

/** Error thrown when a local ref points to a file that no longer exists. */
export class ReportMissingError extends Error {
  constructor(readonly ref: string) {
    super(`Report file not found: ${ref}`);
    this.name = 'ReportMissingError';
  }
}

const isUrl = (ref: string): boolean => /^https?:\/\//.test(ref);

/**
 * Resolve a report ref to its parsed content.
 * @param ref Absolute filesystem path (desktop) or HTTPS URL (cloud)
 * @param authHeader Optional Authorization header for URL refs
 * @throws ReportMissingError if a local ref points to a missing file
 */
export const resolveReportRef = async (ref: string, authHeader?: string): Promise<unknown> => {
  if (isUrl(ref)) {
    const headers: Record<string, string> = authHeader ? { Authorization: authHeader } : {};
    const res = await fetch(ref, { headers });
    if (!res.ok) throw new Error(`Failed to fetch report: ${res.status} ${res.statusText}`);
    return res.json();
  }

  const runner = getCertRunner();
  if (!runner) {
    throw new Error('Local reports are only available in the desktop app.');
  }

  try {
    return await runner.readReportFile(ref);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const msg = err instanceof Error ? err.message : String(err);
    if (code === 'MISSING' || /not found/i.test(msg)) {
      throw new ReportMissingError(ref);
    }
    throw err;
  }
};

/** List which report files currently exist in a local results directory (desktop only). */
export const listLocalReportRefs = async (outputDir: string): Promise<Record<string, string>> => {
  const runner = getCertRunner();
  if (!runner) return {};
  return runner.listReportFiles(outputDir);
};

/**
 * Check if a value looks like a ref (string) vs already-resolved content.
 * Useful for transitional code that may see either shape during migration.
 */
export const isReportRef = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;
