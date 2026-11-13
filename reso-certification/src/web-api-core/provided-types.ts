/**
 * Which Core data types a resource PROVIDES: a field declared with that type in the metadata that holds data, in the
 * records sampled, enough to meet the type.
 *
 * Full type coverage (Josh, 2026-11-03): "For Cert, full coverage needs to be achieved across all types for a Core
 * server to be considered compliant", and "a server who can't fulfill all types in their standard or local fields is
 * just recorded as not having achieved full type coverage, but can still be certified". So a type the server provides
 * must be met, and only a type it does not provide is excused. Reaffirmed 2026-11-12 ("that's a must").
 *
 * This is deliberately independent of field selection. A type counts as met when selection sampled a field for it
 * (`buildCoverage`); if the provided check used the same classifier, a type selection missed would also read as not
 * provided, and a server that has the type would pass without meeting it, which is the failure this exists to catch
 * (a certified run that met no single lookup on a resource carrying lookups). So the type is read from the DECLARED
 * metadata type, and the data from the raw sampled values, with no ranking, standard map or override in between.
 *
 * What meets each type matches the slot: one value for a scalar or a single-valued lookup, two distinct values for a
 * multi-valued lookup (the spec gives a multi-valued enumeration two; `has` with `and`, `any()` and `all()` need both).
 * A multi-valued field whose sampled data holds one value cannot fulfill the type, so it does not count as provided.
 */

import type { CsdlEnumType } from '@reso-standards/reso-metadata-utils';
import type { EntityProperty } from '../test-runner/types.js';
import { CORE_TYPES } from './type-coverage.js';

export type CoreType = (typeof CORE_TYPES)[number];

/** The fields on one resource that provide one type. */
export interface ProvidedType {
  readonly type: CoreType;
  readonly fields: ReadonlyArray<string>;
}

const LOOKUP_NAME = 'RESO.OData.Metadata.LookupName';
const SCALAR_TYPES: Readonly<Record<string, CoreType>> = {
  'Edm.Int16': 'integer',
  'Edm.Int32': 'integer',
  'Edm.Int64': 'integer',
  'Edm.Decimal': 'decimal',
  'Edm.Double': 'decimal',
  'Edm.Date': 'date',
  'Edm.DateTimeOffset': 'timestamp'
};

const unwrapCollection = (type: string): string | undefined =>
  type.startsWith('Collection(') && type.endsWith(')') ? type.slice('Collection('.length, -1) : undefined;

/** The enum type a qualified type name refers to, matched on its last segment (namespaces vary by provider). */
const enumTypeOf = (type: string, enumTypes: ReadonlyArray<CsdlEnumType>): CsdlEnumType | undefined => {
  const name = type.split('.').pop();
  return type.startsWith('Edm.') ? undefined : enumTypes.find(each => each.name === name);
};

/**
 * The Core type a property is DECLARED as, from its metadata alone, or undefined when it is none of them. The lookup
 * forms are those of the Core specification's Single and Multiple Enumerations sections: `Edm.EnumType`, `Edm.String`
 * with a LookupName, an `IsFlags` enum type, and a collection of either.
 */
export const declaredCoreType = (property: EntityProperty, enumTypes: ReadonlyArray<CsdlEnumType>): CoreType | undefined => {
  const scalar = SCALAR_TYPES[property.type];
  if (scalar !== undefined) return scalar;
  const hasLookupName = (property.annotations?.[LOOKUP_NAME] ?? '') !== '';
  const element = unwrapCollection(property.type);
  if (element !== undefined) {
    if (element === 'Edm.String') return hasLookupName ? 'multiLookup' : undefined;
    return enumTypeOf(element, enumTypes) ? 'multiLookup' : undefined;
  }
  if (property.type === 'Edm.String') return hasLookupName ? 'singleLookup' : undefined;
  const enumType = enumTypeOf(property.type, enumTypes);
  if (enumType === undefined) return undefined;
  return enumType.isFlags ? 'multiLookup' : 'singleLookup';
};

const isPresent = (value: unknown): boolean =>
  value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0);

/** The set bits of a bitmask, as member values: 5 is 1 and 4. */
const setBits = (value: number): ReadonlyArray<string> =>
  Number.isInteger(value) && value > 0
    ? value
        .toString(2)
        .split('')
        .reverse()
        .flatMap((bit, index) => (bit === '1' ? [String(2 ** index)] : []))
    : [String(value)];

/** The member values one sampled multi-valued cell holds: array elements, comma-separated names or set bits. */
const membersOf = (value: unknown): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value.filter(isPresent).map(String);
  if (typeof value === 'number') return setBits(value);
  if (typeof value === 'string')
    return value
      .split(',')
      .map(each => each.trim())
      .filter(each => each !== '');
  return [];
};

/** Whether the sampled values of a field are enough to meet its type. */
const fulfills = (type: CoreType, values: ReadonlyArray<unknown>): boolean => {
  const present = values.filter(isPresent);
  if (type !== 'multiLookup') return present.length > 0;
  return new Set(present.flatMap(membersOf)).size >= 2;
};

/**
 * The types a resource provides, each with the fields that provide it, in CORE_TYPES order. Only types with at least
 * one providing field are listed.
 */
export const providedTypesOf = (
  properties: ReadonlyArray<EntityProperty>,
  records: ReadonlyArray<Readonly<Record<string, unknown>>>,
  enumTypes: ReadonlyArray<CsdlEnumType>
): ReadonlyArray<ProvidedType> => {
  const providing = properties.flatMap(property => {
    const type = declaredCoreType(property, enumTypes);
    if (type === undefined) return [];
    return fulfills(
      type,
      records.map(record => record[property.name])
    )
      ? [{ type, field: property.name }]
      : [];
  });
  return CORE_TYPES.flatMap(type => {
    const fields = providing.filter(each => each.type === type).map(each => each.field);
    return fields.length > 0 ? [{ type, fields }] : [];
  });
};
