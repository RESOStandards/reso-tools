/**
 * Full type coverage (Josh, 2026-11-03): every data type the Core tests exercise, met on some field of some resource
 * tested ("The server doesn't have to provide every type on the same resource, just that each one has to be met on
 * some field on some resource"). The old Commander required an element for each type.
 *
 * Every run measures it and its report records it, so a certification says whether it was achieved: "Full Type
 * Coverage Achieved", or "Could Not Be Achieved" for a server that cannot provide a type. It decides a run's outcome
 * only with `--full-coverage`. On Core 2.0.0 only Property counts, the Commander's own scope.
 */
import type { CoreVersion } from '../sdk/core-versions.js';
import type { TypeCoverage } from './test-runner.js';

/** The data types the Core tests exercise, in the order a report lists them. */
export const CORE_TYPES = ['integer', 'decimal', 'date', 'timestamp', 'singleLookup', 'multiLookup'] as const;

/** The one resource Core 2.0.0 is tested on, as the Commander tested it. */
export const CORE_2_0_0_RESOURCE = 'Property';

export interface TypeCoverageVerdict {
  readonly coveredTypes: ReadonlyArray<string>;
  readonly missingTypes: ReadonlyArray<string>;
  readonly fullCoverage: boolean;
}

/**
 * Which types a run met. On Core 2.1.0 a type is met when any resource tested met it. On Core 2.0.0 only Property
 * counts, so a type met only on another resource is not met.
 */
export const typeCoverageOf = (
  reports: ReadonlyArray<{ readonly resource: string; readonly coverage: ReadonlyArray<TypeCoverage> }>,
  version: CoreVersion
): TypeCoverageVerdict => {
  const counted = version === '2.0.0' ? reports.filter(r => r.resource === CORE_2_0_0_RESOURCE) : reports;
  const coveredTypes = CORE_TYPES.filter(type => counted.some(r => r.coverage.some(c => c.type === type && c.hasData)));
  const missingTypes = CORE_TYPES.filter(type => !coveredTypes.includes(type));
  return { coveredTypes, missingTypes, fullCoverage: missingTypes.length === 0 };
};
