import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { mergeWithLookupResource } from '../../src/metadata/lookup-resource.js';

const require = createRequire(import.meta.url);
const { generateJsonSchema, validate, combineErrors } = require(
  resolve(import.meta.dirname, '../../src/legacy/lib/schema/index.js')
);

// End-to-end coverage for a dependency the adversarial pass surfaced: the fail-closed / advertised-membership
// guarantee relies on the /Lookup MERGE having rewritten a STRING-representation enum field's type from
// Edm.String to its LookupName (transformFieldWithLookup). A field left as Edm.String never reaches the
// isLookupField branch, so it would get no enum and a dangling/unadvertised value would slip through.
// schema-enum-fail-closed.test.ts hardcodes the post-merge shape (type = the LookupName); THIS test drives
// the real mergeWithLookupResource so a regression that stops rewriting the type is caught, not masked.

type MergeReport = Parameters<typeof mergeWithLookupResource>[0];
type RawLookup = Parameters<typeof mergeWithLookupResource>[1][number];

const LOOKUP_NAME = 'RESO.OData.Metadata.LookupName';

// StandardStatus served in the STRING representation, PRE-merge: Edm.String carrying a LookupName annotation.
const baseReport = (): MergeReport =>
  ({
    description: 'merge-e2e',
    version: '2.0',
    generatedOn: '2026-07-31T00:00:00Z',
    resources: [],
    actions: [],
    functions: [],
    fields: [
      { resourceName: 'Property', fieldName: 'ListingKey', type: 'Edm.String', nullable: false, annotations: [] },
      {
        resourceName: 'Property',
        fieldName: 'StandardStatus',
        type: 'Edm.String',
        isEnumeration: true,
        nullable: true,
        annotations: [{ term: LOOKUP_NAME, value: 'StandardStatus' }]
      }
    ],
    lookups: []
  }) as unknown as MergeReport;

const raw = (values: ReadonlyArray<string>): RawLookup[] =>
  values.map(
    (v) =>
      ({ LookupKey: `k-${v}`, LookupName: 'StandardStatus', LookupValue: v, ModificationTimestamp: '2026-01-01T00:00:00Z' }) as unknown as RawLookup
  );

const errorsE2E = async (advertised: ReadonlyArray<string>, record: Record<string, unknown>): Promise<number> => {
  const merged = mergeWithLookupResource(baseReport(), raw(advertised));
  const schema = await generateJsonSchema({ metadataReportJson: merged, additionalProperties: false });
  const errorMap = validate({ jsonSchema: schema, jsonPayload: { value: [record] }, resourceName: 'Property', version: '2.0', errorMap: {} });
  return combineErrors(errorMap).totalErrors as number;
};

describe('schema fail-closed — through the REAL /Lookup merge (type-rewrite dependency)', () => {
  it('the merge rewrites a string-rep enum field type to its LookupName (the load-bearing rewrite)', () => {
    const merged = mergeWithLookupResource(baseReport(), raw([]));
    const ss = merged.fields.find((f) => f.fieldName === 'StandardStatus');
    // NOT 'Edm.String' — if this regresses, the field never reaches isLookupField and the hole reopens.
    expect(ss?.type).toBe('StandardStatus');
  });

  it('empty /Lookup + populated value → fail closed', async () => {
    expect(await errorsE2E([], { ListingKey: '1', StandardStatus: 'Active' })).toBe(1);
  });

  it('empty /Lookup + null → passes (nullable, governed by type)', async () => {
    expect(await errorsE2E([], { ListingKey: '1', StandardStatus: null })).toBe(0);
  });

  it('advertised /Lookup → advertised value passes, un-advertised fails', async () => {
    expect(await errorsE2E(['Active'], { ListingKey: '1', StandardStatus: 'Active' })).toBe(0);
    expect(await errorsE2E(['Active'], { ListingKey: '1', StandardStatus: 'Pending' })).toBe(1);
  });
});
