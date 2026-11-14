/**
 * `$filter` inside `$expand` (reso-tools #440): each backend narrows the children where it fetches them, through the same
 * translator as a top-level `$filter`, so a nested filter means what a top-level one means.
 *
 * SQLite runs for real on an in-memory database: the filter's parameters have to follow the parent page's in the SQL
 * text, and only a real query shows they do. PostgreSQL and MongoDB are read from the query each layer builds, as
 * stable-paging.test.ts reads them.
 */
import { parseExpand } from '@reso-standards/odata-expression-parser';
import Database from 'better-sqlite3';
import type { Db } from 'mongodb';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { NavigationPropertyBinding, ResourceContext } from '../src/db/data-access.js';
import { isExpandOptionError } from '../src/db/expand-options.js';
import { createMongoDal } from '../src/db/mongo-dal.js';
import { createPostgresDal } from '../src/db/postgres-dal.js';
import { createSqliteDal } from '../src/db/sqlite-dal.js';
import type { ResoField } from '../src/metadata/types.js';

const field = (resourceName: string, fieldName: string, type: string): ResoField => ({ resourceName, fieldName, type }) as ResoField;

const mediaFields = [
  field('Media', 'MediaKey', 'Edm.String'),
  field('Media', 'ResourceName', 'Edm.String'),
  field('Media', 'ResourceRecordKey', 'Edm.String'),
  field('Media', 'ChecksumType', 'Edm.String'),
  field('Media', 'Order', 'Edm.Int32')
];
const officeFields = [field('Office', 'OfficeKey', 'Edm.String'), field('Office', 'OrganizationKey', 'Edm.String')];

const mediaOf = (resource: string): NavigationPropertyBinding => ({
  name: 'Media',
  targetResource: 'Media',
  targetKeyField: 'MediaKey',
  targetFields: mediaFields,
  foreignKey: { strategy: 'resource-record-key' },
  isCollection: true
});
const offices: NavigationPropertyBinding = {
  name: 'Offices',
  targetResource: 'Office',
  targetKeyField: 'OfficeKey',
  targetFields: officeFields,
  foreignKey: { strategy: 'direct', targetColumn: 'OrganizationKey' },
  isCollection: true
};
const parentOrg: NavigationPropertyBinding = {
  name: 'Organization',
  targetResource: 'Organization',
  targetKeyField: 'OrganizationKey',
  targetFields: [field('Organization', 'OrganizationKey', 'Edm.String')],
  foreignKey: { strategy: 'parent-fk', parentColumn: 'OrganizationKey' },
  isCollection: false
};
const officeCtx: ResourceContext = {
  resource: 'Office',
  keyField: 'OfficeKey',
  fields: officeFields,
  navigationBindings: [mediaOf('Office'), parentOrg]
};
const orgCtx: ResourceContext = {
  resource: 'Organization',
  keyField: 'OrganizationKey',
  fields: [field('Organization', 'OrganizationKey', 'Edm.String'), field('Organization', 'OrganizationName', 'Edm.String')],
  navigationBindings: [mediaOf('Organization'), offices],
  resolveChildContext: resource => (resource === 'Office' ? officeCtx : undefined)
};

const sqlite = () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE "Organization" ("OrganizationKey" TEXT PRIMARY KEY, "OrganizationName" TEXT);
    CREATE TABLE "Office" ("OfficeKey" TEXT PRIMARY KEY, "OrganizationKey" TEXT);
    CREATE TABLE "Media" ("MediaKey" TEXT PRIMARY KEY, "ResourceName" TEXT, "ResourceRecordKey" TEXT, "ChecksumType" TEXT, "Order" INTEGER);
    INSERT INTO "Organization" VALUES ('O1', 'One'), ('O2', 'Two');
    INSERT INTO "Office" VALUES ('F1', 'O1');
    INSERT INTO "Media" VALUES
      ('M1', 'Organization', 'O1', 'sha256', 1), ('M2', 'Organization', 'O1', 'signature', 2), ('M3', 'Organization', 'O1', 'sha256', 3),
      ('M4', 'Organization', 'O2', 'sha256', 1),
      ('F1-1', 'Office', 'F1', 'sha256', 1), ('F1-2', 'Office', 'F1', 'signature', 2);
  `);
  return createSqliteDal(db);
};
const keysOf = (items: unknown): ReadonlyArray<string> => (items as ReadonlyArray<Record<string, unknown>>).map(m => m.MediaKey as string);

describe('SQLite – $filter inside $expand, on real queries', () => {
  it('narrows each parent’s children, and a parent with none keeps an empty collection', async () => {
    const { value } = await sqlite().queryCollection(orgCtx, { $expand: parseExpand("Media($filter=ChecksumType eq 'signature')") });
    expect(value.map(org => [org.OrganizationKey, keysOf(org.Media)])).toEqual([
      ['O1', ['M2']],
      ['O2', []]
    ]);
  });

  it('keeps the parent filter’s parameters and the nested filter’s apart, in the order the SQL uses them', async () => {
    const { value } = await sqlite().queryCollection(orgCtx, {
      $filter: "OrganizationKey eq 'O1'",
      $top: 5,
      $expand: parseExpand("Media($filter=ChecksumType eq 'sha256' and Order gt 1)")
    });
    expect(value.map(org => [org.OrganizationKey, keysOf(org.Media)])).toEqual([['O1', ['M3']]]);
  });

  it('filters before ordering, paging and counting', async () => {
    const { value } = await sqlite().queryCollection(orgCtx, {
      $filter: "OrganizationKey eq 'O1'",
      $expand: parseExpand("Media($filter=ChecksumType eq 'sha256';$orderby=Order desc;$top=1;$count=true)")
    });
    expect([keysOf(value[0].Media), value[0]['Media@odata.count']]).toEqual([['M3'], 2]);
  });

  it('filters on a single-record read, which goes through the same query', async () => {
    const org = await sqlite().readByKey(orgCtx, 'O1', { $expand: parseExpand('Media($filter=Order le 2)') });
    expect(keysOf(org?.Media)).toEqual(['M1', 'M2']);
  });

  it('filters a nested expansion’s children, fetched by key', async () => {
    const { value } = await sqlite().queryCollection(orgCtx, {
      $filter: "OrganizationKey eq 'O1'",
      $expand: parseExpand("Offices($expand=Media($filter=ChecksumType eq 'signature'))")
    });
    const [office] = value[0].Offices as ReadonlyArray<Record<string, unknown>>;
    expect(keysOf(office.Media)).toEqual(['F1-2']);
  });

  it('refuses a field the expanded resource does not have, as a top-level filter would', async () => {
    await expect(sqlite().queryCollection(orgCtx, { $expand: parseExpand("Media($filter=Nope eq 'x')") })).rejects.toThrow(/Nope/);
  });

  it('refuses $filter on a single-valued expansion as a client error', async () => {
    const error = await sqlite()
      .queryCollection(officeCtx, { $expand: parseExpand("Organization($filter=OrganizationKey eq 'O1')") })
      .catch((err: unknown) => err);
    expect(isExpandOptionError(error)).toBe(true);
  });
});

describe('PostgreSQL – the nested filter in the query it builds', () => {
  const capture = () => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const pool = {
      query: async (sql: string, values: unknown[] = []) => {
        calls.push({ sql, values });
        return { rows: [] };
      }
    } as unknown as pg.Pool;
    return { dal: createPostgresDal(pool), calls };
  };

  it('puts the filter on the join and numbers its parameters after the page’s', async () => {
    const { dal, calls } = capture();
    await dal.queryCollection(orgCtx, {
      $filter: "OrganizationKey eq 'O1'",
      $top: 5,
      $expand: parseExpand("Media($filter=ChecksumType eq 'sha256')")
    });
    const { sql, values } = calls[0];
    expect(sql).toMatch(/LEFT JOIN "Media" nav_Media ON .+ AND \(nav_Media\."ChecksumType" = \$3\)/);
    expect(values).toEqual(['O1', 5, 'sha256']);
  });

  it('appends the filter to a nested expansion’s fetch by key, numbered after the keys', async () => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const pool = {
      query: async (sql: string, values: unknown[] = []) => {
        calls.push({ sql, values });
        // The parent page with one organization and its office, then nothing for the nested fetch.
        return calls.length === 1
          ? {
              rows: [
                {
                  'p.OrganizationKey': 'O1',
                  'p.OrganizationName': 'One',
                  'nav_Offices.OfficeKey': 'F1',
                  'nav_Offices.OrganizationKey': 'O1'
                }
              ]
            }
          : { rows: [] };
      }
    } as unknown as pg.Pool;
    await createPostgresDal(pool).queryCollection(orgCtx, {
      $expand: parseExpand("Offices($expand=Media($filter=ChecksumType eq 'signature'))")
    });
    const nested = calls.find(call => call.sql.includes('FROM "Media"') && call.sql.includes('ANY('));
    expect(nested?.sql).toMatch(/"ResourceName" = \$1 AND "ResourceRecordKey" = ANY\(\$2\) AND \("Media"\."ChecksumType" = \$3\)/);
    expect(nested?.values).toEqual(['Office', ['F1'], 'signature']);
  });
});

describe('MongoDB – the nested filter in the lookup it builds', () => {
  it('combines the filter, as the top-level translator writes it, with the key match', async () => {
    const finds: { collection: string; query: Record<string, unknown> }[] = [];
    const cursor = (docs: unknown[]) => ({
      sort: () => cursor(docs),
      skip: () => cursor(docs),
      limit: () => cursor(docs),
      project: () => cursor(docs),
      toArray: async () => docs
    });
    const db = {
      collection: (name: string) => ({
        find: (query: Record<string, unknown>) => {
          finds.push({ collection: name, query });
          return cursor(name === 'Organization' ? [{ OrganizationKey: 'O1' }] : []);
        },
        countDocuments: async () => 1
      })
    } as unknown as Db;
    await createMongoDal(db).queryCollection(orgCtx, { $expand: parseExpand("Media($filter=ChecksumType eq 'sha256')") });
    const lookup = finds.find(find => find.collection === 'Media');
    expect(lookup?.query).toEqual({
      $and: [{ ResourceName: 'Organization', ResourceRecordKey: { $in: ['O1'] } }, { ChecksumType: 'sha256' }]
    });
  });
});
