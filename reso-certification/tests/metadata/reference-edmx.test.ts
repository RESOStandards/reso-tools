import { describe, it, expect } from 'vitest';
import type { MetadataReport } from '../../src/metadata/serializer.js';
import { generateMetadataReport } from '../../src/metadata/serializer.js';
import { generateReferenceEdmx } from '../../src/metadata/reference-edmx.js';
import { synthesizeLookupResourceRecords, mergeWithLookupResource } from '../../src/metadata/lookup-resource.js';

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

describe('enum detection with a CSDL schema Alias', () => {
  // A provider declares Alias="RESOEnums" on the enum schema and references the enum by the alias
  // (a spec-valid CSDL spelling). The field must still be detected as an enumeration, and its
  // canonicalized type must equal the lookup's FQDN. (The original bug missed this.)
  const aliasedEdmx = `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="org.reso.metadata" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Property">
        <Key><PropertyRef Name="ListingKey"/></Key>
        <Property Name="ListingKey" Type="Edm.String"/>
        <Property Name="StandardStatus" Type="RESOEnums.StandardStatus"/>
      </EntityType>
      <EntityContainer Name="Default">
        <EntitySet Name="Property" EntityType="org.reso.metadata.Property"/>
      </EntityContainer>
    </Schema>
    <Schema Namespace="org.reso.metadata.enums" Alias="RESOEnums" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EnumType Name="StandardStatus">
        <Member Name="Active" Value="0">
          <Annotation Term="RESO.OData.Metadata.StandardName" String="Active"/>
        </Member>
      </EnumType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('detects an alias-referenced enum and keeps field.type === lookup.lookupName', () => {
    const rt = generateMetadataReport(aliasedEdmx, '2.1');
    const field = rt.fields.find(f => f.fieldName === 'StandardStatus');
    const lookup = rt.lookups.find(l => l.lookupValue === 'Active');
    expect(field?.isEnumeration).toBe(true);
    expect(field?.type).toBe('org.reso.metadata.enums.StandardStatus');
    expect(lookup?.lookupName).toBe(field?.type);
  });
});

describe('string + Lookup Resource representation', () => {
  // The string rep keeps enum values out of the metadata — a provider serves them at /Lookup.
  // Synthesize that dataset from the DD reference, merge it into the string-mode base report, and
  // the result must be internally consistent: enum fields and their lookups join by the SHORT
  // LookupName, and the standard display name is preserved.
  it('synthesizes a Lookup Resource dataset and merges into a consistent report', () => {
    const base = generateMetadataReport(generateReferenceEdmx(report, ['Property'], 'string'), '2.1');
    const records = synthesizeLookupResourceRecords(report);
    const merged = mergeWithLookupResource(base, records);

    const field = merged.fields.find(f => f.fieldName === 'StandardStatus');
    const lookup = merged.lookups.find(l => l.lookupValue === 'Pending');

    // string-rep join is by the unqualified LookupName
    expect(field?.type).toBe('StandardStatus');
    expect(lookup?.lookupName).toBe('StandardStatus');
    expect(lookup?.lookupName).toBe(field?.type);
    // both values preserved — the standard display name survives synthesis + merge
    expect(lookup?.annotations?.find(a => a.term === 'RESO.OData.Metadata.StandardName')?.value).toBe('Pending Sale');
  });
});

describe('primary key in the metadata report', () => {
  it('marks the entity key field with isPrimaryKey, sourced from the CSDL <Key>', () => {
    const rt = generateMetadataReport(generateReferenceEdmx(report, ['Property'], 'string'), '2.1');
    expect(rt.fields.find(f => f.fieldName === 'ListingKey')?.isPrimaryKey).toBe(true);
    expect(rt.fields.find(f => f.fieldName === 'StandardStatus')?.isPrimaryKey).toBeUndefined();
  });

  // A convention resource (no exception, no key in the DD data): the stored {ResourceName}Key
  // convention is blended into the generated <Key>, and the round-trip serializes it back as
  // isPrimaryKey — the SAME serializer path a provider's metadata takes. This is how the DD
  // reference, which does not encode keys through 2.1, still yields a keyed report.
  it('blends the {ResourceName}Key convention into <Key> and serializes it back as isPrimaryKey', () => {
    const conv: MetadataReport = {
      description: 'test', version: '2.1', generatedOn: '2026-06-19T00:00:00.000Z',
      resources: [{ resourceName: 'Member' }],
      fields: [
        { resourceName: 'Member', fieldName: 'MemberKey', type: 'Edm.String', annotations: [] },
        { resourceName: 'Member', fieldName: 'MemberFirstName', type: 'Edm.String', annotations: [] },
      ],
      lookups: [], actions: [], functions: [],
    };
    const rt = generateMetadataReport(generateReferenceEdmx(conv, ['Member'], 'string'), '2.1');
    expect(rt.fields.find(f => f.fieldName === 'MemberKey')?.isPrimaryKey).toBe(true);
    expect(rt.fields.find(f => f.fieldName === 'MemberFirstName')?.isPrimaryKey).toBeUndefined();
  });

  // When the data itself carries the key (DD 2.2+, or any live-server metadata), that wins over
  // the convention: generateEdmx prefers the field's own isPrimaryKey for the <Key>.
  it('prefers a data-carried isPrimaryKey over the convention fallback', () => {
    const dataKeyed: MetadataReport = {
      description: 'test', version: '2.2', generatedOn: '2026-06-19T00:00:00.000Z',
      resources: [{ resourceName: 'Widget' }],
      fields: [
        { resourceName: 'Widget', fieldName: 'CustomId', type: 'Edm.String', isPrimaryKey: true, annotations: [] },
        { resourceName: 'Widget', fieldName: 'WidgetKey', type: 'Edm.String', annotations: [] },
      ],
      lookups: [], actions: [], functions: [],
    };
    const edmx = generateReferenceEdmx(dataKeyed, ['Widget'], 'string');
    expect(edmx).toContain('<PropertyRef Name="CustomId"/>');
    expect(edmx).not.toContain('<PropertyRef Name="WidgetKey"/>');
    const rt = generateMetadataReport(edmx, '2.2');
    expect(rt.fields.find(f => f.fieldName === 'CustomId')?.isPrimaryKey).toBe(true);
    expect(rt.fields.find(f => f.fieldName === 'WidgetKey')?.isPrimaryKey).toBeUndefined();
  });

  // Compound key: every field the data marks isPrimaryKey becomes a PropertyRef in <Key>, and all
  // of them round-trip back as isPrimaryKey. (OData allows multi-field keys; the DD reference is
  // single-key, but live-server metadata can be compound.)
  it('emits a PropertyRef per isPrimaryKey field for a compound key and round-trips all of them', () => {
    const compound: MetadataReport = {
      description: 'test', version: '2.2', generatedOn: '2026-06-19T00:00:00.000Z',
      resources: [{ resourceName: 'Pair' }],
      fields: [
        { resourceName: 'Pair', fieldName: 'PartA', type: 'Edm.String', isPrimaryKey: true, annotations: [] },
        { resourceName: 'Pair', fieldName: 'PartB', type: 'Edm.String', isPrimaryKey: true, annotations: [] },
        { resourceName: 'Pair', fieldName: 'Payload', type: 'Edm.String', annotations: [] },
      ],
      lookups: [], actions: [], functions: [],
    };
    const edmx = generateReferenceEdmx(compound, ['Pair'], 'string');
    expect(edmx).toContain('<PropertyRef Name="PartA"/>');
    expect(edmx).toContain('<PropertyRef Name="PartB"/>');
    const rt = generateMetadataReport(edmx, '2.2');
    expect(rt.fields.find(f => f.fieldName === 'PartA')?.isPrimaryKey).toBe(true);
    expect(rt.fields.find(f => f.fieldName === 'PartB')?.isPrimaryKey).toBe(true);
    expect(rt.fields.find(f => f.fieldName === 'Payload')?.isPrimaryKey).toBeUndefined();
  });
});
