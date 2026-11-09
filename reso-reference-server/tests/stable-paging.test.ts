/**
 * Every page of a collection sees the rows in one order, whatever the data (2026-11-06).
 *
 * Web API Core 2.1.0 against the server on Postgres failed server-driven paging: a key repeated across pages. Many
 * records shared a ModificationTimestamp, the test paged by ModificationTimestamp, and the query sorted on that column
 * alone, so rows tied on it came back in a different order on each page. With no $orderby the query had no ORDER BY at
 * all.
 *
 * SQLite usually returns ties in insertion order, so a paging test on it would pass with the old query and prove
 * nothing. These tests read the query each layer builds instead: the key is the last sort column, and the only one when
 * the client asks for no order.
 */

import type Database from 'better-sqlite3';
import type { Db } from 'mongodb';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { ResourceContext } from '../src/db/data-access.js';
import { createMongoDal } from '../src/db/mongo-dal.js';
import { createPostgresDal } from '../src/db/postgres-dal.js';
import { createSqliteDal } from '../src/db/sqlite-dal.js';
import { stableOrderBy, withKeyLast } from '../src/db/stable-order.js';
import type { ResoField } from '../src/metadata/types.js';

const field = (fieldName: string, type: string): ResoField => ({ resourceName: 'Organization', fieldName, type }) as ResoField;

const ctx: ResourceContext = {
  resource: 'Organization',
  keyField: 'OrganizationKey',
  fields: [
    field('OrganizationKey', 'Edm.String'),
    field('ModificationTimestamp', 'Edm.DateTimeOffset'),
    field('OrganizationType', 'Edm.String')
  ],
  navigationBindings: []
};

/** The ORDER BY of the one collection query a call issued. */
const orderByOf = (sql: string): string => sql.match(/ORDER BY (.+?)(?: LIMIT| OFFSET|$)/)?.[1] ?? '(none)';

describe('the sort rule', () => {
  it('adds the key last, and only the key when no order is asked for', () => {
    expect(withKeyLast(['p."ModificationTimestamp" ASC'], 'p."OrganizationKey"')).toEqual([
      'p."ModificationTimestamp" ASC',
      'p."OrganizationKey" ASC'
    ]);
    expect(withKeyLast([], 'p."OrganizationKey"')).toEqual(['p."OrganizationKey" ASC']);
    expect(stableOrderBy('', 'p."OrganizationKey"')).toBe('ORDER BY p."OrganizationKey" ASC');
  });

  it('leaves an order that already sorts on the key as it is', () => {
    expect(withKeyLast(['p."OrganizationKey" DESC'], 'p."OrganizationKey"')).toEqual(['p."OrganizationKey" DESC']);
  });
});

describe('the Postgres layer', () => {
  const capture = () => {
    const queries: string[] = [];
    const pool = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      }
    } as unknown as pg.Pool;
    return { dal: createPostgresDal(pool), queries };
  };

  it('sorts ties on the client order by the key', async () => {
    const { dal, queries } = capture();
    await dal.queryCollection(ctx, { $orderby: 'ModificationTimestamp', $top: 500, $skip: 500 });
    expect(orderByOf(queries[0])).toMatch(/"ModificationTimestamp" ASC, \w+\."OrganizationKey" ASC$/);
  });

  it('sorts by the key when the client asks for no order', async () => {
    const { dal, queries } = capture();
    await dal.queryCollection(ctx, { $top: 500, $skip: 500 });
    expect(orderByOf(queries[0])).toMatch(/^\w+\."OrganizationKey" ASC$/);
  });
});

describe('the SQLite layer', () => {
  const capture = () => {
    const queries: string[] = [];
    const db = {
      prepare: (sql: string) => {
        queries.push(sql);
        return { all: () => [], get: () => ({ __total_count: 0 }) };
      }
    } as unknown as Database.Database;
    return { dal: createSqliteDal(db), queries };
  };

  it('sorts ties on the client order by the key', async () => {
    const { dal, queries } = capture();
    await dal.queryCollection(ctx, { $orderby: 'ModificationTimestamp desc', $top: 500, $skip: 500 });
    expect(orderByOf(queries[0])).toMatch(/"ModificationTimestamp" DESC, \w+\."OrganizationKey" ASC$/);
  });

  it('sorts by the key when the client asks for no order', async () => {
    const { dal, queries } = capture();
    await dal.queryCollection(ctx, { $top: 500 });
    expect(orderByOf(queries[0])).toMatch(/^\w+\."OrganizationKey" ASC$/);
  });
});

describe('the Mongo layer', () => {
  const capture = () => {
    const sorts: Array<Record<string, number>> = [];
    const cursor = {
      project: () => cursor,
      sort: (spec: Record<string, number>) => {
        sorts.push(spec);
        return cursor;
      },
      skip: () => cursor,
      limit: () => cursor,
      toArray: async () => []
    };
    const db = { collection: () => ({ find: () => cursor, countDocuments: async () => 0 }) } as unknown as Db;
    return { dal: createMongoDal(db), sorts };
  };

  it('sorts ties on the client order by the key, after the client order', async () => {
    const { dal, sorts } = capture();
    await dal.queryCollection(ctx, { $orderby: 'ModificationTimestamp', $top: 500 });
    expect(Object.entries(sorts[0])).toEqual([
      ['ModificationTimestamp', 1],
      ['OrganizationKey', 1]
    ]);
  });

  it('sorts by the key when the client asks for no order', async () => {
    const { dal, sorts } = capture();
    await dal.queryCollection(ctx, { $top: 500 });
    expect(sorts[0]).toEqual({ OrganizationKey: 1 });
  });
});
