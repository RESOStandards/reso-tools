/**
 * `reso-cert analytics compare`: compare a certification run with the one before it.
 *
 * Reads two run directories and prints what changed, by how much and whether it is better or worse. Without a second
 * run it finds the previous run of the same connection in the results tree (`…/current` against the newest
 * `…/archived/{timestamp}`). Nothing is sent anywhere: both runs are read from disk.
 *
 * Written for a person and for an AI agent alike: the text states every unit and direction in words, and `--json`
 * prints the whole comparison with a schema version, for scripts and agents to read without parsing text.
 */

import { type RunComparison, compareRuns, isNoPreviousRunError } from '../analytics/compare.js';
import { renderComparisonText } from '../analytics/render-text.js';

export interface CompareCommandOptions {
  /** The run to look at: a run directory (`…/current`, `…/archived/{timestamp}`, or any directory with the reports). */
  readonly run: string;
  /** The run to compare it with. Without it, the previous run of the same connection. */
  readonly previous?: string;
}

/** Exit codes, stated in the command's help: 0 compared, 1 nothing to compare with, 2 anything else. */
export const COMPARE_EXIT = { compared: 0, noPreviousRun: 1, failed: 2 } as const;

export const runCompare = (options: CompareCommandOptions): Promise<RunComparison> => compareRuns(options.run, options.previous);

export const compareExitCode = (error?: unknown): number =>
  error === undefined ? COMPARE_EXIT.compared : isNoPreviousRunError(error) ? COMPARE_EXIT.noPreviousRun : COMPARE_EXIT.failed;

export { renderComparisonText };
