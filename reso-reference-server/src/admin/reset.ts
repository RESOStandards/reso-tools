import type { RequestHandler } from 'express';
import type { DataAccessLayer } from '../db/data-access.js';
import { buildResourceContext } from '../metadata/resource-context.js';
import type { ResoMetadata } from '../metadata/types.js';
import { TARGET_RESOURCES } from '../metadata/types.js';

/**
 * Creates a DELETE handler for resetting (truncating) all data.
 * Preserves schema — only removes records from entity tables. Generator-free.
 */
export const createDataResetHandler =
  (metadata: ResoMetadata, dal: DataAccessLayer, readOnlyResources: ReadonlySet<string> = new Set()): RequestHandler =>
  async (_req, res) => {
    if (!dal.truncateResource) {
      res.status(501).json({
        error: { code: '50100', message: 'Reset is not supported for this database backend', details: [] }
      });
      return;
    }

    try {
      const results: Array<{ resource: string; deleted: number }> = [];

      // Delete in reverse dependency order (children first)
      const childResources = TARGET_RESOURCES.filter(r =>
        ['Media', 'OpenHouse', 'Showing', 'PropertyRooms', 'PropertyGreenVerification',
         'PropertyPowerProduction', 'PropertyUnitTypes', 'TeamMembers'].includes(r)
      ).filter(r => !readOnlyResources.has(r));
      const parentResources = TARGET_RESOURCES.filter(r =>
        !childResources.includes(r) && r !== 'Lookup'
      ).filter(r => !readOnlyResources.has(r));

      for (const resource of [...childResources, ...parentResources]) {
        const ctx = buildResourceContext(metadata, resource);
        if (!ctx) continue;
        const deleted = await dal.truncateResource(ctx);
        if (deleted > 0) results.push({ resource, deleted });
      }

      res.json({
        message: 'All data has been reset',
        results,
        totalDeleted: results.reduce((s, r) => s + r.deleted, 0)
      });
    } catch (err) {
      res.status(500).json({
        error: {
          code: '50000',
          message: err instanceof Error ? err.message : 'Internal server error',
          details: []
        }
      });
    }
  };
