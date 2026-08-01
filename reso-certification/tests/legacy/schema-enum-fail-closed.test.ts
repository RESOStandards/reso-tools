import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { generateJsonSchema, validate, combineErrors } = require(
  resolve(import.meta.dirname, '../../src/legacy/lib/schema/index.js')
);

// Coverage for the schema-generator enum rules established alongside the isLookupField / fail-closed
// change in src/legacy/lib/schema/generate.js. The canonical narrative lives in the registry's
// references/enumerations.md ("Validating a value: everything served must be advertised").
//
// The rule: every value a payload carries must be ADVERTISED in the metadata. A lookup field that
// advertises ZERO values fails closed — any present real value is rejected, while an absent/null value
// still passes (null is governed by `type`, not the enum). ComplexTypes are NOT enumerations and are
// never fail-closed. A scale-0 numeric is an integer and rejects fractional values.

const KEY = { resourceName: 'Property', fieldName: 'ListingKey', type: 'Edm.String', nullable: false };
const enumField = (fieldName: string, opts: { nullable?: boolean; isCollection?: boolean } = {}) => ({
  resourceName: 'Property',
  fieldName,
  type: fieldName, // post-merge string-rep: type is the LookupName it joins on
  isEnumeration: true,
  nullable: opts.nullable ?? true,
  isCollection: opts.isCollection ?? false,
  annotations: [{ term: 'RESO.OData.Metadata.LookupName', value: fieldName }]
});

const report = (fields: unknown[], lookups: unknown[] = []) => ({
  description: 'fail-closed fixture',
  version: '2.0',
  generatedOn: '2026-07-31T00:00:00Z',
  resources: [],
  fields,
  lookups,
  actions: [],
  functions: []
});

const errorsFor = async (fields: unknown[], record: Record<string, unknown>, lookups: unknown[] = []) => {
  const jsonSchema = await generateJsonSchema({ metadataReportJson: report(fields, lookups), additionalProperties: false });
  const errorMap = validate({ jsonSchema, jsonPayload: { value: [record] }, resourceName: 'Property', version: '2.0', errorMap: {} });
  return combineErrors(errorMap).totalErrors as number;
};

const defOf = async (fields: unknown[], fieldName: string, lookups: unknown[] = []) => {
  const jsonSchema = await generateJsonSchema({ metadataReportJson: report(fields, lookups), additionalProperties: false });
  return jsonSchema?.definitions?.Property?.properties?.[fieldName];
};

describe('schema fail-closed — declared enumeration advertising zero values', () => {
  describe('single, nullable', () => {
    const fields = [KEY, enumField('StandardStatus')];
    it('attaches an empty enum ([null]) instead of an unconstrained string', async () => {
      expect(await defOf(fields, 'StandardStatus')).toEqual({ type: ['string', 'null'], enum: [null] });
    });
    it('rejects a present real value', async () => {
      expect(await errorsFor(fields, { ListingKey: '1', StandardStatus: 'Active' })).toBe(1);
    });
    it('rejects the literal string "null" (a real value)', async () => {
      expect(await errorsFor(fields, { ListingKey: '1', StandardStatus: 'null' })).toBe(1);
    });
    it('passes JS null (governed by type, not the enum)', async () => {
      expect(await errorsFor(fields, { ListingKey: '1', StandardStatus: null })).toBe(0);
    });
    it('passes an absent field (population-gated)', async () => {
      expect(await errorsFor(fields, { ListingKey: '1' })).toBe(0);
    });
  });

  describe('single, non-nullable', () => {
    const fields = [KEY, enumField('LeaseTermType', { nullable: false })];
    it('rejects a present null on a non-nullable field (fails on type)', async () => {
      expect(await errorsFor(fields, { ListingKey: '1', LeaseTermType: null })).toBe(1);
    });
    it('rejects a present real value', async () => {
      expect(await errorsFor(fields, { ListingKey: '1', LeaseTermType: 'Active' })).toBe(1);
    });
  });

  describe('collection', () => {
    const fields = [KEY, enumField('AssociationAmenities', { isCollection: true, nullable: false })];
    it('rejects a populated array', async () => {
      expect(await errorsFor(fields, { ListingKey: '1', AssociationAmenities: ['Active'] })).toBe(1);
    });
    it('passes an empty array', async () => {
      expect(await errorsFor(fields, { ListingKey: '1', AssociationAmenities: [] })).toBe(0);
    });
    it('rejects a present null (OData collections are not nullable)', async () => {
      expect(await errorsFor(fields, { ListingKey: '1', AssociationAmenities: null })).toBe(1);
    });
  });

  describe('advertised values (control)', () => {
    const fields = [KEY, enumField('StandardStatus')];
    const lookups = [{ lookupName: 'StandardStatus', lookupValue: 'Active', type: 'Edm.String' }];
    it('passes an advertised value and rejects an un-advertised one', async () => {
      expect(await errorsFor(fields, { ListingKey: '1', StandardStatus: 'Active' }, lookups)).toBe(0);
      expect(await errorsFor(fields, { ListingKey: '1', StandardStatus: 'Pending' }, lookups)).toBe(1);
    });
  });
});

describe('ComplexTypes are not enumerations — never fail-closed', () => {
  // A nominal (non-Edm) type with no advertised values, no LookupName annotation, no isEnumeration.
  const complex = { resourceName: 'Property', fieldName: 'SomeComplex', type: 'org.reso.metadata.SomeComplexType', isCollection: false, nullable: true };
  const fields = [KEY, complex];
  it('is typed as an object with no enum', async () => {
    const def = await defOf(fields, 'SomeComplex');
    expect(def?.enum).toBeUndefined();
    expect(def?.type).toContain('object');
  });
  it('passes an object value', async () => {
    expect(await errorsFor(fields, { ListingKey: '1', SomeComplex: { foo: 'bar' } })).toBe(0);
  });
});

describe('scale-0 numerics are integers', () => {
  const scaleZero = { resourceName: 'Property', fieldName: 'ImageHeight', type: 'Edm.Decimal', nullable: true, precision: 8, scale: 0 };
  const fields = [KEY, scaleZero];
  it('types a scale-0 Edm.Decimal as JSON integer', async () => {
    const def = await defOf(fields, 'ImageHeight');
    expect(def?.type).toContain('integer');
    expect(def?.type).not.toContain('number');
  });
  it('rejects a fractional value on a whole-number field', async () => {
    expect(await errorsFor(fields, { ListingKey: '1', ImageHeight: 3.5 })).toBe(1);
  });
  it('accepts a whole-number value', async () => {
    expect(await errorsFor(fields, { ListingKey: '1', ImageHeight: 300 })).toBe(0);
  });
});
