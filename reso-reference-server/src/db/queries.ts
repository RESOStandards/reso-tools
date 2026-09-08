import type { ResoField } from '../metadata/types.js';

/** A parameterized SQL query ready for pg.Pool.query(). */
export interface QueryConfig {
  readonly text: string;
  readonly values: ReadonlyArray<unknown>;
}

/** Edm types that must be returned as JavaScript integers. */
const INT_TYPES = new Set(['Edm.Int16', 'Edm.Int32', 'Edm.Int64', 'Edm.Byte']);

/** Edm types that must be returned as JavaScript decimals. */
const DECIMAL_TYPES = new Set(['Edm.Decimal', 'Edm.Double', 'Edm.Single']);

/**
 * Whether a field is SERVED as an integer, mirroring the EDMX generator's advertised type. A field is an integer
 * on the wire when its Edm type is Int*, OR it's a DD `Edm.Decimal`/`Edm.Double` with scale 0 — the shared
 * `reso-common` generator (toEdmxType) promotes scale-0 numerics to `Edm.Int64` ("scale 0 denotes a whole
 * number"). The stored AND served DATA must match that advertised type, so a scale-0 field is coerced to an
 * integer even though its source type is `Edm.Decimal`. Kept in lock-step with toEdmxType — if that rule changes,
 * change this. Exported so callers that reason about the served type (e.g. tests) share the one definition.
 */
export const isServedAsInteger = (field: ResoField): boolean =>
  INT_TYPES.has(field.type) || ((field.type === 'Edm.Decimal' || field.type === 'Edm.Double') && (field.scale ?? 0) === 0);

/** Truncate a numeric value (number or numeric string) to an integer when the field is served as an integer; a
 *  no-op for any other field or non-numeric value. The ONE coercion rule, shared by insert-serialization (so the
 *  stored value is a true integer → `$filter`/`$orderby` on the column agree with the served value) and read-
 *  deserialization (so the served value matches the advertised type even for a pre-seeded decimal). */
export const coerceServedInteger = (value: unknown, field: ResoField): unknown => {
  if (!isServedAsInteger(field) || (typeof value !== 'number' && typeof value !== 'string')) return value;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : value;
};

/** Serializes a value for PostgreSQL insertion based on the field definition. */
const serializeValue = (value: unknown, field: ResoField): unknown => {
  if (field.isCollection && Array.isArray(value)) {
    return JSON.stringify(value);
  }
  // Store integer-served fields (Edm.Int*, and scale-0 Decimal/Double advertised as Int64) as true integers, so a
  // `$filter`/`$orderby` on the column and the deserialized served value never disagree (the seed carries decimals).
  return coerceServedInteger(value, field);
};

/** Deserializes a database row value back to its API representation. */
const deserializeValue = (value: unknown, field: ResoField): unknown => {
  if (value == null) return field.isCollection ? [] : value;
  if (field.isCollection && typeof value === 'string') {
    return JSON.parse(value) as unknown;
  }
  // Integer-served fields serialize as JS integers against their advertised type. Covers Edm.Int* AND a DD
  // Edm.Decimal/Edm.Double with scale 0 (advertised as Edm.Int64 — see isServedAsInteger). Postgres returns
  // BIGINT/NUMERIC as strings; SQLite returns a REAL for a decimal in an int/real column. This coerces both forms
  // on every read path (collection / key / $expand / navigation-property-path) so a pre-seeded decimal is still
  // served type-correct. MUST precede the DECIMAL branch (a scale-0 Edm.Decimal is in DECIMAL_TYPES but served int).
  if (isServedAsInteger(field)) return coerceServedInteger(value, field);
  if (typeof value === 'string' && DECIMAL_TYPES.has(field.type)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  // Edm.Date must return ISO 8601 date-only (YYYY-MM-DD), not a full timestamp
  if (field.type === 'Edm.Date') {
    if (value instanceof Date) {
      return value.toISOString().split('T')[0];
    }
    if (typeof value === 'string' && value.includes('T')) {
      return value.split('T')[0];
    }
  }
  return value;
};

/** Deserializes an entire database row using field definitions. */
export const deserializeRow = (row: Record<string, unknown>, fields: ReadonlyArray<ResoField>): Record<string, unknown> => {
  const fieldMap = new Map(fields.map(f => [f.fieldName, f]));
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      const field = fieldMap.get(key);
      return [key, field ? deserializeValue(value, field) : value];
    })
  );
};

/** Builds an INSERT query for a new record. */
export const buildInsertQuery = (
  tableName: string,
  record: Readonly<Record<string, unknown>>,
  fields: ReadonlyArray<ResoField>
): QueryConfig => {
  const fieldMap = new Map(fields.map(f => [f.fieldName, f]));
  const entries = Object.entries(record).filter(([key]) => fieldMap.has(key));

  const columns = entries.map(([key]) => `"${key}"`);
  const placeholders = entries.map((_, i) => `$${i + 1}`);
  const values = entries.map(([key, value]) => {
    const field = fieldMap.get(key)!;
    return serializeValue(value, field);
  });

  return {
    text: `INSERT INTO "${tableName}" (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
    values
  };
};

/** Builds a SELECT query for a single record by primary key. */
export const buildSelectByKeyQuery = (tableName: string, keyField: string, keyValue: string): QueryConfig => ({
  text: `SELECT * FROM "${tableName}" WHERE "${keyField}" = $1`,
  values: [keyValue]
});

/** Builds an UPDATE query for an existing record (merge semantics). */
export const buildUpdateQuery = (
  tableName: string,
  keyField: string,
  keyValue: string,
  updates: Readonly<Record<string, unknown>>,
  fields: ReadonlyArray<ResoField>
): QueryConfig => {
  const fieldMap = new Map(fields.map(f => [f.fieldName, f]));
  const entries = Object.entries(updates).filter(([key]) => key !== keyField && fieldMap.has(key));

  const setClauses = entries.map(([key], i) => `"${key}" = $${i + 1}`);
  const values = entries.map(([key, value]) => {
    const field = fieldMap.get(key)!;
    return serializeValue(value, field);
  });

  values.push(keyValue);

  return {
    text: `UPDATE "${tableName}" SET ${setClauses.join(', ')} WHERE "${keyField}" = $${values.length} RETURNING *`,
    values
  };
};

/** Builds a DELETE query for a record by primary key. */
export const buildDeleteQuery = (tableName: string, keyField: string, keyValue: string): QueryConfig => ({
  text: `DELETE FROM "${tableName}" WHERE "${keyField}" = $1`,
  values: [keyValue]
});
