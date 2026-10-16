import { describe, expect, it } from 'vitest';
import { parseCsdlXml } from '../src/csdl/parser.js';
import { generateMetadataReport, serializeMetadataReport } from '../src/serializer.js';

// Minimal but complete EDMX with entity container, properties, enums, and navigation
const testEdmx = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="org.reso.metadata" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EnumType Name="StandardStatus" UnderlyingType="Edm.Int32">
        <Member Name="Active" Value="1"/>
        <Member Name="Pending" Value="2"/>
        <Member Name="Sold" Value="3"/>
      </EnumType>
      <EnumType Name="ParkingFeatures" UnderlyingType="Edm.Int32" IsFlags="true">
        <Member Name="Garage" Value="1"/>
        <Member Name="Street" Value="2"/>
      </EnumType>
      <EntityType Name="Property">
        <Key><PropertyRef Name="ListingKey"/></Key>
        <Property Name="ListingKey" Type="Edm.String" Nullable="false" MaxLength="255"/>
        <Property Name="ListPrice" Type="Edm.Decimal" Nullable="true" Scale="2" Precision="14"/>
        <Property Name="BedroomsTotal" Type="Edm.Int32" Nullable="true"/>
        <Property Name="City" Type="Edm.String" Nullable="true"/>
        <Property Name="ListDate" Type="Edm.Date" Nullable="true"/>
        <Property Name="ModificationTimestamp" Type="Edm.DateTimeOffset" Nullable="true"/>
        <Property Name="Status" Type="org.reso.metadata.StandardStatus"/>
        <Property Name="Parking" Type="Collection(org.reso.metadata.ParkingFeatures)"/>
        <Property Name="LocalFlags" Type="Collection(Edm.String)"/>
        <NavigationProperty Name="Media" Type="Collection(org.reso.metadata.Media)"/>
      </EntityType>
      <EntityType Name="Media">
        <Key><PropertyRef Name="MediaKey"/></Key>
        <Property Name="MediaKey" Type="Edm.String" Nullable="false"/>
        <Property Name="MediaURL" Type="Edm.String" Nullable="true"/>
      </EntityType>
      <EntityContainer Name="Default">
        <EntitySet Name="Property" EntityType="org.reso.metadata.Property"/>
        <EntitySet Name="Media" EntityType="org.reso.metadata.Media"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe('serializeMetadataReport', () => {
  const schema = parseCsdlXml(testEdmx);
  const report = serializeMetadataReport(schema, '2.0');

  it('includes description and version', () => {
    expect(report.description).toBe('RESO Data Dictionary Metadata Report');
    expect(report.version).toBe('2.0');
  });

  it('includes generatedOn timestamp', () => {
    expect(report.generatedOn).toBeTruthy();
    expect(new Date(report.generatedOn).getTime()).not.toBeNaN();
  });

  it('extracts resources from entity container', () => {
    expect(report.resources).toHaveLength(2);
    expect(report.resources.map(r => r.resourceName)).toEqual(['Property', 'Media']);
  });

  it('extracts all fields from all resources', () => {
    const propertyFields = report.fields.filter(f => f.resourceName === 'Property');
    const mediaFields = report.fields.filter(f => f.resourceName === 'Media');
    expect(propertyFields.length).toBe(10); // 9 properties + 1 nav
    expect(mediaFields.length).toBe(2);
  });

  it('includes type, nullable, maxLength, scale, precision', () => {
    const listingKey = report.fields.find(f => f.fieldName === 'ListingKey');
    expect(listingKey?.type).toBe('Edm.String');
    expect(listingKey?.nullable).toBe(false);
    expect(listingKey?.maxLength).toBe(255);

    const listPrice = report.fields.find(f => f.fieldName === 'ListPrice');
    expect(listPrice?.type).toBe('Edm.Decimal');
    expect(listPrice?.nullable).toBe(true);
    expect(listPrice?.scale).toBe(2);
    expect(listPrice?.precision).toBe(14);
  });

  it('marks navigation properties with isExpansion', () => {
    const media = report.fields.find(f => f.fieldName === 'Media' && f.resourceName === 'Property');
    expect(media?.isExpansion).toBe(true);
    expect(media?.isCollection).toBe(true);
    expect(media?.isEnumeration).toBeFalsy();
    // Declared `Collection(org.reso.metadata.Media)`; the report carries the ELEMENT type.
    expect(media?.type).toBe('org.reso.metadata.Media');
  });

  it('marks enum fields with isEnumeration', () => {
    const status = report.fields.find(f => f.fieldName === 'Status');
    expect(status?.isEnumeration).toBe(true);
    expect(status?.isExpansion).toBeFalsy();
  });

  it('marks collection enum fields with isCollection and isEnumeration', () => {
    const parking = report.fields.find(f => f.fieldName === 'Parking');
    expect(parking?.isCollection).toBe(true);
    expect(parking?.isEnumeration).toBe(true);
    // Declared `Collection(org.reso.metadata.ParkingFeatures)`; the report carries the ELEMENT type.
    expect(parking?.type).toBe('org.reso.metadata.ParkingFeatures');
  });

  it('does not mark primitive fields as enumerations', () => {
    const key = report.fields.find(f => f.fieldName === 'ListingKey');
    expect(key?.isEnumeration).toBeFalsy();

    const city = report.fields.find(f => f.fieldName === 'City');
    expect(city?.isEnumeration).toBeFalsy();
  });

  it('serializes enum type members as lookups', () => {
    expect(report.lookups).toHaveLength(5); // 3 StandardStatus + 2 ParkingFeatures
  });

  it('lookups have correct shape', () => {
    const active = report.lookups.find(l => l.lookupValue === 'Active');
    expect(active).toBeDefined();
    expect(active!.lookupName).toBe('org.reso.metadata.StandardStatus');
    expect(active!.type).toBe('Edm.Int32');
  });

  it('lookups include all members', () => {
    const statusLookups = report.lookups.filter(l => l.lookupName === 'org.reso.metadata.StandardStatus');
    expect(statusLookups.map(l => l.lookupValue).sort()).toEqual(['Active', 'Pending', 'Sold']);
  });

  // The element-type contract. These are the assertions that were missing: every test above
  // checked collection-NESS and none checked the TYPE, so the report could carry the CSDL
  // `Collection(...)` wrapper and the whole suite stayed green.
  //
  // Expected values are read from the EDMX declarations at the top of this file, not from the
  // serializer's own output. That matters: a fixture regenerated from the code under test only
  // proves the code equals itself, so the expected side has to be pinned to the source of truth.
  describe('a collection reports its element type, never the Collection() wrapper', () => {
    it('unwraps a scalar collection — the vendor-extension shape', () => {
      // Declared `Collection(Edm.String)` with no LookupName annotation, so nothing downstream
      // normalizes it. This is the shape that produced "MUST be object but found string" against
      // a payload that was a plain array of strings.
      const flags = report.fields.find(f => f.fieldName === 'LocalFlags');
      expect(flags?.type).toBe('Edm.String');
      expect(flags?.isCollection).toBe(true);
      expect(flags?.isEnumeration).toBeFalsy();
    });

    it('leaves no field in the report carrying a Collection() prefix', () => {
      const wrapped = report.fields.filter(f => f.type.startsWith('Collection('));
      expect(wrapped.map(f => `${f.resourceName}.${f.fieldName}=${f.type}`)).toEqual([]);
    });

    it('every collection still declares its collection-ness via isCollection', () => {
      // The wrapper is gone, so `isCollection` is now the ONLY carrier of that fact. If the
      // unwrap ever lands without the flag, collection-ness disappears silently.
      const collections = report.fields.filter(f => f.isCollection);
      expect(collections.map(f => f.fieldName).sort()).toEqual(['LocalFlags', 'Media', 'Parking']);
      for (const f of collections) expect(f.type.startsWith('Collection(')).toBe(false);
    });

    it('keeps the wrapper in the PARSER, which is the layer that should be faithful to CSDL', () => {
      // The boundary this fix lives on. A parser is right to preserve what the document said; a
      // report is a different artifact with its own contract. Pinning both sides means a future
      // "fix" applied in the parser instead of the serializer fails here rather than silently
      // changing what every CSDL consumer sees.
      const property = schema.entityTypes.find(t => t.name === 'Property');
      const parsedFlags = property?.properties.find(pr => pr.name === 'LocalFlags');
      expect(parsedFlags?.type).toBe('Collection(Edm.String)');
    });
  });
});

describe('generateMetadataReport', () => {
  it('generates report from raw XML', () => {
    const report = generateMetadataReport(testEdmx, '2.0');
    expect(report.description).toBe('RESO Data Dictionary Metadata Report');
    expect(report.resources).toHaveLength(2);
    expect(report.fields.length).toBe(12); // Property 9 props + 1 nav, Media 2
    expect(report.lookups).toHaveLength(5);
  });

  it('handles version parameter', () => {
    expect(generateMetadataReport(testEdmx, '1.7').version).toBe('1.7');
    expect(generateMetadataReport(testEdmx, '2.0').version).toBe('2.0');
  });
});

describe('error handling', () => {
  it('throws when entity container is missing', () => {
    const noContainerEdmx = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="org.reso.metadata" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Property">
        <Key><PropertyRef Name="ListingKey"/></Key>
        <Property Name="ListingKey" Type="Edm.String"/>
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

    const schema = parseCsdlXml(noContainerEdmx);
    expect(() => serializeMetadataReport(schema, '2.0')).toThrow('EntityContainer');
  });
});

// A resource whose collection nav is a containment navigation (ContainsTarget="true") targets a CONTAINED
// entity type: it is legally declared as an EntityType but has NO top-level EntitySet (it is addressed
// through the parent's nav path). Such a type is still a valid $expand target, so its fields MUST appear in
// the report — otherwise downstream JSON-Schema generation emits a $ref to a definition that was never built.
// Mirrors the real-world shape (a Property with a contained Media collection) with no vendor data.
const containedEntityEdmx = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="org.reso.metadata" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Property">
        <Key><PropertyRef Name="ListingKey"/></Key>
        <Property Name="ListingKey" Type="Edm.String" Nullable="false"/>
        <NavigationProperty Name="Media" Type="Collection(org.reso.metadata.Media)" ContainsTarget="true"/>
      </EntityType>
      <EntityType Name="Media">
        <Key><PropertyRef Name="MediaKey"/></Key>
        <Property Name="MediaKey" Type="Edm.String" Nullable="false"/>
        <Property Name="MediaURL" Type="Edm.String" Nullable="true"/>
      </EntityType>
      <EntityContainer Name="Default">
        <EntitySet Name="Property" EntityType="org.reso.metadata.Property"/>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe('serializeMetadataReport — contained (ContainsTarget) entity types', () => {
  const report = serializeMetadataReport(parseCsdlXml(containedEntityEdmx), '2.0');

  it('keeps resources scoped to served EntitySets (a contained type is not a top-level resource)', () => {
    // resources[] is legitimately the served set — a contained type must NOT show up here.
    expect(report.resources.map(r => r.resourceName)).toEqual(['Property']);
  });

  it('includes fields for a declared-but-unhosted contained EntityType (Media)', () => {
    const mediaFields = report.fields.filter(f => f.resourceName === 'Media');
    expect(mediaFields.map(f => f.fieldName).sort()).toEqual(['MediaKey', 'MediaURL']);
  });

  it("still records Property's containment nav as an expansion field", () => {
    const nav = report.fields.find(f => f.resourceName === 'Property' && f.fieldName === 'Media');
    expect(nav?.isExpansion).toBe(true);
  });
});
