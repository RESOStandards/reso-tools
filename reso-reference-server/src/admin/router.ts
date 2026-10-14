import { Router } from 'express';
import type { AuthTokenConfig } from '../auth/config.js';
import { requireAuth } from '../auth/middleware.js';
import type { DataAccessLayer } from '../db/data-access.js';
import type { ResoMetadata } from '../metadata/types.js';
import { createDataResetHandler } from './reset.js';
import { createSeedHandler } from './seed.js';

/**
 * Creates an Express router for admin endpoints.
 * All routes require the "admin" auth role.
 *
 * Data generation was replaced by a committed static seed (see `src/seed-data.ts` +
 * `seed-data/`): POST /admin/seed loads it via the DAL; DELETE resets all data.
 */
export const createAdminRouter = (
  metadata: ResoMetadata,
  dal: DataAccessLayer,
  authConfig: AuthTokenConfig,
  readOnlyResources: ReadonlySet<string> = new Set()
): Router => {
  const router = Router();
  const adminAuth = requireAuth('admin', authConfig);

  router.post('/admin/seed', adminAuth, createSeedHandler(metadata, dal));
  router.delete('/admin/data-generator/reset', adminAuth, createDataResetHandler(metadata, dal, readOnlyResources));

  return router;
};
