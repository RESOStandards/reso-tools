import { KEY_FIELD_MAP } from './model.js';
import type { ResoField, ResoLookup, ResoMetadata } from './model.js';

/**
 * Whether a field type denotes an enum/lookup — i.e. anything that is not an `Edm.`
 * primitive. This mirrors the predicate used by `@reso-standards/reso-validation`;
 * kept here so `reso-common` has zero runtime dependencies. Consolidate later by having
 * validation import this one.
 */
export const isEnumType = (type: string): boolean => !type.startsWith('Edm.');

/** All fields belonging to a specific resource. */
export const getFieldsForResource = (metadata: ResoMetadata, resourceName: string): ReadonlyArray<ResoField> =>
  metadata.fields.filter(f => f.resourceName === resourceName);

/** All lookup values for a given enum type (fully qualified name). */
export const getLookupsForType = (metadata: ResoMetadata, lookupName: string): ReadonlyArray<ResoLookup> =>
  metadata.lookups.filter(l => l.lookupName === lookupName);

/** Primary key field name for a resource, or undefined if unknown. */
export const getKeyFieldForResource = (resourceName: string): string | undefined => KEY_FIELD_MAP[resourceName];
