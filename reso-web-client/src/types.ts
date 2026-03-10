/** Annotation entry from RESO metadata (e.g., StandardName, Description). */
export interface ResoAnnotation {
  readonly term: string;
  readonly value: string;
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
  readonly maxLength?: number;
  readonly scale?: number;
  readonly precision?: number;
  readonly annotations: ReadonlyArray<ResoAnnotation>;
  /**
   * LookupName for fields that use the Lookup Resource (Edm.String with
   * RESO.OData.Metadata.LookupName annotation). When set, lookup values
   * are fetched from the Lookup entity set rather than CSDL enum types.
   */
  readonly lookupName?: string;
}

/** A lookup value entry (one member of an enumeration). */
export interface ResoLookup {
  readonly lookupName: string;
  readonly lookupValue: string;
  readonly type: string;
  readonly annotations: ReadonlyArray<ResoAnnotation>;
  /** RESO standard lookup value. Present when fetched from the Lookup Resource. */
  readonly standardLookupValue?: string;
  /** Legacy OData enumeration member name. Present when fetched from the Lookup Resource. */
  readonly legacyODataValue?: string;
}

/** UI configuration served by the server at GET /ui-config. */
export interface UiConfig {
  readonly resources: Readonly<
    Record<
      string,
      {
        readonly summaryFields: ReadonlyArray<string> | '__all__';
      }
    >
  >;
}

/** Field group mapping served by the server at GET /field-groups. */
export type FieldGroups = Readonly<Record<string, Readonly<Record<string, ReadonlyArray<string>>>>>;

/** Default summary fields per resource, ranked by RESO adoption data. */
export type SummaryFieldsConfig = Readonly<Record<string, ReadonlyArray<string>>>;

/** OData collection response shape. */
export interface ODataCollectionResponse {
  readonly '@odata.context'?: string;
  readonly '@odata.count'?: number;
  readonly '@odata.nextLink'?: string;
  readonly value: ReadonlyArray<Record<string, unknown>>;
}

/** OData error response shape. */
export interface ODataError {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: ReadonlyArray<{
      readonly code: string;
      readonly target?: string;
      readonly message: string;
    }>;
  };
}

/** Target resources supported by the reference server. */
export const TARGET_RESOURCES = [
  'Property',
  'Member',
  'Office',
  'Media',
  'OpenHouse',
  'Showing',
  'PropertyGreenVerification',
  'PropertyPowerProduction',
  'PropertyRooms',
  'PropertyUnitTypes',
  'Teams',
  'TeamMembers',
  'OUID',
  'Lookup'
] as const;
export type ResourceName = (typeof TARGET_RESOURCES)[number];

/** Resources that are read-only (no Add/Edit/Delete). */
export const READ_ONLY_RESOURCES: ReadonlySet<string> = new Set(['Lookup']);

/** A RESO member organization from the Organizations and Endorsements service. */
export interface ResoOrganization {
  readonly OrganizationUniqueId: string;
  readonly OrganizationType: string;
  readonly OrganizationName: string;
  readonly OrganizationAddress1: string;
  readonly OrganizationCity: string;
  readonly OrganizationStateOrProvince: string;
  readonly OrganizationPostalCode: string;
  readonly OrganizationWebsite: string | null;
  readonly OrganizationCountry: string;
  readonly ModificationTimestamp: string;
  readonly OrganizationLatitude: number;
  readonly OrganizationLongitude: number;
  readonly OrganizationMemberCount: number | null;
  readonly OrganizationCertName: string | null;
  readonly AssnToMls: string | null;
  readonly CertificationStatus: string;
  readonly CertificationSummaryUrl: string;
  readonly Endorsements: ReadonlyArray<ResoEndorsement>;
}

/** An endorsement (certification) held by a RESO organization. */
export interface ResoEndorsement {
  readonly Endorsement: string;
  readonly Version: string;
  readonly Status: string;
  readonly ProviderUoi: string;
  readonly StatusUpdatedAt: string;
}

/** Response shape from the RESO Organizations and Endorsements service. */
export interface OrganizationsResponse {
  readonly Description: string;
  readonly GeneratedOn: string;
  readonly Organizations: ReadonlyArray<ResoOrganization>;
}

export { isEnumType, isNumericEdmType } from '@reso-standards/validation';
