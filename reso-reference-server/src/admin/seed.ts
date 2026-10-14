import type { RequestHandler } from 'express';
import type { DataAccessLayer } from '../db/data-access.js';
import type { ResoMetadata } from '../metadata/types.js';
import { applySeedData } from '../seed-data.js';

/**
 * Creates a POST handler that loads the committed static seed dataset via the DAL.
 * Idempotent — skips when the database already contains seed data. Replaces the
 * former data-generator endpoint; the server owns the DB connection, so there is no
 * concurrency with a separate seeding process.
 */
export const createSeedHandler =
  (metadata: ResoMetadata, dal: DataAccessLayer): RequestHandler =>
  async (_req, res) => {
    try {
      const result = await applySeedData(dal, metadata);
      res.json({
        message: result.skipped ? 'Database already seeded; nothing to do' : 'Seed data loaded',
        loaded: result.loaded,
        skipped: result.skipped
      });
    } catch (err) {
      res.status(500).json({
        error: { code: '50000', message: err instanceof Error ? err.message : 'Internal server error', details: [] }
      });
    }
  };
