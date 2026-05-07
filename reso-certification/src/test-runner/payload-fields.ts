/**
 * Helpers for extracting field-level information from a RESO Web API
 * record payload, given the EntityType from parsed metadata.
 *
 * Originally local to the Add/Edit compliance report; lifted here so
 * any consumer with a parsed EntityType in hand (MCP server, AI agent
 * tooling, other endorsement reports) can reuse the same logic
 * without duplicating it.
 */

import type { EntityProperty, EntityType } from './types.js';

/** A single enumeration field's name and observed value in a payload. */
export interface EnumerationDetail {
  readonly fieldName: string;
  readonly value: unknown;
}

/** True when an EntityProperty represents a RESO enumeration. */
export const isEnumProperty = (prop: EntityProperty): boolean =>
  prop.type.startsWith('org.reso.metadata.enums.') ||
  prop.type.startsWith('Collection(org.reso.metadata.enums.') ||
  prop.annotations?.['RESO.OData.Metadata.LookupName'] !== undefined;

/** Extract field names from a payload, excluding OData annotations and key fields. */
export const extractPayloadFields = (
  payload: Record<string, unknown>,
  entityType: EntityType,
): ReadonlyArray<string> => {
  const keySet = new Set(entityType.keyProperties);
  return Object.keys(payload).filter(k => !k.startsWith('@') && !keySet.has(k));
};

/** Extract enumeration field names and their values from a payload. */
export const extractEnumerations = (
  payload: Record<string, unknown>,
  entityType: EntityType,
): ReadonlyArray<EnumerationDetail> => {
  const propMap = new Map(entityType.properties.map(p => [p.name, p]));
  const results: EnumerationDetail[] = [];

  for (const [fieldName, value] of Object.entries(payload)) {
    if (fieldName.startsWith('@')) continue;
    const prop = propMap.get(fieldName);
    if (prop && isEnumProperty(prop) && value !== null && value !== undefined) {
      results.push({ fieldName, value });
    }
  }

  return results;
};

/** Extract expansion (navigation property) field names from a payload. */
export const extractExpansions = (
  payload: Record<string, unknown>,
  entityType: EntityType,
): ReadonlyArray<string> => {
  const propNames = new Set(entityType.properties.map(p => p.name));
  return Object.keys(payload).filter(
    k => !k.startsWith('@') && !propNames.has(k) && (Array.isArray(payload[k]) || typeof payload[k] === 'object'),
  );
};
