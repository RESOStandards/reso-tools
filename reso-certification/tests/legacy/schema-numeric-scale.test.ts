/**
 * When a numeric field is an integer, and when it only looks like one.
 *
 * A field whose scale is zero has no fractional digits, so typing it as JSON `integer` is right:
 * that is the rule the seed-conformance fixture was built around, where scale-0 `Edm.Decimal`
 * fields carried fractional values.
 *
 * The rule was applied far too widely. It ran for every type mapping to `number` — `Edm.Decimal`,
 * `Edm.Single` and `Edm.Double` — and its guard, `!field.scale`, is true for an ABSENT scale as
 * well as for zero. `Scale` is a Decimal facet; on an `Edm.Double` it has no meaning at all, and
 * `Precision` there denotes significant floating-point digits.
 *
 * Both RESO specs permit exactly what that rejected. Core and the Data Dictionary agree that
 * Number is "Edm.Decimal OR Edm.Double for decimal values", and the DD adds that decimals "MAY
 * contain Precision and Scale attributes ... which also MAY be omitted".
 *
 * Found on a live run against conformant metadata carrying 71 `Edm.Double` properties, no
 * `Edm.Decimal` and no `Scale` anywhere. Every one was typed `integer`, and three $expand
 * scenarios failed with "MUST be integer or null but found decimal" on fields including Latitude,
 * Longitude and LotSizeAcres. A latitude is not an integer. The verdict was ours, not the
 * provider's, and a wrong FAIL is told to a provider.
 */

import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { generateJsonSchema } = require(resolve(import.meta.dirname, '../../src/legacy/lib/schema/index.js'));

/** One Property field, as a metadata report records it. `scale` is omitted when the XML has no
 *  `Scale` attribute — the serializer drops the key rather than defaulting it. */
const report = (field: Record<string, unknown>) => ({
  fields: [{ resourceName: 'Property', nullable: true, annotations: [], ...field }],
  lookups: []
});

const propertyType = async (field: Record<string, unknown>): Promise<unknown> => {
  const schema = await generateJsonSchema({ metadataReportJson: report(field) });
  const props = schema.definitions.Property.properties as Record<string, { type?: unknown }>;
  return props[field.fieldName as string].type;
};

const allows = (type: unknown, json: string): boolean => (Array.isArray(type) ? type : [type]).includes(json);

describe('numeric typing from precision and scale', () => {
  it('leaves an Edm.Double with precision and no scale as a number', () => {
    // The live failure. Scale is not a Double facet, and the DD says it may be omitted, so its
    // absence cannot be read as an assertion that the value is whole.
    return propertyType({ fieldName: 'Latitude', type: 'Edm.Double', precision: 12 }).then(t => {
      expect(allows(t, 'number')).toBe(true);
      expect(allows(t, 'integer')).toBe(false);
    });
  });

  it('leaves an Edm.Decimal with precision and no scale as a number', () => {
    // The DD permits omitting Scale. An omission is not a statement, so it cannot make a field
    // integer-only — which would fail a provider for declaring exactly what the spec allows.
    return propertyType({ fieldName: 'AssociationFee', type: 'Edm.Decimal', precision: 13 }).then(t => {
      expect(allows(t, 'number')).toBe(true);
      expect(allows(t, 'integer')).toBe(false);
    });
  });

  it('types an Edm.Decimal with an explicit scale of 0 as an integer', () => {
    // The case the rule exists for, preserved. Scale 0 means no fractional digits.
    return propertyType({ fieldName: 'RoomsTotal', type: 'Edm.Decimal', precision: 4, scale: 0 }).then(t => {
      expect(allows(t, 'integer')).toBe(true);
      expect(allows(t, 'number')).toBe(false);
    });
  });

  it('leaves an Edm.Decimal with a non-zero scale as a number', () => {
    return propertyType({ fieldName: 'ListPrice', type: 'Edm.Decimal', precision: 13, scale: 2 }).then(t => {
      expect(allows(t, 'number')).toBe(true);
      expect(allows(t, 'integer')).toBe(false);
    });
  });

  it('does not make an Edm.Double integer even when its scale is explicitly 0', () => {
    // Scale has no meaning on a Double. If one appears, it is noise in the metadata rather than a
    // statement about the value, and reading it would reintroduce the same false failure.
    return propertyType({ fieldName: 'LotSizeAcres', type: 'Edm.Double', precision: 16, scale: 0 }).then(t => {
      expect(allows(t, 'number')).toBe(true);
      expect(allows(t, 'integer')).toBe(false);
    });
  });

  it('still bounds an integer field by its precision', () => {
    return generateJsonSchema({
      metadataReportJson: report({ fieldName: 'RoomsTotal', type: 'Edm.Decimal', precision: 4, scale: 0 })
    }).then((schema: Record<string, never>) => {
      const props = (schema as never as { definitions: { Property: { properties: Record<string, { maximum?: number }> } } }).definitions
        .Property.properties;
      expect(props.RoomsTotal.maximum).toBe(9999);
    });
  });
});
