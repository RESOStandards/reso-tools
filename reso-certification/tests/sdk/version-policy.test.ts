import { describe, expect, it } from 'vitest';
import { CERTIFIABLE_CORE_VERSIONS, whyCoreVersionDoesNotCertify } from '../../src/sdk/core-versions.js';
import { latestOfEachMajor, whyVersionDoesNotCertify } from '../../src/sdk/version-policy.js';

// RESO certifies on the latest minor version within a given major branch, for every endorsement.
describe('latestOfEachMajor', () => {
  it('keeps the highest version of each major, comparing numerically', () => {
    expect(latestOfEachMajor(['2.0', '2.1', '2.10', '2.9'])).toEqual(['2.10']);
    expect(latestOfEachMajor(['2.0.0', '2.1.0', '2.1.1'])).toEqual(['2.1.1']);
  });

  it('keeps each major apart', () => {
    expect(latestOfEachMajor(['1.0.0', '2.0.0'])).toEqual(['1.0.0', '2.0.0']);
    expect(latestOfEachMajor(['1.7', '2.0', '2.1'])).toEqual(['1.7', '2.1']);
  });

  it('is empty for no versions', () => {
    expect(latestOfEachMajor([])).toEqual([]);
  });
});

describe('whyVersionDoesNotCertify', () => {
  const certifiable = ['2.1.0'];

  it('says nothing for a certifiable version', () => {
    expect(whyVersionDoesNotCertify('Web API Core', '2.1.0', certifiable)).toBeUndefined();
  });

  it('names the version certification is on for an older minor', () => {
    expect(whyVersionDoesNotCertify('Web API Core', '2.0.0', certifiable)).toBe(
      'Certification is on Web API Core 2.1.0, the latest 2.x. A run on 2.0.0 is a retest and is not eligible for certification.'
    );
  });

  it('says RESO does not certify a version whose major has nothing certifiable', () => {
    expect(whyVersionDoesNotCertify('Web API Core', '1.0.2', certifiable)).toBe('RESO does not certify Web API Core 1.0.2.');
  });
});

describe('Web API Core versions', () => {
  it('certify on 2.1.0 alone today: 2.0.0 is a retest', () => {
    expect([...CERTIFIABLE_CORE_VERSIONS]).toEqual(['2.1.0']);
    expect(whyCoreVersionDoesNotCertify('2.1.0')).toBeUndefined();
    expect(whyCoreVersionDoesNotCertify('2.0.0')).toContain('A run on 2.0.0 is a retest');
  });
});
