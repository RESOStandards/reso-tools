/**
 * Full type coverage: every data type the Core tests exercise, met on some field of some resource tested (Josh,
 * 2026-11-03: "The server doesn't have to provide every type on the same resource, just that each one has to be met on
 * some field on some resource").
 *
 * It is required for certification (Josh, 2026-11-03: "For Cert, full coverage needs to be achieved across all types
 * for a Core server to be considered compliant"; 2026-11-12: "that's a must"). The one exception is a type the server
 * cannot fulfill: "a server who can't fulfill all types in their standard or local fields is just recorded as not
 * having achieved full type coverage, but can still be certified". So by default a type the server PROVIDES on a
 * resource tested (provided-types.ts) and met nowhere fails the run, and a type it provides nowhere is recorded.
 *
 * `--full-coverage` is the strict mode: every type met, none excused. Core 2.0.0 needed every type on one resource, so
 * testing as it did is naming that resource and requiring full coverage, and, for full equivalence, naming the fields
 * the 2.0.0 report used as overrides (Josh, 2026-11-03).
 */
import type { TypeCoverage } from './test-runner.js';

/** The data types the Core tests exercise, in the order a report lists them. */
export const CORE_TYPES = ['integer', 'decimal', 'date', 'timestamp', 'singleLookup', 'multiLookup'] as const;

/** A type the server provides that the run did not meet, with the fields that provide it, as `Resource.Field`. */
export interface ProvidedNotMet {
  readonly type: string;
  readonly fields: ReadonlyArray<string>;
}

export interface TypeCoverageVerdict {
  readonly coveredTypes: ReadonlyArray<string>;
  readonly missingTypes: ReadonlyArray<string>;
  readonly fullCoverage: boolean;
  /** Missing types the server provides on a resource tested: each fails full type coverage. */
  readonly providedNotMet: ReadonlyArray<ProvidedNotMet>;
}

/** Which types a run met, and which missing ones the server provides. A type is met when any resource tested met it. */
export const typeCoverageOf = (
  reports: ReadonlyArray<{ readonly resource: string; readonly coverage: ReadonlyArray<TypeCoverage> }>
): TypeCoverageVerdict => {
  const coveredTypes = CORE_TYPES.filter(type => reports.some(r => r.coverage.some(c => c.type === type && c.hasData)));
  const missingTypes = CORE_TYPES.filter(type => !coveredTypes.includes(type));
  const providedNotMet = missingTypes.flatMap(type => {
    const fields = reports.flatMap(r =>
      r.coverage.filter(c => c.type === type).flatMap(c => (c.providedBy ?? []).map(field => `${r.resource}.${field}`))
    );
    return fields.length > 0 ? [{ type, fields }] : [];
  });
  return { coveredTypes, missingTypes, fullCoverage: missingTypes.length === 0, providedNotMet };
};

/**
 * Whether coverage fails the run. Strict (`--full-coverage`): any missing type. Otherwise: any missing type the server
 * provides. A run that tested no record measured nothing, and fails for that reason instead, so it is never a coverage
 * failure.
 */
export const coverageFails = (verdict: TypeCoverageVerdict, requireFullCoverage: boolean, recordsTested: boolean): boolean =>
  recordsTested && (requireFullCoverage ? !verdict.fullCoverage : verdict.providedNotMet.length > 0);

/** At most this many providing fields are named per type in a reason; the report holds them all. */
const FIELDS_NAMED = 3;

/** Why coverage failed, one reason per type, in the words the provider sees. */
export const coverageFailureReasons = (verdict: TypeCoverageVerdict, requireFullCoverage: boolean): ReadonlyArray<string> =>
  requireFullCoverage
    ? [`Full coverage required but missing types: ${verdict.missingTypes.join(', ')}`]
    : verdict.providedNotMet.map(({ type, fields }) => {
        const named = fields.slice(0, FIELDS_NAMED).join(', ');
        const more = fields.length > FIELDS_NAMED ? ` and ${fields.length - FIELDS_NAMED} more` : '';
        return `Full type coverage not achieved: the server provides ${type} in ${named}${more}, and the run met no ${type}`;
      });
