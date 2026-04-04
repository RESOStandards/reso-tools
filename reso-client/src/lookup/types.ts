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
  /** Maximum page size for Lookup Resource queries. Sent via Prefer: odata.maxpagesize=N. Default: 1000. */
  readonly maxPageSize?: number;
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
   * Batch-resolve lookup values for multiple lookup names in a single request.
   * Uses `$filter=LookupName in (...)` for efficiency. Returns a map of lookupName → values.
   */
  readonly resolveLookupsBatch: (lookupNames: ReadonlyArray<string>) => Promise<Readonly<Record<string, ReadonlyArray<LookupValue>>>>;
  /**
   * Resolve all lookup values for every enum/lookup field in a resource.
   * Returns a record keyed by field name.
   */
  readonly resolveLookupsForResource: (resourceName: string) => Promise<Readonly<Record<string, ReadonlyArray<LookupValue>>>>;
}
