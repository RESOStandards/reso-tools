/**
 * Which Core data types a resource DECLARES: a standard or local field whose metadata type is that type.
 *
 * All data types are required for Web API Core when the server has them, whether in standard or local fields (Josh,
 * 2026-11-12). "Has" is what the metadata declares: "if they have the types they have to fail if they don't provide some
 * field that can be sampled with that type", and "if they don't have the types then we can pass them without them, but
 * we must never have seen them". So a type declared on a resource tested must be met (a field of it sampled, two values
 * for a multi-valued lookup) and its tests must pass; only a type no resource tested declares is excused. A declared
 * field left empty is not an excuse.
 *
 * This is read from the declared metadata types alone, independent of field selection. A type counts as met when
 * selection sampled a field for it (`buildCoverage`); if "declared" were read through the same classifier, a type
 * selection missed would also read as absent, and a server that has the type would pass without meeting it, which is the
 * failure this exists to catch (a certified run that met no single lookup on a resource carrying lookups).
 *
 * Each declaring field carries how many sampled records hold a value in it, so a run that cannot meet a declared type
 * can suggest which fields to name (Josh, 2026-11-12: "they need to tell us which ones to use for that type, and we can
 * suggest a list of top N fields based on population for that type"). Only a resource that returned records is read:
 * a declared resource with no records has nothing to sample, and is Not Applicable under the serving rules.
 */

import type { CsdlEnumType } from '@reso-standards/reso-metadata-utils';
import type { EntityProperty } from '../test-runner/types.js';
import { CORE_TYPES } from './type-coverage.js';

export type CoreType = (typeof CORE_TYPES)[number];

/** A field that declares a type, and how many sampled records hold a value in it. */
export interface DeclaringField {
  readonly field: string;
  readonly populated: number;
}

/** The fields on one resource that declare one type, most populated first. */
export interface DeclaredType {
  readonly type: CoreType;
  readonly fields: ReadonlyArray<DeclaringField>;
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

/** The types a resource declares, in CORE_TYPES order, each with its declaring fields, most populated first. */
export const declaredTypesOf = (
  properties: ReadonlyArray<EntityProperty>,
  records: ReadonlyArray<Readonly<Record<string, unknown>>>,
  enumTypes: ReadonlyArray<CsdlEnumType>
): ReadonlyArray<DeclaredType> => {
  const declaring = properties.flatMap(property => {
    const type = declaredCoreType(property, enumTypes);
    if (type === undefined) return [];
    const populated = records.filter(record => isPresent(record[property.name])).length;
    return [{ type, field: property.name, populated }];
  });
  return CORE_TYPES.flatMap(type => {
    const fields = declaring
      .filter(each => each.type === type)
      .map(({ field, populated }) => ({ field, populated }))
      .sort((a, b) => b.populated - a.populated || a.field.localeCompare(b.field));
    return fields.length > 0 ? [{ type, fields }] : [];
  });
};
