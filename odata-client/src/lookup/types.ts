/**
 * Types for the RESO lookup resolver — unified interface for resolving
 * enumeration values from CSDL EnumTypes or the Lookup Resource.
 */

/** A single lookup/enumeration value. */
export interface LookupValue {
  readonly lookupName: string;
  readonly lookupValue: string;
  /** RESO standard lookup value. Present only when fetched from Lookup Resource. */
  readonly standardLookupValue?: string;
  /** Legacy OData enumeration member name. Present only when fetched from Lookup Resource. */
  readonly legacyODataValue?: string;
}

/** Configuration for creating a lookup resolver. */
export interface LookupResolverConfig {
  /** The parsed CSDL schema (from parseCsdlXml). */
  readonly schema: import('../csdl/types.js').CsdlSchema;
  /** Base URL for the OData server. Required for Lookup Resource fetching. */
  readonly baseUrl?: string;
  /** Bearer token for authenticated requests. */
  readonly token?: string;
  /**
   * Custom fetch function. Defaults to global `fetch`.
   * Useful for proxying requests in browser environments.
   */
  readonly fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
}

/** A resolver that provides lookup values from CSDL enums or the Lookup Resource. */
export interface LookupResolver {
  /** Whether the server exposes a Lookup entity set. */
  readonly hasLookupResource: boolean;
  /**
   * Get lookup values by LookupName.
   * Fetches from the Lookup Resource if available, otherwise falls back to
   * CSDL EnumType members.
   */
  readonly resolveLookups: (lookupName: string) => Promise<ReadonlyArray<LookupValue>>;
  /**
   * Resolve all lookup values for every enum/lookup field in a resource.
   * Returns a record keyed by field name.
   */
  readonly resolveLookupsForResource: (resourceName: string) => Promise<Readonly<Record<string, ReadonlyArray<LookupValue>>>>;
}
