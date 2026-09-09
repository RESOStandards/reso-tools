import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { loadMetadata, getFieldsForResource, getKeyFieldForResource } from '../src/metadata/loader.js';
import { TARGET_RESOURCES } from '../src/metadata/types.js';
import { generateSqliteSchema } from '../src/db/sqlite-schema-generator.js';
import { createSqliteDal } from '../src/db/sqlite-dal.js';
import { applySeedData } from '../src/seed-data.js';
import { reconcileLookups } from '../src/metadata/lookup-reconciler.js';
import type { DataAccessLayer, ResourceContext, CollectionQueryOptions, CollectionResult } from '../src/db/data-access.js';

const metadataPath = resolve(import.meta.dirname, '../server-metadata.json');

// The "City fix": City is an OPEN enum with no seeded Lookup rows, but the committed Property seed carries
// real City values. reconcileLookups — wired into applySeedData (it was orphaned once by the static-seed
// split) — backfills those values into /Lookup so the reference server passes cert from its own seed
// (RCP-039: every served enum value must be advertised in the Lookup Resource). This suite locks both the
// WIRING and the backfill mechanism so neither can silently regress.

describe('applySeedData reconciles lookups (City fix regression guard)', () => {
  it('backfills served open-lookup values into the Lookup Resource end-to-end', async () => {
    const metadata = await loadMetadata(metadataPath);
    const db = new Database(':memory:'); // bare handle: FKs off by default, so seed insert order is irrelevant
    const resourceSpecs = [...TARGET_RESOURCES, 'Lookup']
      .map((resource) => ({ resourceName: resource, keyField: getKeyFieldForResource(resource), fields: getFieldsForResource(metadata, resource) }))
      .filter((spec) => spec.fields.length > 0);
    for (const statement of generateSqliteSchema(resourceSpecs)) db.exec(statement);
    const dal = createSqliteDal(db);

    await applySeedData(dal, metadata);

    // Expected City set = distinct City values in the committed seed (computed, not hardcoded, so it stays
    // green if the seed evolves — but goes from 39 to 0 and FAILS if reconcileLookups is ever un-wired).
    const seed = JSON.parse(
      gunzipSync(readFileSync(resolve(import.meta.dirname, '../seed-data/seed.json.gz'))).toString(),
    ) as { readonly Property?: ReadonlyArray<Record<string, unknown>> };
    const expectedCities = new Set((seed.Property ?? []).map((p) => p.City).filter(Boolean));

    const ctx: ResourceContext = { resource: 'Lookup', keyField: 'LookupKey', fields: getFieldsForResource(metadata, 'Lookup'), navigationBindings: [] };
    const result = await dal.queryCollection(ctx, { $filter: "LookupName eq 'City'", $top: 10000 });
    const served = new Set(result.value.map((r) => r.LookupValue));

    expect(expectedCities.size).toBeGreaterThan(0);
    expect(served).toEqual(expectedCities);
    expect([...served]).toContain('Cleveland');
    expect(result.value.every((r) => r.LookupName === 'City' && typeof r.LookupKey === 'string' && r.LookupKey.length > 0)).toBe(true);
  });
});

describe('reconcileLookups (open-enum backfill mechanism)', () => {
  const fakeDal = (): { readonly dal: DataAccessLayer; readonly store: Array<Record<string, unknown>> } => {
    const store: Array<Record<string, unknown>> = [];
    const dal = {
      insert: async (_ctx: ResourceContext, record: Readonly<Record<string, unknown>>) => {
        store.push({ ...record });
        return record;
      },
      queryCollection: async (_ctx: ResourceContext, options?: CollectionQueryOptions): Promise<CollectionResult> => {
        const name = /LookupName eq '([^']+)'/.exec(options?.$filter ?? '')?.[1];
        return { value: store.filter((r) => r.LookupName === name) };
      },
    } as unknown as DataAccessLayer; // partial mock — reconcileLookups only calls insert + queryCollection
    return { dal, store };
  };

  it('inserts scalar and collection open-enum values in one pass', async () => {
    const metadata = await loadMetadata(metadataPath);
    const { dal, store } = fakeDal();
    // City is a scalar open-enum; BuildingFeatures is a Collection open-enum (exercises the array path).
    const inserted = await reconcileLookups(dal, metadata, 'Property', [{ City: 'Cleveland', BuildingFeatures: ['Fireplace', 'Deck'] }]);
    expect(store.some((r) => r.LookupName === 'City' && r.LookupValue === 'Cleveland')).toBe(true);
    expect(store.filter((r) => r.LookupName === 'BuildingFeatures').map((r) => r.LookupValue).sort()).toEqual(['Deck', 'Fireplace']);
    expect(inserted).toBe(3);
  });

  it('is idempotent — skips values already present in the Lookup Resource', async () => {
    const metadata = await loadMetadata(metadataPath);
    const { dal, store } = fakeDal();
    store.push({ LookupName: 'City', LookupValue: 'Cleveland' });
    const inserted = await reconcileLookups(dal, metadata, 'Property', [{ City: 'Cleveland' }, { City: 'Hartford' }]);
    expect(inserted).toBe(1);
    expect(store.filter((r) => r.LookupName === 'City').map((r) => r.LookupValue).sort()).toEqual(['Cleveland', 'Hartford']);
  });
});
