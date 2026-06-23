import { describe, it, expect } from 'vitest';
import { generateEdmx, type ResoMetadata } from '../src/index.js';

/**
 * A minimal two-field Property resource: one Edm primitive (the key) and one enum field
 * with two lookup values. Enough to exercise both enum representations.
 */
const metadata: ResoMetadata = {
  description: 'test',
  version: '2.1',
  generatedOn: '2026-06-19T00:00:00.000Z',
  resources: [{ resourceName: 'Property', wikiPageURL: '', payloads: [] }],
  fields: [
    { resourceName: 'Property', fieldName: 'ListingKey', type: 'Edm.String', annotations: [] },
    { resourceName: 'Property', fieldName: 'StandardStatus', type: 'org.reso.metadata.enums.StandardStatus', isEnumeration: true, annotations: [] },
  ],
  lookups: [
    // Active has no StandardName (self-closing member); Pending has one (wrapped member).
    { lookupName: 'org.reso.metadata.enums.StandardStatus', lookupValue: 'Active', type: 'Edm.Int32', annotations: [] },
    { lookupName: 'org.reso.metadata.enums.StandardStatus', lookupValue: 'Pending', type: 'Edm.Int32', annotations: [{ term: 'RESO.OData.Metadata.StandardName', value: 'Pending Sale' }] },
  ],
};

describe('generateEdmx — enum-type representation', () => {
  const edmx = generateEdmx(metadata, ['Property'], 'enum-type');

  it('renders the entity type with its key', () => {
    expect(edmx).toContain('<EntityType Name="Property">');
    expect(edmx).toContain('<PropertyRef Name="ListingKey"/>');
  });

  it('types the enum field as the fully qualified enum and emits an EnumType block', () => {
    expect(edmx).toContain('Name="StandardStatus" Type="org.reso.metadata.enums.StandardStatus"');
    expect(edmx).toContain('<EnumType Name="StandardStatus">');
    expect(edmx).toContain('<Member Name="Active" Value="0"/>');
    expect(edmx).toContain('<Member Name="Pending" Value="1">');
  });

  it('does not emit a LookupName annotation in enum-type mode', () => {
    expect(edmx).not.toContain('RESO.OData.Metadata.LookupName');
  });

  it('wraps members carrying a StandardName and self-closes those without', () => {
    expect(edmx).toContain('<Member Name="Pending" Value="1">');
    expect(edmx).toContain('<Annotation Term="RESO.OData.Metadata.StandardName" String="Pending Sale"/>');
    expect(edmx).toContain('<Member Name="Active" Value="0"/>');
  });
});

describe('generateEdmx — string/Lookup-Resource representation', () => {
  const edmx = generateEdmx(metadata, ['Property'], 'string');

  it('types the enum field as Edm.String with a LookupName annotation', () => {
    expect(edmx).toContain('Name="StandardStatus" Type="Edm.String"');
    expect(edmx).toContain('<Annotation Term="RESO.OData.Metadata.LookupName" String="StandardStatus"/>');
  });

  it('does not emit any EnumType block in string mode', () => {
    expect(edmx).not.toContain('<EnumType');
  });
});
