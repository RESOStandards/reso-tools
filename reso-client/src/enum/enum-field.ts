/**
 * The RESO enum abstraction — one representation-aware handle per enumeration field, so consumers
 * (the Web API Core cert, the web-client display, Add/Edit) delegate the operator choice and value
 * decoding here instead of re-deriving them. Defined by BEHAVIOR (how it filters, how its value
 * decodes and encodes), not by representation, so the Data Dictionary 3.0 collapse to `Edm.String`
 * drops the now-unused branches without touching a caller. Background: the registry's
 * `references/enumerations.md`.
 */

import { decodeFlagsValue, extractTypeName, getEnumType } from '@reso-standards/reso-metadata-utils';
import type { CsdlEnumType, CsdlSchema } from '@reso-standards/reso-metadata-utils';

/** The five metadata shapes an enumeration field may take — two single-valued, three multiple-valued. */
export type EnumRepresentation =
  | 'SINGLE_STRING' // Edm.String + a LookupName annotation
  | 'SINGLE_ENUM' // non-collection enum type, IsFlags="false"
  | 'COLLECTION_STRING' // Collection(Edm.String)
  | 'COLLECTION_ENUM' // Collection(<enum type>)
  | 'FLAGS_ENUM'; // non-collection enum type, IsFlags="true"

/** OData 4.01 filter operators valid across the representations. */
export type EnumFilterOp = 'eq' | 'ne' | 'in' | 'has' | 'any' | 'all';

/** The minimal field metadata `resolveEnum` needs. */
export interface EnumFieldInput {
  readonly name: string;
  /** The OData type string, e.g. `org.reso.metadata.enums.StandardStatus`, `Collection(Edm.String)`. */
  readonly type: string;
  readonly annotations?: Readonly<Record<string, string>>;
}

/** A representation-aware handle for one enumeration field. */
export interface EnumField {
  readonly fieldName: string;
  readonly representation: EnumRepresentation;
  readonly isMultiValued: boolean;
  /** The CSDL enum type — present for the enum-typed representations (SINGLE_ENUM / COLLECTION_ENUM / FLAGS_ENUM). */
  readonly enumType?: CsdlEnumType;
  /** The operator this representation uses by default (`eq` single, `has` flags, `any` collections). */
  readonly defaultOp: EnumFilterOp;
  /**
   * Build the OData `$filter` clause for this field and value(s). `op` defaults to the representation's
   * canonical operator; pass an explicit op (`ne`, `in`, `all`, …) for a specific query or cert scenario.
   */
  readonly buildFilter: (value: string | ReadonlyArray<string>, op?: EnumFilterOp) => string;
  /** Decode a raw field value into its native member elements (member names). */
  readonly decodeValue: (raw: unknown) => ReadonlyArray<string>;
  /** Encode member name(s) into the wire value form this representation expects (for Add/Edit). */
  readonly encodeValue: (members: ReadonlyArray<string>) => string | ReadonlyArray<string>;
}

const LOOKUP_NAME = 'RESO.OData.Metadata.LookupName';

const isCollection = (type: string): boolean => type.startsWith('Collection(') && type.endsWith(')');
const unwrap = (type: string): string => (isCollection(type) ? type.slice('Collection('.length, -1) : type);

/** OData string literal: wrap in single quotes, doubling any embedded single quote. */
const odataString = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const asArray = (value: string | ReadonlyArray<string>): ReadonlyArray<string> =>
  typeof value === 'string' ? [value] : value;

const CANONICAL_OP: Record<EnumRepresentation, EnumFilterOp> = {
  SINGLE_STRING: 'eq',
  SINGLE_ENUM: 'eq',
  COLLECTION_STRING: 'any',
  COLLECTION_ENUM: 'any',
  FLAGS_ENUM: 'has',
};

const buildEnumFilter = (
  field: string,
  value: string | ReadonlyArray<string>,
  op: EnumFilterOp,
): string => {
  const values = asArray(value);
  // An empty value set has no valid OData filter form (`F in ()` is invalid grammar; `F has`/`any`
  // of nothing is an empty clause that a server may 400 on or silently treat as unconstrained). Fail
  // loudly rather than emit a malformed or unconstrained $filter.
  if (values.length === 0) throw new RangeError('buildFilter requires at least one value');
  const first = values[0] ?? '';
  switch (op) {
    case 'eq':
    case 'ne':
      // Scalar operators take exactly one value; a multi-value set would silently drop the rest — use `in`.
      if (values.length > 1) {
        throw new RangeError(`the "${op}" operator takes a single value; use "in" for multiple`);
      }
      return `${field} ${op} ${odataString(first)}`;
    case 'in':
      return `${field} in (${values.map(odataString).join(',')})`;
    case 'has':
      return values.map((v) => `${field} has ${odataString(v)}`).join(' and ');
    case 'any':
      return values.map((v) => `${field}/any(x:x eq ${odataString(v)})`).join(' and ');
    case 'all':
      return values.map((v) => `${field}/all(x:x eq ${odataString(v)})`).join(' and ');
  }
};

const decodeEnumValue = (
  representation: EnumRepresentation,
  enumType: CsdlEnumType | undefined,
  raw: unknown,
): ReadonlyArray<string> => {
  if (raw === null || raw === undefined) return [];
  switch (representation) {
    case 'COLLECTION_STRING':
    case 'COLLECTION_ENUM':
      // A JSON array of member-name strings on the wire; keep only non-empty string elements (never
      // coerce a non-string element into a phantom member). Tolerate a comma-string, which some
      // servers serialize instead of an array.
      return Array.isArray(raw)
        ? raw.filter((el): el is string => typeof el === 'string' && el.trim().length > 0).map((el) => el.trim())
        : typeof raw === 'string'
          ? raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
          : [];
    case 'FLAGS_ENUM':
      // comma-joined names or an integer bitmask — the shared decoder handles both. A non-string,
      // non-number raw is off-contract for a flags value.
      if (typeof raw !== 'string' && typeof raw !== 'number') return [];
      return enumType !== undefined
        ? decodeFlagsValue(enumType, raw)
        : typeof raw === 'string'
          ? raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
          : [];
    case 'SINGLE_STRING':
    case 'SINGLE_ENUM': {
      // A single member-name string; a non-string scalar is off-contract → [].
      if (typeof raw !== 'string') return [];
      const scalar = raw.trim();
      return scalar.length > 0 ? [scalar] : [];
    }
  }
};

const encodeEnumValue = (
  representation: EnumRepresentation,
  members: ReadonlyArray<string>,
): string | ReadonlyArray<string> => {
  switch (representation) {
    case 'COLLECTION_STRING':
    case 'COLLECTION_ENUM':
      return [...members];
    case 'FLAGS_ENUM':
      // The string form — comma-joined member names. A client should not synthesize a bitmask it
      // cannot be sure the server round-trips; the name form is universally accepted.
      return members.join(',');
    case 'SINGLE_STRING':
    case 'SINGLE_ENUM':
      return members[0] ?? '';
  }
};

const makeEnumField = (
  fieldName: string,
  representation: EnumRepresentation,
  enumType: CsdlEnumType | undefined,
): EnumField => ({
  fieldName,
  representation,
  isMultiValued: representation !== 'SINGLE_STRING' && representation !== 'SINGLE_ENUM',
  ...(enumType !== undefined && { enumType }),
  defaultOp: CANONICAL_OP[representation],
  buildFilter: (value, op) => buildEnumFilter(fieldName, value, op ?? CANONICAL_OP[representation]),
  decodeValue: (raw) => decodeEnumValue(representation, enumType, raw),
  encodeValue: (members) => encodeEnumValue(representation, members),
});

/**
 * Classify a field's metadata into an {@link EnumField}, or `null` if the field is not an enumeration.
 * Prefers the string forms (`Edm.String` + `LookupName` / `Collection(Edm.String)`); an enum-typed
 * field is `SINGLE_ENUM` / `COLLECTION_ENUM` / `FLAGS_ENUM` per its collection-ness and `IsFlags`. Pure
 * and synchronous — enum-typed members come from the CSDL schema; string-form members live in the
 * Lookup Resource and are resolved separately (the async lookup resolver).
 */
export const resolveEnum = (field: EnumFieldInput, schema: CsdlSchema): EnumField | null => {
  const collection = isCollection(field.type);
  const inner = unwrap(field.type);

  // String-form lookups carry a LookupName annotation on an Edm.String / Collection(Edm.String).
  if (inner === 'Edm.String') {
    if (field.annotations?.[LOOKUP_NAME] === undefined) return null; // a plain string field, not a lookup
    return makeEnumField(field.name, collection ? 'COLLECTION_STRING' : 'SINGLE_STRING', undefined);
  }

  // Enum-typed lookups: the unwrapped type resolves to a CSDL enum type.
  const enumType = getEnumType(schema, extractTypeName(field.type));
  if (enumType === undefined) return null;
  const representation: EnumRepresentation = collection
    ? 'COLLECTION_ENUM'
    : enumType.isFlags
      ? 'FLAGS_ENUM'
      : 'SINGLE_ENUM';
  return makeEnumField(field.name, representation, enumType);
};
