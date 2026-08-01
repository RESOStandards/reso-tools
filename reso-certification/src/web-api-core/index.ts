/**
 * Web API Core compliance testing — native TypeScript implementation.
 *
 * Replaces the Java-based web-api-commander with a data-driven test runner
 * built on reso-client. Supports both v2.0.0 and v2.1.0.
 */

export { allScenarios, scenariosForVersion } from './scenarios.js';
export type { CoreScenario } from './scenarios.js';
export { resolveTestParams, detectEnumMode, WELL_KNOWN_RESOURCES, REQUIRED_RESOURCES_V21 } from './sampling.js';
export type { TestParams, EnumMode } from './sampling.js';
export { buildStandardMap, buildStandardMapFrom } from './standard-map.js';
export type { StandardMap } from './standard-map.js';
export { selectEnumCandidates, isSingleRep, isMultiRep } from './enum-selection.js';
export type { EnumCandidate } from './enum-selection.js';
export { buildScenarioQuery } from './queries.js';
export type { QuerySpec } from './queries.js';
export { runCoreResourceScenarios } from './test-runner.js';
export type { ScenarioResult, ResourceTestReport, TypeCoverage } from './test-runner.js';
export {
  assertScalarComparison,
  assertSortOrder,
  assertEnumMatch,
  assertCollectionLambda,
  assertODataResponse,
  assertHasResults,
  assertStringComparison,
  extractRecords,
  extractCount,
  extractNextLink,
} from './assertions.js';
export type { AssertionResult } from './assertions.js';
