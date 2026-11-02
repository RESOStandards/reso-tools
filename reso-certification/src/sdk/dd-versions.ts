/**
 * Data Dictionary versions — the single source of truth.
 *
 * Every other place that used to hard-code a DD version list now imports
 * from here. The canonical set is `SUPPORTED_DD_VERSIONS`; the `DDVersion`
 * type is *derived* from it (so the type and the runtime list can never
 * disagree), and a drift-guard test asserts the set exactly matches the
 * `dd-{ver}.json` reference files on disk.
 *
 * Distinct concerns are kept distinct, not merged:
 *   - SUPPORTED   – versions we ship reference metadata for (the SDK accepts all).
 *   - TESTABLE    – SUPPORTED minus DEPRECATED. The CLI runs these; 1.7 is
 *                   deprecated and still runnable only via the SDK.
 *   - CERTIFIABLE – the latest minor of each testable major. RESO certifies on
 *                   the latest MINOR version within a given MAJOR branch, so a
 *                   run on an older minor is a retest: it runs, and it does not
 *                   certify.
 *   - CURRENT     – the version new work defaults to.
 */

/** Versions we ship reference metadata for. SOURCE OF TRUTH — kept in sync with
 *  `reference-metadata/dd-{ver}.json` by `tests/sdk/dd-versions.test.ts`. */
export const SUPPORTED_DD_VERSIONS = ['1.7', '2.0', '2.1'] as const;

/** A DD version we ship reference metadata for. Derived from the constant. */
export type DDVersion = (typeof SUPPORTED_DD_VERSIONS)[number];

/** Deprecated for certification — the SDK still runs them, the CLI does not.
 *  Per the long-standing policy that RESO no longer certifies DD 1.7. */
export const DEPRECATED_DD_VERSIONS = ['1.7'] as const;
export type DeprecatedDDVersion = (typeof DEPRECATED_DD_VERSIONS)[number];

/** Versions the CLI runs: SUPPORTED minus DEPRECATED. */
export type TestableDDVersion = Exclude<DDVersion, DeprecatedDDVersion>;
export const TESTABLE_DD_VERSIONS: ReadonlyArray<TestableDDVersion> = SUPPORTED_DD_VERSIONS.filter(
  (v): v is TestableDDVersion => !(DEPRECATED_DD_VERSIONS as ReadonlyArray<string>).includes(v)
);

const majorOf = (version: string): string => version.split('.')[0] ?? '';
const minorOf = (version: string): number => Number(version.split('.')[1]);

/**
 * Versions a provider can be certified on: the latest minor of each testable major. Derived, so a
 * new minor's reference metadata moves certification to it without an edit here.
 */
export const CERTIFIABLE_DD_VERSIONS: ReadonlyArray<TestableDDVersion> = TESTABLE_DD_VERSIONS.filter(v =>
  TESTABLE_DD_VERSIONS.every(other => majorOf(other) !== majorOf(v) || minorOf(other) <= minorOf(v))
);

/**
 * Why a run on this version cannot certify, or undefined when it can. An older minor is a retest;
 * a version with no certifiable minor in its major (1.7) is not certified at all.
 */
export const whyDDVersionDoesNotCertify = (version: string): string | undefined => {
  const normalized = normalizeDDVersion(version);
  if ((CERTIFIABLE_DD_VERSIONS as ReadonlyArray<string>).includes(normalized)) return undefined;
  const latest = CERTIFIABLE_DD_VERSIONS.find(v => majorOf(v) === majorOf(normalized));
  return latest
    ? `Certification is on Data Dictionary ${latest}, the latest ${majorOf(latest)}.x. A run on ${normalized} is a retest and is not eligible for certification.`
    : `RESO does not certify Data Dictionary ${normalized}.`;
};

/** The current DD version new work defaults to. */
export const CURRENT_DD_VERSION: DDVersion = '2.1';

/**
 * Normalize a version string to the DD `MAJOR.MINOR` form. DD versions are
 * always two-part (e.g. `2.1`) — unlike Web API Core, which carries a patch
 * (`2.1.0`). Coerces any patch-form value that slipped in from a legacy or
 * imported config back to short form. Pure: no allowlist, no fallback.
 */
export const normalizeDDVersion = (version: string): string => version.split('.').slice(0, 2).join('.');

/**
 * Type guard: is this exact (already-normalized) value a supported DD version?
 * Use it to narrow `string` → `DDVersion` safely instead of an `as` cast:
 *   const v = normalizeDDVersion(input);
 *   if (!isDDVersion(v)) throw …;  // v is now DDVersion
 */
export const isDDVersion = (version: string): version is DDVersion => (SUPPORTED_DD_VERSIONS as ReadonlyArray<string>).includes(version);

/** Type guard: is this exact value a version the CLI runs (supported, not deprecated)? */
export const isTestableDDVersion = (version: string): version is TestableDDVersion =>
  (TESTABLE_DD_VERSIONS as ReadonlyArray<string>).includes(version);

/** Type guard: is this exact value a version a provider can be certified on (the latest minor)? */
export const isCertifiableDDVersion = (version: string): version is TestableDDVersion =>
  (CERTIFIABLE_DD_VERSIONS as ReadonlyArray<string>).includes(version);

/** Patch-tolerant convenience: normalize, then test support. Boolean (not a guard). */
export const isSupportedDDVersion = (version: string): boolean => isDDVersion(normalizeDDVersion(version));

/**
 * Coerce arbitrary input (possibly `undefined`, patch-form, or unknown) to a
 * valid `DDVersion`, falling back to the current version. For parsing config
 * files and other untrusted input where a sensible default is wanted — not for
 * UI/CLI selection, which gate on `isDDVersion` / `isCertifiableDDVersion`.
 */
export const coerceDDVersion = (version: string | undefined): DDVersion => {
  if (version == null) return CURRENT_DD_VERSION;
  const normalized = normalizeDDVersion(version);
  return isDDVersion(normalized) ? normalized : CURRENT_DD_VERSION;
};
