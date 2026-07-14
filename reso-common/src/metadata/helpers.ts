import { KEY_FIELD_MAP } from './model.js';
import type { ResoField, ResoLookup, ResoMetadata } from './model.js';

/**
 * Whether a field type denotes an enum/lookup — i.e. anything that is not an `Edm.`
 * primitive. This is the canonical copy; `@reso-standards/reso-validation` and
 * `reso-data-generator` carry duplicates pending consolidation.
 * TODO(#222): collapse those duplicates onto this one, and add an `isEnumField` that reads the
 * precomputed `isEnumeration` flag (crude `isEnumType` fallback). See reso-tools #222.
 */
export const isEnumType = (type: string): boolean => !type.startsWith('Edm.');

/**
 * OData SimpleIdentifier pattern: starts with a letter or underscore, then letters, digits or
 * underscores, up to 128 characters. Per the OASIS OData CSDL specification
 * (https://docs.oasis-open.org/odata/odata/v4.01/odata-v4.01-part3-csdl.html#sec_SimpleIdentifier).
 */
export const SIMPLE_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * Whether a string is a valid OData SimpleIdentifier — the deterministic shape constraint every
 * structural identifier (resource, field, navigation-property and complex-type name) and every
 * non-string `EnumType` member must satisfy. String-enumeration values (backed by a Lookup
 * Resource) are not bound by it; see the DD naming policy for the governance boundary.
 */
export const isValidSimpleIdentifier = (name: string): boolean => SIMPLE_IDENTIFIER_RE.test(name);

/** All fields belonging to a specific resource. */
export const getFieldsForResource = (metadata: ResoMetadata, resourceName: string): ReadonlyArray<ResoField> =>
  metadata.fields.filter(f => f.resourceName === resourceName);

/** All lookup values for a given enum type (fully qualified name). */
export const getLookupsForType = (metadata: ResoMetadata, lookupName: string): ReadonlyArray<ResoLookup> =>
  metadata.lookups.filter(l => l.lookupName === lookupName);

/** The default primary-key convention: `{ResourceName}Key`. */
const keyifyResourceName = (resourceName: string): string => `${resourceName.trim()}Key`;

/**
 * Primary key field name for a resource. Returns the KEY_FIELD_MAP exception when one exists,
 * otherwise the `{ResourceName}Key` convention — mirroring the Web API Commander's
 * getKeyFieldForResource, so every resource resolves to a real key field (see KEY_FIELD_MAP for
 * provenance and the DD-2.2 retirement note). Generators should prefer a field's own
 * `isPrimaryKey` when the metadata carries it; this is the fallback for DD-reference generation,
 * where the DD does not encode keys.
 */
export const getKeyFieldForResource = (resourceName: string): string =>
  KEY_FIELD_MAP[resourceName] ?? keyifyResourceName(resourceName);
