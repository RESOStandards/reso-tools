import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CERTIFIABLE_DD_VERSIONS,
  CURRENT_DD_VERSION,
  DEPRECATED_DD_VERSIONS,
  SUPPORTED_DD_VERSIONS,
  TESTABLE_DD_VERSIONS,
  isCertifiableDDVersion,
  isDDVersion,
  isSupportedDDVersion,
  isTestableDDVersion,
  normalizeDDVersion,
  whyDDVersionDoesNotCertify
} from '../../src/sdk/dd-versions.js';

// The versions we ship reference metadata for, read straight off reso-common's reference-metadata
// directory (the single source; resolved through its `reference-metadata/*` subpath export).
const referenceDir = dirname(createRequire(import.meta.url).resolve('@reso-standards/reso-common/reference-metadata/dd-2.1.json'));
const versionsOnDisk = readdirSync(referenceDir)
  .map(f => /^dd-(.+)\.json$/.exec(f)?.[1])
  .filter((v): v is string => v != null)
  .sort();

describe('SUPPORTED_DD_VERSIONS is the single source of truth', () => {
  it('exactly matches the dd-{ver}.json reference files on disk (drift guard)', () => {
    // If this fails, a reference file was added/removed without updating the
    // constant (or vice versa). Update SUPPORTED_DD_VERSIONS to match disk.
    expect([...SUPPORTED_DD_VERSIONS].sort()).toEqual(versionsOnDisk);
  });
});

describe('derived sets stay consistent', () => {
  it('testable = supported minus deprecated', () => {
    const expected = SUPPORTED_DD_VERSIONS.filter(v => !(DEPRECATED_DD_VERSIONS as ReadonlyArray<string>).includes(v));
    expect([...TESTABLE_DD_VERSIONS].sort()).toEqual([...expected].sort());
  });

  // RESO certifies on the latest minor version within a given major branch.
  it('certifiable = the highest testable minor of each major, and nothing else', () => {
    const majors = [...new Set(TESTABLE_DD_VERSIONS.map(v => v.split('.')[0]))];
    const highest = majors.map(
      major =>
        TESTABLE_DD_VERSIONS.filter(v => v.split('.')[0] === major)
          .map(v => Number(v.split('.')[1]))
          .sort((a, b) => b - a)[0]
    );
    expect([...CERTIFIABLE_DD_VERSIONS].sort()).toEqual(majors.map((major, i) => `${major}.${highest[i]}`).sort());
  });

  it('today that is 2.1 alone: 2.0 is a retest', () => {
    expect([...CERTIFIABLE_DD_VERSIONS]).toEqual(['2.1']);
  });

  it('current is itself a supported and certifiable version', () => {
    expect(isDDVersion(CURRENT_DD_VERSION)).toBe(true);
    expect(isCertifiableDDVersion(CURRENT_DD_VERSION)).toBe(true);
  });

  it('every deprecated version is supported but not certifiable', () => {
    for (const v of DEPRECATED_DD_VERSIONS) {
      expect(isDDVersion(v)).toBe(true);
      expect(isCertifiableDDVersion(v)).toBe(false);
    }
  });
});

describe('normalizeDDVersion strips patch to MAJOR.MINOR', () => {
  it.each([
    ['2.1.0', '2.1'],
    ['2.1', '2.1'],
    ['1.7.3', '1.7'],
    ['2.0.0', '2.0']
  ])('%s -> %s', (input, expected) => {
    expect(normalizeDDVersion(input)).toBe(expected);
  });
});

describe('guards narrow safely (no `as` casts needed)', () => {
  it('isDDVersion matches exact normalized values only', () => {
    expect(isDDVersion('2.1')).toBe(true);
    expect(isDDVersion('2.1.0')).toBe(false); // not normalized — exact guard
    expect(isDDVersion('3.0')).toBe(false);
  });

  it('isSupportedDDVersion is patch-tolerant', () => {
    expect(isSupportedDDVersion('2.1.0')).toBe(true);
    expect(isSupportedDDVersion('2.1')).toBe(true);
    expect(isSupportedDDVersion('3.0')).toBe(false);
  });

  it('isTestableDDVersion excludes deprecated 1.7 and keeps older minors', () => {
    expect(isTestableDDVersion('1.7')).toBe(false);
    expect(isTestableDDVersion('2.0')).toBe(true);
    expect(isTestableDDVersion('2.1')).toBe(true);
  });

  it('isCertifiableDDVersion is the latest minor only', () => {
    expect(isCertifiableDDVersion('1.7')).toBe(false);
    expect(isCertifiableDDVersion('2.0')).toBe(false);
    expect(isCertifiableDDVersion('2.1')).toBe(true);
  });
});

describe('whyDDVersionDoesNotCertify says why, or nothing', () => {
  it('says nothing for the latest minor, in either form', () => {
    expect(whyDDVersionDoesNotCertify('2.1')).toBeUndefined();
    expect(whyDDVersionDoesNotCertify('2.1.0')).toBeUndefined();
  });

  it('names the version certification is on for an older minor', () => {
    expect(whyDDVersionDoesNotCertify('2.0')).toBe(
      'Certification is on Data Dictionary 2.1, the latest 2.x. A run on 2.0 is a retest and is not eligible for certification.'
    );
  });

  it('says RESO does not certify a version with no certifiable minor in its major', () => {
    expect(whyDDVersionDoesNotCertify('1.7')).toBe('RESO does not certify Data Dictionary 1.7.');
  });
});

describe('the legacy @reso.context checker knows the same versions', () => {
  it('KNOWN_DD_VERSIONS in src/legacy/lib/schema/reso-context.js equals SUPPORTED_DD_VERSIONS (drift guard)', () => {
    // The checker accepts a context version with no run version declared only when it names a Data Dictionary
    // version this engine ships a reference for; the two lists are kept in different modules (CJS legacy vs the
    // SDK) so this guard is what keeps them one list.
    const { KNOWN_DD_VERSIONS } = createRequire(import.meta.url)(
      resolve(import.meta.dirname, '../../src/legacy/lib/schema/reso-context.js')
    );
    expect([...KNOWN_DD_VERSIONS].sort()).toEqual([...SUPPORTED_DD_VERSIONS].sort());
  });
});
