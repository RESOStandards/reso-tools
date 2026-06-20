import { describe, it, expect } from 'vitest';
import type { MetadataReport } from '../../src/metadata/serializer.js';
import { generateReferenceArtifacts } from '../../src/metadata/reference-artifacts.js';

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

describe('generateReferenceArtifacts — enum-type representation', () => {
  const artifacts = generateReferenceArtifacts(report, ['Property'], 'enum-type', '2.1');

  it('produces EDMX with an EnumType and a canonical report with the enum detected', () => {
    expect(artifacts.edmx).toContain('<EnumType Name="StandardStatus">');
    const field = artifacts.metadataReport.fields.find(f => f.fieldName === 'StandardStatus');
    expect(field?.isEnumeration).toBe(true);
    expect(field?.type).toBe('org.reso.metadata.enums.StandardStatus');
  });

  it('has no Lookup Resource artifacts (values live in the EDMX)', () => {
    expect(artifacts.lookupResourceDump).toBeUndefined();
    expect(artifacts.rawReport).toBeUndefined();
  });
});

describe('generateReferenceArtifacts — string + Lookup Resource representation', () => {
  const artifacts = generateReferenceArtifacts(report, ['Property'], 'string', '2.1');

  it('produces string EDMX, a synthesized Lookup Resource dump, and a pre-merge base', () => {
    expect(artifacts.edmx).toContain('RESO.OData.Metadata.LookupName');
    expect(artifacts.edmx).not.toContain('<EnumType');
    expect(artifacts.lookupResourceDump?.lookups.length).toBe(2);
    expect(artifacts.rawReport).toBeDefined();
  });

  it('merged report joins field to lookup by the short LookupName', () => {
    const field = artifacts.metadataReport.fields.find(f => f.fieldName === 'StandardStatus');
    const lookup = artifacts.metadataReport.lookups.find(l => l.lookupValue === 'Pending');
    expect(field?.type).toBe('StandardStatus');
    expect(lookup?.lookupName).toBe('StandardStatus');
    expect(lookup?.lookupName).toBe(field?.type);
  });
});
