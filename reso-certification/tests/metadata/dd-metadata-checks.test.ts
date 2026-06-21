import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { checkDisallowedSynonyms, checkClosedEnumValues, runDdMetadataChecks } from '../../src/metadata/dd-metadata-checks.js';
import type { DdReference } from '../../src/metadata/dd-metadata-checks.js';
import type { MetadataReport, MetadataReportLookup } from '../../src/metadata/serializer.js';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const { getReferenceMetadata } = require(resolve(import.meta.dirname, '../../src/etl/index.cjs'));

const SN = 'RESO.OData.Metadata.StandardName';

const emptyReport = (fields: ReadonlyArray<{ resourceName: string; fieldName: string }>): MetadataReport => ({
  description: 'test', version: '2.1', generatedOn: '2026-06-21T00:00:00.000Z',
  resources: [], fields: fields.map((f) => ({ ...f, type: 'Edm.String', annotations: [] })), lookups: [], actions: [], functions: [],
});

const makeReport = (
  fields: ReadonlyArray<{ resourceName: string; fieldName: string; type: string }>,
  lookups: ReadonlyArray<MetadataReportLookup>,
): MetadataReport => ({
  description: 'test', version: '2.1', generatedOn: '2026-06-21T00:00:00.000Z',
  resources: [], fields: fields.map((f) => ({ ...f, annotations: [] })), lookups, actions: [], functions: [],
});

describe('checkDisallowedSynonyms', () => {
  // The Commander's StandardStatus scenario: NormalizedListingStatus / RetsStatus must NOT exist.
  const reference: DdReference = {
    fields: [
      { resourceName: 'Property', fieldName: 'StandardStatus', type: 'org.reso.metadata.enums.StandardStatus', synonyms: 'NormalizedListingStatus, RetsStatus' },
      { resourceName: 'Property', fieldName: 'ListPrice', type: 'Edm.Decimal' },
    ],
    lookups: [],
  };

  it('flags a provider field that uses a disallowed synonym', () => {
    const findings = checkDisallowedSynonyms(emptyReport([
      { resourceName: 'Property', fieldName: 'ListPrice' },
      { resourceName: 'Property', fieldName: 'NormalizedListingStatus' },
    ]), reference);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'disallowed-synonym', resourceName: 'Property', fieldName: 'NormalizedListingStatus' });
    expect(findings[0].message).toContain('StandardStatus');
  });

  it('passes a provider that uses only standard field names', () => {
    expect(checkDisallowedSynonyms(emptyReport([
      { resourceName: 'Property', fieldName: 'StandardStatus' },
      { resourceName: 'Property', fieldName: 'ListPrice' },
    ]), reference)).toEqual([]);
  });

  it('is resource-scoped: the synonym name in a DIFFERENT resource is not flagged', () => {
    expect(checkDisallowedSynonyms(emptyReport([
      { resourceName: 'Member', fieldName: 'NormalizedListingStatus' },
    ]), reference)).toEqual([]);
  });

  it('does not flag a synonym that is itself a standard field (collision guard)', () => {
    const refWithCollision: DdReference = {
      fields: [
        { resourceName: 'Property', fieldName: 'A', type: 'Edm.String', synonyms: 'B' },
        { resourceName: 'Property', fieldName: 'B', type: 'Edm.String' }, // B is also a standard field
      ],
      lookups: [],
    };
    expect(checkDisallowedSynonyms(emptyReport([{ resourceName: 'Property', fieldName: 'B' }]), refWithCollision)).toEqual([]);
  });

  // Self-test invariant: the DD reference, checked against itself, MUST be clean — the standard
  // never uses its own synonyms as field names. (Verified across dd-1.7/2.0/2.1.)
  it.each(['2.0', '2.1'])('DD %s reference passes the disallowed-synonym gate clean', (version) => {
    const ref = getReferenceMetadata(version) as MetadataReport & DdReference;
    expect(checkDisallowedSynonyms(ref, ref)).toEqual([]);
  });
});

describe('checkClosedEnumValues', () => {
  const SS = 'org.reso.metadata.enums.StandardStatus';
  const OPEN = 'org.reso.metadata.enums.OpenEnum';
  const reference: DdReference = {
    fields: [
      { resourceName: 'Property', fieldName: 'StandardStatus', type: SS, lookupStatus: 'Locked with Enumerations' },
      { resourceName: 'Property', fieldName: 'OpenField', type: OPEN, lookupStatus: 'Open with Enumerations' },
    ],
    lookups: [
      { lookupName: SS, lookupValue: 'Active', annotations: [{ term: SN, value: 'Active' }] },
      { lookupName: SS, lookupValue: 'ActiveUnderContract', annotations: [{ term: SN, value: 'Active Under Contract' }] },
      { lookupName: OPEN, lookupValue: 'A', annotations: [{ term: SN, value: 'A' }] },
    ],
  };

  it('flags a value outside a closed enumeration', () => {
    const findings = checkClosedEnumValues(makeReport(
      [{ resourceName: 'Property', fieldName: 'StandardStatus', type: SS }],
      [
        { lookupName: SS, lookupValue: 'Active', type: 'Edm.Int32', annotations: [{ term: SN, value: 'Active' }] },
        { lookupName: SS, lookupValue: 'Foreclosure', type: 'Edm.Int32', annotations: [{ term: SN, value: 'Foreclosure' }] }, // LOCAL
      ]), reference);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ check: 'closed-enum-value', resourceName: 'Property', fieldName: 'StandardStatus' });
    expect(findings[0].message).toContain('Foreclosure');
  });

  it('passes when all closed-enum values are standard', () => {
    expect(checkClosedEnumValues(makeReport(
      [{ resourceName: 'Property', fieldName: 'StandardStatus', type: SS }],
      [
        { lookupName: SS, lookupValue: 'Active', type: 'Edm.Int32', annotations: [{ term: SN, value: 'Active' }] },
        { lookupName: SS, lookupValue: 'ActiveUnderContract', type: 'Edm.Int32', annotations: [{ term: SN, value: 'Active Under Contract' }] },
      ]), reference)).toEqual([]);
  });

  it('permits a value that matches by StandardName even if the machine value differs', () => {
    expect(checkClosedEnumValues(makeReport(
      [{ resourceName: 'Property', fieldName: 'StandardStatus', type: SS }],
      // machine 'AUC' is non-standard, but its StandardName is the standard display form → allowed.
      [{ lookupName: SS, lookupValue: 'AUC', type: 'Edm.Int32', annotations: [{ term: SN, value: 'Active Under Contract' }] }]), reference)).toEqual([]);
  });

  it('does NOT check open enumerations (local values there are mapping variations)', () => {
    expect(checkClosedEnumValues(makeReport(
      [{ resourceName: 'Property', fieldName: 'OpenField', type: OPEN }],
      [{ lookupName: OPEN, lookupValue: 'SomethingLocal', type: 'Edm.Int32', annotations: [] }]), reference)).toEqual([]);
  });

  // Self-test invariant: the DD reference's closed enums contain exactly the standard values, so the
  // reference checked against itself MUST be clean.
  it.each(['2.0', '2.1'])('DD %s reference passes the closed-enum gate clean', (version) => {
    const ref = getReferenceMetadata(version) as MetadataReport & DdReference;
    expect(checkClosedEnumValues(ref, ref)).toEqual([]);
  });
});

describe('runDdMetadataChecks', () => {
  it('aggregates findings (currently the disallowed-synonym check)', () => {
    const reference: DdReference = {
      fields: [{ resourceName: 'Property', fieldName: 'StandardStatus', type: 'x', synonyms: 'RetsStatus' }],
      lookups: [],
    };
    expect(runDdMetadataChecks(emptyReport([{ resourceName: 'Property', fieldName: 'RetsStatus' }]), reference)).toHaveLength(1);
  });
});
