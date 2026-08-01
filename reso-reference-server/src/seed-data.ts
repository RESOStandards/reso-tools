import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { DataAccessLayer } from './db/data-access.js';
import { reconcileLookups } from './metadata/lookup-reconciler.js';
import { buildResourceContext } from './metadata/resource-context.js';
import type { ResoMetadata } from './metadata/types.js';

/**
 * Static-seed core. Reads the committed dataset from `seed-data/seed.json.gz` and
 * inserts each record through the DAL, preserving the record's key so FK links stay
 * intact. The DAL abstracts pg/mongo/sqlite, so one dataset seeds every backend.
 * Generator-free: the dataset was produced once, offline, and committed gzipped.
 *
 * Load order below is FK-dependency order — independents, then Property, then the
 * Property children — so parents exist before children on backends that enforce it
 * (sqlite runs with foreign_keys = ON).
 */
const SEED_ORDER: ReadonlyArray<string> = [
  'OUID', 'Office', 'Member', 'Teams', 'TeamMembers',
  'Property',
  'Media', 'OpenHouse', 'Showing',
  'PropertyGreenVerification', 'PropertyPowerProduction', 'PropertyRooms', 'PropertyUnitTypes'
];

type SeedDataset = Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>;

/** Outcome of a seed operation. */
export interface SeedResult {
  /** Number of records inserted (0 when skipped). */
  readonly loaded: number;
  /** True when the database already contained seed data and nothing was inserted. */
  readonly skipped: boolean;
}

const readSeedDataset = async (): Promise<SeedDataset> => {
  const seedFile = resolve(dirname(fileURLToPath(import.meta.url)), '../seed-data/seed.json.gz');
  return JSON.parse(gunzipSync(await readFile(seedFile)).toString('utf-8')) as SeedDataset;
};

/**
 * Inserts the committed static seed via the provided DAL. Idempotent: if the primary
 * resource (Property) is already populated, it skips rather than duplicating.
 */
export const applySeedData = async (dal: DataAccessLayer, metadata: ResoMetadata): Promise<SeedResult> => {
  const propertyCtx = buildResourceContext(metadata, 'Property');
  if (propertyCtx) {
    const existing = await dal.queryCollection(propertyCtx, { $top: 1 });
    if (existing.value.length > 0) return { loaded: 0, skipped: true };
  }

  const seed = await readSeedDataset();
  let loaded = 0;
  for (const resource of SEED_ORDER) {
    const records = seed[resource];
    if (!records?.length) continue;

    const ctx = buildResourceContext(metadata, resource);
    if (!ctx) continue;

    for (const record of records) {
      await dal.insert(ctx, record);
    }

    // Reconcile the Lookup Resource with the values this resource actually uses. An OPEN lookup — e.g. City,
    // whose values are real city names, not a DD enumeration — has no rows from the metadata-driven
    // `seedLookups`, so a cert run that samples a City from the data can't find it in /Lookup and fails
    // (RCP-039). `reconcileLookups` inserts the missing values, so the reference server passes certification
    // from its own seed. (This reconciler was orphaned when the v1.0.0 split replaced the
    // generate-then-reconcile flow with static seeds; wiring it here restores the guarantee.)
    const reconciled = await reconcileLookups(dal, metadata, resource, records);
    console.log(`  ${resource}: ${records.length} records${reconciled ? `, +${reconciled} lookup value(s) reconciled` : ''}`);
    loaded += records.length;
  }
  return { loaded, skipped: false };
};
