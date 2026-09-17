import { describe, it, expect } from 'vitest';
import { parseCsdlXml } from '../src/csdl/parser.js';
import { validateCsdl } from '../src/csdl/validator.js';

/**
 * CSDL schema Alias resolution across EVERY qualified-name attribute (OData CSDL XML 4.01 §3.4: a schema may
 * declare `Alias`, and qualified names may use the alias or the namespace interchangeably). The parser must
 * canonicalize all of them to the namespace form, so the validator — whose maps are keyed by namespace FQDN —
 * sees one spelling. Before reso-tools #300 only Property/NavigationProperty/BaseType were canonicalized;
 * EntitySet/@EntityType was not, so an alias-spelled entity set silently disabled the navigation-binding
 * check and the dangling-type check (false pass on a defective binding).
 */

const NS = 'org.reso.metadata';
const ALIAS = 'WEBAPI';

/** A provider metadata document with the binding's correctness and the type spellings as knobs. */
const edmx = (opts: { setType: string; navType: string; bindingCorrect?: boolean; setTypo?: boolean; withOperations?: boolean }): string => {
  const media = opts.bindingCorrect === false ? `Collection(${opts.navType}.Property)` : `Collection(${opts.navType}.Media)`;
  const propertySet = opts.setTypo ? `${opts.setType}.Propertyy` : `${opts.setType}.Property`;
  const operations = opts.withOperations
    ? `<Function Name="Nearby" IsBound="true"><Parameter Name="bindingParameter" Type="Collection(${opts.setType}.Property)"/><ReturnType Type="Collection(${opts.setType}.Property)"/></Function>
       <Action Name="Touch"><Parameter Name="target" Type="${opts.setType}.Media"/></Action>`
    : '';
  const imports = opts.withOperations
    ? `<FunctionImport Name="Nearby" Function="${opts.setType}.Nearby" EntitySet="Property"/><ActionImport Name="Touch" Action="${opts.setType}.Touch"/>
       <Singleton Name="Me" Type="${opts.setType}.Member"/>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices>
<Schema Namespace="${NS}" Alias="${ALIAS}" xmlns="http://docs.oasis-open.org/odata/ns/edm">
  <EntityType Name="Property"><Key><PropertyRef Name="ListingKey"/></Key><Property Name="ListingKey" Type="Edm.String"/>
    <NavigationProperty Name="Media" Type="${media}"/></EntityType>
  <EntityType Name="Media"><Key><PropertyRef Name="MediaKey"/></Key><Property Name="MediaKey" Type="Edm.String"/></EntityType>
  <EntityType Name="Member"><Key><PropertyRef Name="MemberKey"/></Key><Property Name="MemberKey" Type="Edm.String"/></EntityType>
  ${operations}
  <EntityContainer Name="Default">
    <EntitySet Name="Property" EntityType="${propertySet}"><NavigationPropertyBinding Path="Media" Target="Media"/></EntitySet>
    <EntitySet Name="Media" EntityType="${opts.setType}.Media"/>
    <EntitySet Name="Member" EntityType="${opts.setType}.Member"/>
    ${imports}
  </EntityContainer>
</Schema></edmx:DataServices></edmx:Edmx>`;
};

const messages = (xml: string): ReadonlyArray<string> => validateCsdl(parseCsdlXml(xml)).errors.map(e => e.message);

describe('CSDL Alias resolution — parser canonicalizes every qualified-name attribute', () => {
  it('EntitySet/@EntityType spelled with the alias parses as the namespace form', () => {
    const schema = parseCsdlXml(edmx({ setType: ALIAS, navType: ALIAS }));
    expect(schema.entityContainer?.entitySets.map(es => es.entityType)).toEqual([`${NS}.Property`, `${NS}.Media`, `${NS}.Member`]);
  });

  const aliased = () => parseCsdlXml(edmx({ setType: ALIAS, navType: ALIAS, withOperations: true }));
  it.each([
    ['Singleton/@Type', (s: ReturnType<typeof parseCsdlXml>) => s.entityContainer?.singletons[0]?.type, `${NS}.Member`],
    ['Function Parameter/@Type (Collection)', (s: ReturnType<typeof parseCsdlXml>) => s.functions[0]?.parameters[0]?.type, `Collection(${NS}.Property)`],
    ['Function ReturnType/@Type (Collection)', (s: ReturnType<typeof parseCsdlXml>) => s.functions[0]?.returnType?.type, `Collection(${NS}.Property)`],
    ['Action Parameter/@Type', (s: ReturnType<typeof parseCsdlXml>) => s.actions[0]?.parameters[0]?.type, `${NS}.Media`],
    ['FunctionImport/@Function', (s: ReturnType<typeof parseCsdlXml>) => s.entityContainer?.functionImports[0]?.function, `${NS}.Nearby`],
    ['ActionImport/@Action', (s: ReturnType<typeof parseCsdlXml>) => s.entityContainer?.actionImports[0]?.action, `${NS}.Touch`],
  ])('%s spelled with the alias parses as the namespace form', (_label, read, expected) => {
    expect(read(aliased())).toBe(expected);
  });

  it('maps each alias to ITS OWN schema namespace, not the first schema\'s (two aliased schemas)', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices>
<Schema Namespace="${NS}" Alias="${ALIAS}" xmlns="http://docs.oasis-open.org/odata/ns/edm">
  <EntityType Name="Property"><Key><PropertyRef Name="ListingKey"/></Key><Property Name="ListingKey" Type="Edm.String"/>
    <Property Name="StandardStatus" Type="RESOEnums.StandardStatus"/></EntityType>
  <EntityContainer Name="Default"><EntitySet Name="Property" EntityType="${ALIAS}.Property"/></EntityContainer>
</Schema>
<Schema Namespace="${NS}.enums" Alias="RESOEnums" xmlns="http://docs.oasis-open.org/odata/ns/edm">
  <EnumType Name="StandardStatus"><Member Name="Active" Value="0"/></EnumType>
</Schema></edmx:DataServices></edmx:Edmx>`;
    const schema = parseCsdlXml(xml);
    expect(schema.entityContainer?.entitySets[0]?.entityType).toBe(`${NS}.Property`);
    expect(schema.entityTypes[0]?.properties.find(p => p.name === 'StandardStatus')?.type).toBe(`${NS}.enums.StandardStatus`);
    expect(validateCsdl(schema).errors.map(e => e.message)).toEqual([]);
  });

  it('negative controls: an unqualified name and a mis-cased alias are left exactly as written (aliases are case-sensitive)', () => {
    const schema = parseCsdlXml(edmx({ setType: 'webapi', navType: NS }));
    expect(schema.entityContainer?.entitySets[0]?.entityType).toBe('webapi.Property');
    const bare = parseCsdlXml(edmx({ setType: NS, navType: NS }).replace(`EntityType="${NS}.Media"`, 'EntityType="Media"'));
    expect(bare.entityContainer?.entitySets[1]?.entityType).toBe('Media');
  });

  it('the namespace spelling is untouched, and a prefix that is not a declared alias is left as written', () => {
    const schema = parseCsdlXml(edmx({ setType: NS, navType: NS }));
    expect(schema.entityContainer?.entitySets[0]?.entityType).toBe(`${NS}.Property`);
    const foreign = parseCsdlXml(edmx({ setType: 'Other.Vendor', navType: NS }));
    expect(foreign.entityContainer?.entitySets[0]?.entityType).toBe('Other.Vendor.Property');
  });
});

describe('CSDL Alias resolution — the validator sees one spelling', () => {
  const spellings: ReadonlyArray<[string, string, string]> = [
    ['namespace set / namespace nav', NS, NS],
    ['alias set / alias nav', ALIAS, ALIAS],
    ['alias set / namespace nav', ALIAS, NS],
    ['namespace set / alias nav', NS, ALIAS],
  ];

  it.each(spellings)('%s — a correct document validates with zero errors', (_label, setType, navType) => {
    expect(messages(edmx({ setType, navType, withOperations: true }))).toEqual([]);
  });

  it.each(spellings)('%s — a navigation bound to a set of the wrong type is reported, with the namespace spelling in the message', (_label, setType, navType) => {
    const errors = messages(edmx({ setType, navType, bindingCorrect: false }));
    expect(errors).toEqual([`Navigation property type '${NS}.Property' does not match binding target entity type '${NS}.Media'`]);
  });

  it.each(spellings)('%s — an entity set whose type does not exist is reported as unknown', (_label, setType, navType) => {
    const errors = messages(edmx({ setType, navType, setTypo: true }));
    expect(errors).toEqual([`Entity set references unknown entity type '${NS}.Propertyy'`]);
  });
});

describe('CSDL Alias resolution — malformed input is the validator\'s job, not a parse crash', () => {
  it('an EntitySet without an EntityType attribute still parses (entityType undefined), as before', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices>
<Schema Namespace="${NS}" Alias="${ALIAS}" xmlns="http://docs.oasis-open.org/odata/ns/edm">
  <EntityType Name="Property"><Key><PropertyRef Name="ListingKey"/></Key><Property Name="ListingKey" Type="Edm.String"/></EntityType>
  <EntityContainer Name="Default"><EntitySet Name="Property"/><ActionImport Name="Touch"/></EntityContainer>
</Schema></edmx:DataServices></edmx:Edmx>`;
    const schema = parseCsdlXml(xml);
    expect(schema.entityContainer?.entitySets[0]?.entityType).toBeUndefined();
    expect(schema.entityContainer?.actionImports[0]?.action).toBeUndefined();
  });
});

describe('CSDL Alias resolution — §3.4 MUSTs: an invalid alias is never used to rewrite a reference', () => {
  const doc = (schemas: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices>${schemas}</edmx:DataServices></edmx:Edmx>`;
  const schemaWith = (ns: string, alias: string | undefined, setType: string): string =>
    `<Schema Namespace="${ns}"${alias ? ` Alias="${alias}"` : ''} xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="Property"><Key><PropertyRef Name="K"/></Key><Property Name="K" Type="Edm.String"/></EntityType>
      <EntityContainer Name="C"><EntitySet Name="Property" EntityType="${setType}"/></EntityContainer></Schema>`;

  it('a duplicate alias maps neither schema: references through it stay as written', () => {
    const schema = parseCsdlXml(doc(schemaWith('org.a', 'X', 'X.Property') + schemaWith('org.b', 'X', 'X.Property')));
    expect(schema.entityContainer?.entitySets.map(e => e.entityType)).toEqual(['X.Property']);
  });

  it('an alias equal to another schema\'s namespace never rewrites that namespace\'s own spelling', () => {
    const schema = parseCsdlXml(doc(schemaWith('org.a', undefined, 'org.a.Property') + schemaWith('org.b', 'org.a', 'org.b.Property')));
    expect(schema.entityContainer?.entitySets.map(e => e.entityType)).toEqual(['org.a.Property']);
    expect(validateCsdl(schema).errors.map(e => e.message)).toEqual([]);
  });

  it.each(['Edm', 'odata', 'System', 'Transient'])('the reserved alias %s is ignored (a reference through it is left as written)', (reserved) => {
    const schema = parseCsdlXml(doc(schemaWith('org.x', reserved, `${reserved}.Property`)));
    expect(schema.entityContainer?.entitySets[0]?.entityType).toBe(`${reserved}.Property`);
    const primitive = parseCsdlXml(doc(schemaWith('org.x', 'Edm', 'org.x.Property')));
    expect(primitive.entityTypes[0]?.properties[0]?.type).toBe('Edm.String');
  });
});
