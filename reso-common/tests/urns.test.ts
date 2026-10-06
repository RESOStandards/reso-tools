import { describe, expect, it } from 'vitest';
import { VARIATIONS_URN_STEM, variationsCanonicalStoreUrn, variationsReportUrn } from '../src/variations/urns.js';

/**
 * These identifiers are the whole contract between the certification service, which
 * builds one to find a lock, and the review client, which builds one to take a lock.
 * Matching is string equality, so any disagreement is silent — a lock nobody else can
 * address, with both sides believing they hold the resource.
 *
 * The literal forms below are asserted spelled out rather than rebuilt from the same
 * template, so that changing a builder fails a test instead of moving with it.
 */

const ENV = 'qa';
const DD = '2.1';
const PROVIDER = 'T00000076';
const USI = '50009';
const RECIPIENT = 'M00000100';

describe('variationsReportUrn', () => {
  it('builds the exact documented form', () => {
    expect(variationsReportUrn(ENV, DD, PROVIDER, USI, RECIPIENT)).toBe(
      'urn:reso:certification:variations:report:qa:2.1:T00000076:50009:M00000100'
    );
  });

  it('names the resource type before the identity, so the type is not inferred from length', () => {
    // The report and canonical forms previously shared a prefix and were told apart by
    // counting segments, which is how a shape check came to reject the canonical lock.
    const report = variationsReportUrn(ENV, DD, PROVIDER, USI, RECIPIENT);
    const canonical = variationsCanonicalStoreUrn(ENV);
    expect(report.startsWith(`${VARIATIONS_URN_STEM}:report:`)).toBe(true);
    expect(canonical.startsWith(`${VARIATIONS_URN_STEM}:canonical:`)).toBe(true);
    expect(report).not.toBe(canonical);
  });

  describe('every coordinate is a scoping dimension', () => {
    // Each of these would be a real collision if the coordinate were left out.
    it('separates environments — one locks table, no environment on the row', () => {
      expect(variationsReportUrn('production', DD, PROVIDER, USI, RECIPIENT)).not.toBe(
        variationsReportUrn('qa', DD, PROVIDER, USI, RECIPIENT)
      );
    });

    it('separates DD versions — a 2.0 report and a 2.1 report are different reports', () => {
      expect(variationsReportUrn(ENV, '2.0', PROVIDER, USI, RECIPIENT)).not.toBe(variationsReportUrn(ENV, '2.1', PROVIDER, USI, RECIPIENT));
    });

    it('separates providers, systems and recipients', () => {
      const base = variationsReportUrn(ENV, DD, PROVIDER, USI, RECIPIENT);
      expect(variationsReportUrn(ENV, DD, 'T00000012', USI, RECIPIENT)).not.toBe(base);
      expect(variationsReportUrn(ENV, DD, PROVIDER, '50010', RECIPIENT)).not.toBe(base);
      expect(variationsReportUrn(ENV, DD, PROVIDER, USI, 'M00000136')).not.toBe(base);
    });
  });

  describe('refuses to build a malformed identifier', () => {
    // Refusing loudly here is the opposite of validating an identifier handed to us:
    // both failures below produce a well-formed-looking string that silently means
    // the wrong thing.
    it('rejects an empty coordinate, which would collide with any other missing it', () => {
      expect(() => variationsReportUrn('', DD, PROVIDER, USI, RECIPIENT)).toThrow(/environmentName is required/);
      expect(() => variationsReportUrn(ENV, '', PROVIDER, USI, RECIPIENT)).toThrow(/ddVersion is required/);
      expect(() => variationsReportUrn(ENV, DD, '', USI, RECIPIENT)).toThrow(/providerUoi is required/);
      expect(() => variationsReportUrn(ENV, DD, PROVIDER, '', RECIPIENT)).toThrow(/providerUsi is required/);
      expect(() => variationsReportUrn(ENV, DD, PROVIDER, USI, '')).toThrow(/recipientUoi is required/);
    });

    it('rejects a coordinate carrying the separator, which would shift every later position', () => {
      // Without this, ('qa', '2.1', 'A:B', 'C', 'D') and ('qa', '2.1', 'A', 'B:C', 'D')
      // produce the identical string.
      expect(() => variationsReportUrn(ENV, DD, 'T000:0076', USI, RECIPIENT)).toThrow(/may not contain/);
      expect(() => variationsReportUrn('qa:1', DD, PROVIDER, USI, RECIPIENT)).toThrow(/may not contain/);
    });
  });
});

describe('variationsCanonicalStoreUrn', () => {
  it('builds the exact documented form', () => {
    expect(variationsCanonicalStoreUrn('qa')).toBe('urn:reso:certification:variations:canonical:qa');
  });

  it('carries no version, because the canonical store is not per-DD-version', () => {
    // The namespace path determines the shape of what follows. A reader reaching
    // `:canonical:` knows no version comes next; this is not an omission.
    expect(variationsCanonicalStoreUrn('qa').split(':')).toHaveLength(6);
  });

  it('separates environments', () => {
    expect(variationsCanonicalStoreUrn('production')).not.toBe(variationsCanonicalStoreUrn('qa'));
  });

  it('refuses an empty or separator-carrying environment', () => {
    expect(() => variationsCanonicalStoreUrn('')).toThrow(/environmentName is required/);
    expect(() => variationsCanonicalStoreUrn('qa:1')).toThrow(/may not contain/);
  });
});
