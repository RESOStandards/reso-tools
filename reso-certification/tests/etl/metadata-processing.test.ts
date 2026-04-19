/**
 * ETL metadata processing tests — ported from reso-certification-etl Mocha suite.
 */

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

// ETL is CommonJS — use require
const createRequire = (await import('node:module')).createRequire;
const require = createRequire(import.meta.url);

const etlRoot = resolve(import.meta.dirname, '../../src/etl');
const etlExports = require(resolve(etlRoot, 'index.cjs'));
const { processMetadataReport } = etlExports.processMetadata;
const { processDataAvailability: processDataAvailabilityFn } = etlExports.processDataAvailability;

// ── Metadata processing tests ──

describe('ETL processMetadataReport', () => {
  const { metadataReport } = require(resolve(etlRoot, 'test/sample-data-dictionary-reports/metadata-report.cjs'));

  it('should process metadata report without errors', () => {
    const result = processMetadataReport(metadataReport);
    expect(result).toBeDefined();
    expect(result.version).toBe('1.7');
    expect(result.description).toBe('RESO Data Dictionary Metadata Report');
  });

  it('should classify standard RESO fields', () => {
    const result = processMetadataReport(metadataReport);
    const standardFields = result.fields.filter((f: Record<string, unknown>) => f.standardRESO);
    expect(standardFields.length).toBeGreaterThan(0);
    // OfficeStateOrProvince, AccessibilityFeatures, StandardStatus, ListPrice are standard
    expect(standardFields.length).toBe(4);
  });

  it('should classify local fields', () => {
    const result = processMetadataReport(metadataReport);
    const localFields = result.fields.filter((f: Record<string, unknown>) => !f.standardRESO);
    // CustomLookupField123 is local
    expect(localFields.length).toBe(1);
    expect(localFields[0].fieldName).toBe('CustomLookupField123');
  });

  it('should count fields correctly', () => {
    const result = processMetadataReport(metadataReport);
    expect(result.totalFieldsCount).toBe(5);
    expect(result.standardFieldsCount).toBe(4);
    expect(result.localFieldsCount).toBe(1);
  });

  it('should count resources correctly', () => {
    const result = processMetadataReport(metadataReport);
    expect(result.totalResourcesCount).toBe(2);
    expect(result.standardResourcesCount).toBe(2);
    expect(result.localResourcesCount).toBe(0);
  });

  it('should process lookups', () => {
    const result = processMetadataReport(metadataReport);
    expect(result.lookups).toBeDefined();
    expect(result.lookups.length).toBeGreaterThan(0);
    expect(result.totalLookupsCount).toBe(result.lookups.length);
  });
});

// ── Data availability tests ──

describe('ETL processDataAvailability', () => {
  const { daReport, daReport2_0 } = require(resolve(etlRoot, 'test/sample-data-availability-reports/availability-report.cjs'));

  it('should process DD 1.7 availability report', async () => {
    const expectedReport = require(resolve(etlRoot, 'test/sample-data-availability-reports/expected-availability-report.json'));
    const result = await processDataAvailabilityFn(daReport);
    expect(JSON.parse(JSON.stringify(result))).toEqual(expectedReport);
  });

  it('should process DD 2.0 availability report', async () => {
    const expectedReport = require(resolve(etlRoot, 'test/sample-data-availability-reports/expected-availability-report-2_0.json'));
    const result = await processDataAvailabilityFn(daReport2_0);
    expect(JSON.parse(JSON.stringify(result))).toEqual(expectedReport);
  });
});

// ── Reference metadata loading ──

describe('ETL reference metadata', () => {
  const { getReferenceMetadata } = require(resolve(etlRoot, 'index.cjs'));

  it('loads DD 1.7 reference metadata', () => {
    const ref = getReferenceMetadata('1.7');
    expect(ref).not.toBeNull();
    expect(ref.version).toBe('1.7');
    expect(ref.fields.length).toBeGreaterThan(1000);
    expect(ref.lookups.length).toBeGreaterThan(2000);
  });

  it('loads DD 2.0 reference metadata', () => {
    const ref = getReferenceMetadata('2.0');
    expect(ref).not.toBeNull();
    expect(ref.version).toBe('2.0');
    expect(ref.fields.length).toBeGreaterThan(1700);
    expect(ref.lookups.length).toBeGreaterThan(3600);
  });

  it('loads DD 2.1 reference metadata', () => {
    const ref = getReferenceMetadata('2.1');
    expect(ref).not.toBeNull();
    expect(ref.version).toBe('2.1');
    expect(ref.fields.length).toBeGreaterThan(2100);
    expect(ref.lookups.length).toBeGreaterThan(4000);
  });

  it('defaults to DD 2.1', () => {
    const ref = getReferenceMetadata();
    expect(ref).not.toBeNull();
    expect(ref.version).toBe('2.1');
  });

  it('returns null for unknown version', () => {
    const ref = getReferenceMetadata('9.9');
    expect(ref).toBeNull();
  });

  it('includes models array', () => {
    const ref = getReferenceMetadata('2.1');
    expect(ref.models).toBeDefined();
    expect(ref.models.length).toBeGreaterThan(0);
    expect(ref.models[0].modelType).toBe('EntityType');
  });

  it('includes isEnumeration on fields', () => {
    const ref = getReferenceMetadata('2.1');
    const enums = ref.fields.filter((f: Record<string, unknown>) => f.isEnumeration);
    expect(enums.length).toBeGreaterThan(400);
  });
});
