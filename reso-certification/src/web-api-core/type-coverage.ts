/**
 * Full type coverage (Josh, 2026-11-03): every data type the Core tests exercise, met on some field of some resource
 * tested ("The server doesn't have to provide every type on the same resource, just that each one has to be met on
 * some field on some resource").
 *
 * Every run measures it and its report records it, so a certification says whether it was achieved. A server that
 * cannot meet every type in its standard or local fields is recorded as not having achieved it, and can still be
 * certified. It decides a run's outcome only with `--full-coverage`. Core 2.0.0 needed every type on one resource:
 * testing as it did is naming that resource and requiring full coverage, and, for full equivalence, naming the fields
 * the 2.0.0 report used as overrides (Josh, 2026-11-03).
 */
import type { TypeCoverage } from './test-runner.js';

/** The data types the Core tests exercise, in the order a report lists them. */
export const CORE_TYPES = ['integer', 'decimal', 'date', 'timestamp', 'singleLookup', 'multiLookup'] as const;

export interface TypeCoverageVerdict {
  readonly coveredTypes: ReadonlyArray<string>;
  readonly missingTypes: ReadonlyArray<string>;
  readonly fullCoverage: boolean;
}

/** Which types a run met: a type is met when any resource tested met it. */
export const typeCoverageOf = (
  reports: ReadonlyArray<{ readonly resource: string; readonly coverage: ReadonlyArray<TypeCoverage> }>
): TypeCoverageVerdict => {
  const coveredTypes = CORE_TYPES.filter(type => reports.some(r => r.coverage.some(c => c.type === type && c.hasData)));
  const missingTypes = CORE_TYPES.filter(type => !coveredTypes.includes(type));
  return { coveredTypes, missingTypes, fullCoverage: missingTypes.length === 0 };
};
