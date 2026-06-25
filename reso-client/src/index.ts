/**
 * @reso-standards/reso-client
 *
 * OData 4.01 client SDK for TypeScript. Provides URI building, CRUD helpers,
 * CSDL metadata parsing/validation, query option validation, and response
 * parsing.
 *
 * Inspired by Apache Olingo's Java Client SDK.
 *
 * @see https://olingo.apache.org/doc/odata4/index.html
 *
 * @example
 * ```ts
 * import { createClient, createEntity, readEntity, buildUri } from "@reso-standards/reso-client";
 *
 * const client = await createClient({
 *   baseUrl: "http://localhost:8080",
 *   auth: { mode: "token", authToken: "test" },
 * });
 *
 * const created = await createEntity(client, "Property", {
 *   ListPrice: 250000,
 *   City: "Austin",
 * }, { prefer: "representation" });
 * ```
 */

// Types
export type {
  ODataQueryOptions,
  ODataResponse,
  ODataEntity,
  ODataCollection,
  ODataAnnotations,
  ODataErrorBody,
  ODataErrorDetail,
  AuthConfig,
  TokenAuth,
  ClientCredentialsAuth,
  CredentialTransport,
  TokenResponse,
  TokenState,
  TokenProvider,
  ClientConfig,
  PreferReturn,
  WriteOptions,
  ODataClient
} from './types.js';

// URI builder
export { buildUri } from './uri/builder.js';
export type { UriBuilder } from './uri/builder.js';
export { parseQueryString } from './uri/parser.js';

// CSDL parse/validate + the Csdl* types moved to @reso-standards/reso-metadata-utils (reso-tools #221).
// Consumers import them directly from that package — no pass-through re-export here, per the
// "each lib owns its deps" rule. The metadata fetchers below still live in reso-client (Stage 3 pending).

// Query validator
export { validateQueryOptions } from './query/validator.js';
export type {
  QueryValidationError,
  QueryValidationResult
} from './query/validator.js';

// HTTP client & auth
export { createClient } from './http/client.js';
export { createTokenProvider, resolveToken, fetchAccessToken } from './http/auth.js';

// CRUD helpers
export { createEntity } from './crud/create.js';
export { readEntity } from './crud/read.js';
export { updateEntity } from './crud/update.js';
export { replaceEntity } from './crud/replace.js';
export { deleteEntity } from './crud/delete.js';
export type { DeleteOptions } from './crud/delete.js';
export { queryEntities } from './crud/query.js';

// Response parsing
export { extractAnnotations, isODataCollection, extractEntityData, getNextLink, followAllPages } from './response/parser.js';
export { isODataError, parseODataError, getErrorTargets } from './response/error.js';

// Environment config
export { authConfigFromEnv, configFromEnv } from './env.js';
export type { EnvConfig } from './env.js';

// Metadata fetcher moved to @reso-standards/reso-metadata-utils (reso-tools #221, Stage 3).
// Import fetchRawMetadata*, fetchAndParseMetadata, and MetadataFetchError from there directly.

// Lookup resolver
export { createLookupResolver } from './lookup/resolver.js';
export type { LookupValue, LookupResolverConfig, LookupResolver } from './lookup/types.js';

// Re-export expression parser types for convenience
export type {
  FilterExpression,
  ComparisonExpr,
  LogicalExpr,
  NotExpr,
  ArithmeticExpr,
  FunctionCallExpr,
  LambdaExpr,
  CollectionExpr,
  LiteralExpr,
  PropertyExpr,
  ExpandExpression,
  ExpandQueryOptions
} from '@reso-standards/odata-expression-parser';
export { parseFilter, parseExpand } from '@reso-standards/odata-expression-parser';

// Utilities — CSV serialization (variations export, ingest)
export { escapeCsvField, rowsToCsv, csvToRows } from './utils/csv.js';
export { VARIATIONS_CSV_COLUMNS, variationsToCsv, csvToVariations } from './utils/variations-csv.js';
export type { VariationCsvRow, ParseVariationsCsvResult, ParseVariationsCsvError } from './utils/variations-csv.js';

// Utilities — variation key (composite identifier)
export { VARIATION_KEY_SEP, buildVariationKey, parseVariationKey } from './utils/variation-key.js';
export type { ParsedVariationKey } from './utils/variation-key.js';
