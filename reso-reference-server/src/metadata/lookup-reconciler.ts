/**
 * Lookup Resource reconciliation — scans generated data for enum field values
 * and inserts any that are missing from the Lookup Resource.
 *
 * This ensures that all values used in generated data are advertised in the
 * metadata, which is required for certification schema validation.
 */

import { createHash } from 'node:crypto';
import type { DataAccessLayer, ResourceContext } from '../db/data-access.js';
import { getFieldsForResource, getKeyFieldForResource, isEnumType } from './loader.js';
import type { ResoMetadata } from './types.js';

const LOOKUP_NAME_ANNOTATION_TERM = 'RESO.OData.Metadata.LookupName';
const ENUM_PREFIX = 'org.reso.metadata.enums.';

/** Strips the enum namespace prefix from a type name. */
const stripEnumPrefix = (name: string): string =>
  name.startsWith(ENUM_PREFIX) ? name.slice(ENUM_PREFIX.length) : name;

/** Unwraps Collection() wrapper from a type name. */
const unwrapCollection = (type: string): string =>
  type.startsWith('Collection(') && type.endsWith(')') ? type.slice(11, -1) : type;

/** Generates a deterministic LookupKey. */
const generateLookupKey = (lookupName: string, lookupValue: string): string =>
  createHash('sha256').update(`${lookupName}:${lookupValue}`).digest('hex');

/**
 * Builds a map of fieldName → lookupName for all enum fields in a resource.
 * Handles both string mode (LookupName annotation) and enum-type mode (type name).
 */
const buildFieldLookupMap = (
  metadata: ResoMetadata,
  resourceName: string,
): ReadonlyMap<string, string> => {
  const fields = getFieldsForResource(metadata, resourceName);
  const map = new Map<string, string>();

  for (const field of fields) {
    const lookupAnnotation = field.annotations?.find(a => a.term === LOOKUP_NAME_ANNOTATION_TERM);
    const rawType = unwrapCollection(field.type);

    if (lookupAnnotation) {
      map.set(field.fieldName, lookupAnnotation.value);
    } else if (isEnumType(rawType)) {
      map.set(field.fieldName, stripEnumPrefix(rawType));
    }
  }

  return map;
};

/**
 * Scans generated records for enum field values and inserts any missing values
 * into the Lookup Resource.
 *
 * @param dal - Data access layer for querying and inserting.
 * @param metadata - Server metadata with field and lookup definitions.
 * @param resourceName - The resource whose records were generated.
 * @param records - The generated records to scan.
 * @returns Number of new Lookup records inserted.
 */
export const reconcileLookups = async (
  dal: DataAccessLayer,
  metadata: ResoMetadata,
  resourceName: string,
  records: ReadonlyArray<Record<string, unknown>>,
): Promise<number> => {
  const keyField = getKeyFieldForResource('Lookup');
  const lookupFields = getFieldsForResource(metadata, 'Lookup');
  if (!keyField || lookupFields.length === 0) return 0;

  const lookupCtx: ResourceContext = {
    resource: 'Lookup',
    keyField,
    fields: lookupFields,
    navigationBindings: [],
  };

  const fieldLookupMap = buildFieldLookupMap(metadata, resourceName);
  if (fieldLookupMap.size === 0) return 0;

  // Collect distinct values per lookupName from the generated records
  const valuesByLookup = new Map<string, Set<string>>();

  for (const record of records) {
    for (const [fieldName, lookupName] of fieldLookupMap) {
      const value = record[fieldName];
      if (value === undefined || value === null) continue;

      const values = Array.isArray(value) ? value.map(String) : [String(value)];
      for (const v of values) {
        if (!v) continue;
        const existing = valuesByLookup.get(lookupName);
        if (existing) {
          existing.add(v);
        } else {
          valuesByLookup.set(lookupName, new Set([v]));
        }
      }
    }
  }

  if (valuesByLookup.size === 0) return 0;

  // Query existing Lookup values to avoid duplicates
  const existingValues = new Map<string, Set<string>>();
  for (const lookupName of valuesByLookup.keys()) {
    const result = await dal.queryCollection(lookupCtx, {
      $filter: `LookupName eq '${lookupName}'`,
      $select: 'LookupValue',
      $top: 10000,
    });
    existingValues.set(
      lookupName,
      new Set(result.value.map(r => String(r.LookupValue ?? ''))),
    );
  }

  // Insert missing values
  const timestamp = new Date().toISOString();
  let inserted = 0;

  for (const [lookupName, values] of valuesByLookup) {
    const existing = existingValues.get(lookupName) ?? new Set();

    for (const value of values) {
      if (existing.has(value)) continue;

      try {
        await dal.insert(lookupCtx, {
          LookupKey: generateLookupKey(lookupName, value),
          LookupName: lookupName,
          LookupValue: value,
          StandardLookupValue: value,
          LegacyODataValue: value,
          ModificationTimestamp: timestamp,
        });
        inserted++;
      } catch {
        // Duplicate key or constraint violation — skip silently
      }
    }
  }

  return inserted;
};
