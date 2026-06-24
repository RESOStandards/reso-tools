import { describe, it, expect } from 'vitest';
import { serializeMetadataReport, generateMetadataReport } from '../../src/metadata/serializer.js';
import { parseCsdlXml } from '@reso-standards/reso-metadata-utils';

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
    expect(propertyFields.length).toBe(9); // 8 properties + 1 nav
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
});

describe('generateMetadataReport', () => {
  it('generates report from raw XML', () => {
    const report = generateMetadataReport(testEdmx, '2.0');
    expect(report.description).toBe('RESO Data Dictionary Metadata Report');
    expect(report.resources).toHaveLength(2);
    expect(report.fields.length).toBe(11);
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
