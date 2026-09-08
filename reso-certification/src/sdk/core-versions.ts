/**
 * Web API Core specification versions — the single source of truth.
 *
 * Parallels {@link ./dd-versions.ts} for the Data Dictionary. Core versions carry a PATCH segment
 * (`2.1.0`), unlike DD's two-part `MAJOR.MINOR` (`2.1`). The `CoreVersion` type is DERIVED from the
 * `SUPPORTED_CORE_VERSIONS` set so the type and the runtime list can never disagree.
 *
 * `CURRENT_CORE_VERSION` is what a run defaults to when the caller doesn't specify one — the CLI's
 * `--spec-version` default, so a plain `reso-cert core --url …` certifies the current minor.
 */

/** Core spec versions the runner supports. SOURCE OF TRUTH — the CLI, config parsing, and the scenario
 *  catalog (`scenariosForVersion`) all gate on this. */
export const SUPPORTED_CORE_VERSIONS = ['2.0.0', '2.1.0'] as const;

/** A supported Web API Core version. Derived from the constant. */
export type CoreVersion = (typeof SUPPORTED_CORE_VERSIONS)[number];

/** The current Core version new runs default to (the latest minor). */
export const CURRENT_CORE_VERSION: CoreVersion = '2.1.0';

/** Type guard: is this exact value a supported Core version? Narrows `string` → `CoreVersion` without a cast. */
export const isCoreVersion = (version: string): version is CoreVersion =>
  (SUPPORTED_CORE_VERSIONS as ReadonlyArray<string>).includes(version);
