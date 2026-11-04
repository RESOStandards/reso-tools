import { describe, expect, it } from 'vitest';
import { coreAuthentication, coreReportParameters } from '../../src/web-api-core/report-parameters.js';
import type { TestParams } from '../../src/web-api-core/sampling.js';
import type { ResourceTestReport, ScenarioResult } from '../../src/web-api-core/test-runner.js';

/**
 * What a Core report says was tested, in the shape the certification site renders and the Commander wrote: eleven
 * named parameters, the OData version and the authentication method. Each parameter names the field a test actually
 * queried, read from that test's request, never the field selection started from: the runner moves to another field
 * when a server refuses one, and naming the first would misstate what was tested.
 */

const url = (filter: string, select = 'ListingKey'): string =>
  `https://api.example.test/Property?$filter=${encodeURIComponent(filter)}&$select=${select}`;

const ran = (tag: string, requestUrl: string, passed = true): ScenarioResult =>
  ({ tag, name: tag, passed, skipped: false, requestUrl, assertions: [], duration: 0 }) as ScenarioResult;
const skipped = (tag: string): ScenarioResult =>
  ({ tag, name: tag, passed: false, skipped: true, assertions: [], duration: 0 }) as ScenarioResult;

const report = (resource: string, scenarios: ReadonlyArray<ScenarioResult>, params: Partial<TestParams> = {}) =>
  ({ resource, params: { keyField: 'ListingKey', skippedTypes: [], ...params } as TestParams, scenarios }) as unknown as ResourceTestReport;

const everyType = [
  ran('fetch-by-key', "https://api.example.test/Property('abc')"),
  ran('filter-int-eq', url('BedroomsTotal eq 3')),
  ran('filter-decimal-gt', url('ListPrice gt 250000.5')),
  ran('filter-string-enum-single-eq', url("StandardStatus eq 'Active'")),
  ran('filter-string-enum-multi-any', url("InteriorFeatures/any(x:x eq 'Garden Bath' or x eq 'Outside Shower')")),
  ran('filter-date-eq', url('ListingContractDate eq 2024-05-01')),
  ran('filter-datetime-gt', url('ModificationTimestamp gt 2024-05-01T00:00:00Z'))
];

describe('the parameters a Core report names', () => {
  it('names all eleven in the order the Commander wrote them, from the tests that ran', () => {
    expect(coreReportParameters([report('Property', everyType)])).toEqual([
      { name: 'Resource', value: 'Property' },
      { name: 'Key Field', value: 'ListingKey' },
      { name: 'Integer Field', value: 'BedroomsTotal' },
      { name: 'Decimal Field', value: 'ListPrice' },
      { name: 'Single Lookup Field', value: 'StandardStatus' },
      { name: 'Single Lookup Value', value: 'Active' },
      { name: 'Multi Lookup Field', value: 'InteriorFeatures' },
      { name: 'Multi Lookup Value 1', value: 'Garden Bath' },
      { name: 'Multi Lookup Value 2', value: 'Outside Shower' },
      { name: 'Date Field', value: 'ListingContractDate' },
      { name: 'Timestamp Field', value: 'ModificationTimestamp' }
    ]);
  });

  it('names the field a test queried, not the one selection started from', () => {
    // Selection started on DaysOnMarket; the server refused it and the runner certified on BedroomsTotal.
    const params = coreReportParameters([report('Property', everyType, { integerField: 'DaysOnMarket' })]);
    expect(params.find(p => p.name === 'Integer Field')?.value).toBe('BedroomsTotal');
  });

  it('leaves out a type no test ran on, rather than guess at it', () => {
    const noMulti = [...everyType.filter(s => s.tag !== 'filter-string-enum-multi-any'), skipped('filter-string-enum-multi-any')];
    const names = coreReportParameters([report('Property', noMulti)]).map(p => p.name);
    expect(names).not.toContain('Multi Lookup Field');
    expect(names).not.toContain('Multi Lookup Value 1');
    expect(names).toContain('Integer Field');
  });

  it('reads an enumeration flags test and unescapes a quoted value', () => {
    const params = coreReportParameters([
      report('Property', [
        ran('filter-enum-multi-has-and', url("AccessibilityFeatures has 'Accessible Entrance' and AccessibilityFeatures has 'Visitable'")),
        ran('filter-enum-single-eq', url("City eq 'Coeur d''Alene'"))
      ])
    ]);
    expect(params).toEqual(
      expect.arrayContaining([
        { name: 'Multi Lookup Field', value: 'AccessibilityFeatures' },
        { name: 'Multi Lookup Value 1', value: 'Accessible Entrance' },
        { name: 'Multi Lookup Value 2', value: 'Visitable' },
        { name: 'Single Lookup Value', value: "Coeur d'Alene" }
      ])
    );
  });

  it('takes the timestamp field from the ordering test when no timestamp filter ran', () => {
    const ordered = ran(
      'orderby-timestamp-asc',
      'https://api.example.test/Property?$orderby=ModificationTimestamp%20asc&$select=ListingKey'
    );
    expect(coreReportParameters([report('Property', [ordered])]).find(p => p.name === 'Timestamp Field')?.value).toBe(
      'ModificationTimestamp'
    );
  });

  it('reports Property when it was tested, as the Commander did, and otherwise the first resource tested', () => {
    expect(coreReportParameters([report('Member', everyType), report('Property', everyType)])[0]).toEqual({
      name: 'Resource',
      value: 'Property'
    });
    expect(coreReportParameters([report('Member', everyType), report('Office', everyType)])[0]).toEqual({
      name: 'Resource',
      value: 'Member'
    });
    expect(coreReportParameters([])).toEqual([]);
  });
});

describe('the authentication a Core report names', () => {
  it('is the method, in the words the Commander wrote, and never the credential', () => {
    expect(coreAuthentication({ mode: 'token', authToken: '<sentinel_token>' })).toEqual(['bearer token']);
    expect(
      coreAuthentication({
        mode: 'client_credentials',
        clientId: 'c',
        clientSecret: '<sentinel_secret>',
        tokenUrl: 'https://auth.example.test'
      })
    ).toEqual(['client credentials']);
  });
});
