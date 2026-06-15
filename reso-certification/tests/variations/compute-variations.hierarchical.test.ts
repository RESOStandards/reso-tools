/**
 * Golden-master coverage — hierarchical ignore suppression (CMP-7).
 *
 * A resource- or field-level ignore suppresses EVERYTHING beneath it:
 *   - resource ignore  → whole resource skipped (no resource OR child-field variations)
 *   - field ignore     → field skipped (no field OR child-lookup variations)
 *
 * Verified structurally in src/legacy/lib/variations/index.js: the nested
 * processing sits inside `!ignoreResourceMapping` / `!ignoreFieldMapping`.
 *
 * Oracle: legacy `computeVariations` (the frozen PoC). These pin the behavior
 * the future `/compute` must reproduce. Each case is a baseline (the variation
 * DOES surface without an ignore) paired with the ignore (it's suppressed) so
 * the test proves the ignore is the cause, not that the variation never fires.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

// Legacy CJS — use require
const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const legacyRoot = resolve(import.meta.dirname, '../../src/legacy');
const { computeVariations } = require(resolve(legacyRoot, 'lib/variations/index.js'));

const FUZZINESS = 0.25;
const DD_1_7 = '1.7';

const run = (metadataReportJson: unknown, suggestionsMap?: unknown) =>
  computeVariations({ metadataReportJson, fuzziness: FUZZINESS, version: DD_1_7, suggestionsMap });

// Lowercase resource name → resource-level machine variation (substring/exact-normalized).
const LOWERCASE_RESOURCE = { fields: [{ resourceName: 'property', fieldName: 'ListPrice' }] };
// Standard resource + noisy field → field-level machine variation.
const NOISY_FIELD = { fields: [{ resourceName: 'Property', fieldName: 'list_price' }] };

describe('computeVariations: hierarchical ignore suppression (CMP-7)', () => {
  it('baseline — lowercase resource name flags a resource variation', async () => {
    const { variations } = await run(LOWERCASE_RESOURCE);
    expect(variations.resources.length).toBeGreaterThan(0);
  });

  it('resource ignore suppresses the resource variation', async () => {
    const { variations } = await run(LOWERCASE_RESOURCE, { property: { ignored: true } });
    expect(variations.resources).toEqual([]);
  });

  it('baseline — standard resource + noisy field flags a field variation', async () => {
    const { variations } = await run(NOISY_FIELD);
    expect(variations.fields.length).toBeGreaterThan(0);
  });

  it('resource ignore suppresses CHILD field variations (hierarchical, downward)', async () => {
    const { variations } = await run(NOISY_FIELD, { Property: { ignored: true } });
    expect(variations.fields).toEqual([]);
  });

  it('field ignore suppresses the field variation', async () => {
    const { variations } = await run(NOISY_FIELD, { Property: { list_price: { ignored: true } } });
    expect(variations.fields).toEqual([]);
  });
});
