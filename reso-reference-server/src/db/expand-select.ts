/**
 * Shared $select filtering for expanded navigation property entities.
 *
 * After navigation properties are stitched into parent entities via $expand,
 * this function applies inline $select options to trim each nav entity down
 * to only the requested fields (plus the key field and any nested $expand
 * property names).
 */

import type { ExpandExpression } from '@reso-standards/odata-expression-parser';
import type { EntityRecord, NavigationPropertyBinding } from './data-access.js';

/** Parse a $select string into an array of field names. */
export const parseExpandSelect = (select: string): ReadonlyArray<string> =>
  select
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);

/** Binding + expand expression pair used by applyExpandSelect. */
export interface ExpandBinding {
  readonly binding: NavigationPropertyBinding;
  readonly expandExpr: ExpandExpression;
}

/** Mongo-style binding pair (uses `expr` instead of `expandExpr`). */
export interface MongoExpandBinding {
  readonly binding: NavigationPropertyBinding;
  readonly expr: ExpandExpression;
}

/** Filter expanded navigation entities by their inline $select options. */
export const applyExpandSelect = (
  entities: ReadonlyArray<EntityRecord>,
  expandBindings: ReadonlyArray<ExpandBinding>
): ReadonlyArray<EntityRecord> => {
  const filters = expandBindings
    .filter(({ expandExpr }) => expandExpr.options.$select)
    .map(({ binding, expandExpr }) => ({
      name: binding.name,
      allowed: new Set([
        ...parseExpandSelect(expandExpr.options.$select!),
        binding.targetKeyField,
        // Preserve expanded navigation property names (they aren't structural fields)
        ...(expandExpr.options.$expand ?? []).map(e => e.property)
      ])
    }));

  if (filters.length === 0) return entities;

  const pick = (obj: Record<string, unknown>, allowed: ReadonlySet<string>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(obj).filter(([k]) => allowed.has(k)));

  return entities.map(entity => {
    const result: Record<string, unknown> = { ...entity };
    for (const { name, allowed } of filters) {
      const value = result[name];
      if (Array.isArray(value)) {
        result[name] = value.map((item: Record<string, unknown>) => pick(item, allowed));
      } else if (value != null && typeof value === 'object') {
        result[name] = pick(value as Record<string, unknown>, allowed);
      }
    }
    return result;
  });
};

/** Convenience wrapper for MongoDB bindings (which use `expr` instead of `expandExpr`). */
export const applyMongoExpandSelect = (
  entities: ReadonlyArray<EntityRecord>,
  bindings: ReadonlyArray<MongoExpandBinding>
): ReadonlyArray<EntityRecord> =>
  applyExpandSelect(
    entities,
    bindings.map(({ binding, expr }) => ({ binding, expandExpr: expr }))
  );
