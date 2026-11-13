/**
 * Full type coverage: every data type the Core tests exercise, met on some field of some resource tested (Josh,
 * 2026-11-03: "The server doesn't have to provide every type on the same resource, just that each one has to be met on
 * some field on some resource").
 *
 * All data types are required for Web API Core when the server has them, whether in standard or local fields (Josh,
 * 2026-11-12). A type the server declares on a resource tested (declared-types.ts) must be met and its required tests
 * must pass. The run tries to meet it by scanning; when it cannot, the server has to name the field to use, and the
 * reason suggests the most populated ones ("we will try and autoscan and pass, if we can't and they have that type we
 * couldn't pass on, they need to provide that info"). A type no resource tested declares is skipped: "if they don't
 * have the type at all it can be skipped", "but we must never have seen them".
 *
 * `--full-coverage` is the strict mode: every type met, none excused. Core 2.0.0 needed every type on one resource, so
 * testing as it did is naming that resource and requiring full coverage, and, for full equivalence, naming the fields
 * the 2.0.0 report used as overrides (Josh, 2026-11-03).
 */
import type { CoreScenario } from './scenarios.js';
import type { ScenarioResult, TypeCoverage } from './test-runner.js';

/** The data types the Core tests exercise, in the order a report lists them. */
export const CORE_TYPES = ['integer', 'decimal', 'date', 'timestamp', 'singleLookup', 'multiLookup'] as const;

/** A field that declares a missing type, as `Resource.Field`, with its population where its resource was sampled. */
export interface SuggestedField {
  readonly field: string;
  /** Sampled records holding a value in it. Absent when its resource was not tested: name the resource to test it. */
  readonly populated?: number;
  /** Records sampled from its resource. */
  readonly sampled?: number;
}

/** A type the server declares that the run did not meet, with the fields to name for it, most populated first. */
export interface DeclaredNotMet {
  readonly type: string;
  readonly fields: ReadonlyArray<SuggestedField>;
}

/** A required test of a type the server declares and the run met, that passed on no resource tested, and why. */
export interface TestNotPassed {
  readonly type: string;
  readonly tag: string;
  readonly name: string;
  readonly reason: string;
}

export interface TypeCoverageVerdict {
  readonly coveredTypes: ReadonlyArray<string>;
  readonly missingTypes: ReadonlyArray<string>;
  readonly fullCoverage: boolean;
  /** Missing types the server declares: each fails the run until the server names a field for it. */
  readonly declaredNotMet: ReadonlyArray<DeclaredNotMet>;
  /** Required tests of a met type that passed nowhere for a reason other than not applying: each fails the run. */
  readonly testsNotPassed: ReadonlyArray<TestNotPassed>;
}

/** The type a scenario exercises, from the field slot it reads. Scenarios with no type slot return undefined. */
const FIELD_PARAM_TYPE: Readonly<Record<string, string>> = {
  integerField: 'integer',
  decimalField: 'decimal',
  dateField: 'date',
  timestampField: 'timestamp',
  singleLookupField: 'singleLookup',
  multiLookupField: 'multiLookup'
};

type ReportWithScenarios = {
  readonly resource: string;
  readonly coverage: ReadonlyArray<TypeCoverage>;
  readonly scenarios?: ReadonlyArray<ScenarioResult>;
  readonly params?: { readonly sampleRecordCount?: number };
};

/**
 * A resource the server declares that the run did not sample (left out, not named, or not tested), with the types its
 * metadata declares. Its types count as seen ("we must never have seen them"); with no sample, it can only be named.
 */
export interface UnsampledResource {
  readonly resource: string;
  readonly declared: ReadonlyArray<{ readonly type: string; readonly fields: ReadonlyArray<{ readonly field: string }> }>;
}

/**
 * The required tests of each met type that never passed (Josh, 2026-11-12: "if they have that type in at least one
 * field, it's a fail if they don't pass on it"; "that pass can be in a standard or local field, it must pass"). A test
 * that ran somewhere either passed or failed, and a failure already fails the run. A test skipped everywhere is excused
 * only when every skip says why it does not count (`skipKind`: it does not apply to this server, the deadline stopped
 * it, or an earlier failure already fails the run); any other skip did not pass. A test no resource ran at all was not
 * selected for this server, because it targets a representation the server does not use (the `Edm.EnumType` tests on a
 * server whose lookups are strings), so it does not apply: two real certified runs replayed on 2026-11-12 had eight such
 * tests each, and none was a gap. A type that was not met is reported once, as declared and not met, not again test by
 * test.
 */
const testsNotPassedOf = (
  scenarios: ReadonlyArray<CoreScenario>,
  reports: ReadonlyArray<ReportWithScenarios>,
  metTypes: ReadonlyArray<string>
): ReadonlyArray<TestNotPassed> =>
  scenarios.flatMap(scenario => {
    const type = 'fieldParam' in scenario && typeof scenario.fieldParam === 'string' ? FIELD_PARAM_TYPE[scenario.fieldParam] : undefined;
    if (type === undefined || scenario.optional || !metTypes.includes(type)) return [];
    const results = reports.flatMap(r => (r.scenarios ?? []).filter(result => result.tag === scenario.tag));
    if (results.some(result => !result.skipped)) return [];
    if (results.every(result => result.skipKind !== undefined)) return [];
    const reason = results.find(result => result.skipKind === undefined)?.skipReason ?? 'skipped';
    return [{ type, tag: scenario.tag, name: scenario.name, reason }];
  });

/** The fields to name for a type, sampled ones most populated first, then those on resources the run did not sample. */
const suggestionsFor = (
  type: string,
  reports: ReadonlyArray<ReportWithScenarios>,
  unsampled: ReadonlyArray<UnsampledResource>
): ReadonlyArray<SuggestedField> => {
  const sampled = reports
    .flatMap(r =>
      r.coverage
        .filter(c => c.type === type)
        .flatMap(c =>
          (c.declaredBy ?? []).map(({ field, populated }) => ({
            field: `${r.resource}.${field}`,
            populated,
            sampled: r.params?.sampleRecordCount ?? 0
          }))
        )
    )
    .sort((a, b) => b.populated - a.populated || a.field.localeCompare(b.field));
  const notSampled = unsampled.flatMap(u =>
    u.declared.filter(d => d.type === type).flatMap(d => d.fields.map(({ field }) => ({ field: `${u.resource}.${field}` })))
  );
  return [...sampled, ...notSampled];
};

/**
 * Which types a run met, which missing types the server declares, and which tests of a met type did not pass. A type is
 * met when any resource tested met it. Without the run's scenarios, no test is judged.
 */
export const typeCoverageOf = (
  reports: ReadonlyArray<ReportWithScenarios>,
  scenarios: ReadonlyArray<CoreScenario> = [],
  unsampled: ReadonlyArray<UnsampledResource> = []
): TypeCoverageVerdict => {
  const coveredTypes = CORE_TYPES.filter(type => reports.some(r => r.coverage.some(c => c.type === type && c.hasData)));
  const missingTypes = CORE_TYPES.filter(type => !coveredTypes.includes(type));
  const declaredNotMet = missingTypes.flatMap(type => {
    const fields = suggestionsFor(type, reports, unsampled);
    return fields.length > 0 ? [{ type, fields }] : [];
  });
  return {
    coveredTypes,
    missingTypes,
    fullCoverage: missingTypes.length === 0,
    declaredNotMet,
    testsNotPassed: testsNotPassedOf(scenarios, reports, coveredTypes)
  };
};

/**
 * Whether coverage fails the run. Strict (`--full-coverage`): any missing type. Otherwise: any missing type the server
 * declares. Either way, a required test of a met type that did not pass. A run that tested no record measured nothing,
 * and fails for that reason instead, so it is never a coverage failure.
 */
export const coverageFails = (verdict: TypeCoverageVerdict, requireFullCoverage: boolean, recordsTested: boolean): boolean =>
  recordsTested && ((requireFullCoverage ? !verdict.fullCoverage : verdict.declaredNotMet.length > 0) || verdict.testsNotPassed.length > 0);

/** What a failure says first (Josh, 2026-11-12: "We can tell people that all types are required for Core if the server
 *  has them, whether in standard or local fields", "as the reason for the failure"). */
export const TYPES_REQUIRED = 'All data types are required for Web API Core when the server has them, whether in standard or local fields';

/** How many fields a reason suggests per type ("a list of top N fields based on population"); the report holds all. */
export const FIELDS_SUGGESTED = 5;

const suggestion = ({ field, populated, sampled }: SuggestedField): string =>
  populated === undefined
    ? `${field} (its resource was not tested: name it with --resources)`
    : `${field} (${populated.toLocaleString('en-US')} of ${(sampled ?? 0).toLocaleString('en-US')} sampled records)`;

const suggestions = (fields: ReadonlyArray<SuggestedField>): string =>
  `${fields.slice(0, FIELDS_SUGGESTED).map(suggestion).join(', ')}${
    fields.length > FIELDS_SUGGESTED ? `, and ${fields.length - FIELDS_SUGGESTED} more in the report` : ''
  }`;

const NAME_A_FIELD = 'Name the field to test with --field-overrides (coreOptions.fieldOverrides in a configuration file)';

/** Why coverage failed, one reason per type, in the words the provider sees. */
export const coverageFailureReasons = (verdict: TypeCoverageVerdict, requireFullCoverage: boolean): ReadonlyArray<string> => {
  const strict =
    requireFullCoverage && !verdict.fullCoverage ? [`Full coverage required but missing types: ${verdict.missingTypes.join(', ')}`] : [];
  const notMet = requireFullCoverage
    ? []
    : verdict.declaredNotMet.map(({ type, fields }) => {
        const needs = type === 'multiLookup' ? ' A multi-valued lookup needs a field holding two different values.' : '';
        return `${TYPES_REQUIRED}. The server declares ${type}, and the run could not sample a field of it.${needs} ${NAME_A_FIELD}. Most populated: ${suggestions(fields)}`;
      });
  const notPassed = [...new Set(verdict.testsNotPassed.map(test => test.type))].map(type => {
    const tests = verdict.testsNotPassed.filter(test => test.type === type).map(test => `"${test.name}" (${test.reason})`);
    return `${TYPES_REQUIRED}. The server declares ${type}, and these tests did not pass on it: ${tests.join(', ')}. ${NAME_A_FIELD} that can carry them`;
  });
  return [...strict, ...notMet, ...notPassed];
};
