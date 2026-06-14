import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_DD_VERSIONS,
  DEPRECATED_DD_VERSIONS,
  CERTIFIABLE_DD_VERSIONS,
  CURRENT_DD_VERSION,
  normalizeDDVersion,
  isDDVersion,
  isCertifiableDDVersion,
  isSupportedDDVersion,
} from '../../src/sdk/dd-versions.js';

// The versions we ship reference metadata for, read straight off disk.
const referenceDir = fileURLToPath(new URL('../../reference-metadata', import.meta.url));
const versionsOnDisk = readdirSync(referenceDir)
  .map((f) => /^dd-(.+)\.json$/.exec(f)?.[1])
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
  it('certifiable = supported minus deprecated', () => {
    const expected = SUPPORTED_DD_VERSIONS.filter(
      (v) => !(DEPRECATED_DD_VERSIONS as ReadonlyArray<string>).includes(v),
    );
    expect([...CERTIFIABLE_DD_VERSIONS].sort()).toEqual([...expected].sort());
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
    ['2.0.0', '2.0'],
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

  it('isCertifiableDDVersion excludes deprecated 1.7', () => {
    expect(isCertifiableDDVersion('1.7')).toBe(false);
    expect(isCertifiableDDVersion('2.0')).toBe(true);
    expect(isCertifiableDDVersion('2.1')).toBe(true);
  });
});
