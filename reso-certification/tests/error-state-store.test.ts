import { describe, expect, it } from 'vitest';

import { createBufferDistinctKeySet } from '../src/state/distinct-key-set-buffer.js';
import { type SchemaErrorObservation, createErrorStateStore } from '../src/state/error-state-store.js';

/**
 * These tests encode a real measurement rather than a hypothetical.
 *
 * On a DD 2.1 run against a live provider, the existing accumulator reported 2,256,059 schema
 * errors where there were 1,050,216 distinct violations. The multiplier was the number of expansion
 * shapes carrying each field: Property declared three navigation properties, so every Property
 * record was validated four times; Office and Member declared one, so twice. `Office.OfficeStatus`
 * reported 12,934 for 6,467 Office records that exist in total, and `Property.YearRenovated`
 * reported 500 for 125 records.
 *
 * The cases below replay exactly those multiplicities. If this store is working, the counts come
 * out 6,467 and 125.
 */

const observe = (over: Partial<SchemaErrorObservation> = {}): SchemaErrorObservation => ({
  message: 'MUST be advertised in the metadata',
  resourceName: 'Office',
  fieldName: 'OfficeStatus',
  lookupValue: 'Inactive',
  keyField: 'OfficeKey',
  keyFieldValue: 'OFFICE-1',
  ...over
});

describe('error state store — counts distinct records, not sightings', () => {
  it('collapses the 2x Office sweep to the real record count', () => {
    const store = createErrorStateStore({ expectedViolations: 100_000 });
    const records = 6_467;
    const sweeps = 2; // bare + $expand=Media
    const outcomes = Array.from({ length: records * sweeps }, (_unused, i) =>
      store.record(observe({ keyFieldValue: `OFFICE-${i % records}` }))
    );
    expect(outcomes.filter(o => o === 'counted')).toHaveLength(records);
    expect(outcomes.filter(o => o === 'duplicate')).toHaveLength(records);
    expect(store.stats().distinctViolations).toBe(records);
  });

  it('collapses the 4x Property sweep to the real record count', () => {
    const store = createErrorStateStore({ expectedViolations: 100_000 });
    const records = 125;
    const sweeps = 4; // bare + Media + Rooms + UnitTypes
    Array.from({ length: records * sweeps }, (_unused, i) =>
      store.record(
        observe({
          message: 'MUST be integer or null but found string',
          resourceName: 'Property',
          fieldName: 'YearRenovated',
          lookupValue: undefined,
          keyField: 'ListingKey',
          keyFieldValue: `MBR-${i % records}`
        })
      )
    );
    expect(store.stats().distinctViolations).toBe(records);
    expect(store.stats().duplicatesSuppressed).toBe(records * (sweeps - 1));
  });

  it('keeps two fields on one resource separate, which a record-only key would merge', () => {
    // City and CountyOrParish are the same error class on different fields. Deduping on
    // (record, class) alone would collapse them into one count.
    const store = createErrorStateStore({ expectedViolations: 1_000 });
    store.record(
      observe({ resourceName: 'Property', fieldName: 'City', lookupValue: 'Indianapolis', keyField: 'ListingKey', keyFieldValue: 'MBR-1' })
    );
    store.record(
      observe({
        resourceName: 'Property',
        fieldName: 'CountyOrParish',
        lookupValue: 'Marion',
        keyField: 'ListingKey',
        keyFieldValue: 'MBR-1'
      })
    );
    expect(store.stats().distinctViolations).toBe(2);
  });

  it('keeps two values of one field separate', () => {
    const store = createErrorStateStore({ expectedViolations: 1_000 });
    store.record(observe({ lookupValue: 'Inactive' }));
    store.record(observe({ lookupValue: 'Active' }));
    expect(store.stats().distinctViolations).toBe(2);
  });
});

describe('error state store — refuses rather than guessing', () => {
  it('declines an observation with no record key instead of counting it', () => {
    const store = createErrorStateStore({ expectedViolations: 1_000 });
    expect(store.record(observe({ keyFieldValue: undefined }))).toBe('uncounted');
    expect(store.stats().distinctViolations).toBe(0);
    expect(store.stats().totalsAreFloor).toBe(true);
  });

  it('declines, and flags the totals as a floor, when the dedup set saturates', () => {
    const store = createErrorStateStore({
      keySet: createBufferDistinctKeySet({ targetDistinctKeys: 4, maxBytes: 64 })
    });
    const outcomes = Array.from({ length: 50 }, (_unused, i) => store.record(observe({ keyFieldValue: `OFFICE-${i}` })));
    expect(outcomes).toContain('uncounted');
    expect(store.stats().totalsAreFloor).toBe(true);
    // Undercount, never overcount: what it counted is never more than what it saw.
    expect(store.stats().distinctViolations).toBeLessThan(50);
  });
});

describe('error state store — report shape', () => {
  it('caps samples per value and carries the distinct record count', () => {
    const store = createErrorStateStore({ expectedViolations: 10_000, samplesPerValue: 5 });
    Array.from({ length: 400 }, (_unused, i) => store.record(observe({ keyFieldValue: `OFFICE-${i}` })));
    const report = store.toReport({ version: '2.1' }) as {
      totalErrors: number;
      errors: Record<
        string,
        {
          resources: Record<
            string,
            {
              count: number;
              distinctRecordCount: number;
              fields: Record<string, { lookups: Record<string, { count: number; keys: string[] }> }>;
            }
          >;
        }
      >;
    };
    expect(report.totalErrors).toBe(400);
    const office = report.errors['MUST be advertised in the metadata']?.resources.Office;
    expect(office?.count).toBe(400);
    expect(office?.distinctRecordCount).toBe(400);
    const value = office?.fields.OfficeStatus?.lookups.Inactive;
    expect(value?.count).toBe(400);
    // 5 samples, not 400 keys. On the reference run the full lists were 99.84% of a 20 MB file.
    expect(value?.keys).toHaveLength(5);
  });

  it('puts a type failure under the field rather than inventing a value bucket', () => {
    const store = createErrorStateStore({ expectedViolations: 1_000 });
    store.record(observe({ fieldName: 'CeilingHeight', lookupValue: undefined, keyFieldValue: 'MBR-9' }));
    const report = store.toReport() as {
      errors: Record<
        string,
        { resources: Record<string, { fields: Record<string, { count?: number; keys?: string[]; lookups?: unknown }> }> }
      >;
    };
    const field = report.errors['MUST be advertised in the metadata']?.resources.Office?.fields.CeilingHeight;
    expect(field?.count).toBe(1);
    expect(field?.lookups).toBeUndefined();
  });
});
