/**
 * buildMetadataMap — the `isStringEnumeration` flag the type-aware Int* gate keys off.
 *
 * computeVariationsV2 drops an integer-backed enum's StandardName-derived lookupValue via
 * `applyIntEnumFix && !entry.isStringEnumeration`. That gate is only correct if buildMetadataMap
 * flags string-enum lookupValues `isStringEnumeration: true` and leaves Int* enum lookupValues
 * un-flagged. If a future buildMetadataMap change flagged an Int* enum's derived value as a string
 * enum, the gate would stop skipping it and the duplicate-false-negative path (the machine value
 * AND the derived display value both matched) would silently re-open. This regression pins the flag.
 *
 * Synthetic inputs — no vendor reports or identifiers.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const legacyRoot = resolve(import.meta.dirname, '../../src/legacy');
const { buildMetadataMap } = require(resolve(legacyRoot, 'common.js'));

const SN = 'RESO.OData.Metadata.StandardName';
const INT_ENUM = 'Cotality.DataStandard.RESO.DD.Enums.Multi.Appliances';
const STR_ENUM = 'Cotality.DataStandard.RESO.DD.Enums.String.Single.SomeEnum';

const lookupEntries = (type: string, enumName: string): Array<{ isStringEnumeration?: boolean }> => {
  const { metadataMap } = buildMetadataMap({
    fields: [{ resourceName: 'Property', fieldName: 'F', type: enumName, annotations: [] }],
    lookups: [{ lookupName: enumName, lookupValue: 'Activ', type, annotations: [{ term: SN, value: 'Active' }] }],
  });
  return Object.values(metadataMap.Property.F.lookupValues ?? {}) as Array<{ isStringEnumeration?: boolean }>;
};

describe('buildMetadataMap: isStringEnumeration flag gates the type-aware Int* fix', () => {
  it('Int* enum lookupValues are NOT flagged isStringEnumeration (the gate skips the derived value)', () => {
    const entries = lookupEntries('Edm.Int64', INT_ENUM);
    expect(entries.length).toBeGreaterThan(0); // the StandardName-derived "Active" entry exists
    for (const e of entries) {
      expect(e.isStringEnumeration).not.toBe(true);
    }
  });

  it('string enum lookupValues ARE flagged isStringEnumeration (the gate keeps the declared value)', () => {
    const entries = lookupEntries('Edm.String', STR_ENUM);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.isStringEnumeration).toBe(true);
    }
  });
});
