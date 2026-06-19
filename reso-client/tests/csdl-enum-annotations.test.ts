import { describe, it, expect } from 'vitest';
import { parseCsdlXml } from '../src/index.js';

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
