/**
 * A served value that is a prefix of MORE THAN ONE standard value must yield a suggestion for
 * EACH candidate, not an arbitrary one of them.
 *
 * Observed on a live DD 2.1 run: a provider served the bare lookup value `Modified` on a lease-type
 * field, and the report carried a single suggestion. `Modified` is a prefix of two DD standard
 * values, `Modified Gross` and `Modified Net`, so one suggestion looked like the matcher silently
 * keeping one of two equally-valid candidates. It is not: the single suggestion appears only because
 * that provider already served the other value, which is correctly excluded as already present.
 *
 * This pins the behavior with the minimum input that produces the case — one field, one lookup
 * element, neither candidate already served — so the two-candidate path cannot regress to one
 * unnoticed. Josh, 2026-10-05: "if we have Modified in the system, and they don't have ModifiedGross
 * or ModifiedNet in their metadata, then they'll get two suggestions, one for each."
 *
 * The field is deliberately one whose name DIFFERS from its lookup name: `AvailableLeaseType` is
 * served by the `ExistingLeaseType` enum, which 154 DD 2.1 enum fields do in some form. Matching
 * must key off the lookup, not the field name.
 */

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);
const legacyRoot = resolve(import.meta.dirname, '../../src/legacy');
const { computeVariations } = require(resolve(legacyRoot, 'lib/variations/index.js'));

/** The lookup backing Property.AvailableLeaseType — note it is NOT named after the field. */
const SHARED_ENUM = 'org.reso.metadata.enums.ExistingLeaseType';
const FUZZINESS = 0.25;
const DD_2_1 = '2.1';

const SN = 'RESO.OData.Metadata.StandardName';

/**
 * One field plus the given lookup elements. A served value is recognized as standard through its
 * StandardName annotation, which is how a real server declares that its machine-form value maps to
 * a DD display value — so a served entry is modeled as [servedValue, standardName].
 */
const reportServing = (...served: ReadonlyArray<readonly [string, string?]>) => ({
  fields: [{ resourceName: 'Property', fieldName: 'AvailableLeaseType', type: SHARED_ENUM }],
  lookups: served.map(([lookupValue, standardName]) => ({
    lookupName: SHARED_ENUM,
    type: 'Edm.String',
    lookupValue,
    ...(standardName ? { annotations: [{ term: SN, value: standardName }] } : {})
  }))
});

const run = (metadataReportJson: unknown) => computeVariations({ metadataReportJson, fuzziness: FUZZINESS, version: DD_2_1 });

describe('computeVariations: a prefix matching two standard values suggests both', () => {
  it('suggests Modified Gross AND Modified Net when neither is served', async () => {
    const {
      variations: { lookups = [] }
    } = await run(reportServing(['Modified', 'Modified']));

    expect(lookups).toHaveLength(1);
    const [variation] = lookups;
    expect(variation).toMatchObject({ resourceName: 'Property', fieldName: 'AvailableLeaseType', lookupValue: 'Modified' });

    // Both candidates, not one. A regression to a single suggestion is the defect this guards.
    expect(variation.suggestions).toHaveLength(2);
    expect(variation.suggestions.map((s: { suggestedLookupValue: string }) => s.suggestedLookupValue).sort()).toEqual([
      'Modified Gross',
      'Modified Net'
    ]);
    for (const suggestion of variation.suggestions) {
      expect(suggestion.strategy).toBe('Substring');
    }
  });

  /**
   * NOT TESTED HERE, deliberately. In a live DD 2.1 run a provider served BOTH `Modified` and
   * `ModifiedGross` (machine form, each carrying a StandardName annotation) and the report carried
   * only ONE suggestion, `ModifiedNet` — correct, because the other candidate is already present.
   * Minimal reproductions of that suppression from synthetic input did not reproduce it: supplying
   * the display form suppresses, supplying the machine form with a StandardName annotation does
   * not. So the suppression path depends on something the minimal fixture does not carry, and the
   * exact trigger is UNESTABLISHED. Left unasserted rather than pinned wrongly, since a test that
   * encodes a guess about this is worse than none. The live artifact is the evidence that
   * suppression works; what the minimum input for it is remains open.
   */
});
