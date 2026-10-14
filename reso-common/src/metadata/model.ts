/**
 * RESO metadata model — the shared, universal (browser + Node) shape used across the
 * reference server, the certification tooling and anything else that reads or projects
 * RESO Data Dictionary metadata.
 *
 * Pure types and data only — no runtime dependencies and no Node APIs, so this module is
 * safe to bundle into the browser.
 */

/** Annotation entry from RESO metadata (e.g., StandardName, Description, DDWikiUrl). */
export interface ResoAnnotation {
  readonly term: string;
  readonly value: string;
}

/** A RESO resource definition (e.g., Property, Member, Office). */
export interface ResoResource {
  readonly resourceName: string;
  readonly wikiPageURL: string;
  readonly payloads: ReadonlyArray<string>;
}

/** A field definition from the RESO Data Dictionary metadata. */
export interface ResoField {
  readonly resourceName: string;
  readonly fieldName: string;
  readonly type: string;
  readonly typeName?: string;
  readonly nullable?: boolean;
  readonly isCollection?: boolean;
  readonly isExpansion?: boolean;
  readonly isEnumeration?: boolean;
  readonly maxLength?: number;
  readonly scale?: number;
  readonly precision?: number;
  /**
   * True when this field is (part of) the entity type's primary key, from the CSDL <Key>.
   * Set when parsing live-server or generated metadata (which always carries keys); generators
   * prefer this over the KEY_FIELD_MAP/convention fallback when it is present.
   */
  readonly isPrimaryKey?: boolean;
  readonly annotations: ReadonlyArray<ResoAnnotation>;
}

/** A lookup value entry (one member of an enumeration). */
export interface ResoLookup {
  readonly lookupName: string;
  readonly lookupValue: string;
  readonly type: string;
  readonly annotations: ReadonlyArray<ResoAnnotation>;
}

/** Top-level RESO metadata document structure. */
export interface ResoMetadata {
  readonly description: string;
  readonly version: string;
  readonly generatedOn: string;
  readonly resources: ReadonlyArray<ResoResource>;
  readonly fields: ReadonlyArray<ResoField>;
  readonly lookups: ReadonlyArray<ResoLookup>;
}

/** Enumeration mode: string enums with Lookup Resource, or OData EnumType definitions. */
export type EnumMode = 'string' | 'enum-type';

/**
 * Primary-key field EXCEPTIONS — resources whose key field deviates from the default
 * `{ResourceName}Key` convention. Ported verbatim from the Web API Commander's
 * DataDictionaryMetadata.getKeyFieldForResource (the switch cases):
 * https://github.com/RESOStandards/web-api-commander/blob/ff8baf0fae753fe98d591e2723ecbcc8195fe98a/src/main/java/org/reso/commander/common/DataDictionaryMetadata.java#L4
 *
 * The DD does not encode primary keys through 2.1, so there is nothing to read from the
 * reference data — this list is hand-maintained the way the Commander does it. Resolve keys
 * via `getKeyFieldForResource`, which applies the `{ResourceName}Key` convention for anything
 * NOT listed here; only the exceptions live in this map. (Direct indexing returns undefined for
 * convention resources by design — go through the helper.)
 *
 * Live-server and generated metadata DO carry keys (the CSDL <Key>), so `generateEdmx` prefers
 * a field's own `isPrimaryKey` over this fallback. DD 2.2 will carry keys in the spec, at which
 * point the data is authoritative and this map can be generated/retired.
 *
 * Verified against dd-1.7/2.0/2.1: every resource's resolved key (exception or convention) is a
 * real, existing field — see the dd-key-coverage regression test.
 */
export const KEY_FIELD_MAP: Readonly<Record<string, string>> = {
  Property: 'ListingKey',
  Contacts: 'ContactKey',
  ContactListingNotes: 'ContactKey',
  InternetTracking: 'EventKey',
  InternetTrackingSummary: 'ListingId',
  OUID: 'OrganizationUniqueIdKey',
  Queue: 'QueueTransactionKey',
  PropertyGreenVerification: 'GreenBuildingVerificationKey',
  PropertyRooms: 'RoomKey',
  PropertyUnitTypes: 'UnitTypeKey',
  EntityEvent: 'EntityEventSequence',
  MemberAssociation: 'AssociationKey',
  OfficeAssociation: 'AssociationKey',
  TransactionManagement: 'TransactionKey',
  Rules: 'RuleKey',
  Teams: 'TeamKey',
  TeamMembers: 'TeamMemberKey',
  PropertyPowerProduction: 'PowerProductionKey',
  PropertyPowerStorage: 'PowerStorageKey'
};
