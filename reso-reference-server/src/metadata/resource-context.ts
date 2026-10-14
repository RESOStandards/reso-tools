import type { ResourceContext } from '../db/data-access.js';
import { getFieldsForResource, getKeyFieldForResource } from './loader.js';
import type { ResoMetadata } from './types.js';

/**
 * Builds a minimal ResourceContext for insert and truncate operations. Navigation
 * bindings are read/$expand-only, so they are empty here. Returns null when the
 * resource has no key field or no fields declared in the metadata.
 *
 * Shared by the seed loader and the admin reset handler; kept free of any
 * data-generation dependency so reso-reference-server can publish standalone.
 */
export const buildResourceContext = (metadata: ResoMetadata, resource: string): ResourceContext | null => {
  const keyField = getKeyFieldForResource(resource);
  if (!keyField) return null;

  const fields = getFieldsForResource(metadata, resource);
  if (fields.length === 0) return null;

  return {
    resource,
    keyField,
    fields,
    navigationBindings: []
  };
};
