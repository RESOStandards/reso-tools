/**
 * Parity: the reso-common `buildMetadataMap` (the #112 lift) must be byte-identical to the legacy
 * `src/legacy/common.js` one it was ported from — across every DD reference version. This is the
 * Stage-0 calibration: the matcher port (Stage 1) relies on the shared map matching the legacy shape
 * exactly. Retire the legacy copy once nothing in reso-tools imports it.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { buildMetadataMap as buildCommon } from '@reso-standards/reso-common';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const { buildMetadataMap: buildLegacy } = require(resolve(import.meta.dirname, '../../src/legacy/common.js'));
const { getReferenceMetadata } = require(resolve(import.meta.dirname, '../../src/etl/index.cjs'));

describe('buildMetadataMap parity — reso-common port === legacy', () => {
  it.each(['1.7', '2.0', '2.1'])('DD %s reference → identical metadataMap + stats', (version) => {
    const ref = getReferenceMetadata(version);
    const legacy = buildLegacy(ref);
    const common = buildCommon(ref);
    expect(common.metadataMap).toEqual(legacy.metadataMap);
    expect(common.stats).toEqual(legacy.stats);
  });
});
