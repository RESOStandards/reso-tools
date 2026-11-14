/**
 * `$search` (reso-tools #442): a record matches a word or phrase when one of its plain text fields contains it, ignoring
 * case, at the top level, inside `$expand` and combined with `$filter`.
 *
 * SQLite runs for real on an in-memory database, because what a search matches, and that its parameters line up with
 * the SQL text, only a real query shows. PostgreSQL and MongoDB are read from the query each layer builds, as
 * expand-filter.test.ts reads them.
 */
import { isSearchParseError, parseExpand } from '@reso-standards/odata-expression-parser';
import Database from 'better-sqlite3';
import type { Db } from 'mongodb';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { NavigationPropertyBinding, ResourceContext } from '../src/db/data-access.js';
import { isExpandOptionError } from '../src/db/expand-options.js';
import { createMongoDal } from '../src/db/mongo-dal.js';
import { createPostgresDal } from '../src/db/postgres-dal.js';
import { searchableFields } from '../src/db/search.js';
import { createSqliteDal } from '../src/db/sqlite-dal.js';
import type { ResoField } from '../src/metadata/types.js';

const field = (resourceName: string, fieldName: string, type: string, extra: Partial<ResoField> = {}): ResoField =>
  ({ resourceName, fieldName, type, annotations: [], ...extra }) as ResoField;

const mediaFields = [
  field('Media', 'MediaKey', 'Edm.String'),
  field('Media', 'ResourceName', 'org.reso.metadata.enums.ResourceName', { isEnumeration: true }),
  field('Media', 'ResourceRecordKey', 'Edm.String'),
  field('Media', 'ShortDescription', 'Edm.String'),
  field('Media', 'LongDescription', 'Edm.String'),
  // A lookup in string mode: an Edm.String field the LookupName annotation marks. $filter matches it, not $search.
  field('Media', 'ChecksumType', 'Edm.String', { annotations: [{ term: 'RESO.OData.Metadata.LookupName', value: 'ChecksumType' }] }),
  field('Media', 'Order', 'Edm.Int32')
];
const officeFields = [field('Office', 'OfficeKey', 'Edm.String'), field('Office', 'OrganizationKey', 'Edm.String')];

const mediaOf = (): NavigationPropertyBinding => ({
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
const mediaCtx: ResourceContext = { resource: 'Media', keyField: 'MediaKey', fields: mediaFields, navigationBindings: [] };
const officeCtx: ResourceContext = {
  resource: 'Office',
  keyField: 'OfficeKey',
  fields: officeFields,
  navigationBindings: [mediaOf(), parentOrg]
};
const orgCtx: ResourceContext = {
  resource: 'Organization',
  keyField: 'OrganizationKey',
  fields: [field('Organization', 'OrganizationKey', 'Edm.String'), field('Organization', 'OrganizationName', 'Edm.String')],
  navigationBindings: [mediaOf(), offices],
  resolveChildContext: resource => (resource === 'Office' ? officeCtx : undefined)
};

const sqlite = () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE "Organization" ("OrganizationKey" TEXT PRIMARY KEY, "OrganizationName" TEXT);
    CREATE TABLE "Office" ("OfficeKey" TEXT PRIMARY KEY, "OrganizationKey" TEXT);
    CREATE TABLE "Media" (
      "MediaKey" TEXT PRIMARY KEY, "ResourceName" TEXT, "ResourceRecordKey" TEXT,
      "ShortDescription" TEXT, "LongDescription" TEXT, "ChecksumType" TEXT, "Order" INTEGER
    );
    INSERT INTO "Organization" VALUES ('O1', 'Standards'), ('O2', 'Research');
    INSERT INTO "Office" VALUES ('F1', 'O1');
    INSERT INTO "Media" VALUES
      ('M1', 'Organization', 'O1', 'Business Case Template', 'A template for a business case', 'sha256', 1),
      ('M2', 'Organization', 'O1', 'Data Dictionary 2.1', NULL, 'signature', 2),
      ('M3', 'Organization', 'O1', 'Product Roadmap', 'The business roadmap for the next two years', 'sha256', 3),
      ('M4', 'Organization', 'O2', '100% Uptime_Report', 'Filed under C:\\reports', 'sha256', 1),
      ('M5', 'Organization', 'O2', NULL, NULL, 'roadmap', 2),
      ('F1-1', 'Office', 'F1', 'Lobby poster', NULL, 'sha256', 1),
      ('F1-2', 'Office', 'F1', 'Lobby roadmap', NULL, 'signature', 2);
  `);
  return createSqliteDal(db);
};
const keysOf = (items: unknown): ReadonlyArray<string> => (items as ReadonlyArray<Record<string, unknown>>).map(m => m.MediaKey as string);
const search = async (expression: string, options: Record<string, unknown> = {}): Promise<ReadonlyArray<string>> =>
  keysOf((await sqlite().queryCollection(mediaCtx, { $search: expression, ...options })).value);

describe('searchableFields', () => {
  it('is every Edm.String field except the key, collections, expansions and lookups in either mode', () => {
    expect(
      searchableFields(
        [
          ...mediaFields,
          field('Media', 'Keywords', 'Edm.String', { isCollection: true }),
          field('Media', 'Property', 'Property', { isExpansion: true })
        ],
        'MediaKey'
      )
    ).toEqual(['ResourceRecordKey', 'ShortDescription', 'LongDescription']);
  });
});

describe('SQLite – $search on real queries', () => {
  it('matches a word in any plain text field, ignoring case, but not in a lookup or the key', async () => {
    expect(await search('ROADMAP')).toEqual(['F1-2', 'M3']);
    expect(await search('M1')).toEqual([]);
  });

  it('matches a phrase as written, and two words wherever each appears', async () => {
    expect(await search('"business case"')).toEqual(['M1']);
    expect(await search('business roadmap')).toEqual(['M3']);
    expect(await search('case template')).toEqual(['M1']);
  });

  it('reads OR, NOT and grouping, and a null field contains nothing, so NOT keeps it', async () => {
    expect(await search('roadmap OR dictionary')).toEqual(['F1-2', 'M2', 'M3']);
    expect(await search('business NOT roadmap')).toEqual(['M1']);
    expect(await search('NOT (business OR lobby)')).toEqual(['M2', 'M4', 'M5']);
  });

  it('matches %, _ and \\ as themselves, not as wildcards', async () => {
    expect(await search('%')).toEqual(['M4']);
    expect(await search('s_r')).toEqual([]);
    expect(await search('Uptime_Report')).toEqual(['M4']);
    expect(await search('C:\\reports')).toEqual(['M4']);
  });

  it('requires $filter and $search both, even when the filter has a top-level or, and counts what matches both', async () => {
    const { value, count } = await sqlite().queryCollection(mediaCtx, {
      $filter: 'Order eq 1 or Order eq 3',
      $search: 'business',
      $count: true
    });
    expect([keysOf(value), count]).toEqual([['M1', 'M3'], 2]);
    expect(await search('roadmap', { $filter: 'Order eq 1 or Order eq 3' })).toEqual(['M3']);
  });

  it("reads the type-ahead form as one phrase, and '' as nothing typed yet, which matches every record", async () => {
    expect(await search("'busin'")).toEqual(['M1', 'M3']);
    expect(await search("''")).toEqual(['F1-1', 'F1-2', 'M1', 'M2', 'M3', 'M4', 'M5']);
  });

  it('matches nothing on a resource with no field to search, and NOT then matches everything', async () => {
    const bare: ResourceContext = { ...mediaCtx, fields: [mediaFields[0], mediaFields[6]] };
    const dal = sqlite();
    expect(keysOf((await dal.queryCollection(bare, { $search: 'roadmap' })).value)).toEqual([]);
    expect(keysOf((await dal.queryCollection(bare, { $search: 'NOT roadmap' })).value)).toHaveLength(7);
  });

  it('narrows the children inside $expand, with a parent filter and a nested one, in the order the SQL uses them', async () => {
    const { value } = await sqlite().queryCollection(orgCtx, { $expand: parseExpand('Media($search=business)') });
    expect(value.map(org => [org.OrganizationKey, keysOf(org.Media)])).toEqual([
      ['O1', ['M1', 'M3']],
      ['O2', []]
    ]);
    const narrowed = await sqlite().queryCollection(orgCtx, {
      $filter: "OrganizationKey eq 'O1'",
      $top: 5,
      $expand: parseExpand('Media($filter=Order gt 1;$search=business;$count=true)')
    });
    expect(narrowed.value.map(org => [org.OrganizationKey, keysOf(org.Media), org['Media@odata.count']])).toEqual([['O1', ['M3'], 1]]);
  });

  it('narrows a nested expansion’s children, fetched by key', async () => {
    const { value } = await sqlite().queryCollection(orgCtx, {
      $filter: "OrganizationKey eq 'O1'",
      $expand: parseExpand('Offices($expand=Media($search=roadmap))')
    });
    const [office] = value[0].Offices as ReadonlyArray<Record<string, unknown>>;
    expect(keysOf(office.Media)).toEqual(['F1-2']);
  });

  it('refuses a malformed expression and a search on a single-valued expansion as client errors', async () => {
    const malformed = await sqlite()
      .queryCollection(mediaCtx, { $search: '(roadmap' })
      .catch((err: unknown) => err);
    expect(isSearchParseError(malformed)).toBe(true);
    const nested = await sqlite()
      .queryCollection(orgCtx, { $expand: parseExpand('Media($search="business)') })
      .catch((err: unknown) => err);
    expect(isSearchParseError(nested)).toBe(true);
    const singleValued = await sqlite()
      .queryCollection(officeCtx, { $expand: parseExpand('Organization($search=one)') })
      .catch((err: unknown) => err);
    expect(isExpandOptionError(singleValued)).toBe(true);
  });
});

describe('PostgreSQL – $search in the query it builds', () => {
  const capture = (rowsFor: (call: number) => ReadonlyArray<Record<string, unknown>> = () => []) => {
    const calls: { sql: string; values: unknown[] }[] = [];
    const pool = {
      query: async (sql: string, values: unknown[] = []) => {
        calls.push({ sql, values });
        return { rows: rowsFor(calls.length) };
      }
    } as unknown as pg.Pool;
    return { dal: createPostgresDal(pool), calls };
  };
  const term = (alias: string, n: number): string =>
    ['ResourceRecordKey', 'ShortDescription', 'LongDescription']
      .map(name => `COALESCE(${alias}."${name}", '') ILIKE $${n} ESCAPE '\\'`)
      .join(' OR ');

  it('parenthesizes the filter and the search, and numbers one parameter per term after the filter’s', async () => {
    const { dal, calls } = capture();
    await dal.queryCollection(mediaCtx, { $filter: 'Order eq 1 or Order eq 3', $search: 'roadmap OR dictionary', $top: 5 });
    const { sql, values } = calls[0];
    expect(sql).toContain('WHERE (');
    expect(sql).toContain(`) AND (((${term('p', 3)}) OR (${term('p', 4)})))`);
    expect(values).toEqual([1, 3, '%roadmap%', '%dictionary%', 5]);
  });

  it('puts a nested search on the join, numbered after the page’s parameters and the nested filter’s', async () => {
    const { dal, calls } = capture();
    await dal.queryCollection(orgCtx, {
      $filter: "OrganizationKey eq 'O1'",
      $top: 5,
      $expand: parseExpand('Media($filter=Order gt 1;$search=business)')
    });
    const { sql, values } = calls[0];
    expect(sql).toContain(`AND ((nav_Media."Order" > $3) AND ((${term('nav_Media', 4)})))`);
    expect(values).toEqual(['O1', 5, 1, '%business%']);
  });

  it('appends a nested search to a nested expansion’s fetch by key, numbered after the keys', async () => {
    const { dal, calls } = capture(call =>
      call === 1
        ? [
            {
              'p.OrganizationKey': 'O1',
              'p.OrganizationName': 'Standards',
              'nav_Offices.OfficeKey': 'F1',
              'nav_Offices.OrganizationKey': 'O1'
            }
          ]
        : []
    );
    await dal.queryCollection(orgCtx, { $expand: parseExpand('Offices($expand=Media($search=roadmap))') });
    const nested = calls.find(call => call.sql.includes('FROM "Media"') && call.sql.includes('ANY('));
    expect(nested?.sql).toContain(`= ANY($2) AND ((${term('"Media"', 3)}))`);
    expect(nested?.values).toEqual(['Office', ['F1'], '%roadmap%']);
  });
});

describe('MongoDB – $search in the query it builds', () => {
  const capture = () => {
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
    return { dal: createMongoDal(db), finds };
  };
  const term = (pattern: string) => ({
    $or: ['ResourceRecordKey', 'ShortDescription', 'LongDescription'].map(name => ({ [name]: { $regex: pattern, $options: 'i' } }))
  });

  it('ANDs the search with the filter, escapes the pattern and reads NOT as $nor', async () => {
    const { dal, finds } = capture();
    await dal.queryCollection(mediaCtx, { $filter: "ChecksumType eq 'sha256'", $search: 'v2.1 NOT "100%"' });
    expect(finds[0].query).toEqual({ $and: [{ ChecksumType: 'sha256' }, { $and: [term('v2\\.1'), { $nor: [term('100%')] }] }] });
  });

  it('combines a nested search with the key match', async () => {
    const { dal, finds } = capture();
    await dal.queryCollection(orgCtx, { $expand: parseExpand('Media($search=roadmap)') });
    const lookup = finds.find(find => find.collection === 'Media');
    expect(lookup?.query).toEqual({ $and: [{ ResourceName: 'Organization', ResourceRecordKey: { $in: ['O1'] } }, term('roadmap')] });
  });
});
