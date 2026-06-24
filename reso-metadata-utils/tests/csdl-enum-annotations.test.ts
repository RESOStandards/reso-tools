import { describe, it, expect } from 'vitest';
import { parseCsdlXml, getAllFields } from '../src/index.js';

/**
 * Enum types declared in a separate namespaced schema (org.reso.metadata.enums) from the
 * entity types (org.reso.metadata), with member StandardName annotations in BOTH forms:
 * the inline-attribute form on Active and the wrapped child-element form on Pending.
 */
const edmx = `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="org.reso.metadata" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Property">
        <Key><PropertyRef Name="ListingKey"/></Key>
        <Property Name="ListingKey" Type="Edm.String"/>
        <Property Name="StandardStatus" Type="org.reso.metadata.enums.StandardStatus"/>
      </EntityType>
      <EntityContainer Name="Default">
        <EntitySet Name="Property" EntityType="org.reso.metadata.Property"/>
      </EntityContainer>
    </Schema>
    <Schema Namespace="org.reso.metadata.enums" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EnumType Name="StandardStatus">
        <Member Name="Active" Value="0">
          <Annotation Term="RESO.OData.Metadata.StandardName" String="Active"/>
        </Member>
        <Member Name="Pending" Value="1">
          <Annotation Term="RESO.OData.Metadata.StandardName"><String>Pending Sale</String></Annotation>
        </Member>
      </EnumType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

describe('CSDL enum namespace + member annotations', () => {
  const schema = parseCsdlXml(edmx);
  const enumType = schema.enumTypes.find(e => e.name === 'StandardStatus');

  it('captures the enum type\'s own namespace from its split schema', () => {
    expect(enumType?.namespace).toBe('org.reso.metadata.enums');
  });

  it('parses member StandardName in the inline-attribute form', () => {
    const active = enumType?.members.find(m => m.name === 'Active');
    expect(active?.annotations?.['RESO.OData.Metadata.StandardName']).toBe('Active');
  });

  it('parses member StandardName in the wrapped child-element form', () => {
    const pending = enumType?.members.find(m => m.name === 'Pending');
    expect(pending?.annotations?.['RESO.OData.Metadata.StandardName']).toBe('Pending Sale');
  });
});

describe('CSDL schema Alias resolution', () => {
  // The enum schema declares Alias="RESOEnums" and the field references the enum by that alias —
  // a spec-valid CSDL spelling that must resolve to the same FQDN as the namespace form.
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
        <Member Name="Active" Value="0"/>
      </EnumType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('canonicalizes an alias-qualified field type to its namespace form', () => {
    const schema = parseCsdlXml(aliasedEdmx);
    const field = schema.entityTypes
      .find(e => e.name === 'Property')
      ?.properties.find(p => p.name === 'StandardStatus');
    expect(field?.type).toBe('org.reso.metadata.enums.StandardStatus');
  });
});

describe('XML entity decoding in annotation values', () => {
  // A StandardName like "Flex R&D" is escaped to "Flex R&amp;D" in EDMX; the parser must decode
  // it back. (With processEntities off it parsed to the literal "Flex R&amp;D", corrupting it.)
  const edmx = `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="org.reso.metadata" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Property">
        <Key><PropertyRef Name="ListingKey"/></Key>
        <Property Name="ListingKey" Type="Edm.String"/>
      </EntityType>
      <EntityContainer Name="Default">
        <EntitySet Name="Property" EntityType="org.reso.metadata.Property"/>
      </EntityContainer>
    </Schema>
    <Schema Namespace="org.reso.metadata.enums" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EnumType Name="PropertySubcategory">
        <Member Name="FlexRAndD" Value="0">
          <Annotation Term="RESO.OData.Metadata.StandardName" String="Flex R&amp;D"/>
        </Member>
      </EnumType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

  it('decodes &amp; in a member StandardName', () => {
    const schema = parseCsdlXml(edmx);
    const member = schema.enumTypes
      .find(e => e.name === 'PropertySubcategory')
      ?.members.find(m => m.name === 'FlexRAndD');
    expect(member?.annotations?.['RESO.OData.Metadata.StandardName']).toBe('Flex R&D');
  });
});

describe('primary key flag from the CSDL <Key>', () => {
  it('marks the entity key field as isPrimaryKey', () => {
    // The top-level `edmx` declares <Key><PropertyRef Name="ListingKey"/></Key> on Property.
    const fields = getAllFields(parseCsdlXml(edmx)).Property ?? [];
    expect(fields.find(f => f.fieldName === 'ListingKey')?.isPrimaryKey).toBe(true);
    expect(fields.find(f => f.fieldName === 'StandardStatus')?.isPrimaryKey).toBeUndefined();
  });
});
