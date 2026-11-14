/**
 * `$search`: free-text search over a collection (OData 4.01 URL Conventions, Section 5.1.7; Protocol, `$search`).
 *
 * What counts as a match is the service's to define. Here a record matches a word or phrase when one of its plain text
 * fields contains it, ignoring case. Plain text means every `Edm.String` field that is not the key, a collection or a
 * lookup; lookup fields are matched exactly with `$filter`. A null field contains nothing.
 *
 * Every backend uses the same plain containment: `LIKE` on SQLite, `ILIKE` on PostgreSQL and a case-insensitive regular
 * expression on MongoDB. Each engine's own full-text search stems words differently, so it would answer the same
 * search differently. Case folding beyond ASCII follows the engine: SQLite's `LIKE` folds ASCII letters only.
 *
 * An empty term, which only the type-ahead form `''` can produce, matches every record.
 */

import { type SearchExpression, parseSearch } from '@reso-standards/odata-expression-parser';
import { LOOKUP_NAME_ANNOTATION_TERM } from '../metadata/lookup-reconciler.js';
import type { ResoField } from '../metadata/types.js';
import type { FilterSqlResult } from './filter-to-sql.js';

/** The fields a search looks in: plain text, not the key, a collection, an expansion or a lookup. */
export const searchableFields = (fields: ReadonlyArray<ResoField>, keyField: string): ReadonlyArray<string> =>
  fields
    .filter(
      f =>
        f.type === 'Edm.String' &&
        f.fieldName !== keyField &&
        !f.isCollection &&
        !f.isExpansion &&
        !f.isEnumeration &&
        !f.annotations?.some(a => a.term === LOOKUP_NAME_ANNOTATION_TERM)
    )
    .map(f => f.fieldName);

/** Escape LIKE wildcard characters so they match literally. */
const escapeLike = (value: string): string => value.replace(/[%_\\]/g, ch => `\\${ch}`);

/** Escape regular-expression metacharacters so they match literally. */
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Walk a search expression into SQL; `term` writes one term's condition from its LIKE pattern. */
const toSql = (expr: SearchExpression, term: (pattern: string) => string): string => {
  switch (expr.type) {
    case 'term':
      return expr.value === '' ? '1 = 1' : term(`%${escapeLike(expr.value)}%`);
    case 'not':
      return `NOT (${toSql(expr.operand, term)})`;
    case 'and':
      return `(${toSql(expr.left, term)} AND ${toSql(expr.right, term)})`;
    case 'or':
      return `(${toSql(expr.left, term)} OR ${toSql(expr.right, term)})`;
  }
};

/** A term no record can match: the resource has no field to search. */
const NO_MATCH_SQL = '1 = 0';

/**
 * Translate `$search` to a parameterized SQLite condition. Parameters are positional and follow the SQL text, one per
 * searched column per term. Throws an error `isSearchParseError` recognizes when the expression is malformed.
 */
export const searchToSqlite = (search: string, fields: ReadonlyArray<ResoField>, keyField: string, tableAlias: string): FilterSqlResult => {
  const columns = searchableFields(fields, keyField).map(name => `${tableAlias}."${name}"`);
  const values: unknown[] = [];
  const where = toSql(parseSearch(search), pattern => {
    if (columns.length === 0) return NO_MATCH_SQL;
    values.push(...columns.map(() => pattern));
    return `(${columns.map(column => `COALESCE(${column}, '') LIKE ? ESCAPE '\\'`).join(' OR ')})`;
  });
  return { where, values };
};

/**
 * Translate `$search` to a parameterized PostgreSQL condition, numbering parameters from `startParamIndex`. One
 * parameter per term, shared by every searched column. Throws an error `isSearchParseError` recognizes when the
 * expression is malformed.
 */
export const searchToSql = (
  search: string,
  fields: ReadonlyArray<ResoField>,
  keyField: string,
  tableAlias: string,
  startParamIndex: number
): FilterSqlResult => {
  const columns = searchableFields(fields, keyField).map(name => `${tableAlias}."${name}"`);
  const values: unknown[] = [];
  const where = toSql(parseSearch(search), pattern => {
    if (columns.length === 0) return NO_MATCH_SQL;
    values.push(pattern);
    const placeholder = `$${startParamIndex + values.length - 1}`;
    return `(${columns.map(column => `COALESCE(${column}, '') ILIKE ${placeholder} ESCAPE '\\'`).join(' OR ')})`;
  });
  return { where, values };
};

/** A MongoDB condition no document can match: none of `{}`, which matches every document. */
const NO_MATCH_MONGO: Readonly<Record<string, unknown>> = { $nor: [{}] };

/** Translate `$search` to a MongoDB query. Throws an error `isSearchParseError` recognizes when it is malformed. */
export const searchToMongo = (search: string, fields: ReadonlyArray<ResoField>, keyField: string): Record<string, unknown> => {
  const names = searchableFields(fields, keyField);
  const toMongo = (expr: SearchExpression): Record<string, unknown> => {
    switch (expr.type) {
      case 'term':
        if (expr.value === '') return {};
        if (names.length === 0) return NO_MATCH_MONGO;
        return { $or: names.map(name => ({ [name]: { $regex: escapeRegex(expr.value), $options: 'i' } })) };
      case 'not':
        return { $nor: [toMongo(expr.operand)] };
      case 'and':
        return { $and: [toMongo(expr.left), toMongo(expr.right)] };
      case 'or':
        return { $or: [toMongo(expr.left), toMongo(expr.right)] };
    }
  };
  return toMongo(parseSearch(search));
};

/**
 * SQL conditions a record has to meet together, such as a `$filter` and a `$search`, or undefined when there are none.
 * A single condition is returned as it is; several are each parenthesized, so a top-level `OR` in one cannot bind
 * across the `AND`. Values follow the conditions' order, which is their order in the SQL text.
 */
export const allSqlConditions = (conditions: ReadonlyArray<FilterSqlResult | undefined>): FilterSqlResult | undefined => {
  const present = conditions.filter((c): c is FilterSqlResult => c !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return { where: present.map(c => `(${c.where})`).join(' AND '), values: present.flatMap(c => c.values) };
};

/** MongoDB conditions a document has to meet together, or undefined when there are none; a single one as it is. */
export const allMongoConditions = (conditions: ReadonlyArray<Record<string, unknown> | undefined>): Record<string, unknown> | undefined => {
  const present = conditions.filter((c): c is Record<string, unknown> => c !== undefined);
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : { $and: present };
};
