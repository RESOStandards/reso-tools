import { describe, it, expect } from 'vitest';
import { resolveEnum } from '../src/index.js';
import type { CsdlSchema } from '@reso-standards/reso-metadata-utils';

const schema: CsdlSchema = {
  namespace: 'org.reso.metadata',
  entityTypes: [],
  complexTypes: [],
  actions: [],
  functions: [],
  enumTypes: [
    {
      name: 'StandardStatus',
      isFlags: false,
      members: [
        { name: 'Active', value: '0' },
        { name: 'Pending', value: '1' },
        { name: 'Closed', value: '2' },
      ],
    },
    {
      name: 'AccessibilityFeatures',
      isFlags: true,
      members: [
        { name: 'None', value: '0' },
        { name: 'A', value: '1' },
        { name: 'B', value: '2' },
        { name: 'C', value: '4' },
      ],
    },
  ],
};

const LOOKUP = { 'RESO.OData.Metadata.LookupName': 'StandardStatus' };

/** Non-null resolve helper — every fixture here is a known enum field. */
const rEnum = (type: string, annotations?: Record<string, string>) => {
  const ef = resolveEnum({ name: 'F', type, ...(annotations && { annotations }) }, schema);
  if (!ef) throw new Error(`expected an EnumField for type ${type}`);
  return ef;
};

describe('resolveEnum — classification of the five representations', () => {
  it('SINGLE_STRING: Edm.String + LookupName', () => {
    const ef = rEnum('Edm.String', LOOKUP);
    expect(ef.representation).toBe('SINGLE_STRING');
    expect(ef.isMultiValued).toBe(false);
    expect(ef.defaultOp).toBe('eq');
    expect(ef.enumType).toBeUndefined();
  });

  it('SINGLE_ENUM: non-collection enum type, IsFlags false', () => {
    const ef = rEnum('org.reso.metadata.enums.StandardStatus');
    expect(ef.representation).toBe('SINGLE_ENUM');
    expect(ef.defaultOp).toBe('eq');
    expect(ef.enumType?.name).toBe('StandardStatus');
  });

  it('FLAGS_ENUM: non-collection enum type, IsFlags true', () => {
    const ef = rEnum('org.reso.metadata.enums.AccessibilityFeatures');
    expect(ef.representation).toBe('FLAGS_ENUM');
    expect(ef.isMultiValued).toBe(true);
    expect(ef.defaultOp).toBe('has');
  });

  it('COLLECTION_STRING: Collection(Edm.String) + LookupName', () => {
    const ef = rEnum('Collection(Edm.String)', LOOKUP);
    expect(ef.representation).toBe('COLLECTION_STRING');
    expect(ef.isMultiValued).toBe(true);
    expect(ef.defaultOp).toBe('any');
  });

  it('COLLECTION_ENUM: Collection(enum type)', () => {
    const ef = rEnum('Collection(org.reso.metadata.enums.AccessibilityFeatures)');
    expect(ef.representation).toBe('COLLECTION_ENUM');
    expect(ef.isMultiValued).toBe(true);
    expect(ef.defaultOp).toBe('any');
  });

  it('returns null for non-enum fields', () => {
    expect(resolveEnum({ name: 'City', type: 'Edm.String' }, schema)).toBeNull(); // no LookupName
    expect(resolveEnum({ name: 'ListPrice', type: 'Edm.Decimal' }, schema)).toBeNull();
    expect(resolveEnum({ name: 'X', type: 'org.reso.metadata.enums.NotInSchema' }, schema)).toBeNull();
    expect(resolveEnum({ name: 'X', type: 'Collection(Edm.String)' }, schema)).toBeNull(); // no LookupName
    expect(resolveEnum({ name: 'X', type: 'Collection(Edm.Int32)' }, schema)).toBeNull(); // non-string/non-enum collection
  });
});

describe('buildFilter — guards against malformed OData', () => {
  const single = () => rEnum('org.reso.metadata.enums.StandardStatus');
  const flags = () => rEnum('org.reso.metadata.enums.AccessibilityFeatures');
  const coll = () => rEnum('Collection(org.reso.metadata.enums.AccessibilityFeatures)');

  it('throws on an empty value set (no valid OData filter form)', () => {
    expect(() => single().buildFilter([], 'in')).toThrow(RangeError);
    expect(() => flags().buildFilter([])).toThrow(RangeError);
    expect(() => coll().buildFilter([])).toThrow(RangeError);
  });

  it('throws when eq/ne is given multiple values (would silently drop the rest)', () => {
    expect(() => single().buildFilter(['Active', 'Pending'])).toThrow(RangeError);
    expect(() => single().buildFilter(['Active', 'Pending'], 'ne')).toThrow(RangeError);
  });

  it('a single-element in() is valid', () => {
    expect(single().buildFilter(['Active'], 'in')).toBe("F in ('Active')");
  });
});

describe('buildFilter — operator per representation', () => {
  const single = () => rEnum('org.reso.metadata.enums.StandardStatus');
  const flags = () => rEnum('org.reso.metadata.enums.AccessibilityFeatures');
  const coll = () => rEnum('Collection(org.reso.metadata.enums.AccessibilityFeatures)');

  it('single: eq by default, ne and in on request', () => {
    expect(single().buildFilter('Active')).toBe("F eq 'Active'");
    expect(single().buildFilter('Active', 'ne')).toBe("F ne 'Active'");
    expect(single().buildFilter(['Active', 'Pending'], 'in')).toBe("F in ('Active','Pending')");
  });

  it('flags: has by default, has-and for multiple values', () => {
    expect(flags().buildFilter('A')).toBe("F has 'A'");
    expect(flags().buildFilter(['A', 'B'])).toBe("F has 'A' and F has 'B'");
  });

  it('collection: any() by default, all() on request', () => {
    expect(coll().buildFilter('A')).toBe("F/any(x:x eq 'A')");
    expect(coll().buildFilter('A', 'all')).toBe("F/all(x:x eq 'A')");
  });

  it('escapes single quotes in values (OData literal doubling)', () => {
    expect(single().buildFilter("O'Brien")).toBe("F eq 'O''Brien'");
  });
});

describe('decodeValue — native member elements per representation', () => {
  const single = () => rEnum('org.reso.metadata.enums.StandardStatus');
  const flags = () => rEnum('org.reso.metadata.enums.AccessibilityFeatures');
  const coll = () => rEnum('Collection(org.reso.metadata.enums.AccessibilityFeatures)');
  const collStr = () => rEnum('Collection(Edm.String)', LOOKUP);

  it('single: a scalar → one element, empty/null → []', () => {
    expect(single().decodeValue('Active')).toEqual(['Active']);
    expect(single().decodeValue(null)).toEqual([]);
    expect(single().decodeValue('')).toEqual([]);
  });

  it('flags: comma and bitmask forms decode via the shared decoder', () => {
    expect(flags().decodeValue('A,C')).toEqual(['A', 'C']);
    expect(flags().decodeValue(3)).toEqual(['A', 'B']); // 1 | 2
    expect(flags().decodeValue(0)).toEqual([]); // None excluded
  });

  it('collection: array passthrough, comma-string fallback, null → []', () => {
    expect(coll().decodeValue(['A', 'B'])).toEqual(['A', 'B']);
    expect(collStr().decodeValue(['X', 'Y'])).toEqual(['X', 'Y']);
    expect(coll().decodeValue('A,B')).toEqual(['A', 'B']);
    expect(coll().decodeValue(null)).toEqual([]);
  });

  it('off-contract raws never manufacture a phantom member', () => {
    expect(single().decodeValue(0 as unknown)).toEqual([]); // non-string scalar
    expect(single().decodeValue(false as unknown)).toEqual([]);
    expect(coll().decodeValue(5 as unknown)).toEqual([]); // non-array, non-string
    expect(coll().decodeValue([{}, 'A', ''] as unknown)).toEqual(['A']); // non-string + empty elements dropped
    expect(flags().decodeValue({} as unknown)).toEqual([]); // object is not a flags value
  });
});

describe('encodeValue — wire form per representation', () => {
  it('single → the single value', () => {
    expect(rEnum('org.reso.metadata.enums.StandardStatus').encodeValue(['Active'])).toBe('Active');
    expect(rEnum('org.reso.metadata.enums.StandardStatus').encodeValue([])).toBe('');
  });

  it('flags → comma-joined member names', () => {
    expect(rEnum('org.reso.metadata.enums.AccessibilityFeatures').encodeValue(['A', 'B'])).toBe('A,B');
  });

  it('collection → an array', () => {
    expect(rEnum('Collection(org.reso.metadata.enums.AccessibilityFeatures)').encodeValue(['A', 'B'])).toEqual(['A', 'B']);
  });
});
