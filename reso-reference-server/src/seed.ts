import { createApp, loadConfig } from './index.js';
import { loadMetadata } from './metadata/loader.js';
import { applySeedData, type SeedResult } from './seed-data.js';

/**
 * Standalone seed CLI (`npm run seed` / `node dist/seed.js`). Builds a DAL for the
 * configured backend and applies the committed static seed. Used for local dev and
 * the desktop client; docker and compliance seed the running server via POST
 * /admin/seed instead (same `applySeedData` core).
 */
export const loadSeedData = async (): Promise<SeedResult> => {
  const config = loadConfig();
  const metadata = await loadMetadata(config.metadataPath);

  // createApp initializes the schema, DAL, and Lookup seeding for the configured backend.
  const { dal, cleanup } = await createApp({ config });
  try {
    const result = await applySeedData(dal, metadata);
    console.log(result.skipped
      ? 'Seed skipped: database already contains data.'
      : `Seed complete: ${result.loaded} records loaded.`);
    return result;
  } finally {
    cleanup();
  }
};

// CLI entry point — only runs when executed directly (not when imported).
const isDirectExecution = process.argv[1]?.endsWith('/dist/seed.js') === true;
if (isDirectExecution) {
  loadSeedData()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Seed failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
