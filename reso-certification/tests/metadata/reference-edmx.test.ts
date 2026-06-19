import { describe, it, expect } from 'vitest';
import type { MetadataReport } from '../../src/metadata/serializer.js';
import { generateMetadataReport } from '../../src/metadata/serializer.js';
import { generateReferenceEdmx } from '../../src/metadata/reference-edmx.js';

/** A minimal Property report: an Edm primitive key plus one enum field with two lookup values. */
const report: MetadataReport = {
  description: 'test',
  version: '2.1',
  generatedOn: '2026-06-19T00:00:00.000Z',
  resources: [{ resourceName: 'Property' }],
  fields: [
    { resourceName: 'Property', fieldName: 'ListingKey', type: 'Edm.String', annotations: [] },
    { resourceName: 'Property', fieldName: 'StandardStatus', type: 'org.reso.metadata.enums.StandardStatus', isEnumeration: true, annotations: [] },
  ],
  lookups: [
    { lookupName: 'org.reso.metadata.enums.StandardStatus', lookupValue: 'Active', type: 'Edm.Int32', annotations: [{ term: 'RESO.OData.Metadata.StandardName', value: 'Active' }] },
    { lookupName: 'org.reso.metadata.enums.StandardStatus', lookupValue: 'Pending', type: 'Edm.Int32', annotations: [{ term: 'RESO.OData.Metadata.StandardName', value: 'Pending Sale' }] },
  ],
  actions: [],
  functions: [],
};

describe('generateReferenceEdmx', () => {
  it('emits an EnumType block in enum-type mode and a LookupName annotation in string mode', () => {
    expect(generateReferenceEdmx(report, ['Property'], 'enum-type')).toContain('<EnumType Name="StandardStatus">');
    const stringEdmx = generateReferenceEdmx(report, ['Property'], 'string');
    expect(stringEdmx).toContain('RESO.OData.Metadata.LookupName');
    expect(stringEdmx).not.toContain('<EnumType');
  });

  // The self-test contract in miniature: generate EDMX from the DD report, parse it back to a
  // report, and the enum field is still detected as an enumeration in BOTH representations.
  it.each(['enum-type', 'string'] as const)('round-trips the enum field as an enumeration in %s mode', (enumMode) => {
    const edmx = generateReferenceEdmx(report, ['Property'], enumMode);
    const roundTripped = generateMetadataReport(edmx, '2.1');
    const field = roundTripped.fields.find(f => f.fieldName === 'StandardStatus');
    expect(field?.isEnumeration).toBe(true);
  });

  // Transport-level join: the field type and its lookup name must be the same full FQDN, and
  // both values (the legacy value + the StandardName display) must survive the round-trip.
  it('round-trips the enum-type FQDN consistently and preserves StandardName', () => {
    const edmx = generateReferenceEdmx(report, ['Property'], 'enum-type');
    const rt = generateMetadataReport(edmx, '2.1');
    const field = rt.fields.find(f => f.fieldName === 'StandardStatus');
    const lookup = rt.lookups.find(l => l.lookupValue === 'Pending');
    expect(field?.type).toBe('org.reso.metadata.enums.StandardStatus');
    expect(lookup?.lookupName).toBe(field?.type);
    expect(lookup?.annotations?.find(a => a.term === 'RESO.OData.Metadata.StandardName')?.value).toBe('Pending Sale');
  });
});
