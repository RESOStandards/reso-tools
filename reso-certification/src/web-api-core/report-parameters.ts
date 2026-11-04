/**
 * What a Web API Core report says was tested, in the shape the certification site renders and the Commander wrote:
 * eleven named parameters, and the authentication method.
 *
 * Each parameter names the field a test actually queried, read from that test's own request, never the field selection
 * started from. The runner moves to another field when a server refuses one, and naming the first would misstate what
 * was tested. A type no test ran on is left out rather than guessed at.
 */
import type { AuthConfig } from '../test-runner/types.js';
import type { ResourceTestReport } from './test-runner.js';

/** The parameter names, in the order every Commander report wrote them. */
export const CORE_PARAMETER_NAMES = [
  'Resource',
  'Key Field',
  'Integer Field',
  'Decimal Field',
  'Single Lookup Field',
  'Single Lookup Value',
  'Multi Lookup Field',
  'Multi Lookup Value 1',
  'Multi Lookup Value 2',
  'Date Field',
  'Timestamp Field'
] as const;

export type CoreParameterName = (typeof CORE_PARAMETER_NAMES)[number];

export interface CoreReportParameter {
  readonly name: CoreParameterName;
  readonly value: string;
}

/** The resource the Commander tested, and so the one a report names when it was tested. */
const PRIMARY_RESOURCE = 'Property';

/** The tests whose request shows each type's field, in order of preference. */
const INTEGER_TESTS = ['filter-int-eq', 'filter-int-gt', 'filter-int-ge', 'filter-int-lt', 'filter-int-le', 'filter-int-ne'];
const DECIMAL_TESTS = ['filter-decimal-gt', 'filter-decimal-ge', 'filter-decimal-lt', 'filter-decimal-le', 'filter-decimal-ne'];
const DATE_TESTS = ['filter-date-eq', 'filter-date-gt', 'filter-date-ge', 'filter-date-lt', 'filter-date-le', 'filter-date-ne'];
const TIMESTAMP_TESTS = ['filter-datetime-gt', 'filter-datetime-ge', 'filter-datetime-lt', 'filter-datetime-le', 'filter-datetime-ne'];
const TIMESTAMP_ORDER_TESTS = ['orderby-timestamp-asc', 'orderby-timestamp-desc'];
const SINGLE_LOOKUP_TESTS = ['filter-string-enum-single-eq', 'filter-enum-single-eq'];
const MULTI_LOOKUP_TESTS = ['filter-string-enum-multi-any', 'filter-enum-multi-has-and', 'filter-coll-enum-any'];

/** The field a filter or ordering begins with: `Field eq …`, `Field has …`, `Field/any(…)`, `Field asc`. */
const LEADING_FIELD = /^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\/(?:any|all)\(|\s+(?:eq|ne|gt|ge|lt|le|has|asc|desc)\b)/;
/** An OData string literal, with `''` standing for one apostrophe. */
const QUOTED = /'((?:[^']|'')*)'/g;

const queryOption = (requestUrl: string | undefined, option: string): string | undefined => {
  if (requestUrl === undefined || !URL.canParse(requestUrl)) return undefined;
  return new URL(requestUrl).searchParams.get(option) ?? undefined;
};

const leadingField = (expression: string | undefined): string | undefined =>
  expression === undefined ? undefined : LEADING_FIELD.exec(expression)?.[1];

const quotedValues = (expression: string): ReadonlyArray<string> =>
  [...expression.matchAll(QUOTED)].map(match => (match[1] ?? '').replace(/''/g, "'"));

/** The first of these tests that ran, whether it passed or failed: either way, its request is what was tested. */
const firstRan = (report: ResourceTestReport, tags: ReadonlyArray<string>) =>
  tags.map(tag => report.scenarios.find(s => s.tag === tag && s.skipped !== true && s.requestUrl !== undefined)).find(s => s !== undefined);

const fieldFrom = (report: ResourceTestReport, tags: ReadonlyArray<string>, option = '$filter'): string | undefined =>
  leadingField(queryOption(firstRan(report, tags)?.requestUrl, option));

const lookupFrom = (report: ResourceTestReport, tags: ReadonlyArray<string>): { field?: string; values: ReadonlyArray<string> } => {
  const filter = queryOption(firstRan(report, tags)?.requestUrl, '$filter');
  return { field: leadingField(filter), values: filter === undefined ? [] : quotedValues(filter) };
};

const entry = (name: CoreParameterName, value: string | undefined): ReadonlyArray<CoreReportParameter> =>
  value === undefined || value === '' ? [] : [{ name, value }];

/**
 * The parameters of the resource a report names: Property when it was tested, as the Commander tested it, and
 * otherwise the first resource tested.
 */
export const coreReportParameters = (reports: ReadonlyArray<ResourceTestReport>): ReadonlyArray<CoreReportParameter> => {
  const report = reports.find(r => r.resource === PRIMARY_RESOURCE) ?? reports[0];
  if (report === undefined) return [];
  const single = lookupFrom(report, SINGLE_LOOKUP_TESTS);
  const multi = lookupFrom(report, MULTI_LOOKUP_TESTS);
  return [
    ...entry('Resource', report.resource),
    ...entry('Key Field', report.params.keyField),
    ...entry('Integer Field', fieldFrom(report, INTEGER_TESTS)),
    ...entry('Decimal Field', fieldFrom(report, DECIMAL_TESTS)),
    ...entry('Single Lookup Field', single.field),
    ...(single.field === undefined ? [] : entry('Single Lookup Value', single.values[0])),
    ...entry('Multi Lookup Field', multi.field),
    ...(multi.field === undefined ? [] : entry('Multi Lookup Value 1', multi.values[0])),
    ...(multi.field === undefined ? [] : entry('Multi Lookup Value 2', multi.values[1])),
    ...entry('Date Field', fieldFrom(report, DATE_TESTS)),
    ...entry('Timestamp Field', fieldFrom(report, TIMESTAMP_TESTS) ?? fieldFrom(report, TIMESTAMP_ORDER_TESTS, '$orderby'))
  ];
};

/** The authentication method, in the words every Commander report used. The method only, never the credential. */
export const coreAuthentication = (auth: AuthConfig): ReadonlyArray<string> =>
  auth.mode === 'client_credentials' ? ['client credentials'] : ['bearer token'];
