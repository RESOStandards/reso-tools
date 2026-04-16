import { Router } from 'express';
import type { AuthTokenConfig } from '../auth/config.js';
import { requireAuth } from '../auth/middleware.js';
import type { EnumMode } from '../config.js';
import type { DataAccessLayer } from '../db/data-access.js';
import type { ResoMetadata } from '../metadata/types.js';
import { createDataGeneratorHandler, createDataGeneratorStatusHandler, createDataResetHandler } from './data-generator.js';

/**
 * Creates an Express router for admin endpoints.
 * All routes require the "admin" auth role.
 */
export const createAdminRouter = (
  metadata: ResoMetadata,
  dal: DataAccessLayer,
  authConfig: AuthTokenConfig,
  enumMode: EnumMode,
  readOnlyResources: ReadonlySet<string> = new Set()
): Router => {
  const router = Router();
  const adminAuth = requireAuth('admin', authConfig);

  // Data generator endpoints
  router.post('/admin/data-generator', adminAuth, createDataGeneratorHandler(metadata, dal, enumMode));
  router.get('/admin/data-generator/status', adminAuth, createDataGeneratorStatusHandler(metadata, dal));
  router.delete('/admin/data-generator/reset', adminAuth, createDataResetHandler(metadata, dal, readOnlyResources));

  return router;
};
