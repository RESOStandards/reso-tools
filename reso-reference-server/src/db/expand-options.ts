/**
 * Query options inside `$expand`, applied to the expanded entities once a data layer has stitched them into their
 * parents: `$orderby`, `$skip`, `$top`, `$count` and `$select` (OData 4.01 URL Conventions, Section 5.1.3). One step
 * for every backend, so SQLite, PostgreSQL and MongoDB answer the same way.
 *
 * `$filter` and `$levels` inside an expansion are not implemented. The handlers answer 501 for them (OData 4.01
 * Protocol, Section 9.3.1) rather than return the unfiltered collection as if it were filtered.
 */

import type { ExpandExpression } from '@reso-standards/odata-expression-parser';
import type { ResoField } from '../metadata/types.js';
import type { EntityRecord, NavigationPropertyBinding } from './data-access.js';

/** Parse a $select string into an array of field names. */
export const parseExpandSelect = (select: string): ReadonlyArray<string> =>
  select
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);

/** Binding + expand expression pair used by applyExpandOptions. */
export interface ExpandBinding {
  readonly binding: NavigationPropertyBinding;
  readonly expandExpr: ExpandExpression;
}

/** Mongo-style binding pair (uses `expr` instead of `expandExpr`). */
export interface MongoExpandBinding {
  readonly binding: NavigationPropertyBinding;
  readonly expr: ExpandExpression;
}

const EXPAND_OPTION_ERROR = 'ExpandOptionError';

/** A client error in an option inside `$expand` (an unknown field, a malformed `$orderby` term): a 400. */
export const expandOptionError = (message: string): Error => Object.assign(new Error(message), { name: EXPAND_OPTION_ERROR });

export const isExpandOptionError = (err: unknown): err is Error => err instanceof Error && err.name === EXPAND_OPTION_ERROR;

/** The options inside `$expand` this server does not implement, each named with where it appears, for a 501. */
export const unsupportedExpandOptions = (tree: ReadonlyArray<ExpandExpression> | undefined, path = ''): ReadonlyArray<string> =>
  (tree ?? []).flatMap(expr => {
    const at = path ? `${path}/${expr.property}` : expr.property;
    const own = (['$filter', '$levels'] as const)
      .filter(option => expr.options[option] !== undefined)
      .map(option => `${option} inside $expand=${at}`);
    return [...own, ...unsupportedExpandOptions(expr.options.$expand, at)];
  });

const NUMERIC_TYPES = new Set(['Edm.Byte', 'Edm.SByte', 'Edm.Int16', 'Edm.Int32', 'Edm.Int64', 'Edm.Decimal', 'Edm.Double', 'Edm.Single']);
const TEMPORAL_TYPES = new Set(['Edm.Date', 'Edm.DateTimeOffset', 'Edm.TimeOfDay']);

/**
 * A value as it sorts, by the field's declared type: a database may hand a decimal back as a string ("10" sorts before
 * "9" as text) or a boolean as 0 and 1. Null stays null.
 */
const sortable = (value: unknown, type: string): number | string | null => {
  if (value === null || value === undefined) return null;
  if (NUMERIC_TYPES.has(type)) return Number(value);
  if (TEMPORAL_TYPES.has(type)) return value instanceof Date ? value.getTime() : Date.parse(String(value)) || String(value);
  if (type === 'Edm.Boolean') return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
  return String(value);
};

/** Ascending order with nulls first; a descending term reverses it, so nulls come last (OData 4.01 Protocol, $orderby). */
const compareAscending = (a: number | string | null, b: number | string | null): number => {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const [x, y] = [String(a), String(b)];
  return x < y ? -1 : x > y ? 1 : 0;
};

interface OrderTerm {
  readonly field: string;
  readonly type: string;
  readonly descending: boolean;
}

/** `$orderby` inside an expansion: property names of the target, each optionally `asc` or `desc` (any case). */
const parseOrderTerms = (orderby: string, fields: ReadonlyMap<string, ResoField>, at: string): ReadonlyArray<OrderTerm> =>
  orderby
    .split(',')
    .map(term => term.trim())
    .filter(term => term.length > 0)
    .map(term => {
      const [field, direction = 'asc', ...rest] = term.split(/\s+/);
      const dir = direction.toLowerCase();
      if (rest.length > 0 || (dir !== 'asc' && dir !== 'desc'))
        throw expandOptionError(`Invalid $orderby term inside $expand=${at}: "${term}"`);
      const definition = fields.get(field);
      if (!definition || definition.isExpansion) throw expandOptionError(`Unknown field in $orderby inside $expand=${at}: "${field}"`);
      return { field, type: definition.type, descending: dir === 'desc' };
    });

interface ExpandPlan {
  readonly name: string;
  readonly order?: (a: EntityRecord, b: EntityRecord) => number;
  readonly skip: number;
  readonly top?: number;
  readonly count: boolean;
  readonly pick?: (entity: Record<string, unknown>) => Record<string, unknown>;
}

const planFor = ({ binding, expandExpr }: ExpandBinding): ExpandPlan | undefined => {
  const { $orderby, $skip, $top, $count, $select, $expand } = expandExpr.options;
  if ($orderby === undefined && $skip === undefined && $top === undefined && !$count && $select === undefined) return undefined;
  const fields = new Map(binding.targetFields.map(field => [field.fieldName, field]));
  const terms = $orderby ? parseOrderTerms($orderby, fields, binding.name) : [];
  const keyType = fields.get(binding.targetKeyField)?.type ?? 'Edm.String';
  // The key breaks ties, so a page taken with $top and $skip is the same page every time.
  const byKey: OrderTerm = { field: binding.targetKeyField, type: keyType, descending: false };
  const ordering = terms.length > 0 || $top !== undefined || $skip !== undefined ? [...terms, byKey] : [];
  const order =
    ordering.length > 0
      ? (a: EntityRecord, b: EntityRecord): number => {
          for (const term of ordering) {
            const result = compareAscending(sortable(a[term.field], term.type), sortable(b[term.field], term.type));
            if (result !== 0) return term.descending ? -result : result;
          }
          return 0;
        }
      : undefined;
  const allowed = $select
    ? new Set([...parseExpandSelect($select), binding.targetKeyField, ...($expand ?? []).map(e => e.property)])
    : undefined;
  return {
    name: binding.name,
    ...(order ? { order } : {}),
    skip: $skip ?? 0,
    ...($top !== undefined ? { top: $top } : {}),
    count: $count === true,
    ...(allowed
      ? { pick: (entity: Record<string, unknown>) => Object.fromEntries(Object.entries(entity).filter(([k]) => allowed.has(k))) }
      : {})
  };
};

/** One expanded collection, ordered, paged and trimmed as its options ask. */
const applyToCollection = (plan: ExpandPlan, items: ReadonlyArray<EntityRecord>): ReadonlyArray<EntityRecord> => {
  const ordered = plan.order ? [...items].sort(plan.order) : items;
  const paged = ordered.slice(plan.skip, plan.top === undefined ? undefined : plan.skip + plan.top);
  return plan.pick ? paged.map(item => plan.pick!(item as Record<string, unknown>) as EntityRecord) : paged;
};

/**
 * Apply each expansion's options to every parent entity. A collection is ordered (`$orderby`, then the key), paged
 * (`$skip`, `$top`), counted before paging (`<NavigationProperty>@odata.count`, placed just before the property) and
 * trimmed (`$select`, keeping the key and any nested expansion). A single-valued expansion takes `$select` only.
 */
export const applyExpandOptions = (
  entities: ReadonlyArray<EntityRecord>,
  expandBindings: ReadonlyArray<ExpandBinding>
): ReadonlyArray<EntityRecord> => {
  const plans = expandBindings.map(planFor).filter((plan): plan is ExpandPlan => plan !== undefined);
  if (plans.length === 0) return entities;
  const byName = new Map(plans.map(plan => [plan.name, plan]));
  return entities.map(
    entity =>
      Object.fromEntries(
        Object.entries(entity).flatMap(([key, value]): ReadonlyArray<[string, unknown]> => {
          const plan = byName.get(key);
          if (!plan) return [[key, value]];
          if (Array.isArray(value)) {
            return [
              ...(plan.count ? [[`${key}@odata.count`, value.length] as [string, unknown]] : []),
              [key, applyToCollection(plan, value)]
            ];
          }
          if (value != null && typeof value === 'object' && plan.pick) return [[key, plan.pick(value as Record<string, unknown>)]];
          return [[key, value]];
        })
      ) as EntityRecord
  );
};

/** Convenience wrapper for MongoDB bindings (which use `expr` instead of `expandExpr`). */
export const applyMongoExpandOptions = (
  entities: ReadonlyArray<EntityRecord>,
  bindings: ReadonlyArray<MongoExpandBinding>
): ReadonlyArray<EntityRecord> =>
  applyExpandOptions(
    entities,
    bindings.map(({ binding, expr }) => ({ binding, expandExpr: expr }))
  );
