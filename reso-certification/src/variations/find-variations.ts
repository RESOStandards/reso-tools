/**
 * findVariations — the thin-client replacement for the frozen v3.0.0 local
 * matcher.
 *
 * Reads a metadata report from disk, computes its DD variations via the backend
 * Variations Service (`computeVariationsViaService`), and writes the report to
 * an output directory when variations are found. The canonical + in-review
 * blend and the machine matching run server-side; this function is I/O glue.
 *
 * The input signature mirrors the legacy `findVariations` so existing call
 * sites (CLI, cert pipeline) swap over without changing their arguments. Unlike
 * the legacy — which caught internally and returned null — this surfaces the
 * service's coded errors (auth / service) to the caller, matching
 * `computeVariationsViaService`. Callers already wrap in try/catch.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { computeVariationsViaService, type VariationsServiceReport } from './service.js';
import { DEFAULT_DD_VERSION, DEFAULT_FUZZINESS, VARIATIONS_REPORT_FILENAME } from './constants.js';

export interface FindVariationsInput {
  /** Path to the metadata-report JSON on disk. */
  readonly pathToMetadataReportJson: string;
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

export const findVariations = async (input: FindVariationsInput): Promise<VariationsServiceReport> => {
  const {
    pathToMetadataReportJson,
    fuzziness = DEFAULT_FUZZINESS,
    version = DEFAULT_DD_VERSION,
    fromCli,
    outputPath,
    bearerToken,
  } = input;

  const metadataReportJson = JSON.parse(
    await readFile(pathToMetadataReportJson, { encoding: 'utf8' }),
  ) as unknown;

  const report = await computeVariationsViaService({
    metadataReportJson,
    version,
    fuzziness,
    ...(fromCli ? { fromCli } : {}),
    ...(bearerToken ? { bearerToken } : {}),
  });

  if (hasVariations(report)) {
    await writeFile(
      resolve(join(outputPath ?? '', VARIATIONS_REPORT_FILENAME)),
      JSON.stringify(report, null, 2),
    );
  }

  return report;
};
