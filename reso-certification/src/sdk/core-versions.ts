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

/** Split a dotted version into numeric segments; a missing or non-numeric segment reads as 0. Tolerates both
 *  two-part (`2.1`) and three-part (`2.1.0`) input so a comparison never hinges on the exact string shape. */
const versionSegments = (version: string): ReadonlyArray<number> =>
  version.split('.').map((segment) => Number.parseInt(segment, 10) || 0);

/** `true` when `version` is greater than or equal to `target` by numeric segment comparison. Shape-tolerant:
 *  `coreVersionGte('2.1', '2.1.0')` is `true`. This is the ONE comparator every version-gated branch routes
 *  through — a future DD comparator / general semver comparator can be lifted from this shape (see the module
 *  header). */
export const coreVersionGte = (version: string, target: string): boolean => {
  const actual = versionSegments(version);
  const required = versionSegments(target);
  const width = Math.max(actual.length, required.length);
  const firstDifference = Array.from({ length: width }, (_, i) => (actual[i] ?? 0) - (required[i] ?? 0)).find(
    (delta) => delta !== 0,
  );
  return (firstDifference ?? 0) >= 0;
};

/** `true` for Core 2.1.0 and later — the version line that introduced the serving-mask, empty-required-resource
 *  routing, and $expand schema-validation carve-outs. Core 2.0.0 predates all three. The SINGLE boundary
 *  predicate every 2.1.0-gated branch shares, so the boundary literal lives in exactly one place. */
export const isCore21OrLater = (version: string): boolean => coreVersionGte(version, '2.1.0');

/** Normalize any caller-supplied version string to a canonical {@link CoreVersion}. Config sources hand the Core
 *  version over in DD's two-part shape (`2.1`) as often as the canonical three-part (`2.1.0`); both MUST resolve
 *  to the exact `CoreVersion` literal the gates compare against. A bare `as CoreVersion` cast previously let
 *  `'2.1'` masquerade as valid, which silently disabled every 2.1.0-gated branch (the $expand validator among
 *  them). Matches by MAJOR.MINOR against {@link SUPPORTED_CORE_VERSIONS}; an absent or unrecognizable version
 *  falls back to {@link CURRENT_CORE_VERSION} — the current minor. That means an unrecognized-because-NEWER
 *  version (e.g. a future `2.2` not yet in the supported set) certifies under the strictest known profile rather
 *  than silently downgrading to the oldest baseline, which would be a false-PASS (skipping every 2.1.0 gate). */
export const coerceCoreVersion = (version: string | undefined): CoreVersion => {
  if (version && isCoreVersion(version)) return version;
  const [major, minor] = (version ?? '').split('.');
  const match = SUPPORTED_CORE_VERSIONS.find((candidate) => {
    const [candidateMajor, candidateMinor] = candidate.split('.');
    return candidateMajor === major && candidateMinor === minor;
  });
  return match ?? CURRENT_CORE_VERSION;
};
