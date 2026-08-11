/**
 * findVariations — the thin-client replacement for the frozen v3.0.0 local
 * matcher.
 *
 * Takes a metadata report — from disk (`pathToMetadataReportJson`) or already
 * in memory (`metadataReportJson`, e.g. fetched + serialized from a live server
 * via `--from-server`) — computes its DD variations via the backend Variations
 * Service (`computeVariationsViaService`), and writes the report to an output
 * directory when variations are found. The canonical + in-review blend and the
 * machine matching run server-side; this function is I/O glue.
 *
 * The input signature mirrors the legacy `findVariations` so existing call
 * sites (CLI, cert pipeline) swap over without changing their arguments. Unlike
 * the legacy — which caught internally and returned null — this surfaces the
 * service's coded errors (auth / service) to the caller, matching
 * `computeVariationsViaService`. Callers already wrap in try/catch.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { computeVariationsViaService, type VariationsServiceReport } from './service.js';
import { DEFAULT_DD_VERSION, DEFAULT_FUZZINESS, VARIATIONS_REPORT_FILENAME } from './constants.js';

export interface FindVariationsInput {
  /**
   * Metadata source — provide exactly one of this or {@link metadataReportJson}.
   * Path to the metadata-report JSON on disk; read + parsed by this function.
   */
  readonly pathToMetadataReportJson?: string;
  /**
   * Metadata source — provide exactly one of this or {@link pathToMetadataReportJson}.
   * An already-in-memory metadata report, e.g. one fetched + serialized from a
   * live server (`--from-server`), so no temporary file has to be written.
   */
  readonly metadataReportJson?: unknown;
  /** Fuzzy-match threshold (0–1). Defaults to {@link DEFAULT_FUZZINESS}. */
  readonly fuzziness?: number;
  /** Data Dictionary version. Defaults to {@link DEFAULT_DD_VERSION}. */
  readonly version?: string;
  /**
   * Accepted for signature parity with the legacy matcher. The backend service
   * always performs the canonical + in-review match — there is no separate
   * suggestion-fetch step to toggle — so this flag is inert. Retained so
   * existing call sites compile unchanged.
   */
  readonly useSuggestions?: boolean;
  /** True when invoked from the CLI — tailors the not-configured auth message. */
  readonly fromCli?: boolean;
  /**
   * Directory to write `data-dictionary-variations.json` into when variations
   * are found. Omit (undefined) to resolve against the current directory, as
   * the legacy did.
   */
  readonly outputPath?: string;
  /** Session bearer (Desktop / UI). Omit to mint from `.env` (CLI). */
  readonly bearerToken?: string;
}

/** True when the report carries at least one variation in any category. */
const hasVariations = (report: VariationsServiceReport): boolean =>
  Object.values(report.variations ?? {}).some((entries) => Array.isArray(entries) && entries.length > 0);

/**
 * Resolve the metadata report from exactly one source — an in-memory report or
 * a file path. Mutually exclusive: both or neither is a caller error, surfaced
 * as a thrown Error rather than silently preferring one.
 */
const loadMetadataReport = async (input: FindVariationsInput): Promise<unknown> => {
  const inline = input.metadataReportJson;
  const path = input.pathToMetadataReportJson;
  const hasInline = inline !== undefined;
  const hasPath = typeof path === 'string' && path.length > 0;
  if (hasInline && hasPath) {
    throw new Error(
      'findVariations: metadataReportJson and pathToMetadataReportJson are mutually exclusive — provide one.',
    );
  }
  if (hasInline) return inline;
  if (typeof path === 'string' && path.length > 0) {
    return JSON.parse(await readFile(path, { encoding: 'utf8' })) as unknown;
  }
  throw new Error(
    'findVariations: provide a metadata source — metadataReportJson (in-memory) or pathToMetadataReportJson (file).',
  );
};

export const findVariations = async (input: FindVariationsInput): Promise<VariationsServiceReport> => {
  const {
    fuzziness = DEFAULT_FUZZINESS,
    version = DEFAULT_DD_VERSION,
    fromCli,
    outputPath,
    bearerToken,
  } = input;

  const metadataReportJson = await loadMetadataReport(input);

  const report = await computeVariationsViaService({
    metadataReportJson,
    version,
    fuzziness,
    ...(fromCli ? { fromCli } : {}),
    ...(bearerToken ? { bearerToken } : {}),
  });

  if (hasVariations(report)) {
    const reportPath = resolve(join(outputPath ?? '', VARIATIONS_REPORT_FILENAME));
    // Honor the CLI's "created if missing" contract — and match every sibling writer
    // (writeArtifact, the compliance reporters) — by creating the target directory before
    // writing, so a per-run --output-dir like ./results/run1 works instead of ENOENT-ing.
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2));
  }

  return report;
};
