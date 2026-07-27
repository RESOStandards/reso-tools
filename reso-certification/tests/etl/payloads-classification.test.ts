/**
 * Payloads classification tests — guards the IDX classification chokepoint.
 *
 * Regression: the transport DD generator moved `payloads` from the
 * RESO.OData.Metadata.Payloads annotation to a top-level property, but the ETL
 * still read the (now-absent) annotation, silently emptying IDX classification.
 * getStandardMetadata now normalizes the top-level property, tolerant of the
 * array (DD 2.2 shape), the legacy comma-string, or the annotation (pre-2.2 refs).
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

// ETL is CommonJS — use require
const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);

const etlRoot = resolve(import.meta.dirname, '../../src/etl');
const { normalizePayloads, getStandardMetadata } = require(resolve(etlRoot, 'common.cjs'));

const PAYLOADS_TERM = 'RESO.OData.Metadata.Payloads';

describe('normalizePayloads', () => {
  it('reads a top-level array (DD 2.2 shape), trimming members', () => {
    expect(normalizePayloads({ payloads: ['IDX', 'OM'] })).toEqual(['IDX', 'OM']);
    expect(normalizePayloads({ payloads: [' IDX ', 'OM'] })).toEqual(['IDX', 'OM']);
  });

  it('reads a legacy top-level comma-string, trimming whitespace', () => {
    expect(normalizePayloads({ payloads: 'IDX,OM' })).toEqual(['IDX', 'OM']);
    expect(normalizePayloads({ payloads: 'IDX, OM ,AMS' })).toEqual(['IDX', 'OM', 'AMS']);
  });

  it('keeps tokens distinct — a superstring of IDX is not IDX', () => {
    // Downstream IDX matching is exact-element (payloads.includes('IDX')), so a
    // token like "IDXplus" must survive as its own token and never read as IDX.
    expect(normalizePayloads({ payloads: 'IDX,IDXplus' })).toEqual(['IDX', 'IDXplus']);
    expect(normalizePayloads({ payloads: 'IDXplus' })).not.toContain('IDX');
  });

  it('falls back to the Payloads annotation for pre-2.2 refs', () => {
    expect(normalizePayloads({}, { [PAYLOADS_TERM]: 'IDX' })).toEqual(['IDX']);
    expect(normalizePayloads({ annotations: [] }, { [PAYLOADS_TERM]: 'IDX,OM' })).toEqual(['IDX', 'OM']);
  });

  it('prefers the top-level property over the annotation', () => {
    expect(normalizePayloads({ payloads: 'IDX' }, { [PAYLOADS_TERM]: 'OM' })).toEqual(['IDX']);
  });

  it('returns [] when payloads are absent (never [""])', () => {
    expect(normalizePayloads({})).toEqual([]);
    expect(normalizePayloads({ payloads: '' })).toEqual([]);
    expect(normalizePayloads({ payloads: [] })).toEqual([]);
    expect(normalizePayloads(undefined)).toEqual([]);
    expect(normalizePayloads(null)).toEqual([]);
  });
});

describe('getStandardMetadata — IDX classification against real refs', () => {
  it('DD 2.0: ListPrice carries the IDX payload', () => {
    const { fields } = getStandardMetadata('2.0');
    const listPrice = fields.find(
      (f: Record<string, unknown>) => f.resourceName === 'Property' && f.fieldName === 'ListPrice'
    );
    expect(listPrice).toBeDefined();
    expect(listPrice.payloads).toContain('IDX');
  });

  it('DD 2.0: a meaningful number of fields are IDX (regression guard — was 0 when broken)', () => {
    const { fields } = getStandardMetadata('2.0');
    const idx = fields.filter((f: Record<string, unknown>) => (f.payloads as string[])?.includes('IDX'));
    // ~247 IDX fields in DD 2.0; before the fix this was 0.
    expect(idx.length).toBeGreaterThan(100);
  });

  it('DD 2.0: non-IDX fields have [] payloads, not [""] (regression guard)', () => {
    const { fields } = getStandardMetadata('2.0');
    const empty = fields.filter((f: Record<string, unknown>) => (f.payloads as string[]).length === 0);
    // ~817 fields have no payloads; before the fix every field was [""] (length 1).
    expect(empty.length).toBeGreaterThan(0);
  });

  it('DD 2.1: IDX classification is populated', () => {
    const { fields } = getStandardMetadata('2.1');
    const idx = fields.filter((f: Record<string, unknown>) => (f.payloads as string[])?.includes('IDX'));
    expect(idx.length).toBeGreaterThan(100);
  });
});
