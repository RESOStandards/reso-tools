/**
 * SQLite implementation of the Data Access Layer.
 *
 * Uses LEFT JOINs for $expand resolution with app-side grouping to nest
 * expanded navigation properties into their parent entities, mirroring
 * the PostgreSQL implementation pattern. Supports multi-level $expand
 * via recursive sub-query resolution.
 *
 * better-sqlite3 is synchronous — methods return Promise-wrapped results
 * to conform to the async DataAccessLayer interface.
 */

import type Database from 'better-sqlite3';
import type { ExpandExpression } from '@reso/odata-expression-parser';
import type { ResoField } from '../metadata/types.js';
import type {
  CollectionQueryOptions,
  CollectionResult,
  DataAccessLayer,
  EntityRecord,
  NavigationPropertyBinding,
  ResourceContext,
  SingleResult
} from './data-access.js';
import { MAX_EXPAND_DEPTH } from './data-access.js';
import { applyExpandSelect } from './expand-select.js';
import { filterToSqlite } from './filter-to-sqlite.js';
import { deserializeRow } from './queries.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Serialize a value for SQLite insertion based on field definition. */
const serializeValue = (value: unknown, field: ResoField): unknown => {
  if (field.isCollection && Array.isArray(value)) {
    return JSON.stringify(value);
  }
  // SQLite stores booleans as 0/1
  if (field.type === 'Edm.Boolean' && typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  return value;
};

/**
 * SQLite-aware deserialization wrapper.
 * Handles boolean 0/1 → true/false before delegating to the shared deserializer.
 */
const deserializeSqliteRow = (row: Record<string, unknown>, fields: ReadonlyArray<ResoField>): Record<string, unknown> => {
  const fieldMap = new Map(fields.map(f => [f.fieldName, f]));
  const coerced: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const field = fieldMap.get(key);
    if (field?.type === 'Edm.Boolean' && typeof value === 'number') {
      coerced[key] = value !== 0;
    } else {
      coerced[key] = value;
    }
  }
  return deserializeRow(coerced, fields);
};

/** Parse a $select string into an array of field names. */
const parseSelect = (select: string): ReadonlyArray<string> =>
  select
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);

/** Parse a $orderby string into validated ORDER BY clauses. */
const parseOrderBy = (orderby: string, fields: ReadonlyArray<ResoField>, tableAlias: string): string => {
  const fieldNames = new Set(fields.map(f => f.fieldName));
  return orderby
    .split(',')
    .map(part => {
      const trimmed = part.trim();
      const [field, ...rest] = trimmed.split(/\s+/);
      if (!field || !fieldNames.has(field)) return undefined;
      const dir = rest[0]?.toLowerCase();
      const direction = dir === 'desc' ? 'DESC' : 'ASC';
      return `${tableAlias}."${field}" ${direction}`;
    })
    .filter((clause): clause is string => clause !== undefined)
    .join(', ');
};

/**
 * Resolve expand expressions to navigation property bindings.
 */
const resolveExpandBindings = (
  expandTree: ReadonlyArray<ExpandExpression>,
  navigationBindings: ReadonlyArray<NavigationPropertyBinding>
): ReadonlyArray<{
  readonly binding: NavigationPropertyBinding;
  readonly alias: string;
  readonly expandExpr: ExpandExpression;
}> => {
  const bindingMap = new Map(navigationBindings.map(b => [b.name, b]));
  const result: Array<{
    readonly binding: NavigationPropertyBinding;
    readonly alias: string;
    readonly expandExpr: ExpandExpression;
  }> = [];

  for (const expr of expandTree) {
    const binding = bindingMap.get(expr.property);
    if (!binding) continue;
    result.push({ binding, alias: `nav_${expr.property}`, expandExpr: expr });
  }

  return result;
};

/**
 * Build the SELECT column list for the parent resource, optionally
 * restricted by $select. Always includes the key field.
 */
const buildSelectColumns = (
  fields: ReadonlyArray<ResoField>,
  keyField: string,
  select: string | undefined,
  alias: string
): ReadonlyArray<string> => {
  let selectedNames: ReadonlyArray<string>;
  if (select) {
    const requested = new Set(parseSelect(select));
    requested.add(keyField);
    selectedNames = fields.filter(f => requested.has(f.fieldName)).map(f => f.fieldName);
  } else {
    selectedNames = fields.map(f => f.fieldName);
  }
  return selectedNames.map(name => `${alias}."${name}" AS "${alias}.${name}"`);
};

/**
 * Build SELECT column list for an expanded navigation property.
 * Excludes expansion fields — they are lazy, loaded via nested $expand.
 */
const buildNavSelectColumns = (binding: NavigationPropertyBinding, alias: string): ReadonlyArray<string> =>
  binding.targetFields.filter(f => !f.isExpansion).map(f => `${alias}."${f.fieldName}" AS "${alias}.${f.fieldName}"`);

/**
 * Build the LEFT JOIN clause for a navigation property.
 */
const buildExpandJoin = (
  parentResource: string,
  parentKeyField: string,
  parentAlias: string,
  binding: NavigationPropertyBinding,
  navAlias: string
): string => {
  const fk = binding.foreignKey;
  if (fk.strategy === 'resource-record-key') {
    return (
      `LEFT JOIN "${binding.targetResource}" ${navAlias} ` +
      `ON ${navAlias}."ResourceName" = '${parentResource}' ` +
      `AND ${navAlias}."ResourceRecordKey" = ${parentAlias}."${parentKeyField}"`
    );
  }
  if (fk.strategy === 'parent-fk') {
    const rawCol = fk.parentColumn!;
    const dotIdx = parentKeyField.indexOf('.');
    const parentCol = dotIdx >= 0 ? `${parentKeyField.substring(0, dotIdx)}.${rawCol}` : rawCol;
    return (
      `LEFT JOIN "${binding.targetResource}" ${navAlias} ` + `ON ${navAlias}."${binding.targetKeyField}" = ${parentAlias}."${parentCol}"`
    );
  }
  const targetCol = fk.targetColumn ?? parentKeyField;
  return `LEFT JOIN "${binding.targetResource}" ${navAlias} ` + `ON ${navAlias}."${targetCol}" = ${parentAlias}."${parentKeyField}"`;
};

// ---------------------------------------------------------------------------
// Row grouping — collapse LEFT JOIN results into nested entities
// ---------------------------------------------------------------------------

const extractParentColumns = (row: Record<string, unknown>, alias: string, fields: ReadonlyArray<ResoField>): Record<string, unknown> => {
  const prefix = `${alias}.`;
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const colKey = `${prefix}${field.fieldName}`;
    if (colKey in row) {
      result[field.fieldName] = row[colKey];
    }
  }
  return result;
};

const extractNavColumns = (
  row: Record<string, unknown>,
  navAlias: string,
  binding: NavigationPropertyBinding
): Record<string, unknown> | undefined => {
  const prefix = `${navAlias}.`;
  const result: Record<string, unknown> = {};
  let hasNonNull = false;
  for (const field of binding.targetFields) {
    const colKey = `${prefix}${field.fieldName}`;
    if (colKey in row) {
      result[field.fieldName] = row[colKey];
      if (row[colKey] !== null && row[colKey] !== undefined) {
        hasNonNull = true;
      }
    }
  }
  return hasNonNull ? result : undefined;
};

const groupRows = (
  rows: ReadonlyArray<Record<string, unknown>>,
  parentAlias: string,
  keyField: string,
  parentFields: ReadonlyArray<ResoField>,
  selectedFields: ReadonlyArray<ResoField>,
  expandBindings: ReadonlyArray<{
    readonly binding: NavigationPropertyBinding;
    readonly alias: string;
  }>
): ReadonlyArray<EntityRecord> => {
  const grouped = new Map<string, { parent: Record<string, unknown>; navs: Map<string, Record<string, unknown>[]> }>();

  for (const row of rows) {
    const parentData = extractParentColumns(row, parentAlias, selectedFields);
    const parentKey = String(parentData[keyField] ?? '');

    if (!grouped.has(parentKey)) {
      const deserializedParent = deserializeSqliteRow(parentData, parentFields);
      grouped.set(parentKey, {
        parent: deserializedParent,
        navs: new Map(expandBindings.map(({ binding }) => [binding.name, []]))
      });
    }

    const entry = grouped.get(parentKey)!;
    for (const { binding, alias } of expandBindings) {
      const navData = extractNavColumns(row, alias, binding);
      if (navData) {
        const deserialized = deserializeSqliteRow(navData, [...binding.targetFields]);
        entry.navs.get(binding.name)?.push(deserialized);
      }
    }
  }

  const result: EntityRecord[] = [];
  for (const { parent, navs } of grouped.values()) {
    const entity: Record<string, unknown> = { ...parent };
    for (const { binding } of expandBindings) {
      const navRows = navs.get(binding.name) ?? [];
      if (binding.isCollection) {
        const seen = new Set<string>();
        entity[binding.name] = navRows.filter(r => {
          const k = String(r[binding.targetKeyField] ?? '');
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      } else {
        entity[binding.name] = navRows[0] ?? null;
      }
    }
    result.push(entity);
  }

  return result;
};

// ---------------------------------------------------------------------------
// Recursive expand resolution
// ---------------------------------------------------------------------------

const resolveNestedExpand = (
  database: Database.Database,
  entities: ReadonlyArray<EntityRecord>,
  expandBindings: ReadonlyArray<{
    readonly binding: NavigationPropertyBinding;
    readonly expandExpr: ExpandExpression;
  }>,
  resolveChildContext: ((resource: string) => ResourceContext | undefined) | undefined,
  depth: number
): ReadonlyArray<EntityRecord> => {
  if (!resolveChildContext || depth >= MAX_EXPAND_DEPTH) return entities;

  const result: EntityRecord[] = [];

  for (const entity of entities) {
    const expanded: Record<string, unknown> = { ...entity };

    for (const { binding, expandExpr } of expandBindings) {
      const nestedExpand = expandExpr.options.$expand;
      if (!nestedExpand || nestedExpand.length === 0) continue;

      const childCtx = resolveChildContext(binding.targetResource);
      if (!childCtx) continue;

      const childBindings = resolveExpandBindings(nestedExpand, childCtx.navigationBindings);
      if (childBindings.length === 0) continue;

      const children = expanded[binding.name];
      if (!children) continue;

      const childEntities = binding.isCollection
        ? (children as ReadonlyArray<EntityRecord>)
        : [children as EntityRecord];

      if (childEntities.length === 0) continue;

      const expandedChildren = resolveChildExpand(database, childCtx, childEntities, childBindings, depth + 1);
      expanded[binding.name] = binding.isCollection ? expandedChildren : (expandedChildren[0] ?? null);
    }

    result.push(expanded);
  }

  return result;
};

const resolveChildExpand = (
  database: Database.Database,
  childCtx: ResourceContext,
  childEntities: ReadonlyArray<EntityRecord>,
  expandBindings: ReadonlyArray<{
    readonly binding: NavigationPropertyBinding;
    readonly alias: string;
    readonly expandExpr: ExpandExpression;
  }>,
  depth: number
): ReadonlyArray<EntityRecord> => {
  if (childEntities.length === 0) return childEntities;

  const childKeys = childEntities.map(e => String(e[childCtx.keyField] ?? ''));
  const navResults = new Map<string, Map<string, Record<string, unknown>[]>>();
  const placeholders = childKeys.map(() => '?').join(', ');

  for (const { binding } of expandBindings) {
    const fk = binding.foreignKey;
    const targetFields = binding.targetFields.filter(f => !f.isExpansion);
    const selectCols = targetFields.map(f => `"${f.fieldName}"`).join(', ');

    let sql: string;
    let values: unknown[];

    if (fk.strategy === 'resource-record-key') {
      sql = `SELECT ${selectCols} FROM "${binding.targetResource}" WHERE "ResourceName" = ? AND "ResourceRecordKey" IN (${placeholders})`;
      values = [childCtx.resource, ...childKeys];
    } else if (fk.strategy === 'parent-fk') {
      const fkColumn = fk.parentColumn!;
      const fkValues = [...new Set(childEntities.map(e => String(e[fkColumn] ?? '')).filter(v => v.length > 0))];
      const fkPlaceholders = fkValues.map(() => '?').join(', ');
      sql = `SELECT ${selectCols} FROM "${binding.targetResource}" WHERE "${binding.targetKeyField}" IN (${fkPlaceholders})`;
      values = fkValues;
    } else {
      const targetCol = fk.targetColumn ?? childCtx.keyField;
      sql = `SELECT ${selectCols} FROM "${binding.targetResource}" WHERE "${targetCol}" IN (${placeholders})`;
      values = childKeys;
    }

    const rows = database.prepare(sql).all(...values) as Record<string, unknown>[];
    const grouped = new Map<string, Record<string, unknown>[]>();

    for (const row of rows) {
      const deserialized = deserializeSqliteRow(row, [...binding.targetFields]);

      let parentKey: string;
      if (fk.strategy === 'resource-record-key') {
        parentKey = String(row.ResourceRecordKey ?? '');
      } else if (fk.strategy === 'parent-fk') {
        const targetKeyVal = String(deserialized[binding.targetKeyField] ?? '');
        const fkColumn = fk.parentColumn!;
        for (const child of childEntities) {
          if (String(child[fkColumn] ?? '') === targetKeyVal) {
            parentKey = String(child[childCtx.keyField] ?? '');
            if (!grouped.has(parentKey)) grouped.set(parentKey, []);
            grouped.get(parentKey)!.push(deserialized);
          }
        }
        continue;
      } else {
        const targetCol = fk.targetColumn ?? childCtx.keyField;
        parentKey = String(row[targetCol] ?? '');
      }

      if (!grouped.has(parentKey)) grouped.set(parentKey, []);
      grouped.get(parentKey)!.push(deserialized);
    }

    navResults.set(binding.name, grouped);
  }

  const stitched: ReadonlyArray<EntityRecord> = childEntities.map(child => {
    const childKey = String(child[childCtx.keyField] ?? '');
    const entity: Record<string, unknown> = { ...child };

    for (const { binding } of expandBindings) {
      const grouped = navResults.get(binding.name);
      const related = grouped?.get(childKey) ?? [];

      if (binding.isCollection) {
        const seen = new Set<string>();
        entity[binding.name] = related.filter(r => {
          const k = String(r[binding.targetKeyField] ?? '');
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      } else {
        entity[binding.name] = related[0] ?? null;
      }
    }

    return entity;
  });

  const nestedBindings = expandBindings.filter(({ expandExpr }) =>
    expandExpr.options.$expand && expandExpr.options.$expand.length > 0
  );

  if (nestedBindings.length > 0 && childCtx.resolveChildContext) {
    return applyExpandSelect(
      resolveNestedExpand(database, stitched, nestedBindings, childCtx.resolveChildContext, depth),
      expandBindings
    );
  }

  return applyExpandSelect(stitched, expandBindings);
};

// ---------------------------------------------------------------------------
// SQLite DAL implementation
// ---------------------------------------------------------------------------

/** Creates a SQLite Data Access Layer implementation. */
export const createSqliteDal = (db: Database.Database): DataAccessLayer => {
  const queryCollection = async (ctx: ResourceContext, options?: CollectionQueryOptions): Promise<CollectionResult> => {
    const parentAlias = 'p';
    const values: unknown[] = [];

    const dataFields = ctx.fields.filter(f => !f.isExpansion);
    let selectedFields: ReadonlyArray<ResoField>;
    if (options?.$select) {
      const requested = new Set(parseSelect(options.$select));
      requested.add(ctx.keyField);
      selectedFields = dataFields.filter(f => requested.has(f.fieldName));
    } else {
      selectedFields = dataFields;
    }

    const expandBindings = options?.$expand
      ? resolveExpandBindings(options.$expand, ctx.navigationBindings)
      : [];

    let expandSelect = options?.$select;
    if (options?.$select && expandBindings.length > 0) {
      const fkCols = expandBindings.map(({ binding }) => binding.foreignKey.parentColumn).filter((col): col is string => col !== undefined);
      if (fkCols.length > 0) {
        expandSelect = `${options.$select},${fkCols.join(',')}`;
      }
    }
    const parentSelectCols: ReadonlyArray<string> = buildSelectColumns(dataFields, ctx.keyField, expandSelect, parentAlias);

    let whereClause = '';
    const filterValues: unknown[] = [];
    if (options?.$filter) {
      const filterResult = filterToSqlite(options.$filter, ctx.fields, parentAlias);
      whereClause = `WHERE ${filterResult.where}`;
      filterValues.push(...filterResult.values);
      values.push(...filterResult.values);
    }

    let orderByClause = '';
    if (options?.$orderby) {
      const parsed = parseOrderBy(options.$orderby, ctx.fields, parentAlias);
      if (parsed) {
        orderByClause = `ORDER BY ${parsed}`;
      }
    }

    let limitClause = '';
    if (options?.$top !== undefined) {
      limitClause = 'LIMIT ?';
      values.push(options.$top);
    }

    let offsetClause = '';
    if (options?.$skip !== undefined) {
      offsetClause = 'OFFSET ?';
      values.push(options.$skip);
    }

    const countCol = options?.$count ? ', COUNT(*) OVER() AS "__total_count"' : '';

    if (expandBindings.length > 0) {
      const cteSql = [
        `SELECT ${parentSelectCols.join(', ')}${countCol}`,
        `FROM "${ctx.resource}" ${parentAlias}`,
        whereClause,
        orderByClause,
        limitClause,
        offsetClause
      ]
        .filter(s => s.length > 0)
        .join(' ');

      const cteAlias = 'parent_page';

      const outerParentCols = parentSelectCols.map(col => {
        const match = col.match(/AS "(.+)"$/);
        return match ? `${cteAlias}."${match[1]}"` : col;
      });
      const outerCountCol = options?.$count ? `, ${cteAlias}."__total_count"` : '';

      const outerNavCols: string[] = [];
      const outerJoinClauses: string[] = [];
      for (const { binding, alias: navAlias } of expandBindings) {
        outerNavCols.push(...buildNavSelectColumns(binding, navAlias));
        outerJoinClauses.push(buildExpandJoin(ctx.resource, `${parentAlias}.${ctx.keyField}`, cteAlias, binding, navAlias));
      }

      let outerOrderBy = '';
      if (options?.$orderby) {
        const outerParts = options.$orderby
          .split(',')
          .map(part => {
            const trimmed = part.trim();
            const [field, ...rest] = trimmed.split(/\s+/);
            if (!field || !ctx.fields.some(f => f.fieldName === field)) return undefined;
            const dir = rest[0]?.toLowerCase();
            return `${cteAlias}."${parentAlias}.${field}" ${dir === 'desc' ? 'DESC' : 'ASC'}`;
          })
          .filter((clause): clause is string => clause !== undefined);
        if (outerParts.length > 0) outerOrderBy = `ORDER BY ${outerParts.join(', ')}`;
      }
      if (!outerOrderBy) {
        outerOrderBy = `ORDER BY ${cteAlias}."${parentAlias}.${ctx.keyField}"`;
      }

      const outerSql = [
        `SELECT ${[...outerParentCols, ...outerNavCols].join(', ')}${outerCountCol}`,
        `FROM ${cteAlias}`,
        ...outerJoinClauses,
        outerOrderBy
      ]
        .filter(s => s.length > 0)
        .join(' ');

      const sql = `WITH ${cteAlias} AS (${cteSql}) ${outerSql}`;

      const rows = db.prepare(sql).all(...values) as Record<string, unknown>[];

      let count: number | undefined;
      if (options?.$count && rows.length > 0) {
        count = Number(rows[0].__total_count);
      }

      let entities = groupRows(rows, parentAlias, ctx.keyField, ctx.fields, selectedFields, expandBindings);

      const nestedBindings = expandBindings.filter(({ expandExpr }) =>
        expandExpr.options.$expand && expandExpr.options.$expand.length > 0
      );
      if (nestedBindings.length > 0) {
        entities = resolveNestedExpand(db, entities, nestedBindings, ctx.resolveChildContext, 1);
      }

      entities = applyExpandSelect(entities, expandBindings);

      return { value: entities, ...(count !== undefined ? { count } : {}) };
    }

    const sql = [
      `SELECT ${parentSelectCols.join(', ')}${countCol}`,
      `FROM "${ctx.resource}" ${parentAlias}`,
      whereClause,
      orderByClause,
      limitClause,
      offsetClause
    ]
      .filter(s => s.length > 0)
      .join(' ');

    const rows = db.prepare(sql).all(...values) as Record<string, unknown>[];

    let count: number | undefined;
    if (options?.$count && rows.length > 0) {
      count = Number(rows[0].__total_count);
    } else if (options?.$count && rows.length === 0) {
      const countSql = ['SELECT COUNT(*) AS cnt', `FROM "${ctx.resource}" ${parentAlias}`, whereClause].filter(s => s.length > 0).join(' ');
      const countRow = db.prepare(countSql).get(...filterValues) as Record<string, unknown> | undefined;
      count = Number(countRow?.cnt ?? 0);
    }

    const entities = rows.map(row => {
      const parent = extractParentColumns(row, parentAlias, selectedFields);
      return deserializeSqliteRow(parent, [...ctx.fields]);
    });

    return { value: entities, ...(count !== undefined ? { count } : {}) };
  };

  const readByKey = async (
    ctx: ResourceContext,
    keyValue: string,
    options?: { readonly $select?: string; readonly $expand?: ReadonlyArray<ExpandExpression> }
  ): Promise<SingleResult> => {
    if (options?.$expand) {
      const result = await queryCollection(ctx, {
        $filter: `${ctx.keyField} eq '${keyValue.replace(/'/g, "''")}'`,
        $select: options.$select,
        $expand: options.$expand,
        $top: 1
      });
      return result.value[0];
    }

    const parentAlias = 'p';
    const dataFields = ctx.fields.filter(f => !f.isExpansion);
    const selectCols = buildSelectColumns(dataFields, ctx.keyField, options?.$select, parentAlias);

    const sql = `SELECT ${selectCols.join(', ')} FROM "${ctx.resource}" ${parentAlias} WHERE ${parentAlias}."${ctx.keyField}" = ?`;
    const row = db.prepare(sql).get(keyValue) as Record<string, unknown> | undefined;

    if (!row) return undefined;

    const parent = extractParentColumns(row, parentAlias, dataFields);
    return deserializeSqliteRow(parent, [...dataFields]);
  };

  const insert = async (ctx: ResourceContext, record: Readonly<Record<string, unknown>>): Promise<EntityRecord> => {
    const fieldMap = new Map(ctx.fields.map(f => [f.fieldName, f]));
    const entries = Object.entries(record).filter(([key]) => fieldMap.has(key));

    const columns = entries.map(([key]) => `"${key}"`);
    const placeholders = entries.map(() => '?');
    const values = entries.map(([key, value]) => {
      const field = fieldMap.get(key)!;
      return serializeValue(value, field);
    });

    const sql = `INSERT INTO "${ctx.resource}" (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`;
    const row = db.prepare(sql).get(...values) as Record<string, unknown>;
    return deserializeSqliteRow(row, [...ctx.fields]);
  };

  const update = async (ctx: ResourceContext, keyValue: string, updates: Readonly<Record<string, unknown>>): Promise<SingleResult> => {
    const fieldMap = new Map(ctx.fields.map(f => [f.fieldName, f]));
    const entries = Object.entries(updates).filter(([key]) => key !== ctx.keyField && fieldMap.has(key));

    if (entries.length === 0) {
      return readByKey(ctx, keyValue);
    }

    const setClauses = entries.map(([key]) => `"${key}" = ?`);
    const values = entries.map(([key, value]) => {
      const field = fieldMap.get(key)!;
      return serializeValue(value, field);
    });
    values.push(keyValue);

    const sql = `UPDATE "${ctx.resource}" SET ${setClauses.join(', ')} WHERE "${ctx.keyField}" = ? RETURNING *`;
    const row = db.prepare(sql).get(...values) as Record<string, unknown> | undefined;

    if (!row) return undefined;
    return deserializeSqliteRow(row, [...ctx.fields]);
  };

  const deleteByKey = async (ctx: ResourceContext, keyValue: string): Promise<boolean> => {
    const sql = `DELETE FROM "${ctx.resource}" WHERE "${ctx.keyField}" = ?`;
    const result = db.prepare(sql).run(keyValue);
    return result.changes > 0;
  };

  return { queryCollection, readByKey, insert, update, deleteByKey };
};
