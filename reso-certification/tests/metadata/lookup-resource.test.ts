import type { MetadataReport } from '@reso-standards/reso-metadata-utils';
import { describe, expect, it } from 'vitest';
import {
  fetchLookupResource,
  mergeWithLookupResource,
  serializeLookupResourceDump,
  synthesizeLookupResourceRecords
} from '../../src/metadata/lookup-resource.js';
import type { RawLookupRecord } from '../../src/metadata/lookup-resource.js';
import type { ODataRequester } from '../../src/test-runner/index.js';

const baseReport: MetadataReport = {
  // `actions` and `functions` are required on MetadataReport. The fixture omitted both, which only
  // went unnoticed because this file was never typechecked.
  actions: [],
  functions: [],
  description: 'RESO Data Dictionary Metadata Report',
  version: '2.0',
  generatedOn: '2026-04-06T00:00:00.000Z',
  resources: [{ resourceName: 'Property' }],
  fields: [
    {
      resourceName: 'Property',
      fieldName: 'ListingKey',
      type: 'Edm.String',
      annotations: []
    },
    {
      resourceName: 'Property',
      fieldName: 'StandardStatus',
      type: 'Edm.String',
      isEnumeration: true,
      annotations: [{ term: 'RESO.OData.Metadata.LookupName', value: 'StandardStatus' }]
    },
    {
      resourceName: 'Property',
      fieldName: 'InteriorFeatures',
      type: 'Edm.String',
      isCollection: true,
      isEnumeration: true,
      annotations: [{ term: 'RESO.OData.Metadata.LookupName', value: 'InteriorFeatures' }]
    }
  ],
  lookups: []
};

const lookupRecords: ReadonlyArray<RawLookupRecord> = [
  {
    LookupName: 'StandardStatus',
    LookupValue: 'Active',
    StandardLookupValue: 'Active',
    LegacyODataValue: 'Active',
    ModificationTimestamp: '2021-07-09T01:14:09Z',
    LookupKey: '103-456188-2106739-8419115'
  },
  {
    LookupName: 'StandardStatus',
    LookupValue: 'Pending',
    StandardLookupValue: 'Pending',
    LegacyODataValue: null,
    ModificationTimestamp: '2021-07-09T01:14:09Z',
    LookupKey: '103-456188-2106739-8419116'
  },
  {
    LookupName: 'InteriorFeatures',
    LookupValue: 'Garden Bath',
    StandardLookupValue: 'Garden Bath',
    LegacyODataValue: 'GardenBath',
    ModificationTimestamp: '2021-07-09T01:14:09Z',
    LookupKey: '103-456188-2106739-8419117'
  }
];

describe('mergeWithLookupResource', () => {
  const merged = mergeWithLookupResource(baseReport, lookupRecords);

  it('preserves base report metadata', () => {
    expect(merged.description).toBe(baseReport.description);
    expect(merged.version).toBe(baseReport.version);
    expect(merged.resources).toEqual(baseReport.resources);
  });

  it('replaces field type with LookupName for annotated fields', () => {
    const status = merged.fields.find(f => f.fieldName === 'StandardStatus');
    expect(status?.type).toBe('StandardStatus');
  });

  it('replaces field type for collection lookup fields', () => {
    const interior = merged.fields.find(f => f.fieldName === 'InteriorFeatures');
    expect(interior?.type).toBe('InteriorFeatures');
  });

  it('does not modify non-lookup fields', () => {
    const key = merged.fields.find(f => f.fieldName === 'ListingKey');
    expect(key?.type).toBe('Edm.String');
  });

  it('adds transformed lookup records', () => {
    expect(merged.lookups).toHaveLength(3);
  });

  it('lookup records have correct shape', () => {
    const active = merged.lookups.find(l => l.lookupValue === 'Active');
    expect(active).toBeDefined();
    expect(active!.lookupName).toBe('StandardStatus');
    expect(active!.type).toBe('Edm.String');
  });

  it('includes StandardName annotation when present', () => {
    const active = merged.lookups.find(l => l.lookupValue === 'Active');
    expect(active!.annotations).toBeDefined();
    expect(active!.annotations!.some(a => a.term === 'RESO.OData.Metadata.StandardName')).toBe(true);
  });

  it('includes LegacyODataValue annotation when present', () => {
    const gardenBath = merged.lookups.find(l => l.lookupValue === 'Garden Bath');
    expect(gardenBath!.annotations).toBeDefined();
    expect(gardenBath!.annotations!.some(a => a.term === 'RESO.OData.Metadata.LegacyODataValue')).toBe(true);
  });

  it('omits annotations array when no annotations present', () => {
    const pending = merged.lookups.find(l => l.lookupValue === 'Pending');
    // Pending has StandardLookupValue but no LegacyODataValue
    expect(pending).toBeDefined();
    // Should have StandardName annotation
    expect(pending!.annotations).toBeDefined();
  });

  it('preserves existing lookups from base report', () => {
    const baseWithLookups: MetadataReport = {
      ...baseReport,
      lookups: [{ lookupName: 'ExistingLookup', lookupValue: 'Value1', type: 'Edm.Int32' }]
    };
    const result = mergeWithLookupResource(baseWithLookups, lookupRecords);
    expect(result.lookups).toHaveLength(4); // 1 existing + 3 new
    expect(result.lookups[0].lookupName).toBe('ExistingLookup');
  });
});

describe('synthesizeLookupResourceRecords', () => {
  const enumField = (fieldName: string, lookupName: string) => ({
    resourceName: 'Property',
    fieldName,
    type: `org.reso.metadata.enums.${lookupName}`,
    isEnumeration: true,
    annotations: []
  });

  it('synthesizes records from standard lookup values (short LookupName + StandardLookupValue)', () => {
    const report: MetadataReport = {
      ...baseReport,
      fields: [enumField('StandardStatus', 'StandardStatus')],
      lookups: [
        {
          lookupName: 'org.reso.metadata.enums.StandardStatus',
          lookupValue: 'ActiveUnderContract',
          type: 'Edm.Int32',
          annotations: [{ term: 'RESO.OData.Metadata.StandardName', value: 'Active Under Contract' }]
        }
      ]
    };
    const records = synthesizeLookupResourceRecords(report);
    const auc = records.find(r => r.LookupValue === 'ActiveUnderContract');
    expect(auc?.LookupName).toBe('StandardStatus');
    expect(auc?.StandardLookupValue).toBe('Active Under Contract');
    expect(records.some(r => String(r.LookupValue).startsWith('Sample'))).toBe(false);
  });

  it('seeds a single self-identifying sample sentinel for an open enumeration (no standard values)', () => {
    // CountyOrParish is referenced by a field but has no standard lookup values in the DD.
    const report: MetadataReport = { ...baseReport, fields: [enumField('CountyOrParish', 'CountyOrParish')], lookups: [] };
    const samples = synthesizeLookupResourceRecords(report).filter(r => r.LookupName === 'CountyOrParish');
    expect(samples).toHaveLength(1);
    expect(samples[0].LookupValue).toBe('SampleCountyOrParishEnumValue');
    // Matches the Sample…EnumValue sentinel that buildMetadataMap filters out downstream.
    expect(samples[0].LookupValue.startsWith('Sample') && samples[0].LookupValue.endsWith('EnumValue')).toBe(true);
  });

  it('does not seed a sample when the enumeration already carries standard values', () => {
    const report: MetadataReport = {
      ...baseReport,
      fields: [enumField('StandardStatus', 'StandardStatus')],
      lookups: [{ lookupName: 'org.reso.metadata.enums.StandardStatus', lookupValue: 'Active', type: 'Edm.Int32', annotations: [] }]
    };
    expect(synthesizeLookupResourceRecords(report).every(r => !String(r.LookupValue).startsWith('Sample'))).toBe(true);
  });
});

describe('serializeLookupResourceDump', () => {
  it('creates dump in Commander format', () => {
    const dump = serializeLookupResourceDump(lookupRecords, '1.7');
    expect(dump.description).toBe('Data Dictionary Lookup Resource Metadata');
    expect(dump.version).toBe('1.7');
    expect(dump.generatedOn).toBeTruthy();
    expect(dump.lookups).toHaveLength(3);
    expect(dump.lookups[0].LookupName).toBe('StandardStatus');
  });

  // `version` carried a default of '1.7', and the DD pipeline's caller passed only `records`, so every
  // run stamped the dump "1.7" regardless of the DD version under test — observed 2026-10-04 on two
  // DD 2.1 runs whose every other artifact said 2.1. The default is now gone, which makes omitting the
  // argument a compile error rather than a silently wrong label; that type signature is the real control,
  // since no runtime test can observe a caller that does not exist in the test. These cases guard the
  // field mapping against a reintroduced default by asserting a version that is NOT the old one.
  it.each(['2.0', '2.1'])('stamps the version it is handed rather than a default — %s', version => {
    expect(serializeLookupResourceDump(lookupRecords, version).version).toBe(version);
  });
});

/**
 * The fetch itself, end to end through the caller.
 *
 * `fetchLookupResource` had no tests at all, which is why a truncation that lost two thirds of one
 * provider's lookup rows shipped and then produced reports that read as clean. The first test here
 * is that exact provider shape.
 */
describe('fetchLookupResource', () => {
  const ROOT = 'https://example.com/odata';

  const rows = (count: number): Array<Record<string, unknown>> =>
    Array.from({ length: count }, (_, i) => ({ LookupKey: `K${i}`, LookupName: 'Roof', LookupValue: `V${i}` }));

  /** Serves at most `cap` rows per response regardless of `$top`, and offers a nextLink when asked to. */
  const server = (data: Array<Record<string, unknown>>, cap: number, offerNextLink = false): ODataRequester => ({
    request: async ({ url }) => {
      const parsed = new URL(url);
      const top = Number(parsed.searchParams.get('$top') ?? '0');
      const skip = Number(parsed.searchParams.get('$skip') ?? '0');
      const page = data.slice(skip, skip + Math.min(top, cap));
      const body: Record<string, unknown> = { value: page };
      // `$top` bounds a server-driven walk — the server offers links until `$top` is satisfied or
      // the rows run out. Modeling that budget is what reproduces the truncation: a fixture that
      // keeps offering links past `$top` lets the OLD implementation pass, which is how a
      // regression test for this defect becomes vacuous.
      const remaining = top - page.length;
      if (offerNextLink && remaining > 0 && skip + page.length < data.length) {
        body['@odata.nextLink'] = `${ROOT}/Lookup?$skip=${skip + page.length}&$top=${remaining}`;
      }
      return { status: 200, headers: {}, body, rawBody: JSON.stringify(body) };
    }
  });

  const failing = (status: number, onRequest = 1): ODataRequester => {
    let seen = 0;
    return {
      request: async ({ url }) => {
        seen += 1;
        if (seen === onRequest) {
          const body = { error: { code: String(status), message: 'nope' } };
          return { status, headers: {}, body, rawBody: JSON.stringify(body) };
        }
        const parsed = new URL(url);
        const skip = Number(parsed.searchParams.get('$skip') ?? '0');
        const body = { value: rows(2909).slice(skip, skip + 200) };
        return { status: 200, headers: {}, body, rawBody: JSON.stringify(body) };
      }
    };
  };

  it('fetches all 2,909 rows from a provider serving 200 per page with a nextLink', async () => {
    const records = await fetchLookupResource(ROOT, 'token', undefined, undefined, server(rows(2909), 200, true));
    expect(records).toHaveLength(2909);
  });

  it('reports progress as the running total, not the page size', async () => {
    const seen: number[] = [];
    await fetchLookupResource(ROOT, 'token', n => seen.push(n), undefined, server(rows(450), 200));
    expect(seen).toEqual([200, 400, 450]);
  });

  it('returns undefined when the provider does not serve a Lookup resource', async () => {
    expect(await fetchLookupResource(ROOT, 'token', undefined, undefined, failing(404))).toBeUndefined();
  });

  it('throws on a 404 partway through a walk rather than reporting an absent resource', async () => {
    // A resource we have already read 200 rows from is not absent. Returning undefined here would
    // turn a mid-walk failure into "this provider has no lookups", which is a clean-looking lie.
    await expect(fetchLookupResource(ROOT, 'token', undefined, undefined, failing(404, 2))).rejects.toThrow(/HTTP 404/);
  });

  it('throws with the failing request attached on a non-200', async () => {
    await expect(fetchLookupResource(ROOT, 'token', undefined, undefined, failing(500))).rejects.toMatchObject({
      requestDetails: { status: 500, method: 'GET' }
    });
  });

  it('returns an empty array for a provider that serves the resource with no rows', async () => {
    const records = await fetchLookupResource(ROOT, 'token', undefined, undefined, server([], 200));
    expect(records).toEqual([]);
  });
});

describe('fetchLookupResource — a server whose cursor does not move', () => {
  const ROOT2 = 'https://example.com/odata';

  const rows2 = (count: number): Array<Record<string, unknown>> =>
    Array.from({ length: count }, (_, i) => ({ LookupKey: `K${i}`, LookupName: 'Roof', LookupValue: `V${i}` }));

  it('stops instead of walking forever against a server that ignores $skip', async () => {
    // The same rows at every cursor position. Those pages are never empty, so the walk's only
    // termination condition never fires: without the guard this call does not return, and this test
    // fails by timing out rather than by assertion. The explicit timeout is there so a regression
    // fails fast instead of hanging the suite.
    const data = rows2(300);
    const ignoresSkip: ODataRequester = {
      request: async () => {
        const body = { value: data.slice(0, 100) };
        return { status: 200, headers: {}, body, rawBody: JSON.stringify(body) };
      }
    };

    await expect(fetchLookupResource(ROOT2, 'token', undefined, undefined, ignoresSkip)).rejects.toThrow(/not honoring \$skip/i);
  }, 5000);

  it('does not trip on a server that merely repeats a boundary record', async () => {
    // The guard must catch "the cursor is stuck", not "the page overlaps". A server that starts each
    // page one row early still contributes new records, so the walk continues. An over-eager guard
    // would fail a provider here, which is worse than the loop it is protecting against.
    const data = rows2(250);
    const overlapsByOne: ODataRequester = {
      request: async ({ url }) => {
        const skip = Number(new URL(url).searchParams.get('$skip') ?? '0');
        const body = { value: data.slice(skip === 0 ? 0 : skip - 1, (skip === 0 ? 0 : skip - 1) + 100) };
        return { status: 200, headers: {}, body, rawBody: JSON.stringify(body) };
      }
    };

    const records = await fetchLookupResource(ROOT2, 'token', undefined, undefined, overlapsByOne);

    // 250 distinct rows plus the one boundary record the server repeated. The count is the server's
    // doing, not ours; what matters is that the walk completed rather than being refused.
    expect(records).toHaveLength(251);
  }, 5000);
});
