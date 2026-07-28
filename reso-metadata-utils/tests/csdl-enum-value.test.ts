import { describe, it, expect } from 'vitest';
import { decodeFlagsValue, extractTypeName } from '../src/index.js';
import type { CsdlEnumType } from '../src/csdl/types.js';

/** A well-formed IsFlags enum: power-of-two member values, with a value-0 "None". */
const flagsEnum: CsdlEnumType = {
  name: 'AccessibilityFeatures',
  isFlags: true,
  members: [
    { name: 'None', value: '0' },
    { name: 'A', value: '1' },
    { name: 'B', value: '2' },
    { name: 'C', value: '4' },
    { name: 'D', value: '8' },
  ],
};

describe('decodeFlagsValue — comma-joined name form', () => {
  it('decodes a lone scalar name to a one-element list', () => {
    expect(decodeFlagsValue(flagsEnum, 'A')).toEqual(['A']);
  });

  it('splits comma-joined names', () => {
    expect(decodeFlagsValue(flagsEnum, 'A,B')).toEqual(['A', 'B']);
  });

  it('trims whitespace around tokens', () => {
    expect(decodeFlagsValue(flagsEnum, ' A , B ')).toEqual(['A', 'B']);
  });

  it('drops empty tokens from trailing/double commas', () => {
    expect(decodeFlagsValue(flagsEnum, 'A,,B,')).toEqual(['A', 'B']);
  });

  it('returns [] for an empty or whitespace-only string', () => {
    expect(decodeFlagsValue(flagsEnum, '')).toEqual([]);
    expect(decodeFlagsValue(flagsEnum, '   ')).toEqual([]);
  });

  it('preserves unknown name tokens as sent (membership is a separate concern)', () => {
    expect(decodeFlagsValue(flagsEnum, 'A,Unknown,B')).toEqual(['A', 'Unknown', 'B']);
  });
});

describe('decodeFlagsValue — integer bitmask form', () => {
  it('decodes a numeric bitmask into its set members', () => {
    expect(decodeFlagsValue(flagsEnum, 3)).toEqual(['A', 'B']); // 1 | 2
    expect(decodeFlagsValue(flagsEnum, 5)).toEqual(['A', 'C']); // 1 | 4
    expect(decodeFlagsValue(flagsEnum, 15)).toEqual(['A', 'B', 'C', 'D']); // 1|2|4|8
  });

  it('decodes an all-digits string bitmask identically', () => {
    expect(decodeFlagsValue(flagsEnum, '3')).toEqual(['A', 'B']);
  });

  it('excludes the value-0 "None" member (it is a subset of every input)', () => {
    expect(decodeFlagsValue(flagsEnum, 0)).toEqual([]);
    expect(decodeFlagsValue(flagsEnum, 1)).toEqual(['A']); // None never appears alongside A
  });

  it('drops bits that match no member', () => {
    expect(decodeFlagsValue(flagsEnum, 16)).toEqual([]); // max member bit is 8
    expect(decodeFlagsValue(flagsEnum, 17)).toEqual(['A']); // 16 (no member) | 1 (A)
  });

  it('returns [] for a negative integer', () => {
    expect(decodeFlagsValue(flagsEnum, -1)).toEqual([]);
  });

  it('skips members with no declared value', () => {
    const partial: CsdlEnumType = {
      name: 'Partial',
      isFlags: true,
      members: [{ name: 'A' }, { name: 'B', value: '2' }], // A has no @Value
    };
    expect(decodeFlagsValue(partial, 3)).toEqual(['B']); // A cannot participate in bit math
  });

  it('handles Int64-wide bitmasks without 32-bit truncation (BigInt)', () => {
    const highBit = (2n ** 60n).toString(); // far beyond 32-bit and Number.MAX_SAFE_INTEGER
    const wide: CsdlEnumType = {
      name: 'Wide',
      isFlags: true,
      members: [
        { name: 'Low', value: '1' },
        { name: 'High', value: highBit },
      ],
    };
    expect(decodeFlagsValue(wide, highBit)).toEqual(['High']);
    expect(decodeFlagsValue(wide, (1n + 2n ** 60n).toString())).toEqual(['Low', 'High']);
  });
});

describe('decodeFlagsValue — off-contract inputs yield [] (never a phantom member)', () => {
  it('returns [] for null and undefined (an empty enum field across the JSON boundary)', () => {
    expect(decodeFlagsValue(flagsEnum, null)).toEqual([]);
    expect(decodeFlagsValue(flagsEnum, undefined)).toEqual([]);
  });

  it('returns [] for a non-integer or non-finite number', () => {
    expect(decodeFlagsValue(flagsEnum, 3.5)).toEqual([]);
    expect(decodeFlagsValue(flagsEnum, Number.NaN)).toEqual([]);
    expect(decodeFlagsValue(flagsEnum, Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it('rejects a precision-unsafe numeric bitmask (> 2^53) rather than decoding the wrong number', () => {
    // As a NUMBER, 2^54 + 1 has already lost its low bit at parse time — reject, do not silently
    // decode a corrupted mask. Wide masks must arrive as strings (see the Int64-wide test above).
    expect(decodeFlagsValue(flagsEnum, 2 ** 54 + 1)).toEqual([]);
  });
});

describe('decodeFlagsValue — composite (non-power-of-two) members are excluded', () => {
  it('decodes to atomic flags only, never over-reporting a combined convenience member', () => {
    const withComposite: CsdlEnumType = {
      name: 'Composite',
      isFlags: true,
      members: [
        { name: 'A', value: '1' },
        { name: 'B', value: '2' },
        { name: 'AB', value: '3' }, // combined convenience flag — not a power of two
      ],
    };
    expect(decodeFlagsValue(withComposite, 3)).toEqual(['A', 'B']); // not ['A','B','AB']
  });
});

describe('extractTypeName', () => {
  it('strips the namespace from a bare FQDN', () => {
    expect(extractTypeName('org.reso.metadata.enums.StandardStatus')).toBe('StandardStatus');
  });

  it('unwraps Collection() and strips the namespace', () => {
    expect(extractTypeName('Collection(org.reso.metadata.enums.Appliances)')).toBe('Appliances');
  });

  it('returns the last segment of any dotted type, and a bare name unchanged', () => {
    expect(extractTypeName('Edm.String')).toBe('String');
    expect(extractTypeName('Foo')).toBe('Foo');
  });
});
