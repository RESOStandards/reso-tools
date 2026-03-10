/**
 * MongoDB Data Access Layer implementation.
 *
 * Key differences from the PostgreSQL implementation:
 *
 * 1. No JOINs — uses batch queries per navigation property for $expand.
 *    For each parent entity that matches the query, we collect parent keys,
 *    then issue a single query per navigation property to fetch all related
 *    documents, then stitch results together in application code.
 *
 * 2. $filter translation targets MongoDB query operators ($eq, $gt, $regex)
 *    via the filterToMongo() translator in filter-to-mongo.ts.
 *
 * 3. Collection fields are stored natively as arrays (no JSON serialization).
 *
 * 4. Pagination is naturally correct — $skip/$limit apply to the parent
 *    cursor first, then batchExpandNavigation() resolves navigation properties
 *    against the already-paginated parent set. No CTE needed (unlike PostgreSQL).
 *
 * 5. Multi-level $expand is supported via recursive batch lookups.
 */

import type { Db } from 'mongodb';
import type { ExpandExpression } from '@reso-standards/odata-expression-parser';
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
import { applyMongoExpandSelect } from './expand-select.js';
import { filterToMongo } from './filter-to-mongo.js';

// ---------------------------------------------------------------------------
// _id suppression helper
// ---------------------------------------------------------------------------

/** Remove MongoDB's _id field from a document. */
const stripId = (doc: Record<string, unknown>): Record<string, unknown> => {
  const { _id: _, ...rest } = doc;
  return rest;
};

/** Coerce null collection fields to [] for DD 2.0 compliance. */
const coerceCollections = (doc: Record<string, unknown>, collectionFields: ReadonlySet<string>): Record<string, unknown> => {
  for (const field of collectionFields) {
    if (doc[field] == null) doc[field] = [];
  }
  return doc;
};

// ---------------------------------------------------------------------------
// Batch expand resolution (document store pattern)
// ---------------------------------------------------------------------------

/**
 * Resolve navigation properties for a set of parent entities using batch
 * queries. Supports multi-level $expand via recursive resolution.
 */
const batchExpandNavigation = async (
  db: Db,
  parentResource: string,
  parentKeyField: string,
  parents: ReadonlyArray<EntityRecord>,
  expandTree: ReadonlyArray<ExpandExpression>,
  navigationBindings: ReadonlyArray<NavigationPropertyBinding>,
  resolveChildContext: ((resource: string) => ResourceContext | undefined) | undefined,
  depth: number
): Promise<ReadonlyArray<EntityRecord>> => {
  if (expandTree.length === 0 || parents.length === 0) return parents;

  const bindingMap = new Map(navigationBindings.map(b => [b.name, b]));
  const bindings = expandTree
    .map(expr => ({ expr, binding: bindingMap.get(expr.property) }))
    .filter((e): e is { expr: ExpandExpression; binding: NavigationPropertyBinding } => e.binding !== undefined);

  if (bindings.length === 0) return parents;

  // Collect all parent key values
  const parentKeys = parents.map(p => String(p[parentKeyField] ?? ''));

  // For each navigation property, fetch all related documents in one query
  const navResults = new Map<string, Map<string, Record<string, unknown>[]>>();

  for (const { binding } of bindings) {
    const collection = db.collection(binding.targetResource);
    const fk = binding.foreignKey;

    // Build projection for target fields — exclude _id and expansion fields (lazy via $expand)
    const navProjection: Record<string, number> = { _id: 0 };
    for (const f of binding.targetFields) {
      if (f.isExpansion) navProjection[f.fieldName] = 0;
    }

    if (fk.strategy === 'parent-fk') {
      const fkColumn = fk.parentColumn!;
      const fkValues = [...new Set(parents.map(p => String(p[fkColumn] ?? '')).filter(v => v.length > 0))];
      if (fkValues.length === 0) {
        navResults.set(binding.name, new Map());
        continue;
      }
      const docs = await collection.find({ [binding.targetKeyField]: { $in: fkValues } }, { projection: navProjection }).toArray();

      const byKey = new Map<string, Record<string, unknown>>();
      for (const doc of docs) {
        byKey.set(String(doc[binding.targetKeyField] ?? ''), doc);
      }

      const grouped = new Map<string, Record<string, unknown>[]>();
      for (const parent of parents) {
        const pk = String(parent[parentKeyField] ?? '');
        const fkVal = String(parent[fkColumn] ?? '');
        const target = byKey.get(fkVal);
        grouped.set(pk, target ? [target] : []);
      }
      navResults.set(binding.name, grouped);
      continue;
    }

    let filter: Record<string, unknown>;
    if (fk.strategy === 'resource-record-key') {
      filter = {
        ResourceName: parentResource,
        ResourceRecordKey: { $in: parentKeys }
      };
    } else {
      const targetCol = fk.targetColumn ?? parentKeyField;
      filter = { [targetCol]: { $in: parentKeys } };
    }

    const docs = await collection.find(filter, { projection: navProjection }).toArray();

    const grouped = new Map<string, Record<string, unknown>[]>();
    for (const doc of docs) {
      const parentKey =
        fk.strategy === 'resource-record-key' ? String(doc.ResourceRecordKey ?? '') : String(doc[fk.targetColumn ?? parentKeyField] ?? '');
      if (!grouped.has(parentKey)) {
        grouped.set(parentKey, []);
      }
      grouped.get(parentKey)!.push(doc);
    }

    navResults.set(binding.name, grouped);
  }

  // Stitch navigation results into parent entities
  const stitched = parents.map(parent => {
    const parentKey = String(parent[parentKeyField] ?? '');
    const expanded: Record<string, unknown> = { ...parent };

    for (const { binding } of bindings) {
      const grouped = navResults.get(binding.name);
      const related = grouped?.get(parentKey) ?? [];

      if (binding.isCollection) {
        expanded[binding.name] = related;
      } else {
        expanded[binding.name] = related[0] ?? null;
      }
    }

    return expanded;
  });

  // Recursively resolve nested $expand (level 2+), then apply inline $select
  if (depth < MAX_EXPAND_DEPTH && resolveChildContext) {
    const result: EntityRecord[] = [];

    for (const entity of stitched) {
      const expanded: Record<string, unknown> = { ...entity };

      for (const { expr, binding } of bindings) {
        const nestedExpand = expr.options.$expand;
        if (!nestedExpand || nestedExpand.length === 0) continue;

        const childCtx = resolveChildContext(binding.targetResource);
        if (!childCtx) continue;

        const children = expanded[binding.name];
        if (!children) continue;

        const childEntities = binding.isCollection
          ? (children as ReadonlyArray<EntityRecord>)
          : [children as EntityRecord];

        if (childEntities.length === 0) continue;

        const expandedChildren = await batchExpandNavigation(
          db,
          binding.targetResource,
          childCtx.keyField,
          childEntities,
          nestedExpand,
          childCtx.navigationBindings,
          childCtx.resolveChildContext,
          depth + 1
        );

        expanded[binding.name] = binding.isCollection ? expandedChildren : (expandedChildren[0] ?? null);
      }

      result.push(expanded);
    }

    return applyMongoExpandSelect(result, bindings);
  }

  return applyMongoExpandSelect(stitched, bindings);
};

// ---------------------------------------------------------------------------
// MongoDB DAL implementation
// ---------------------------------------------------------------------------

/**
 * Creates a MongoDB Data Access Layer implementation.
 *
 * @param db - MongoDB Db instance (from MongoClient.db())
 */
export const createMongoDal = (db: Db): DataAccessLayer => {
  /** Returns the set of collection field names for a resource context (excludes expansion/navigation properties). */
  const collectionFieldSet = (ctx: ResourceContext): ReadonlySet<string> =>
    new Set(ctx.fields.filter(f => f.isCollection && !f.isExpansion).map(f => f.fieldName));

  const queryCollection = async (ctx: ResourceContext, options?: CollectionQueryOptions): Promise<CollectionResult> => {
    const collection = db.collection(ctx.resource);

    // Build MongoDB filter from $filter
    const filter = options?.$filter ? filterToMongo(options.$filter, ctx.fields).query : {};

    // Build projection from $select (always suppress _id and expansion fields — they are lazy, loaded via $expand)
    const expansionFieldNames = new Set(ctx.fields.filter(f => f.isExpansion).map(f => f.fieldName));
    const projection: Record<string, number> = { _id: 0 };
    if (options?.$select) {
      const selectFields = options.$select
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0);
      for (const f of selectFields) {
        if (!expansionFieldNames.has(f)) projection[f] = 1;
      }
      projection[ctx.keyField] = 1; // always include key
    } else {
      // Explicitly exclude expansion fields from default projection
      for (const name of expansionFieldNames) projection[name] = 0;
    }

    // Start cursor
    let cursor = collection.find(filter);

    // Always apply projection (at minimum to suppress _id)
    cursor = cursor.project(projection);

    // $orderby — validate field names and build sort spec
    if (options?.$orderby) {
      const fieldNames = new Set(ctx.fields.map(f => f.fieldName));
      const sort: Record<string, 1 | -1> = {};
      for (const part of options.$orderby.split(',')) {
        const [fieldName, dir] = part.trim().split(/\s+/);
        if (fieldName) {
          if (!fieldNames.has(fieldName)) {
            throw new Error(`Unknown field in $orderby: ${fieldName}`);
          }
          sort[fieldName] = dir?.toLowerCase() === 'desc' ? -1 : 1;
        }
      }
      cursor = cursor.sort(sort);
    }

    // $skip / $top — pagination applies to parent cursor (naturally correct)
    if (options?.$skip !== undefined) cursor = cursor.skip(options.$skip);
    if (options?.$top !== undefined) cursor = cursor.limit(options.$top);

    const collFields = collectionFieldSet(ctx);
    const docs = ((await cursor.toArray()) as Record<string, unknown>[]).map(d => coerceCollections(d, collFields));

    // $count — uses the same filter for accurate count
    let count: number | undefined;
    if (options?.$count) {
      count = await collection.countDocuments(filter);
    }

    // $expand — batch query per navigation property (supports multi-level)
    let entities: ReadonlyArray<EntityRecord> = docs;
    if (options?.$expand) {
      entities = await batchExpandNavigation(
        db, ctx.resource, ctx.keyField, docs,
        options.$expand, ctx.navigationBindings, ctx.resolveChildContext, 0
      );
    }

    return { value: entities, ...(count !== undefined ? { count } : {}) };
  };

  const readByKey = async (
    ctx: ResourceContext,
    keyValue: string,
    options?: { readonly $select?: string; readonly $expand?: ReadonlyArray<ExpandExpression> }
  ): Promise<SingleResult> => {
    const collection = db.collection(ctx.resource);
    // Exclude expansion fields from projection — they are lazy, loaded via $expand
    const expansionNames = new Set(ctx.fields.filter(f => f.isExpansion).map(f => f.fieldName));
    const readProjection: Record<string, number> = { _id: 0 };
    for (const name of expansionNames) readProjection[name] = 0;
    const doc = await collection.findOne({ [ctx.keyField]: keyValue }, { projection: readProjection });
    if (!doc) return undefined;
    coerceCollections(doc as Record<string, unknown>, collectionFieldSet(ctx));

    // Apply $select
    let entity: EntityRecord = doc;
    if (options?.$select) {
      const selectFields = new Set(
        options.$select
          .split(',')
          .map(s => s.trim())
          .filter(s => s.length > 0)
      );
      selectFields.add(ctx.keyField);
      entity = Object.fromEntries(Object.entries(doc).filter(([k]) => selectFields.has(k)));
    }

    // Apply $expand
    if (options?.$expand) {
      const [expanded] = await batchExpandNavigation(
        db, ctx.resource, ctx.keyField, [entity],
        options.$expand, ctx.navigationBindings, ctx.resolveChildContext, 0
      );
      return expanded;
    }

    return entity;
  };

  const insert = async (ctx: ResourceContext, record: Readonly<Record<string, unknown>>): Promise<EntityRecord> => {
    const collection = db.collection(ctx.resource);
    await collection.insertOne({ ...record });
    // Return the record without _id
    return stripId(record as Record<string, unknown>);
  };

  const update = async (ctx: ResourceContext, keyValue: string, updates: Readonly<Record<string, unknown>>): Promise<SingleResult> => {
    const collection = db.collection(ctx.resource);
    const result = await collection.updateOne({ [ctx.keyField]: keyValue }, { $set: updates });
    if (result.matchedCount === 0) return undefined;
    const updated = await collection.findOne({ [ctx.keyField]: keyValue }, { projection: { _id: 0 } });
    return updated as SingleResult;
  };

  const deleteByKey = async (ctx: ResourceContext, keyValue: string): Promise<boolean> => {
    const collection = db.collection(ctx.resource);
    const result = await collection.deleteOne({ [ctx.keyField]: keyValue });
    return result.deletedCount > 0;
  };

  return { queryCollection, readByKey, insert, update, deleteByKey };
};
