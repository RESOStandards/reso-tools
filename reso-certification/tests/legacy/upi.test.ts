import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runUpiTests } = require(resolve(import.meta.dirname, '../../src/legacy/lib/certification/upi/index.js'));
const { parseUpi, validateCountrySubdivision, buildCountrySubdivisionCaches } = require(
  resolve(import.meta.dirname, '../../src/legacy/lib/upi/index.js')
);

const KNOWN_GOOD_UPI = 'urn:reso:upi:2.0:US:48201:12345 parcel number',
  KNOWN_GOOD_UPI_WITH_SUBCOMPONENT = `${KNOWN_GOOD_UPI}:sub:test parcel subcomponent`;

describe('UPI Parsing Tests', () => {
  it('Should have required properties with a known-good UPI', async () => {
    expect(parseUpi(KNOWN_GOOD_UPI)).toBeTruthy();
  });

  it('Should have required properties with a known-good UPI with Parcel Subcomponent', async () => {
    expect(parseUpi(KNOWN_GOOD_UPI_WITH_SUBCOMPONENT)).toBeTruthy();
  });

  it('Should produce correct components when parsed with a known-good UPI', async () => {
    const { Country, CountrySubdivision, ParcelNumber, ParcelSubcomponent } = parseUpi(KNOWN_GOOD_UPI);

    expect(Country).toBe('US');
    expect(CountrySubdivision).toBe('48201');
    expect(ParcelNumber).toBe('12345 parcel number');
    expect(ParcelSubcomponent).toBeFalsy();
  });

  it('Should produce correct components when parsed with a known-good UPI with Parcel Subcomponent', async () => {
    const { Country, CountrySubdivision, ParcelNumber, ParcelSubcomponent } = parseUpi(KNOWN_GOOD_UPI_WITH_SUBCOMPONENT);

    expect(Country).toBe('US');
    expect(CountrySubdivision).toBe('48201');
    expect(ParcelNumber).toBe('12345 parcel number');
    expect(ParcelSubcomponent).toBe('test parcel subcomponent');
  });

  it('Should return undefined ParcelSubcomponent when subcomponent is not present', () => {
    const { ParcelSubcomponent } = parseUpi(KNOWN_GOOD_UPI);
    expect(ParcelSubcomponent).toBe(undefined);
  });

  it('Should throw when given null', () => {
    expect(() => parseUpi(null)).toThrow(/Incorrectly formatted UPI/);
  });

  it('Should throw when given undefined', () => {
    expect(() => parseUpi(undefined)).toThrow(/Incorrectly formatted UPI/);
  });

  it('Should throw when given an empty string', () => {
    expect(() => parseUpi('')).toThrow(/Incorrectly formatted UPI/);
  });

  it('Should throw when given a string that does not start with urn:reso:upi', () => {
    expect(() => parseUpi('not:a:valid:upi')).toThrow(/Incorrectly formatted UPI/);
  });

  it('Should throw when given an unsupported UPI version', () => {
    expect(() => parseUpi('urn:reso:upi:1.0:US:48201:parcel')).toThrow(/UPI version of '1.0' is not supported/);
  });

  it('Should throw when CountrySubdivision is missing', () => {
    expect(() => parseUpi('urn:reso:upi:2.0:US::parcel')).toThrow(/CountrySubdivision is required/);
  });

  it('Should throw when ParcelNumber is missing', () => {
    expect(() => parseUpi('urn:reso:upi:2.0:US:48201:')).toThrow(/ParcelNumber is required/);
  });

  it('Should preserve special characters in ParcelNumber (dashes, dots, slashes)', () => {
    const { ParcelNumber } = parseUpi('urn:reso:upi:2.0:US:48201:R000022230-A/B.1#2');
    expect(ParcelNumber).toBe('R000022230-A/B.1#2');
  });

  it('Should preserve special characters in ParcelSubcomponent per spec example (78 - 9.aB)', () => {
    const { ParcelNumber, ParcelSubcomponent } = parseUpi('urn:reso:upi:2.0:US:48201:R000022230:sub:78 - 9.aB');
    expect(ParcelNumber).toBe('R000022230');
    expect(ParcelSubcomponent).toBe('78 - 9.aB');
  });

  it('Should preserve capitalization in ParcelNumber', () => {
    const { ParcelNumber } = parseUpi('urn:reso:upi:2.0:US:48201:aAbBcC');
    expect(ParcelNumber).toBe('aAbBcC');
  });
});

describe('UPI Validation Tests', () => {
  it('Should fail validation with an unknown country and country subdivision', async () => {
    const records = {
      '@reso.context': 'urn:reso:metadata:2.0:resource:property',
      value: [
        {
          UniversalParcelId: 'urn:reso:upi:2.0:UK:ABCDE:ohai',
          Country: 'UK',
          CountrySubdivision: 'ABCDE',
          ParcelNumber: 'ohai'
        }
      ]
    };

    const { errors = [] } = await runUpiTests({ resoCommonFormatJson: records });
    expect(errors && !!errors?.[0] && errors[0].error === "Country 'UK' is not supported for UPI version '2.0'!").toBeTruthy();
  });

  it('Should fail validation with an unknown country and known country subdivision', async () => {
    const records = {
      '@reso.context': 'urn:reso:metadata:2.0:resource:property',
      value: [
        {
          UniversalParcelId: 'urn:reso:upi:2.0:UK:48201:ohai',
          Country: 'UK',
          CountrySubdivision: '48201',
          ParcelNumber: 'ohai'
        }
      ]
    };

    const { errors = [] } = await runUpiTests({ resoCommonFormatJson: records });
    expect(errors && !!errors?.[0] && errors[0].error === "Country 'UK' is not supported for UPI version '2.0'!").toBeTruthy();
  });

  it('Should fail validation with an known country and unknown country subdivision', async () => {
    const records = {
      '@reso.context': 'urn:reso:metadata:2.0:resource:property',
      value: [
        {
          UniversalParcelId: 'urn:reso:upi:2.0:US:ABCDE:ohai',
          Country: 'US',
          CountrySubdivision: 'ABCDE',
          ParcelNumber: 'ohai'
        }
      ]
    };

    const { errors = [] } = await runUpiTests({ resoCommonFormatJson: records });
    expect(errors && !!errors?.[0] && errors[0].error === "Invalid country subdivision 'ABCDE'").toBeTruthy();
  });

  it('Should throw when called with no arguments', async () => {
    await expect(runUpiTests()).rejects.toThrow(/One of resoCommonFormatJson or pathToResoCommonFormatJson are required/);
  });

  it('Should fail validation when ParcelNumber in the payload does not match the UPI', async () => {
    const records = {
      '@reso.context': 'urn:reso:metadata:2.0:resource:property',
      value: [
        {
          UniversalParcelId: KNOWN_GOOD_UPI,
          Country: 'US',
          CountrySubdivision: '48201',
          ParcelNumber: 'different parcel number'
        }
      ]
    };

    const { errors = [] } = await runUpiTests({ resoCommonFormatJson: records });
    expect(errors?.some((e: { error: string }) => e.error === 'Parsed UPI mismatch with UPI data')).toBeTruthy();
  });

  it('Should pass validation with a known-good UPI and matching ParcelNumber in the payload', async () => {
    const records = {
      '@reso.context': 'urn:reso:metadata:2.0:resource:property',
      value: [
        {
          UniversalParcelId: KNOWN_GOOD_UPI,
          Country: 'US',
          CountrySubdivision: '48201',
          ParcelNumber: '12345 parcel number'
        }
      ]
    };

    const result = await runUpiTests({ resoCommonFormatJson: records });
    expect(!result.errors && result.numValidRecords === 1).toBeTruthy();
  });

  it('Should pass validation for a single record not wrapped in a value array', async () => {
    const record = {
      '@reso.context': 'urn:reso:metadata:2.0:resource:property',
      UniversalParcelId: KNOWN_GOOD_UPI,
      Country: 'US',
      CountrySubdivision: '48201',
      ParcelNumber: '12345 parcel number'
    };

    const result = await runUpiTests({ resoCommonFormatJson: record });
    expect(!result.errors).toBeTruthy();
  });

  it('Should pass validation when ParcelNumber contains special characters and matches the UPI', async () => {
    const upi = 'urn:reso:upi:2.0:US:48201:R000022230-A/B.1#2';
    const records = {
      '@reso.context': 'urn:reso:metadata:2.0:resource:property',
      value: [
        {
          UniversalParcelId: upi,
          Country: 'US',
          CountrySubdivision: '48201',
          ParcelNumber: 'R000022230-A/B.1#2'
        }
      ]
    };

    const result = await runUpiTests({ resoCommonFormatJson: records });
    expect(!result.errors && result.numValidRecords === 1).toBeTruthy();
  });

  it('Should fail validation when Country in the payload does not match the UPI', async () => {
    const records = {
      '@reso.context': 'urn:reso:metadata:2.0:resource:property',
      value: [
        {
          UniversalParcelId: KNOWN_GOOD_UPI,
          Country: 'CA',
          CountrySubdivision: '48201',
          ParcelNumber: '12345 parcel number'
        }
      ]
    };

    const { errors = [] } = await runUpiTests({ resoCommonFormatJson: records });
    expect(errors?.some((e: { error: string }) => e.error === 'Parsed UPI mismatch with UPI data')).toBeTruthy();
  });

  it('Should fail validation when CountrySubdivision in the payload does not match the UPI', async () => {
    const records = {
      '@reso.context': 'urn:reso:metadata:2.0:resource:property',
      value: [
        {
          UniversalParcelId: KNOWN_GOOD_UPI,
          Country: 'US',
          CountrySubdivision: '99999',
          ParcelNumber: '12345 parcel number'
        }
      ]
    };

    const { errors = [] } = await runUpiTests({ resoCommonFormatJson: records });
    expect(errors?.some((e: { error: string }) => e.error === 'Parsed UPI mismatch with UPI data')).toBeTruthy();
  });

  it('Should report only the invalid records when processing a mix of valid and invalid records', async () => {
    const records = {
      '@reso.context': 'urn:reso:metadata:2.0:resource:property',
      value: [
        {
          UniversalParcelId: KNOWN_GOOD_UPI,
          Country: 'US',
          CountrySubdivision: '48201',
          ParcelNumber: '12345 parcel number'
        },
        {
          UniversalParcelId: 'urn:reso:upi:2.0:US:ABCDE:ohai',
          Country: 'US',
          CountrySubdivision: 'ABCDE',
          ParcelNumber: 'ohai'
        }
      ]
    };

    const { errors = [] } = await runUpiTests({ resoCommonFormatJson: records });
    expect(errors.length === 1 && errors[0].error === "Invalid country subdivision 'ABCDE'").toBeTruthy();
  });
});

describe('validateCountrySubdivision Tests', () => {
  // PORT-NOTE: mocha `before` -> vitest `beforeAll`; `let` retained for the async-populated cache.
  let subdivisionCache: unknown;

  beforeAll(async () => {
    subdivisionCache = await buildCountrySubdivisionCaches('US');
  });

  it('Should return true for a valid US county FIPS code (Harris County, TX = 48201)', () => {
    expect(validateCountrySubdivision('48201', subdivisionCache)).toBeTruthy();
  });

  it('Should return false for an unrecognized subdivision code', () => {
    expect(validateCountrySubdivision('ABCDE', subdivisionCache)).toBeFalsy();
  });

  it('Should return false when countrySubdivision is null', () => {
    expect(validateCountrySubdivision(null, subdivisionCache)).toBeFalsy();
  });

  it('Should return false when countrySubdivision is an empty string', () => {
    expect(validateCountrySubdivision('', subdivisionCache)).toBeFalsy();
  });

  it('Should return false when the cache is null', () => {
    expect(validateCountrySubdivision('48201', null)).toBeFalsy();
  });

  it('Should return false when the cache is empty', () => {
    expect(validateCountrySubdivision('48201', {})).toBeFalsy();
  });
});
