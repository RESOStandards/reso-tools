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
 *   - SUPPORTED   — versions we ship reference metadata for (the SDK accepts all).
 *   - CERTIFIABLE — SUPPORTED minus DEPRECATED. The CLI enforces this; 1.7 is
 *                   deprecated for certification but still runnable via the SDK.
 *   - CURRENT     — the version new work defaults to.
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

/** Versions a provider can be certified on: SUPPORTED minus DEPRECATED. */
export type CertifiableDDVersion = Exclude<DDVersion, DeprecatedDDVersion>;
export const CERTIFIABLE_DD_VERSIONS: ReadonlyArray<CertifiableDDVersion> =
  SUPPORTED_DD_VERSIONS.filter(
    (v): v is CertifiableDDVersion => !(DEPRECATED_DD_VERSIONS as ReadonlyArray<string>).includes(v),
  );

/** The current DD version new work defaults to. */
export const CURRENT_DD_VERSION: DDVersion = '2.1';

/**
 * Normalize a version string to the DD `MAJOR.MINOR` form. DD versions are
 * always two-part (e.g. `2.1`) — unlike Web API Core, which carries a patch
 * (`2.1.0`). Coerces any patch-form value that slipped in from a legacy or
 * imported config back to short form. Pure: no allowlist, no fallback.
 */
export const normalizeDDVersion = (version: string): string =>
  version.split('.').slice(0, 2).join('.');

/**
 * Type guard: is this exact (already-normalized) value a supported DD version?
 * Use it to narrow `string` → `DDVersion` safely instead of an `as` cast:
 *   const v = normalizeDDVersion(input);
 *   if (!isDDVersion(v)) throw …;  // v is now DDVersion
 */
export const isDDVersion = (version: string): version is DDVersion =>
  (SUPPORTED_DD_VERSIONS as ReadonlyArray<string>).includes(version);

/** Type guard: is this exact value a certifiable DD version (supported, not deprecated)? */
export const isCertifiableDDVersion = (version: string): version is CertifiableDDVersion =>
  (CERTIFIABLE_DD_VERSIONS as ReadonlyArray<string>).includes(version);

/** Patch-tolerant convenience: normalize, then test support. Boolean (not a guard). */
export const isSupportedDDVersion = (version: string): boolean =>
  isDDVersion(normalizeDDVersion(version));

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
